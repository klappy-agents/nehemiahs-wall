// M2 first play: one Fish Gate encounter (kitchen design board 09) in the pure core, clock injected.
import test from "node:test";
import assert from "node:assert/strict";
import { newRoom, apply, act, step, slice, advance, COLS, ROWS } from "../src/core/game.js";
import { RULES, STONE, RUBBLE } from "../src/core/rules.js";
import { checkStateSize } from "../src/core/limits.js";

const B = { roles: ["builder"] };
const W = { roles: ["watchman"] };
let n = 0;
const rid = () => `req-${++n}`;
const play = (s, seat, type, arg, now) => {
  const r = step(s, { seat, type, arg, requestId: rid() }, seat === "builder" ? B : W, now);
  return r;
};
const ok = (r) => (assert.ok(r.ok, r.error), r.state);

function started(seed = 7, now = 1000) {
  let s = newRoom({ id: "fish", seed, now: 0 });
  s = ok(apply(s, { seat: "watchman", type: "join" }, now));
  assert.equal(s.encounter.status, "waiting", "one seat is not a round");
  s = ok(apply(s, { seat: "builder", type: "join" }, now));
  return s;
}
// Fill a row except the cells of the falling stone's landing footprint, so a hard drop completes it.
function rowsReadyFor(s, rows) {
  const t = structuredClone(s);
  const land = slice(t, "builder").falling.landing;
  for (const y of rows) for (let x = 0; x < COLS; x++) if (!land.some(([lx, ly]) => lx === x && ly === y)) t.grid[y][x] = STONE;
  return t;
}

test("the round begins only when both seats are here: a stone falls, a raid is telegraphed, the long stone is in the quarry", () => {
  const s = started();
  assert.equal(s.encounter.status, "building");
  assert.equal(s.encounter.goal, 2);
  assert.ok(s.falling);
  assert.equal(s.threats.length, 1);
  assert.equal(s.threats[0].status, "incoming");
  assert.ok(RULES.THREAT_LEAD_MS >= 15000, "SPEC: threat lead time ≥ 15 s");
  assert.ok(s.queue.some((q) => q.kind === "long"), "opening tradeoff: trumpet now or send the long stone");
});

test("stones fall on the injected clock, one row per tick", () => {
  const s = started(7, 1000);
  const y0 = s.falling.y;
  const a = advance(s, 1000 + RULES.TICK_MS * 3).state;
  assert.equal(a.falling.y, y0 + 3);
  assert.equal(s.falling.y, y0, "advance never mutates its input");
  // A closed tab slips the clock instead of collapsing the wall.
  const far = advance(s, 1000 + 10 * 60 * 1000).state;
  assert.ok(far.clock <= RULES.MAX_CATCHUP_MS);
});

test("Builder move, rotate and drop act on the falling stone; a hard drop locks it and the next stone spawns", () => {
  let s = started();
  const x0 = s.falling.x;
  s = ok(play(s, "builder", "move", -2, 1000));
  assert.equal(s.falling.x, x0 - 2);
  s = ok(play(s, "builder", "move", -20 + 11, 1000));
  assert.ok(slice(s, "builder").falling.cells.every(([x]) => x >= 0), "walls stop the stone");
  const rot = s.falling.rot;
  s = ok(play(s, "builder", "rotate", undefined, 1000));
  assert.ok(s.falling.rot === (rot + 1) % 4 || s.falling.kind === "square" || s.falling.rot === rot);
  const before = s.grid.flat().filter((v) => v === STONE).length;
  s = ok(play(s, "builder", "drop", "hard", 1000));
  assert.equal(s.grid.flat().filter((v) => v === STONE).length, before + 4);
  assert.ok(s.falling, "the next stone is falling");
  assert.equal(play(s, "builder", "move", 0, 1000).error, "bad_arg");
  assert.equal(play(s, "builder", "drop", "sideways", 1000).error, "bad_arg");
});

