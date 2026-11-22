// D10 agent-first acceptance (cookbook PRD ca36fb87 §8), end to end through route() with in-memory DOs.
import test from "node:test";
import assert from "node:assert/strict";
import { route } from "../src/router.js";
import { RoomCore, RegistryCore, CAPS, slidingWindow, minuteWindow, sha256hex, ipBucket, ipKey } from "../src/core/caps.js";

class MemStorage {
  constructor() { this.m = new Map(); this.alarmAt = null; }
  async get(k) { return structuredClone(this.m.get(k)); }
  async put(k, v) { if (typeof k === "object") for (const [a, b] of Object.entries(k)) this.m.set(a, structuredClone(b)); else this.m.set(k, structuredClone(v)); }
  async delete(k) { for (const x of [].concat(k)) this.m.delete(x); }
  async deleteAll() { this.m.clear(); }
  async list({ prefix = "", limit = Infinity } = {}) {
    return new Map([...this.m].filter(([k]) => k.startsWith(prefix)).slice(0, limit).map(([k, v]) => [k, structuredClone(v)]));
  }
  async setAlarm(t) { this.alarmAt = t; }
}

function world({ max = 200 } = {}) {
  const clock = { t: 1_800_000_000_000 };
  const now = () => clock.t;
  const regStore = new MemStorage();
  const registry = new RegistryCore(regStore, { max, now });
  const regStub = { capCreate: (ip) => registry.create(ip), release: (id) => registry.release(id) };
  const rooms = new Map();
  const roomStub = (id) => {
    if (!rooms.has(id)) rooms.set(id, new RoomCore(new MemStorage(), { now, release: (rid) => registry.release(rid) }));
    const core = rooms.get(id);
    return { capInit: (rid) => core.init(rid, 1), capCall: (t, r, ip) => core.call(t, r, ip), capClaim: (c, ip) => core.claim(c, ip), core };
  };
  const env = {
    ENVIRONMENT: "dev", VERSION: "test", AUTH_MODE: "capability",
    MCP_KEY: "w".repeat(32), BUILDER_KEY: "b".repeat(32), // set but must be ignored in capability mode
    ASSETS: { fetch: async () => new Response("asset") },
    ROOM: { idFromName: (n) => n, get: (n) => roomStub(n) },
    REGISTRY: { idFromName: (n) => n, get: () => regStub },
  };
  return { env, clock, rooms, regStore };
}
const exec = async (env, body, { bearer, ip = "203.0.113.7" } = {}) => {
  const r = await route(new Request("https://nw.test/v1/execute", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": ip, ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
    body: JSON.stringify(body),
  }), env);
  return { status: r.status, headers: r.headers, body: await r.json() };
};
const capOf = (link) => new URL(link).hash.slice("#cap=".length);
async function create(env, opts) {
  const r = await exec(env, { op: "create" }, opts);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return { ...r.body, builderToken: capOf(r.body.builderLink) };
}

test("1. create with no key → room + watchmanToken + builderLink; Watchman look has no grid", async () => {
  const { env } = world();
  const c = await create(env);
  assert.match(c.room, /^[A-Za-z0-9_-]{22}$/);
  assert.match(c.watchmanToken, /^[A-Za-z0-9_-]{43}$/);
  assert.match(c.builderLink, new RegExp(`^https://nw\\.test/r/${c.room}#cap=[A-Za-z0-9_-]{43}$`));
  const look = await exec(env, { room: c.room, op: "look" }, { bearer: c.watchmanToken });
  assert.equal(look.status, 200);
  assert.equal(look.body.seat, "watchman");
  assert.equal("grid" in look.body, false);
  const blook = await exec(env, { room: c.room, seat: "builder", op: "look" }, { bearer: c.builderToken });
  assert.ok(Array.isArray(blook.body.grid));
});

test("tokens are stored only as SHA-256 hashes", async () => {
  const { env, rooms } = world();
  const c = await create(env);
  const dump = JSON.stringify([...rooms.get(c.room).storage.m]);
  assert.equal(dump.includes(c.watchmanToken), false);
  assert.equal(dump.includes(c.builderToken), false);
  assert.ok(dump.includes(await sha256hex(c.watchmanToken)));
});

