// Browser shell (public/app.js) under a minimal fake DOM: PRD §8 item 2 without a real browser.
// The live in-browser check on nehemiahs-wall-dev still runs after deploy.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const SRC = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const TOKEN = "T".repeat(43);
const ROOM = "room_abcdefghijklmnop";

function boot(href, { respond, fetchImpl, clock, timers } = {}) {
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
  const intervals = [];
  const keys = {};
  const sandbox = {
    document: { getElementById: el, createElement: () => ({ className: "" }), set onkeydown(f) { keys.down = f; } },
    location,
    history: { replaceState: (_s, _t, u) => { history.push(u); const n = new URL(u, url); url.pathname = n.pathname; url.hash = n.hash; url.search = n.search; } },
    sessionStorage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)) },
    fetch: async (path, init) => {
      calls.push({ path, init, at: url.href });
      if (fetchImpl) return fetchImpl(JSON.parse(init.body), init);
      const body = respond ? respond(JSON.parse(init.body), init) : { ok: true, seats: {}, grid: [] };
      return { json: async () => body };
    },
    crypto: { randomUUID: () => "uuid" },
    setInterval: (f) => (intervals.push(f), 0),
    ...(clock ? { Date: { now: () => clock.now } } : {}),
    ...(timers ? { setTimeout: timers.set, clearTimeout: timers.clear, AbortController } : {}),
    URLSearchParams,
    navigator: {},
  };
  vm.runInNewContext(SRC, sandbox);
  return { els, store, calls, history, url, keys, pump: () => intervals.forEach((f) => f()) };
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
  assert.match(b.els.raid.textContent, /Raid coming from the left/);
  assert.equal(b.els.raid.hidden, false);
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

// ── Try again after a finished round (live dev bug, 0.1.0): the restart must reach the server. ──
const grid = () => Array.from({ length: 14 }, () => Array(10).fill(0));
const tee = { kind: "tee", by: "quarry", cells: [[4, 0], [3, 1], [4, 1], [5, 1]], landing: [[4, 12], [3, 13], [4, 13], [5, 13]] };
const viewOf = (status, round = 1) => ({
  seats: { builder: "here", watchman: "here" }, grid: grid(), falling: status === "building" ? tee : null, next: null, cue: [], effects: [],
  encounter: { status, round, courses: status === "won" ? 2 : 0, goal: 2, outcome: status === "won" ? "Doors hung at the Fish Gate" : status === "lost" ? "The stones reached the top" : null },
});
// A tiny fake server: one round; `endOn` decides how it ends; restart starts round 2.
function fakeServer(endOn) {
  const s = { status: "building", round: 1, acts: [] };
  const respond = (body) => {
    if (body.op === "act") s.acts.push(body.action);
    if (body.op === "join" || body.op === "look") return viewOf(s.status, s.round);
    if (body.action === "restart") {
      if (s.status === "building") return { ok: false, error: "round_in_progress" };
      Object.assign(s, { status: "building", round: s.round + 1 });
      return { ok: true, view: viewOf(s.status, s.round) };
    }
    if (s.status !== "building") return { ok: false, error: "round_over" };
    if (endOn === "win-drop" && body.action === "drop") { s.status = "won"; return { ok: true, view: viewOf("won") }; }
    if (endOn === "gravity-loss") { s.status = "lost"; return { ok: false, error: "round_over" }; } // the stones topped out between calls
    return { ok: true, view: viewOf(s.status, s.round) };
  };
  return { s, respond };
}
async function finishRound(endOn) {
  const clock = { now: 1_000_000 };
  const server = fakeServer(endOn);
  const b = boot(`https://nw.test/r/${ROOM}#cap=${TOKEN}`, { respond: server.respond, clock });
  await settle();
  const tick = async (ms = 600) => { clock.now += ms; b.pump(); await settle(); };
  await tick();
  // Mash Drop: the first tap goes out at once and ends the round; the rest were queued for that round.
  for (let i = 0; i < 8; i++) b.els.drop._click();
  await settle();
  for (let i = 0; i < 4 && b.els.end.hidden; i++) await tick(); // a look shows the finished round
  return { b, server, tick };
}
for (const [endOn, status] of [["win-drop", "won"], ["gravity-loss", "lost"]]) {
  const control = status === "won" ? "next-round" : "restart";
  test(`${status === "won" ? "Next round after a WIN" : "Try again after a LOSS"} reaches the server even after mashed taps (no frozen board)`, async () => {
    const { b, server, tick } = await finishRound(endOn);
    assert.equal(b.els[control].hidden, false, `${control} is shown`);
    assert.equal(server.s.status, status);
    const stale = server.s.acts.length;
    b.keys.down({ key: " ", preventDefault() {} }); // keyboard taps after the round ended
    b.keys.down({ key: "ArrowLeft", preventDefault() {} });
    b.els[control]._click();
    assert.equal(b.els[control].disabled, true, "one restart per finished round");
    await tick();
    assert.deepEqual(server.s.acts.slice(stale), ["restart"], "restart is the very next act; stale stone taps never went out");
    assert.equal(server.s.round, 2);
    assert.equal(b.els[control].hidden, true, "board is live again");
    assert.equal(b.els.end.hidden, true);
    assert.match(b.els.status.textContent, /Build two courses/);
    assert.equal(b.els.drop.disabled, false);
    // A second press (double tap) after the round restarted sends nothing.
    b.els[control]._click();
    await tick();
    assert.deepEqual(server.s.acts.slice(stale), ["restart"]);
  });
}