test("a finished course locks into the wall (the field keeps its rows); the second course hangs the Fish Gate doors and wins", () => {
  let s = rowsReadyFor(started(), [ROWS - 1]);
  s = ok(play(s, "builder", "drop", "hard", 1000));
  assert.equal(s.encounter.courses, 1);
  assert.equal(s.grid.length, ROWS);
  assert.equal(s.sections.find((x) => x.gate === "Fish").height, 1, "the finished course is saved on the section");
  assert.match(s.effects.at(-1).text + s.effects.at(-2).text, /locks into the wall/);
  s = rowsReadyFor(s, [ROWS - 1]);
  s = ok(play(s, "builder", "drop", "hard", 1000));
  assert.equal(s.encounter.status, "won");
  assert.equal(s.sections.find((x) => x.gate === "Fish").hung, true);
  assert.match(s.encounter.outcome, /Doors hung/);
  assert.equal(play(s, "builder", "move", 1, 1000).error, "round_over");
  assert.equal(play(s, "watchman", "guard", 3, 1000).error, "round_over");
  // Saves are copies of the tables.
  assert.deepEqual(JSON.parse(JSON.stringify(s)), s);
  s = ok(play(s, "builder", "restart", undefined, 2000));
  assert.equal(s.encounter.status, "building");
  assert.equal(s.encounter.courses, 0);
  assert.equal(s.encounter.round, 2);
});

test("trumpet (4:20) turns the raid back; an unanswered raid raises one row of rubble (4:10)", () => {
  const s0 = started(7, 1000);
  const id = s0.threats[0].id;
  const t = ok(play(s0, "watchman", "trumpet", id, 1000));
  // Keep the stone hovering so only the raid changes the bottom row.
  const at = 1000 + RULES.THREAT_LEAD_MS;
  let a = t, b = s0;
  for (let now = 1000; now <= at; now += 4000) {
    a = advance(a, now).state;
    b = advance(b, now).state;
    a.falling && (a.falling.y = Math.min(a.falling.y, 0), a.falling.stepAt = a.clock + RULES.TICK_MS);
    b.falling && (b.falling.y = Math.min(b.falling.y, 0), b.falling.stepAt = b.clock + RULES.TICK_MS);
  }
  a = advance(a, at + 100).state;
  b = advance(b, at + 100).state;
  assert.equal(a.threats[0].status, "turned_back");
  assert.equal(a.grid[ROWS - 1].includes(RUBBLE), false);
  assert.ok(a.effects.some((e) => e.text === "Raid turned back"));
  assert.equal(b.threats[0].status, "landed");
  assert.equal(b.grid[ROWS - 1].filter((v) => v === RUBBLE).length, COLS - 1, "one gap to build over");
  assert.ok(b.effects.some((e) => /rubble/.test(e.text) && e.row === ROWS - 1), "the cause sits on that row");
});

test("guard (4:13) keeps its column open in the rubble row; one act per watch is a real tradeoff", () => {
  const s0 = started(7, 1000);
  let s = ok(play(s0, "watchman", "guard", 0, 1000));
  assert.equal(play(s, "watchman", "trumpet", s.threats[0].id, 1000).error, "watch_spent", "guard OR trumpet this watch");
  assert.equal(play(s, "watchman", "set_next", s.queue[0].id, 1000).error, "watch_spent");
  s.falling.y = 0;
  for (let now = 1000; now <= 1000 + RULES.THREAT_LEAD_MS + 4000; now += 4000) {
    s = advance(s, now).state;
    if (s.falling) (s.falling.y = 0), (s.falling.stepAt = s.clock + RULES.TICK_MS);
  }
  assert.equal(s.threats[0].status, "landed");
  assert.equal(s.grid[ROWS - 1][0], 0, "guarded column left open");
  assert.equal(s.watch.acts, 1, "a new watch begins after the raid");
});

test("set_next sends a quarry stone next; the Builder sees it marked as the Watchman's pick", () => {
  const s0 = started();
  const id = s0.queue.find((q) => q.kind === "long").id;
  const s = ok(play(s0, "watchman", "set_next", id, 1000));
  const bv = slice(s, "builder");
  assert.deepEqual(bv.next, { kind: "long", by: "watchman" });
  assert.equal(play(s0, "watchman", "set_next", "gone", 1000).error, "quarry_slot_gone");
  const old = s0.queue[0].id;
  const dropped = ok(play(s0, "builder", "drop", "hard", 1000));
  assert.equal(play(dropped, "watchman", "set_next", old, 1000).error, "quarry_slot_gone", "an expired quarry target never picks its replacement");
});