test("3. Builder token on Watchman ops → seat_not_granted; Watchman token on Builder grid → refused", async () => {
  const { env } = world();
  const c = await create(env);
  for (const body of [{ seat: "watchman", op: "look" }, { op: "invite", seat: "builder" }, { op: "rotate", seat: "builder" }]) {
    const r = await exec(env, { room: c.room, ...body }, { bearer: c.builderToken });
    assert.equal(r.body.error, "seat_not_granted", JSON.stringify(body));
  }
  const r = await exec(env, { room: c.room, seat: "builder", op: "look" }, { bearer: c.watchmanToken });
  assert.equal(r.body.error, "seat_not_granted");
  assert.equal("grid" in r.body, false);
  const a = await exec(env, { room: c.room, seat: "builder", op: "act", action: "drop", expectedRev: 0 }, { bearer: c.watchmanToken });
  assert.equal(a.body.error, "seat_not_granted");
});

test("4. no / unknown / rotated / foreign-room token → 401 capability_required (MCP_KEY ignored)", async () => {
  const { env } = world();
  const c = await create(env);
  const d = await create(env, { ip: "203.0.113.8" });
  assert.equal((await exec(env, { room: c.room, op: "look" })).status, 401);
  assert.equal((await exec(env, { room: c.room, op: "look" }, { bearer: "x".repeat(43) })).status, 401);
  assert.equal((await exec(env, { room: c.room, op: "look" }, { bearer: env.MCP_KEY })).status, 401);
  assert.equal((await exec(env, { room: c.room, op: "look" }, { bearer: d.watchmanToken })).status, 401);
  const rot = await exec(env, { room: c.room, op: "rotate", seat: "builder" }, { bearer: c.watchmanToken });
  assert.equal(rot.status, 200);
  const old = await exec(env, { room: c.room, seat: "builder", op: "look" }, { bearer: c.builderToken });
  assert.equal(old.status, 401);
  assert.equal(old.body.error, "capability_required");
  const fresh = await exec(env, { room: c.room, seat: "builder", op: "look" }, { bearer: capOf(rot.body.builderLink) });
  assert.equal(fresh.status, 200);
});

test("cap argument works like the header (MCP clients cannot set per-room headers)", async () => {
  const { env } = world();
  const c = await create(env);
  const r = await exec(env, { room: c.room, op: "join", cap: c.watchmanToken });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
});

test("5. 6th create in 10 min from one IP → 429 with retry-after; 201st room → room_cap_reached", async () => {
  const { env, clock } = world();
  for (let i = 0; i < 5; i++) await create(env);
  const r = await exec(env, { op: "create" });
  assert.equal(r.status, 429);
  assert.equal(r.body.error, "rate_limited");
  assert.ok(Number(r.headers.get("retry-after")) > 0);
  clock.t += CAPS.CREATE_IP_WINDOW_MS;
  await create(env);

  const w = world({ max: 3 });
  for (let i = 0; i < 3; i++) await create(w.env, { ip: `198.51.100.${i}` });
  const full = await exec(w.env, { op: "create" }, { ip: "198.51.100.99" });
  assert.equal(full.body.error, "room_cap_reached");
});

test("create: 50/hour per environment", async () => {
  const { env } = world();
  for (let i = 0; i < 50; i++) await create(env, { ip: `10.0.${i}.1` });
  const r = await exec(env, { op: "create" }, { ip: "10.9.9.9" });
  assert.equal(r.status, 429);
});

test("5b. a 65 KiB body → 413 before any room work", async () => {
  const { env } = world();
  const r = await exec(env, { op: "create", pad: "x".repeat(65 * 1024) });
  assert.equal(r.status, 413);
});

