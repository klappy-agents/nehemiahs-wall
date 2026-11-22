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

test("first play: the board renders the falling stone; taps send move/rotate/drop as Bearer acts, coalesced under the seat limit", async () => {
  const view = {
    ok: true, seats: { builder: "here", watchman: "here" }, encounter: { status: "building", courses: 0, goal: 2 },
    grid: Array.from({ length: 14 }, () => Array(10).fill(0)), falling: { kind: "tee", by: "quarry", cells: [[4, 0], [3, 1], [4, 1], [5, 1]], landing: [[4, 12], [3, 13], [4, 13], [5, 13]] },
    next: { kind: "long", by: "watchman" }, cue: [{ side: "left" }], effects: [],
  };
  const b = boot(`https://nw.test/r/${ROOM}#cap=${TOKEN}`, { respond: (body) => (body.op === "look" ? view : { ok: true, view }) });
  await settle();
  assert.equal(b.els.field.children.length, 140);
  assert.equal(b.els.field.children.filter((c) => /falling/.test(c.className)).length, 4);
  assert.equal(b.els.field.children.filter((c) => /landing/.test(c.className)).length, 4);
  assert.match(b.els.next.textContent, /long stone · Watchman's pick/);
  assert.match(b.els.cue.textContent, /left/);
  const before = b.calls.length;
  const gap = () => new Promise((r) => setTimeout(r, 560));
  await gap();
  b.els.left._click(); // goes out at once
  b.els.left._click(); b.els.left._click(); // arrive inside the gap: coalesced into one move
  b.els.turn._click();
  await settle();
  await gap();
  b.els.drop._click(); // the next pump sends the coalesced move; rotate and drop wait their turn
  await settle();
  const acts = b.calls.slice(before).map((c) => JSON.parse(c.init.body));
  assert.deepEqual(acts.map((a) => [a.op, a.action, a.arg]), [["act", "move", -1], ["act", "move", -2]]);
  assert.ok(acts.every((a) => a.seat === "builder" && a.room === ROOM && a.requestId));
  for (const c of b.calls) assert.equal(c.init.headers.authorization, `Bearer ${TOKEN}`);
  for (const c of b.calls) assert.equal(c.init.body.includes(TOKEN), false);
});
