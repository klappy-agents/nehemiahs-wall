// Pure bounds for rooms and storage — no I/O, testable without a Worker.
// Numbers are scaffold-stage choices (see docs/SECURITY.md); they are engineering caps, not product decisions.
export const LIMITS = Object.freeze({
  MAX_ROOMS: 200, // hard ceiling per environment (each env has its own registry DO); env MAX_ROOMS may only lower it
  MAX_STATE_BYTES: 64 * 1024, // one room's serialized tables; a full room is ~20–30 KB (grid + 200-entry log)
  MAX_BODY_BYTES: 8 * 1024, // one HTTP request body; an execute call is < 1 KB
  ROOM_ID: /^[A-Za-z0-9_-]{16,64}$/, // client mints 22-char base64url ids (16 random bytes)
});

export function validRoomId(id) {
  return typeof id === "string" && LIMITS.ROOM_ID.test(id);
}

export function effectiveMaxRooms(env = {}) {
  const n = Number.parseInt(env.MAX_ROOMS, 10);
  return Number.isInteger(n) && n > 0 ? Math.min(n, LIMITS.MAX_ROOMS) : LIMITS.MAX_ROOMS;
}

// Registry decision: existing rooms are always admitted; new ones only under the cap.
export function decideClaim({ exists, count, max }) {
  if (exists) return { ok: true, create: false };
  if (count >= max) return { ok: false, error: "room_cap_reached" };
  return { ok: true, create: true };
}

export function checkStateSize(state) {
  const bytes = new TextEncoder().encode(JSON.stringify(state)).length;
  return bytes <= LIMITS.MAX_STATE_BYTES ? { ok: true, bytes } : { ok: false, error: "state_too_large", bytes };
}