test("6. invite → claim gives a second agent its own token; a reused or expired code fails", async () => {
  const { env, clock } = world();
  const c = await create(env);
  const inv = await exec(env, { room: c.room, op: "invite", seat: "watchman" }, { bearer: c.watchmanToken });
  assert.equal(inv.status, 200);
  assert.equal(inv.body.expiresInSec, 900);
  const cl = await exec(env, { room: c.room, op: "claim", code: inv.body.code });
  assert.equal(cl.status, 200);
  assert.match(cl.body.watchmanToken, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(cl.body.watchmanToken, c.watchmanToken);
  assert.equal((await exec(env, { room: c.room, op: "look" }, { bearer: cl.body.watchmanToken })).status, 200);
  assert.equal((await exec(env, { room: c.room, op: "look" }, { bearer: c.watchmanToken })).status, 401, "one holder per seat");
  assert.equal((await exec(env, { room: c.room, op: "claim", code: inv.body.code })).status, 401, "single use");
  const inv2 = await exec(env, { room: c.room, op: "invite", seat: "builder" }, { bearer: cl.body.watchmanToken });
  clock.t += CAPS.CLAIM_TTL_MS + 1;
  assert.equal((await exec(env, { room: c.room, op: "claim", code: inv2.body.code })).status, 401, "expired");
});

test("claim: 10 failed tries per IP per room per 10 min", async () => {
  const { env } = world();
  const c = await create(env);
  for (let i = 0; i < 10; i++) assert.equal((await exec(env, { room: c.room, op: "claim", code: "z".repeat(43) })).status, 401);
  assert.equal((await exec(env, { room: c.room, op: "claim", code: "z".repeat(43) })).status, 429);
});

test("execute: 120/min per token", async () => {
  const { env, clock } = world();
  const c = await create(env);
  for (let i = 0; i < 120; i++) assert.equal((await exec(env, { room: c.room, op: "look" }, { bearer: c.watchmanToken })).status, 200);
  assert.equal((await exec(env, { room: c.room, op: "look" }, { bearer: c.watchmanToken })).status, 429);
  clock.t += 60_000;
  assert.equal((await exec(env, { room: c.room, op: "look" }, { bearer: c.watchmanToken })).status, 200);
});

test("TTL: never-joined room deleted after 24 h; idle room after 7 days; registry slot freed", async () => {
  const { env, clock, rooms, regStore } = world();
  const a = await create(env);
  const b = await create(env);
  await exec(env, { room: b.room, op: "join" }, { bearer: b.watchmanToken });
  assert.equal(await regStore.get("count"), 2);
  clock.t += CAPS.UNJOINED_MS;
  assert.equal((await rooms.get(a.room).alarm()).deleted, true);
  assert.equal((await rooms.get(b.room).alarm()).deleted, false);
  assert.equal(await regStore.get("count"), 1);
  assert.equal((await exec(env, { room: a.room, op: "look" }, { bearer: a.watchmanToken })).status, 401);
  clock.t += CAPS.ROOM_IDLE_MS;
  assert.equal((await rooms.get(b.room).alarm()).deleted, true);
  assert.equal(await regStore.get("count"), 0);
});

test("7. no MCP_KEY/BUILDER_KEY anywhere in the user flow: /mcp lists 3 tools with no key; docs/telemetry open", async () => {
  const { env } = world();
  delete env.MCP_KEY; delete env.BUILDER_KEY;
  const req = new Request("https://nw.test/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
  const r = await route(req, env);
  assert.equal(r.status, 200);
  const out = await r.json();
  assert.deepEqual(out.result.tools.map((t) => t.name).sort(), ["docs", "execute", "telemetry"]);
  const call = await route(new Request("https://nw.test/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "cf-connecting-ip": "192.0.2.1" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "execute", arguments: { op: "create" } } }),
  }), env);
  const made = JSON.parse((await call.json()).result.content[0].text);
  assert.match(made.builderLink, /#cap=/);
  for (const p of ["/v1/docs", "/v1/telemetry"]) {
    const d = await route(new Request(`https://nw.test${p}`, { method: "POST", body: "{}" }), env);
    assert.equal(d.status, 200, p);
  }
});

test("rate-limit helpers", () => {
  assert.equal(slidingWindow([0, 1, 2], 3, 10, 3).ok, false);
  assert.equal(slidingWindow([0, 1, 2], 20, 10, 3).ok, true);
  assert.equal(minuteWindow({ win: 0, n: 5 }, 59_000, 5).ok, false);
  assert.equal(minuteWindow({ win: 0, n: 5 }, 60_000, 5).ok, true);
});

// ── Follow-up hardening (Terry P2/P3 on #7) ──────────────────────────────────────────────────────────
import { readFileSync } from "node:fs";

const mcpCall = (env, args, ip = "192.0.2.50") =>
  route(new Request("https://nw.test/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "cf-connecting-ip": ip },
    body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "execute", arguments: args } }),
  }), env).then((r) => r.json());

