// D10 agent-first acceptance (cookbook PRD ca36fb87 §8), end to end through route() with in-memory DOs.
import test from "node:test";
import assert from "node:assert/strict";
import { route } from "../src/router.js";
import { RoomCore, RegistryCore, CAPS, slidingWindow, minuteWindow, sha256hex } from "../src/core/caps.js";

class MemStorage {
  constructor() { this.m = new Map(); this.alarmAt = null; }
  async get(k) { return structuredClone(this.m.get(k)); }
  async put(k, v) { if (typeof k === "object") for (const [a, b] of Object.entries(k)) this.m.set(a, structuredClone(b)); else this.m.set(k, structuredClone(v)); }
  async delete(k) { for (const x of [].concat(k)) this.m.delete(x); }
  async deleteAll() { this.m.clear(); }
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
    return { capInit: (rid) => core.init(rid, 1), capCall: (t, r) => core.call(t, r), capClaim: (c) => core.claim(c), core };
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

test("claim: 10 tries per room per 10 min", async () => {
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
