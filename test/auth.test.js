import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { route } from "../src/router.js";

const W = "w".repeat(32); // test-only placeholder keys, not real secrets
const B = "b".repeat(32);
const ROOM = "room_abcdefghijklmnop";

function fakeEnv(extra = {}) {
  const calls = [];
  const stubRoom = {
    async look(id, seat, grant) { calls.push(["look", id, seat, grant]); return { seat }; },
    async act(id, action, grant) { calls.push(["act", id, action, grant]); return { ok: true }; },
  };
  return {
    calls,
    ENVIRONMENT: "dev",
    VERSION: "test",
    ASSETS: { fetch: async () => new Response("asset") },
    ROOM: { idFromName: (n) => n, get: () => stubRoom },
    ...extra,
  };
}
const post = (path, body = {}, key) =>
  new Request(`https://x.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify(body),
  });

test("/health stays public", async () => {
  const r = await route(new Request("https://x.test/health"), fakeEnv({ MCP_KEY: W }));
  assert.equal(r.status, 200);
});

test("/v1/execute requires the key when auth is enabled (missing and wrong key → 401)", async () => {
  const env = fakeEnv({ MCP_KEY: W });
  assert.equal((await route(post("/v1/execute", { room: ROOM, seat: "watchman", op: "look" }), env)).status, 401);
  assert.equal((await route(post("/v1/execute", { room: ROOM, seat: "watchman", op: "look" }, "nope"), env)).status, 401);
  assert.equal(env.calls.length, 0, "no room call may happen without a key");
});

test("docs, telemetry and /mcp 401 on missing or wrong key", async () => {
  const env = fakeEnv({ MCP_KEY: W });
  for (const p of ["/v1/docs", "/v1/telemetry", "/mcp"]) {
    assert.equal((await route(post(p), env)).status, 401, `${p} missing`);
    assert.equal((await route(post(p, {}, W.slice(1) + "x"), env)).status, 401, `${p} wrong`);
  }
});

test("no key configured fails closed (does not fail open)", async () => {
  const env = fakeEnv(); // no MCP_KEY, no BUILDER_KEY, no AUTH_MODE
  for (const p of ["/v1/docs", "/v1/execute", "/v1/telemetry", "/mcp"]) {
    assert.equal((await route(post(p, { room: ROOM }), env)).status, 401, p);
  }
});

test("open mode only in explicit local mode; refused for dev/staging/production", async () => {
  for (const ENVIRONMENT of ["dev", "staging", "production", undefined]) {
    const r = await route(post("/v1/docs"), fakeEnv({ AUTH_MODE: "open", ENVIRONMENT }));
    assert.equal(r.status, 401, String(ENVIRONMENT));
  }
  const ok = await route(post("/v1/docs"), fakeEnv({ AUTH_MODE: "open", ENVIRONMENT: "local" }));
  assert.equal(ok.status, 200);
});

test("correct key is accepted", async () => {
  const env = fakeEnv({ MCP_KEY: W });
  assert.equal((await route(post("/v1/docs", {}, W), env)).status, 200);
  assert.equal((await route(post("/v1/execute", { room: ROOM, seat: "watchman", op: "look" }, W), env)).status, 200);
});

test("Watchman key cannot take the Builder seat (look or act); Builder key cannot take the Watchman seat", async () => {
  const env = fakeEnv({ MCP_KEY: W, BUILDER_KEY: B });
  const asBuilder = await (await route(post("/v1/execute", { room: ROOM, seat: "builder", op: "look" }, W), env)).json();
  assert.equal(asBuilder.error, "seat_not_granted");
  const actBuilder = await (await route(post("/v1/execute", { room: ROOM, seat: "builder", op: "act", action: "noop" }, W), env)).json();
  assert.equal(actBuilder.error, "seat_not_granted");
  const asWatch = await (await route(post("/v1/execute", { room: ROOM, seat: "watchman", op: "join" }, B), env)).json();
  assert.equal(asWatch.error, "seat_not_granted");
  assert.equal(env.calls.length, 0);
});

test("oversized request body is rejected with 413", async () => {
  const env = fakeEnv({ MCP_KEY: W });
  const r = await route(post("/v1/execute", { room: ROOM, pad: "x".repeat(20000) }, W), env);
  assert.equal(r.status, 413);
  const m = await route(post("/mcp", { jsonrpc: "2.0", pad: "x".repeat(20000) }, W), env);
  assert.equal(m.status, 413);
  assert.equal(env.calls.length, 0);
});

test("room ids outside 16–64 url-safe chars are rejected", async () => {
  const env = fakeEnv({ MCP_KEY: W });
  for (const room of ["short", "x".repeat(65), "has space and more chars"]) {
    const v = await (await route(post("/v1/execute", { room, seat: "watchman", op: "look" }, W), env)).json();
    assert.equal(v.error, "room_capability_required", room);
  }
});

test("wrangler config: dev is capability (D10 agent-first); staging/production stay key; no open mode in config", () => {
  const raw = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8").replace(/^\s*\/\/.*$/gm, "");
  const cfg = JSON.parse(raw);
  assert.equal(cfg.vars.AUTH_MODE, "key");
  assert.equal(cfg.env.dev.vars.AUTH_MODE, "capability");
  assert.equal(cfg.env.staging.vars.AUTH_MODE, "key");
  assert.equal(/"AUTH_MODE"\s*:\s*"open"/.test(raw), false);
});

test("/mcp with the right key reaches the server and lists exactly 3 tools", async () => {
  const env = fakeEnv({ MCP_KEY: W });
  const req = new Request("https://x.test/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${W}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
  const r = await route(req, env);
  assert.equal(r.status, 200);
  const out = await r.json();
  assert.deepEqual(out.result.tools.map((t) => t.name).sort(), ["docs", "execute", "telemetry"]);
});
