import test from "node:test";
import assert from "node:assert/strict";
import { newRoom, slice, apply, COLS, ROWS } from "../src/core/game.js";

test("new room holds plain tables", () => {
  const s = newRoom({ id: "r1" });
  assert.equal(s.grid.length, ROWS);
  assert.equal(s.grid[0].length, COLS);
  assert.equal(s.sections.length, 10);
  assert.equal(s.rev, 0);
});

test("watchman slice never contains the grid", () => {
  const s = newRoom({ id: "r1" });
  const w = slice(s, "watchman");
  assert.equal("grid" in w, false);
  assert.ok(Array.isArray(slice(s, "builder").grid));
});

test("join advances revision; stale and duplicate requests never mutate", () => {
  let s = newRoom({ id: "r1" });
  const j = apply(s, { seat: "watchman", type: "join", requestId: "a" });
  assert.ok(j.ok);
  s = j.state;
  assert.equal(s.rev, 1);
  const dup = apply(s, { seat: "watchman", type: "join", requestId: "a" });
  assert.equal(dup.error, "duplicate_request");
  assert.equal(dup.state, s);
  const stale = apply(s, { seat: "builder", type: "noop", expectedRev: 0 });
  assert.equal(stale.error, "stale_revision");
  assert.equal(apply(s, { seat: "builder", type: "noop", expectedRev: 1 }).state.rev, 2);
});

test("unknown seat or action is rejected", () => {
  const s = newRoom({ id: "r1" });
  assert.equal(apply(s, { seat: "sanballat", type: "join" }).error, "unknown_seat");
  assert.equal(apply(s, { seat: "builder", type: "tear_down" }).error, "unsupported_action");
});

test("snapshot round-trips through JSON (saves are copies of the tables)", () => {
  const s = apply(newRoom({ id: "r1" }), { seat: "builder", type: "join" }).state;
  assert.deepEqual(JSON.parse(JSON.stringify(s)), s);
});
