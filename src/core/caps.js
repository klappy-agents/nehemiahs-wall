// D10 agent-first room capabilities (PRD: klappy/nehemiahs-wall-cookbook
// design/proposals/2026-11-21-d10-agent-first-auth-prd.md @ ca36fb87). No shared keys, no signing secret.
// A seat token is 32 CSPRNG bytes (base64url, 43 chars) scoped to one room + one seat; the room stores only
// SHA-256(token). Revocation = delete the hash. Tokens are never logged, never in a path or query.
import { newRoom, view, act } from "./game.js";
import { checkStateSize } from "./limits.js";

export const CAPS = Object.freeze({
  TOKEN_BYTES: 32,
  ROOM_ID_BYTES: 16, // 22-char base64url, the existing room id format
  CLAIM_TTL_MS: 15 * 60 * 1000, // invite → claim code lifetime; single use
  ROOM_IDLE_MS: 7 * 24 * 60 * 60 * 1000, // idle rooms deleted by DO alarm
  UNJOINED_MS: 24 * 60 * 60 * 1000, // a room never joined is deleted after 24 h
  EXEC_PER_MIN: 120, // execute calls per token per minute
  CLAIM_TRIES: 10, // claim attempts per room per window
  CLAIM_WINDOW_MS: 10 * 60 * 1000,
  CREATE_PER_IP: 5, // creates per IP per window
  CREATE_IP_WINDOW_MS: 10 * 60 * 1000,
  CREATE_PER_ENV: 50, // creates per environment per hour
  CREATE_ENV_WINDOW_MS: 60 * 60 * 1000,
  BAD_TOKEN_PER_IP: 30, // failed execute (unknown/revoked token) per IP per room per window
  BAD_TOKEN_WINDOW_MS: 10 * 60 * 1000,
});

// Salted, truncated IP keys: raw IPs are never stored, and a stored key cannot be reversed by hashing
// the IPv4 space without the per-DO salt. Salt lives in the DO that stores the keys.
export async function ipKey(salt, ip) {
  return (await sha256hex(`${salt}:${ipBucket(ip)}`)).slice(0, 24);
}
// IPv6 clients (and egress pools) rotate within their /64; one /64 is one caller for rate limits.
// Found live on nehemiahs-wall-dev 2026-11-21: per-address IPv6 keys let creates spread across addresses.
export function ipBucket(ip) {
  const s = String(ip ?? "unknown").trim().toLowerCase();
  if (!s.includes(":")) return s;
  const [head, tail = ""] = s.split("::");
  const h = head ? head.split(":") : [];
  const t = tail ? tail.split(":") : [];
  const full = s.includes("::") ? [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t] : h;
  return full.slice(0, 4).map((x) => (x || "0").replace(/^0+(?=.)/, "")).join(":") + "::/64";
}
// A map of key → hit list, pruned of keys with no live hits (bounded by the window's own caps).
export function pruneHits(map = {}, now, windowMs) {
  const out = {};
  for (const [k, hits] of Object.entries(map)) {
    const live = hits.filter((t) => now - t < windowMs);
    if (live.length) out[k] = live;
  }
  return out;
}

const defaultRand = (n) => crypto.getRandomValues(new Uint8Array(n));