test("P2: capability mode is code-gated to dev/local; a staging/production var flip is refused (401, no room created)", async () => {
  for (const ENVIRONMENT of ["staging", "production", undefined]) {
    const { env, regStore } = world();
    env.ENVIRONMENT = ENVIRONMENT;
    for (const body of [{ op: "create" }, {}]) {
      const r = await exec(env, body);
      assert.equal(r.status, 401, `${ENVIRONMENT} ${JSON.stringify(body)}`);
    }
    const docs = await route(new Request("https://nw.test/v1/docs", { method: "POST", body: "{}" }), env);
    assert.equal(docs.status, 401);
    assert.equal(await regStore.get("count"), undefined, "no room was created");
  }
});

test("P3: claim spam from one IP cannot lock out a legitimate claimer on another IP", async () => {
  const { env } = world();
  const c = await create(env);
  const inv = await exec(env, { room: c.room, op: "invite", seat: "watchman" }, { bearer: c.watchmanToken });
  for (let i = 0; i < 10; i++) await exec(env, { room: c.room, op: "claim", code: "z".repeat(43) }, { ip: "203.0.113.66" });
  assert.equal((await exec(env, { room: c.room, op: "claim", code: "z".repeat(43) }, { ip: "203.0.113.66" })).status, 429);
  const ok = await exec(env, { room: c.room, op: "claim", code: inv.body.code }, { ip: "198.51.100.5" });
  assert.equal(ok.status, 200);
  assert.match(ok.body.watchmanToken, /^[A-Za-z0-9_-]{43}$/);
});

test("P3: invalid-token execute is throttled per IP per room (30 / 10 min); other callers unaffected", async () => {
  const { env, clock } = world();
  const c = await create(env);
  for (let i = 0; i < 30; i++) assert.equal((await exec(env, { room: c.room, op: "look" }, { bearer: "y".repeat(43), ip: "203.0.113.77" })).status, 401);
  const r = await exec(env, { room: c.room, op: "look" }, { bearer: "y".repeat(43), ip: "203.0.113.77" });
  assert.equal(r.status, 429);
  assert.ok(Number(r.headers.get("retry-after")) > 0);
  assert.equal((await exec(env, { room: c.room, op: "look" }, { bearer: c.watchmanToken, ip: "198.51.100.9" })).status, 200);
  clock.t += 10 * 60 * 1000;
  assert.equal((await exec(env, { room: c.room, op: "look" }, { bearer: "y".repeat(43), ip: "203.0.113.77" })).status, 401);
});

test("P3: bad tokens against a room that does not exist write nothing", async () => {
  const { env, rooms } = world();
  const ghost = "ghost_room_abcdefghij";
  await exec(env, { room: ghost, op: "look" }, { bearer: "y".repeat(43) });
  assert.equal(rooms.get(ghost).storage.m.size, 0);
});

test("P3: IP keys are salted, truncated, held in one map and pruned (no raw or unsalted IP, no unbounded keys)", async () => {
  const { env, clock, regStore } = world();
  await create(env, { ip: "203.0.113.7" });
  const keys = [...regStore.m.keys()];
  assert.equal(keys.some((k) => k.startsWith("ip:")), false);
  const dump = JSON.stringify([...regStore.m]);
  assert.equal(dump.includes("203.0.113.7"), false);
  assert.equal(dump.includes(await sha256hex("ip:203.0.113.7")), false);
  assert.equal(dump.includes(await sha256hex("203.0.113.7")), false);
  assert.equal(Object.keys(await regStore.get("ips")).length, 1);
  clock.t += CAPS.CREATE_IP_WINDOW_MS;
  await create(env, { ip: "203.0.113.8" });
  assert.equal(Object.keys(await regStore.get("ips")).length, 1, "the stale key was pruned");
});

