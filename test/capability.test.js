import test from "node:test";
import assert from "node:assert/strict";
import { newRoom, act, view, ROLE_ACTIONS } from "../src/core/game.js";

const builderOnly = { roles: ["builder"] };
const watchOnly = { roles: ["watchman"] };

test("role action tables are disjoint apart from join/noop", () => {
  const shared = ROLE_ACTIONS.builder.filter((a) => ROLE_ACTIONS.watchman.includes(a));
  assert.deepEqual(shared.sort(), ["join", "noop"]);
});

test("a grant can only use its own seat", () => {
  const s = newRoom({ id: "r1" });
  assert.equal(act(s, { seat: "builder", type: "join" }, watchOnly).error, "seat_not_granted");
  assert.equal(act(s, { seat: "watchman", type: "join" }, builderOnly).error, "seat_not_granted");
  assert.ok(act(s, { seat: "watchman", type: "join" }, watchOnly).ok);
});

test("no grant means no action (fails closed)", () => {
  const s = newRoom({ id: "r1" });
  assert.equal(act(s, { seat: "builder", type: "join" }).error, "seat_not_granted");
  assert.equal(act(s, { seat: "builder", type: "join" }, { roles: [] }).error, "seat_not_granted");
});

test("cross-role actions are rejected with a clear error, even with both seats granted", () => {
  const s = newRoom({ id: "r1" });
  const both = { roles: ["builder", "watchman"] };
  for (const type of ROLE_ACTIONS.builder.filter((a) => !ROLE_ACTIONS.watchman.includes(a)))
    assert.equal(act(s, { seat: "watchman", type, expectedRev: 0 }, both).error, "cross_role_action", type);
  for (const type of ROLE_ACTIONS.watchman.filter((a) => !ROLE_ACTIONS.builder.includes(a)))
    assert.equal(act(s, { seat: "builder", type, expectedRev: 0 }, both).error, "cross_role_action", type);
});

test("own-role actions not yet built are reported as unsupported, not applied", () => {
  const s = newRoom({ id: "r1" });
  const r = act(s, { seat: "builder", type: "drop", expectedRev: 0 }, builderOnly);
  assert.equal(r.error, "unsupported_action");
  assert.equal(r.state, s);
});

test("view enforces the grant: a Watchman grant never receives the Builder slice (grid)", () => {
  const s = newRoom({ id: "r1" });
  assert.equal(view(s, "builder", watchOnly).error, "seat_not_granted");
  assert.equal("grid" in view(s, "watchman", watchOnly), false);
  assert.ok(Array.isArray(view(s, "builder", builderOnly).grid));
});
