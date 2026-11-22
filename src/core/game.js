// Pure rules core — no I/O, clock and RNG injected. Scaffold stage: tables + seats + revision only.
// The falling-stone rules arrive in M2 (see docs/SPEC.md §Milestones).
export const COLS = 10;
export const ROWS = 14;
export const GATES = ["Sheep", "Fish", "Old", "Valley", "Dung", "Fountain", "Water", "Horse", "East", "Muster"];
export const SEATS = ["builder", "watchman"];

export function newRoom({ id, seed = 1, now = 0 } = {}) {
  return {
    id,
    rev: 0,
    seed,
    createdAt: now,
    day: 1,
    grid: Array.from({ length: ROWS }, () => Array(COLS).fill(0)),
    falling: null,
    queue: [],
    threats: [],
    sections: GATES.map((gate) => ({ gate, height: 0, guarded: false })),
    seats: { builder: null, watchman: null },
    log: [],
  };
}

// The Watchman never receives the grid: asymmetry is enforced here, not by a prompt.
export function slice(state, seat) {
  const common = { id: state.id, rev: state.rev, day: state.day, seats: seatView(state), sections: state.sections };
  if (seat === "builder") return { ...common, seat, grid: state.grid, falling: state.falling, next: state.queue[0] ?? null };
  if (seat === "watchman") return { ...common, seat, threats: state.threats, queue: state.queue };
  return { ...common, seat: "spectator" };
}

function seatView(state) {
  return Object.fromEntries(SEATS.map((s) => [s, state.seats[s] ? "here" : "open"]));
}

// Implemented actions per seat (scaffold). Rules for the rest arrive in M2.
export const ACTIONS = { builder: ["join", "noop"], watchman: ["join", "noop"] };

// Capability table: which seat may ever perform which action. Names come from docs/SPEC.md
// ("Builder moves, rotates and drops"; Watchman trumpet 4:20, guard 4:13, letter 6:3, quarry queue).
// A name here is a capability boundary, not an implemented rule.
export const ROLE_ACTIONS = Object.freeze({
  builder: Object.freeze(["join", "noop", "move", "rotate", "drop"]),
  watchman: Object.freeze(["join", "noop", "trumpet", "guard", "answer_letter", "set_next"]),
});

// A grant is what the edge proved about the caller: { roles: ["builder"] } etc. No grant → nothing.
export function granted(grant, seat) {
  return Boolean(grant && Array.isArray(grant.roles) && grant.roles.includes(seat));
}

// Capability-checked view: a caller only ever gets the slice of a seat it holds.
export function view(state, seat, grant) {
  if (!SEATS.includes(seat)) return { error: "unknown_seat" };
  if (!granted(grant, seat)) return { error: "seat_not_granted" };
  return slice(state, seat);
}

// Capability-checked act: the only entry point the Worker uses. apply() stays the pure rules step.
export function act(state, action, grant, now = 0) {
  const { seat, type } = action ?? {};
  if (!SEATS.includes(seat)) return reject(state, "unknown_seat");
  if (!granted(grant, seat)) return reject(state, "seat_not_granted");
  const other = SEATS.find((s) => s !== seat);
  if (!ROLE_ACTIONS[seat].includes(type) && ROLE_ACTIONS[other].includes(type)) return reject(state, "cross_role_action");
  return apply(state, action, now);
}

// apply → { ok, state, error }. Stale or unknown actions never mutate state.
export function apply(state, { seat, type, expectedRev, requestId }, now = 0) {
  if (!SEATS.includes(seat)) return reject(state, "unknown_seat");
  if (!ACTIONS[seat].includes(type)) return reject(state, "unsupported_action");
  if (requestId && state.log.some((e) => e.requestId === requestId)) return reject(state, "duplicate_request");
  if (type !== "join" && expectedRev !== state.rev) return reject(state, "stale_revision");
  const next = structuredClone(state);
  if (type === "join") next.seats[seat] = { joinedAt: now };
  next.rev += 1;
  next.log.push({ rev: next.rev, seat, type, requestId: requestId ?? null, at: now });
  if (next.log.length > 200) next.log.splice(0, next.log.length - 200);
  return { ok: true, state: next };
}

function reject(state, error) {
  return { ok: false, state, error };
}
