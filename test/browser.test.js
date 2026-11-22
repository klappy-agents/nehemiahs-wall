// Browser shell (public/app.js) under a minimal fake DOM: PRD §8 item 2 without a real browser.
// The live in-browser check on nehemiahs-wall-dev still runs after deploy.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const SRC = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const TOKEN = "T".repeat(43);
const ROOM = "room_abcdefghijklmnop";

function boot(href, { respond } = {}) {
  const url = new URL(href);
  const els = {};
  const el = (id) => (els[id] ??= { id, hidden: false, textContent: "", children: [], replaceChildren(...c) { this.children = c; }, set onclick(f) { this._click = f; } });
  const store = new Map();
  const calls = [];
  const history = [];
  const location = {
    get pathname() { return url.pathname; },
    get hash() { return url.hash; },
    get href() { return url.href; },
  };
  const sandbox = {
    document: { getElementById: el, createElement: () => ({ className: "" }) },
    location,
    history: { replaceState: (_s, _t, u) => { history.push(u); const n = new URL(u, url); url.pathname = n.pathname; url.hash = n.hash; url.search = n.search; } },
    sessionStorage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)) },
    fetch: async (path, init) => {
      calls.push({ path, init, at: url.href });
      const body = respond ? respond(JSON.parse(init.body), init) : { ok: true, seats: {}, grid: [] };
      return { json: async () => body };
    },
    crypto: { randomUUID: () => "uuid" },
    setInterval: () => 0,
    URLSearchParams,
    navigator: {},
  };
  vm.runInNewContext(SRC, sandbox);
  return { els, store, calls, history, url };
}
const settle = () => new Promise((r) => setTimeout(r, 10));

test("Builder link: #cap is read, stored for the room, cleared from the URL, and sent only as Bearer", async () => {
  const b = boot(`https://nw.test/r/${ROOM}#cap=${TOKEN}`);
  await settle();
  assert.equal(b.url.hash, "", "fragment gone from the address bar");
  assert.equal(b.url.href.includes(TOKEN), false);
  assert.equal(b.store.get(`cap:${ROOM}`), TOKEN);
  assert.ok(b.calls.length >= 2, "join + look");
  for (const c of b.calls) {
    assert.equal(c.path, "/v1/execute");
    assert.equal(c.path.includes(TOKEN) || c.at.includes(TOKEN), false, "never in path, query or the page URL at request time");
    assert.equal(c.init.headers.authorization, `Bearer ${TOKEN}`);
    assert.equal(c.init.body.includes(TOKEN), false, "not in the body either");
  }
  assert.equal(b.els.board.hidden, false);
});

test("no #cap → fails closed: no request, 'ask your agent' shown, no board", async () => {
  const b = boot(`https://nw.test/r/${ROOM}`);
  await settle();
  assert.equal(b.calls.length, 0);
  assert.match(b.els["room-line"].textContent, /Ask your agent/);
  assert.notEqual(b.els.board?.hidden, false);
});

test("a revoked link (server says capability_required) falls back to 'ask your agent'", async () => {
  const b = boot(`https://nw.test/r/${ROOM}#cap=${TOKEN}`, { respond: () => ({ error: "capability_required" }) });
  await settle();
  assert.match(b.els["room-line"].textContent, /Ask your agent/);
  assert.notEqual(b.els.board?.hidden, false);
});