test("P3: alarm releases the registry slot before deleting; a failed release deletes nothing and re-arms the alarm", async () => {
  const { env, clock, rooms, regStore } = world();
  const a = await create(env);
  const core = rooms.get(a.room);
  const realRelease = core.release;
  core.release = async () => { throw new Error("registry unavailable"); };
  clock.t += CAPS.UNJOINED_MS;
  const r = await core.alarm();
  assert.equal(r.deleted, false);
  assert.equal(core.storage.alarmAt, clock.t + CAPS.ALARM_RETRY_MS, "we re-arm; Cloudflare's own retries are bounded");
  assert.ok(await core.storage.get("meta"), "room kept when release fails");
  assert.equal(await regStore.get("count"), 1);
  core.release = realRelease;
  assert.equal((await core.alarm()).deleted, true);
  assert.equal(await regStore.get("count"), 0);
  assert.equal(core.storage.m.size, 0);
});

test("P3: MCP tool errors carry isError; successes do not", async () => {
  const { env } = world();
  const bad = await mcpCall(env, { room: "room_abcdefghijklmnop", op: "look" });
  assert.equal(bad.result.isError, true);
  assert.equal(JSON.parse(bad.result.content[0].text).error, "capability_required");
  const good = await mcpCall(env, { op: "create" });
  assert.notEqual(good.result.isError, true);
});

test("P2 carried (HYGIENE 19): one version — /health, telemetry and MCP serverInfo all read package.json; wrangler has no VERSION var", async () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const { env } = world();
  env.VERSION = "stale-var-must-be-ignored";
  const h = await (await route(new Request("https://nw.test/health"), env)).json();
  assert.equal(h.version, pkg.version);
  const t = await (await route(new Request("https://nw.test/v1/telemetry", { method: "POST", body: "{}" }), env)).json();
  assert.equal(t.version, pkg.version);
  const init = await (await route(new Request("https://nw.test/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } } }),
  }), env)).json();
  assert.equal(init.result.serverInfo.version, pkg.version);
  assert.equal(/VERSION/.test(readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8")), false);
});

test("IPv6 callers are rate-limited per /64 (rotating addresses in one /64 share the create limit)", async () => {
  assert.equal(ipBucket("2a09:bac5:c828:32a0::50b:45"), "2a09:bac5:c828:32a0::/64");
  assert.equal(ipBucket("2a09:bac5:c828:32a0:1:2:3:4"), "2a09:bac5:c828:32a0::/64");
  assert.equal(ipBucket("2a09::1"), "2a09:0:0:0::/64");
  assert.equal(ipBucket("203.0.113.7"), "203.0.113.7");
  const { env } = world();
  for (let i = 0; i < 5; i++) await create(env, { ip: `2a09:bac5:c828:32a0::${i + 1}` });
  assert.equal((await exec(env, { op: "create" }, { ip: "2a09:bac5:c828:32a0::99" })).status, 429);
  assert.equal((await exec(env, { op: "create" }, { ip: "2a09:bac5:c828:32a1::1" })).status, 200);
});

// ── #8 accepted P3 follow-ups (Terry 6009985315 nits 1–2, 6009993447 findings 1–4)

test("P3 #8-1: failure records re-read the map, so parallel failures are not lost", async () => {
  const { env, rooms } = world();
  const c = await create(env);
  const core = rooms.get(c.room);
  // Two gates opened before either records (the window verify() leaves between gate and record).
  const g1 = await core.failGate("bad", "203.0.113.1", CAPS.BAD_TOKEN_PER_IP, CAPS.BAD_TOKEN_WINDOW_MS);
  const g2 = await core.failGate("bad", "203.0.113.1", CAPS.BAD_TOKEN_PER_IP, CAPS.BAD_TOKEN_WINDOW_MS);
  const g3 = await core.failGate("bad", "198.51.100.1", CAPS.BAD_TOKEN_PER_IP, CAPS.BAD_TOKEN_WINDOW_MS);
  // In a DO each record()'s get→put runs under the input gate, so records serialize; the bug was the stale
  // snapshot from gate time. With it, g2 would overwrite g1 and the count would be [1, 1].
  for (const g of [g1, g2, g3]) await g.record();
  const map = await core.storage.get("fails:bad");
  const counts = Object.values(map).map((h) => h.length).sort();
  assert.deepEqual(counts, [1, 2], "both failures from one IP and the one from another IP are all kept");
});