export function b64url(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export const mintToken = (rand = defaultRand) => b64url(rand(CAPS.TOKEN_BYTES));
export const mintRoomId = (rand = defaultRand) => b64url(rand(CAPS.ROOM_ID_BYTES));
export const looksLikeToken = (t) => typeof t === "string" && /^[A-Za-z0-9_-]{43}$/.test(t);

export async function sha256hex(s) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Sliding window over a short list of hit times. → { ok, hits, retryAfter (seconds) }
export function slidingWindow(hits = [], now, windowMs, max) {
  const live = hits.filter((t) => now - t < windowMs);
  if (live.length >= max) return { ok: false, hits: live, retryAfter: Math.max(1, Math.ceil((live[0] + windowMs - now) / 1000)) };
  return { ok: true, hits: [...live, now] };
}
// Fixed one-minute window counter (cheap per-call write). → { ok, counter, retryAfter }
export function minuteWindow(counter, now, max) {
  const win = Math.floor(now / 60000);
  const n = counter && counter.win === win ? counter.n : 0;
  if (n >= max) return { ok: false, counter: { win, n }, retryAfter: Math.max(1, Math.ceil(((win + 1) * 60000 - now) / 1000)) };
  return { ok: true, counter: { win, n: n + 1 } };
}

const fail = (error, extra = {}) => ({ ok: false, error, ...extra });

// Environment-wide room registry: room cap (200/env, existing) + create rate limits. Single-threaded DO → atomic.
export class RegistryCore {
  constructor(storage, { max, now = () => Date.now(), rand = defaultRand } = {}) {
    Object.assign(this, { storage, max, now, rand });
  }
  async salt() {
    let salt = await this.storage.get("salt");
    if (!salt) await this.storage.put("salt", (salt = mintToken(this.rand)));
    return salt;
  }
  // ip is the caller IP; only a salted, truncated hash is stored, in one map pruned on every create.
  async create(ip) {
    const now = this.now();
    const key = await ipKey(await this.salt(), ip);
    const ips = pruneHits(await this.storage.get("ips"), now, CAPS.CREATE_IP_WINDOW_MS);
    const ipw = slidingWindow(ips[key], now, CAPS.CREATE_IP_WINDOW_MS, CAPS.CREATE_PER_IP);
    if (!ipw.ok) {
      await this.storage.put("ips", ips);
      return fail("rate_limited", { retryAfter: ipw.retryAfter });
    }
    const envw = slidingWindow(await this.storage.get("creates"), now, CAPS.CREATE_ENV_WINDOW_MS, CAPS.CREATE_PER_ENV);
    if (!envw.ok) return fail("rate_limited", { retryAfter: envw.retryAfter });
    const count = (await this.storage.get("count")) ?? 0;
    if (count >= this.max) return fail("room_cap_reached");
    ips[key] = ipw.hits;
    let id;
    do id = mintRoomId(this.rand);
    while (await this.storage.get(`room:${id}`));
    await this.storage.put({ ips, creates: envw.hits, [`room:${id}`]: now, count: count + 1 });
    return { ok: true, room: id };
  }
  async release(id) {
    if (!(await this.storage.get(`room:${id}`))) return { ok: true, released: false };
    const count = (await this.storage.get("count")) ?? 1;
    await this.storage.delete(`room:${id}`);
    await this.storage.put("count", Math.max(0, count - 1));
    return { ok: true, released: true };
  }
}

// One room's capability authority. storage: DO storage (get/put/delete/deleteAll/setAlarm).
// release(id): frees the registry slot when the room is deleted.
export class RoomCore {
  constructor(storage, { now = () => Date.now(), rand = defaultRand, release = async () => {} } = {}) {
    Object.assign(this, { storage, now, rand, release });
  }

  // Called once, right after the registry admitted the room. → { watchmanToken, builderToken }
  async init(id, seed) {
    if (await this.storage.get("meta")) return fail("room_exists");
    const now = this.now();
    await this.storage.put({ state: newRoom({ id, seed, now }), meta: { id, createdAt: now, lastActive: now, joined: false, salt: mintToken(this.rand) } });
    const watchmanToken = await this.issue("watchman");
    const builderToken = await this.issue("builder");
    await this.storage.setAlarm(now + CAPS.UNJOINED_MS);
    return { ok: true, watchmanToken, builderToken };
  }

  // One holder per seat (v1): issuing revokes the seat's previous token.
  async issue(seat) {
    const old = await this.storage.get(`seat:${seat}`);
    if (old) await this.storage.delete([`cap:${old}`, `rl:${old}`]);
    const token = mintToken(this.rand);
    const h = await sha256hex(token);
    await this.storage.put({ [`cap:${h}`]: { seat, at: this.now() }, [`seat:${seat}`]: h });
    return token;
  }

  // → { ok, seat, hash } | capability_required. Unknown, revoked, foreign-room or deleted-room tokens all fail.
  async verify(token) {
    if (!looksLikeToken(token)) return fail("capability_required");
    if (!(await this.storage.get("meta"))) return fail("capability_required");
    const h = await sha256hex(token);
    const rec = await this.storage.get(`cap:${h}`);
    if (!rec) return fail("capability_required");
    return { ok: true, seat: rec.seat, hash: h };
  }

  // Per-IP failure gate for this room (bad tokens, bad claim codes). Only failures count, so a caller
  // spraying bad codes cannot lock out a legitimate holder on another address. Never writes to a room
  // that does not exist. kind: "bad" (execute) | "claim".
  async failGate(kind, ip, max, windowMs) {
    const meta = await this.storage.get("meta");
    if (!meta) return { ok: true, record: async () => {} };
    const now = this.now();
    const k = await ipKey(meta.salt ?? meta.id, ip);
    const map = pruneHits(await this.storage.get(`fails:${kind}`), now, windowMs);
    const live = map[k] ?? [];
    if (live.length >= max) return fail("rate_limited", { retryAfter: Math.max(1, Math.ceil((live[0] + windowMs - now) / 1000)) });
    return {
      ok: true,
      record: async () => {
        map[k] = [...live, now];
        await this.storage.put(`fails:${kind}`, map);
      },
    };
  }

  // Every seat-token call goes through here. req: { op, seat?, action?, expectedRev?, requestId? }
  async call(token, req = {}, ip) {
    const gate = await this.failGate("bad", ip, CAPS.BAD_TOKEN_PER_IP, CAPS.BAD_TOKEN_WINDOW_MS);
    if (!gate.ok) return gate;
    const v = await this.verify(token);
    if (!v.ok) {
      await gate.record();
      return v;
    }
    const rl = minuteWindow(await this.storage.get(`rl:${v.hash}`), this.now(), CAPS.EXEC_PER_MIN);
    await this.storage.put(`rl:${v.hash}`, rl.counter);
    if (!rl.ok) return fail("rate_limited", { retryAfter: rl.retryAfter });
    const seat = req.seat ?? v.seat;
    const grant = { roles: [v.seat], mode: "capability" };
    const meta = await this.storage.get("meta");
    meta.lastActive = this.now();
    const { op } = req;
    if (op === "invite" || op === "rotate") {
      if (v.seat !== "watchman") return fail("seat_not_granted");
      const target = req.seat ?? "builder";
      if (!["builder", "watchman"].includes(target)) return fail("unknown_seat");
      await this.storage.put("meta", meta);
      if (op === "rotate") return { ok: true, seat: target, token: await this.issue(target) };
      const code = mintToken(this.rand);
      await this.storage.put(`inv:${await sha256hex(code)}`, { seat: target, exp: this.now() + CAPS.CLAIM_TTL_MS });
      return { ok: true, seat: target, code, expiresInSec: CAPS.CLAIM_TTL_MS / 1000 };
    }
    const state = await this.storage.get("state");
    if (op === "look") {
      await this.storage.put("meta", meta);
      return view(state, seat, grant);
    }
    if (op === "join" || op === "act") {
      const action = op === "join" ? { seat, type: "join", requestId: req.requestId } : { seat, type: req.action, expectedRev: req.expectedRev, requestId: req.requestId };
      const res = act(state, action, grant, this.now());
      if (!res.ok) return { ok: false, error: res.error, rev: state.rev };
      const size = checkStateSize(res.state);
      if (!size.ok) return { ok: false, error: size.error, rev: state.rev };
      if (op === "join") meta.joined = true;
      await this.storage.put({ state: res.state, meta });
      return { ok: true, view: view(res.state, seat, grant) };
    }
    return fail("unsupported_op");
  }

  // Single-use code → fresh seat token for the claiming agent. 10 failed tries per IP per room per 10 min
  // (failures only, per address: a spammer cannot burn a legitimate claimer's attempts).
  async claim(code, ip) {
    if (!(await this.storage.get("meta"))) return fail("capability_required");
    const now = this.now();
    const gate = await this.failGate("claim", ip, CAPS.CLAIM_TRIES, CAPS.CLAIM_WINDOW_MS);
    if (!gate.ok) return gate;
    const bad = async () => (await gate.record(), fail("capability_required"));
    if (!looksLikeToken(code)) return bad();
    const key = `inv:${await sha256hex(code)}`;
    const inv = await this.storage.get(key);
    if (!inv) return bad();
    await this.storage.delete(key); // single use, even if expired
    if (inv.exp <= now) return bad();
    return { ok: true, seat: inv.seat, token: await this.issue(inv.seat) };
  }

  // DO alarm: delete never-joined rooms after 24 h and idle rooms after 7 days; frees the registry slot.
  async alarm() {
    const meta = await this.storage.get("meta");
    if (!meta) return { deleted: false };
    const now = this.now();
    const expired = (!meta.joined && now - meta.createdAt >= CAPS.UNJOINED_MS) || now - meta.lastActive >= CAPS.ROOM_IDLE_MS;
    if (expired) {
      // Release the registry slot FIRST. If release throws, nothing is deleted and the DO alarm retries;
      // release is idempotent, so a retry after a successful release just deletes the room.
      await this.release(meta.id);
      await this.storage.deleteAll();
      return { deleted: true };
    }
    const next = meta.joined ? meta.lastActive + CAPS.ROOM_IDLE_MS : Math.min(meta.createdAt + CAPS.UNJOINED_MS, meta.lastActive + CAPS.ROOM_IDLE_MS);
    await this.storage.setAlarm(Math.max(next, now + 1000));
    return { deleted: false, next };
  }
}