test("a rate-limited Try again is kept and goes out after the wait", async () => {
  const clock = { now: 1_000_000 };
  const server = fakeServer("win-drop");
  let limitNext = false;
  const respond = (body) => (limitNext && body.action === "restart" ? ((limitNext = false), { error: "rate_limited", retryAfter: 2 }) : server.respond(body));
  const b = boot(`https://nw.test/r/${ROOM}#cap=${TOKEN}`, { respond, clock });
  await settle();
  const tick = async (ms = 600) => { clock.now += ms; b.pump(); await settle(); };
  await tick();
  b.els.drop._click();
  await settle();
  assert.equal(server.s.status, "won");
  limitNext = true;
  b.els["next-round"]._click();
  await tick();
  assert.equal(server.s.round, 1, "limited: nothing happened yet");
  await tick(2500);
  assert.equal(server.s.round, 2, "the kept restart went out after retryAfter");
  assert.equal(b.els["next-round"].hidden, true);
});

test("a call that never answers is cut off, so the board cannot stay busy forever", async () => {
  const clock = { now: 1_000_000 };
  const pendingTimers = [];
  const timers = { set: (f, ms) => (pendingTimers.push({ f, ms }), pendingTimers.length), clear: (id) => { if (pendingTimers[id - 1]) pendingTimers[id - 1].f = () => {}; } };
  const server = fakeServer("win-drop");
  let hang = false;
  const fetchImpl = (body, init) => {
    if (hang) return new Promise((_, rej) => init.signal.addEventListener("abort", () => rej(new Error("aborted"))));
    return { json: async () => server.respond(body) };
  };
  const b = boot(`https://nw.test/r/${ROOM}#cap=${TOKEN}`, { fetchImpl, clock, timers });
  await settle();
  const tick = async (ms = 600) => { clock.now += ms; b.pump(); await settle(); };
  await tick();
  hang = true;
  b.els.drop._click(); // this call hangs
  await settle();
  assert.ok(pendingTimers.some((t) => t.ms === 8000), "each call is bounded");
  for (const t of pendingTimers.splice(0)) t.f(); // the bound fires
  await settle();
  assert.match(b.els.notice.textContent, /Reconnecting/);
  hang = false;
  await tick();
  b.els.drop._click();
  await tick();
  assert.equal(server.s.status, "won", "the next tap went out: not stuck busy");
});

// ── Fish Gate UX pass (kitchen rail 2026-11-21-nehemiahs-wall-fish-gate-ux-pass) ──
const HTML = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
async function showing(views, clock = { now: 1_000_000 }) {
  let i = 0;
  const current = () => views[Math.min(i, views.length - 1)];
  const b = boot(`https://nw.test/r/${ROOM}#cap=${TOKEN}`, { respond: (body) => (body.op === "act" ? { ok: true, view: current() } : current()), clock });
  await settle();
  const next = async (ms = 1600) => { i++; clock.now += ms; b.pump(); await settle(); };
  return { b, next, clock };
}

test("a WIN reads as a win: doors-hung label and Next round, never Try again", async () => {
  const { b } = await showing([viewOf("won")]);
  assert.match(b.els.status.textContent, /You won!.*Fish Gate doors are hung/);
  assert.equal(b.els.end.hidden, false);
  assert.equal(b.els["next-round"].hidden, false, "progress control shown");
  assert.equal(b.els.restart.hidden, true, "no Try again after a win");
  assert.match(b.els["end-cause"].textContent, /Next round/);
  assert.match(HTML, /id="next-round"[^>]*>Next round</);
  assert.equal(b.els.drop.disabled, true);
});

test("a LOSS reads as a loss with one cause line and Try again", async () => {
  const { b } = await showing([viewOf("lost")]);
  assert.equal(b.els.status.textContent, "Round lost");
  assert.equal(b.els["end-cause"].textContent, "Why it stopped: The stones reached the top.");
  assert.equal(b.els.restart.hidden, false);
  assert.equal(b.els["next-round"].hidden, true);
  assert.match(HTML, /id="restart"[^>]*>Try again</);
});