test("Builder motion never makes a Watchman act stale; late and duplicate acts fail on their target", () => {
  let s = started();
  const id = s.threats[0].id;
  for (let i = 0; i < 5; i++) s = ok(play(s, "builder", "move", i % 2 ? 1 : -1, 1000));
  const r = step(s, { seat: "watchman", type: "trumpet", arg: id, expectedRev: 0, requestId: "w1" }, W, 1000);
  assert.ok(r.ok, "an old expectedRev does not invalidate a targeted act");
  assert.equal(step(r.state, { seat: "watchman", type: "trumpet", arg: id, requestId: "w1" }, W, 1000).error, "duplicate_request");
  assert.equal(play(r.state, "watchman", "trumpet", "raid-9", 1000).error, "unknown_threat");
  // Late: the raid already landed.
  let late = s;
  for (let now = 1000; now <= 1000 + RULES.THREAT_LEAD_MS + 5000; now += 4000) {
    late = advance(late, now).state;
    if (late.falling) (late.falling.y = 0), (late.falling.stepAt = late.clock + RULES.TICK_MS);
  }
  assert.equal(play(late, "watchman", "trumpet", id, 40000).error, "threat_closed");
});

test("rubble at the top loses the round", () => {
  let s = started(7, 1000);
  for (let y = 0; y < ROWS; y++) for (let x = 1; x < COLS; x++) s.grid[y][x] = STONE;
  s.falling = null;
  for (let now = 1000; now <= 1000 + RULES.THREAT_LEAD_MS + 4000; now += 4000) s = advance(s, now).state;
  assert.equal(s.encounter.status, "lost");
  assert.match(s.encounter.outcome, /top/);
});

test("seeded rounds replay exactly", () => {
  const run = () => {
    let s = started(42, 1000);
    for (let now = 1000; now < 20000; now += 700) {
      s = advance(s, now).state;
      if (s.encounter.status !== "building") break;
      s = ok(play(s, "builder", now % 1400 ? "drop" : "move", now % 1400 ? "hard" : 1, now));
    }
    return { grid: s.grid, queue: s.queue, status: s.encounter.status };
  };
  assert.deepEqual(run(), run());
});

test("the Watchman's slice never contains the grid or the falling stone, mid-round", () => {
  let s = started();
  s = advance(s, 3000).state;
  const w = slice(s, "watchman");
  for (const k of ["grid", "falling", "next", "cue"]) assert.equal(k in w, false, k);
  assert.equal(JSON.stringify(w).includes("landing"), false);
  assert.ok(w.threats[0].secondsLeft > 0);
  assert.ok(w.queue.every((q, i) => q.slot === i));
  const b = slice(s, "builder");
  assert.deepEqual(b.cue, [{ side: "left" }], "the Builder gets a dim cue only");
  assert.equal("threats" in b, false);
  assert.equal("queue" in b, false);
});

test("cross-seat play acts fail; ungranted seats fail", () => {
  const s = started();
  assert.equal(act(s, { seat: "watchman", type: "drop" }, W).error, "cross_role_action");
  assert.equal(act(s, { seat: "builder", type: "trumpet", arg: "raid-1" }, B).error, "cross_role_action");
  assert.equal(act(s, { seat: "builder", type: "move", arg: 1 }, W).error, "seat_not_granted");
  assert.equal(act(s, { seat: "watchman", type: "guard", arg: 1 }, B).error, "seat_not_granted");
  assert.equal(act(s, { seat: "builder", type: "drop" }).error, "seat_not_granted");
});

test("a full round stays far under the 64 KiB room cap", () => {
  let s = started();
  for (let i = 0; i < 400; i++) {
    const r = play(s, "builder", "move", i % 2 ? 1 : -1, 1000 + i);
    s = r.ok ? r.state : r.advanced;
  }
  assert.ok(checkStateSize(s).ok);
  assert.ok(checkStateSize(s).bytes < 32 * 1024, String(checkStateSize(s).bytes));
});