test("P3 #8-2: leftover unsalted ip: keys from #7 are swept from the registry, once", async () => {
  const { env, regStore } = world();
  for (let i = 0; i < 3; i++) await regStore.put(`ip:${await sha256hex(`203.0.113.${i}`)}`, [1]);
  await create(env, { ip: "198.51.100.20" });
  assert.equal([...regStore.m.keys()].some((k) => k.startsWith("ip:")), false);
  assert.equal(await regStore.get("legacyIpSwept"), true);
  assert.equal(await regStore.get("count"), 1, "sweep never touches room slots");
});

test("P3 #8-2: the sweep is batched and finishes over later creates", async () => {
  const { regStore } = world();
  const reg = new RegistryCore(regStore, { max: 200 });
  for (let i = 0; i < 5; i++) await regStore.put(`ip:${i}`, [1]);
  assert.equal(await reg.sweepLegacyIpKeys(2), 2);
  assert.equal(await regStore.get("legacyIpSwept"), undefined, "not done yet");
  assert.equal(await reg.sweepLegacyIpKeys(2), 2);
  assert.equal(await reg.sweepLegacyIpKeys(2), 1);
  assert.equal(await regStore.get("legacyIpSwept"), true);
  assert.equal(await reg.sweepLegacyIpKeys(2), 0);
});

test("P3 #8-3: a release that keeps failing never strands the room; it is deleted once release succeeds", async () => {
  const { env, clock, rooms, regStore } = world();
  const a = await create(env);
  const core = rooms.get(a.room);
  const realRelease = core.release;
  core.release = async () => { throw new Error("registry unavailable"); };
  clock.t += CAPS.UNJOINED_MS;
  for (let i = 0; i < 10; i++) {
    assert.equal((await core.alarm()).deleted, false);
    assert.equal(core.storage.alarmAt, clock.t + CAPS.ALARM_RETRY_MS, `alarm re-armed after failure ${i + 1}`);
    clock.t = core.storage.alarmAt;
  }
  core.release = realRelease;
  assert.equal((await core.alarm()).deleted, true);
  assert.equal(await regStore.get("count"), 0, "slot freed");
});

test("P3 #8-4: IPv4-mapped IPv6 unwraps to its IPv4 address; ::1 and :: still bucket as IPv6", async () => {
  assert.equal(ipBucket("::ffff:203.0.113.7"), "203.0.113.7");
  assert.equal(ipBucket("::FFFF:203.0.113.7"), "203.0.113.7");
  assert.equal(ipBucket("0:0:0:0:0:ffff:198.51.100.1"), "198.51.100.1");
  assert.equal(ipBucket("::ffff:c000:201"), "192.0.2.1");
  assert.equal(ipBucket("::1"), "0:0:0:0::/64");
  assert.equal(ipBucket("::"), "0:0:0:0::/64");
  assert.equal(ipBucket("fe80::ffff:1.2.3.4"), "fe80:0:0:0::/64", "only the ::ffff:0:0/96 prefix is unwrapped");
  const { env } = world();
  for (let i = 0; i < 5; i++) await create(env, { ip: `::ffff:203.0.113.${i + 1}` });
  assert.equal((await exec(env, { op: "create" }, { ip: "::ffff:198.51.100.1" })).status, 200, "different mapped IPv4 callers no longer share one bucket");
  assert.equal((await exec(env, { op: "create" }, { ip: "203.0.113.1" })).status, 200);
  for (let i = 0; i < 3; i++) await create(env, { ip: "203.0.113.1" });
  assert.equal((await exec(env, { op: "create" }, { ip: "::ffff:203.0.113.1" })).status, 429, "mapped and plain forms are one caller");
});