const building = (extra = {}) => ({ ...viewOf("building"), cue: [{ side: "left" }], ...extra });
test("a coming raid is named with its side and roughly how soon, for the whole warning window", async () => {
  const begun = (ago) => ({ text: "The work begins at the Fish Gate", at: 0, ago });
  const { b, next } = await showing([building({ effects: [begun(10)] }), building({ effects: [begun(26)] }), building({ effects: [begun(30)] })]);
  assert.equal(b.els.raid.hidden, false);
  assert.match(b.els.raid.textContent, /^Raid coming from the left, lands in about 20 s\./);
  assert.match(b.els.raid.textContent, /trumpet|guard/);
  await next();
  assert.match(b.els.raid.textContent, /about 4 s/);
  await next();
  assert.match(b.els.raid.textContent, /any moment now/);
});

test("after the trumpet the raid notice names the gate and says it will be turned back; a landed raid says what it did", async () => {
  const trumpet = { text: "Trumpet sounds at the Old Gate", at: 4000, ago: 1, side: "left", gate: "Old" };
  const landed = { ...viewOf("building"), cue: [], effects: [{ text: "Raid: +1 row of rubble", at: 30000, ago: 1, side: "left", gate: "Old", row: 13 }] };
  const { b, next } = await showing([building({ effects: [{ text: "The work begins at the Fish Gate", at: 0, ago: 5 }, trumpet] }), landed]);
  assert.match(b.els.raid.textContent, /Raid coming from the left at the Old Gate.*turned back/);
  await next();
  assert.match(b.els.raid.textContent, /raid hit from the left: a row of rubble/);
});

test("joined mid-round without the round's first line: the raid notice does not invent a time", async () => {
  const { b } = await showing([building({ effects: [] })]);
  assert.match(b.els.raid.textContent, /Raid coming from the left, landing soon/);
  assert.doesNotMatch(b.els.raid.textContent, /about \d+ s/);
});

// Watchman effects come from the real rules core, so a copy change there fails here (lens k0002).
import { newRoom, apply, step as coreStep, slice } from "../src/core/game.js";
function coreViews(type) {
  const W = { roles: ["watchman"] };
  let s = newRoom({ id: "fish", seed: 7, now: 0 });
  s = apply(s, { seat: "watchman", type: "join" }, 1000).state;
  s = apply(s, { seat: "builder", type: "join" }, 1000).state;
  const before = slice(s, "builder");
  const arg = { trumpet: s.threats[0].id, guard: 4, set_next: s.queue[1].id }[type];
  const r = coreStep(s, { seat: "watchman", type, arg, requestId: `w-${type}` }, W, 3000);
  assert.ok(r.ok, `${type}: ${r.error}`);
  return [before, slice(r.state, "builder")];
}
for (const [type, label, words] of [["trumpet", "Trumpet", /Trumpet sounds at the Old Gate/], ["guard", "Guard", /guard is posted at column 5/], ["set_next", "Next stone", /sends the \w+ stone next/]]) {
  test(`a Watchman ${label} act (${type}) shows a notice naming the act for at least 4 s, and joins the calls log`, async () => {
    const [before, after] = coreViews(type);
    const clock = { now: 1_000_000 };
    let v = before;
    const b = boot(`https://nw.test/r/${ROOM}#cap=${TOKEN}`, { respond: (body) => (body.op === "act" ? { ok: true, view: v } : v), clock });
    await settle();
    assert.equal(b.els["watch-act"].hidden, true, "no act yet");
    assert.equal(b.els["calls-empty"].hidden, false);
    v = after; clock.now += 1600; b.pump(); await settle();
    assert.equal(b.els["watch-act"].hidden, false);
    assert.match(b.els["watch-act"].textContent, new RegExp(`^Watchman just acted · ${label}\\.`));
    assert.match(b.els["watch-act"].textContent, words);
    clock.now += 4200; b.pump(); await settle();
    assert.equal(b.els["watch-act"].hidden, false, "still up after 4 s");
    clock.now += 2500; b.pump(); await settle();
    assert.equal(b.els["watch-act"].hidden, true, "then it clears; the log keeps it");
    assert.equal(b.els.calls.children.length, 1);
    assert.match(b.els.calls.children[0].textContent, new RegExp(`^0:02 · ${label}:`));
    assert.equal(b.els["calls-empty"].hidden, true);
  });
}

test("first-time guidance on the board: the goal, the controls and the Watchman's role", () => {
  const howto = HTML.slice(HTML.indexOf('<details id="howto"'), HTML.indexOf("</details>"));
  assert.match(howto, /<details id="howto"[^>]* open>/);
  assert.match(howto, /Two courses hang the Fish Gate doors/);
  assert.match(howto, /move.*Rotate.*Drop/s);
  assert.match(howto, /Watchman<\/b> is your teammate.*see raids coming but not your grid/s);
  assert.doesNotMatch(HTML, /set_next|\brev\b/, "no system words on screen");
});
