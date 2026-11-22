import test from "node:test";
import assert from "node:assert/strict";
import { LIMITS, decideClaim, checkStateSize, validRoomId, effectiveMaxRooms } from "../src/core/limits.js";
import { newRoom, apply } from "../src/core/game.js";

test("room cap: new rooms past the cap are rejected, existing rooms still admitted", () => {
  assert.deepEqual(decideClaim({ exists: false, count: 0, max: 2 }), { ok: true, create: true });
  assert.deepEqual(decideClaim({ exists: false, count: 2, max: 2 }), { ok: false, error: "room_cap_reached" });
  assert.deepEqual(decideClaim({ exists: true, count: 2, max: 2 }), { ok: true, create: false });
});

test("env can lower the room cap but never raise it past the hard ceiling", () => {
  assert.equal(effectiveMaxRooms({}), LIMITS.MAX_ROOMS);
  assert.equal(effectiveMaxRooms({ MAX_ROOMS: "10" }), 10);
  assert.equal(effectiveMaxRooms({ MAX_ROOMS: "999999" }), LIMITS.MAX_ROOMS);
  assert.equal(effectiveMaxRooms({ MAX_ROOMS: "nonsense" }), LIMITS.MAX_ROOMS);
  assert.equal(effectiveMaxRooms({ MAX_ROOMS: "-5" }), LIMITS.MAX_ROOMS);
});

test("state size bound: a fresh room and a full 200-entry log fit; an oversized state is rejected", () => {
  let s = newRoom({ id: "r".repeat(64) });
  assert.equal(checkStateSize(s).ok, true);
  for (let i = 0; i < 260; i++) s = apply(s, { seat: "builder", type: "noop", expectedRev: s.rev, requestId: "q".repeat(64) + i }).state;
  assert.equal(s.log.length, 200);
  assert.equal(checkStateSize(s).ok, true);
  const big = { ...s, junk: "x".repeat(LIMITS.MAX_STATE_BYTES) };
  assert.equal(checkStateSize(big).error, "state_too_large");
});

test("room id shape", () => {
  assert.equal(validRoomId("a".repeat(16)), true);
  assert.equal(validRoomId("a".repeat(15)), false);
  assert.equal(validRoomId("a".repeat(65)), false);
  assert.equal(validRoomId("a/b".repeat(8)), false);
  assert.equal(validRoomId(42), false);
});