test("P3 #8-5: a room created before #8 (no meta.salt) gets its own salt; the public room id is never the salt", async () => {
  const { env, rooms } = world();
  const c = await create(env);
  const core = rooms.get(c.room);
  const meta = await core.storage.get("meta");
  delete meta.salt;
  await core.storage.put("meta", meta);
  await exec(env, { room: c.room, op: "look" }, { bearer: "y".repeat(43), ip: "203.0.113.9" });
  const after = await core.storage.get("meta");
  assert.match(after.salt, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(after.salt, c.room);
  const keys = Object.keys(await core.storage.get("fails:bad"));
  assert.deepEqual(keys, [await ipKey(after.salt, "203.0.113.9")]);
  assert.equal(keys.includes(await ipKey(c.room, "203.0.113.9")), false);
  assert.equal((await exec(env, { room: c.room, op: "look" }, { bearer: c.watchmanToken })).status, 200, "holders unaffected");
});

// ── M2 first play: one Fish Gate encounter end to end (Watchman over MCP, Builder over its link's token) ──
test("first play: Watchman creates + joins over MCP, Builder joins by link; stones fall, Builder plays, Watchman acts without the grid", async () => {
  const { env, clock } = world();
  const made = JSON.parse((await mcpCall(env, { op: "create" })).result.content[0].text);
  const w = made.watchmanToken;
  const b = capOf(made.builderLink);
  const room = made.room;
  const wj = JSON.parse((await mcpCall(env, { room, cap: w, op: "join" })).result.content[0].text);
  assert.equal(wj.view.encounter.status, "waiting");
  const bj = await exec(env, { room, seat: "builder", op: "join", requestId: "bj" }, { bearer: b });
  assert.equal(bj.body.view.encounter.status, "building");
  const y0 = bj.body.view.falling.cells[0][1];
  clock.t += 2000;
  const look = await exec(env, { room, seat: "builder", op: "look" }, { bearer: b });
  assert.ok(look.body.falling.cells[0][1] > y0, "the stone fell while nobody acted");
  const moved = await exec(env, { room, seat: "builder", op: "act", action: "move", arg: -1, requestId: "m1" }, { bearer: b });
  assert.equal(moved.body.ok, true, JSON.stringify(moved.body));
  const dropped = await exec(env, { room, seat: "builder", op: "act", action: "drop", arg: "hard", requestId: "d1" }, { bearer: b });
  assert.ok(dropped.body.view.grid.flat().some((v) => v === 1), "a stone is set in the wall");
  // Watchman: look (no grid), then trumpet the named raid over MCP; Builder motion in between does not make it stale.
  const wl = JSON.parse((await mcpCall(env, { room, cap: w, op: "look" })).result.content[0].text);
  assert.equal("grid" in wl, false);
  assert.equal("falling" in wl, false);
  await exec(env, { room, seat: "builder", op: "act", action: "move", arg: 1, requestId: "m2" }, { bearer: b });
  const tr = await mcpCall(env, { room, cap: w, op: "act", action: "trumpet", arg: wl.threats[0].id, expectedRev: wl.rev, requestId: "t1" });
  assert.equal(tr.result.isError, undefined, tr.result.content[0].text);
  const tv = JSON.parse(tr.result.content[0].text).view;
  assert.equal(tv.threats[0].trumpet, true);
  assert.equal("grid" in tv, false);
  // Capability checks stay: cross-seat and ungranted acts fail.
  const cross = await exec(env, { room, seat: "builder", op: "act", action: "drop", requestId: "x1" }, { bearer: w });
  assert.equal(cross.body.error, "seat_not_granted");
  const cross2 = await exec(env, { room, op: "act", action: "trumpet", arg: wl.threats[0].id, requestId: "x2" }, { bearer: b });
  assert.equal(cross2.body.error, "cross_role_action");
  const none = await exec(env, { room, seat: "builder", op: "act", action: "move", arg: 1 });
  assert.equal(none.status, 401);
});
