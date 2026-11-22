// Pure rules core — no I/O, clock and RNG injected. Tables + seats + revision, plus the first play slice:
// one Fish Gate encounter (src/core/rules.js). The full circuit, day clock and letters are later milestones.
import { encounterTables, begin, advance, builderAct, watchmanAct, cellsOf, landing, secondsLeft } from "./rules.js";
export { advance } from "./rules.js";
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
    ...encounterTables(seed),
  };
}

// The Watchman never receives the grid: asymmetry is enforced here, not by a prompt.
export function slice(state, seat) {
  const common = { id: state.id, rev: state.rev, day: state.day, seats: seatView(state), sections: state.sections, encounter: state.encounter ?? null };
  const effects = (state.effects ?? []).map((e) => ({ ...e, ago: Math.max(0, Math.round(((state.clock ?? 0) - e.at) / 1000)) }));
  if (seat === "builder") {
    const f = state.falling;
    return {
      ...common,
      seat,
      grid: state.grid,
      falling: f ? { kind: f.kind, by: f.by, cells: cellsOf(f), landing: landing(state.grid, f) } : null,
      next: state.queue[0] ? { kind: state.queue[0].kind, by: state.queue[0].by } : null,
      // The Builder lacks threat telegraphs: a dim cue only (which side), no timers, no names.
      cue: (state.threats ?? []).filter((t) => t.status === "incoming").map((t) => ({ side: t.side })),
      guard: state.guard ?? null,
      effects,
    };
  }
  if (seat === "watchman") {
    return {
      ...common,
      seat,
      threats: (state.threats ?? []).map(({ id, kind, by, gate, side, ref, status, trumpet, landsAt }) => ({ id, kind, by, gate, side, ref, status, trumpet, secondsLeft: secondsLeft(state, landsAt) })),
      queue: state.queue.map((q, slot) => ({ slot, ...q })),
      watch: state.watch ? { n: state.watch.n, acts: state.watch.acts, secondsLeft: secondsLeft(state, state.watch.endsAt) } : null,
      guard: state.guard ?? null,
      effects: effects.map(({ text, ago, gate, side, col }) => ({ text, ago, ...(gate ? { gate } : {}), ...(side ? { side } : {}), ...(col !== undefined ? { col } : {}) })),
    };
  }
  return { ...common, seat: "spectator" };
}

function seatView(state) {
  return Object.fromEntries(SEATS.map((s) => [s, state.seats[s] ? "here" : "open"]));
}

// Implemented actions per seat. answer_letter stays unbuilt: the first Fish Gate encounter has no letter.
export const ACTIONS = { builder: ["join", "noop", "move", "rotate", "drop", "restart"], watchman: ["join", "noop", "trumpet", "guard", "set_next"] };
// Play acts are real-time: they validate against their target (the live stone, a threat id, a column, a quarry
// slot), not against the revision, so ordinary motion by one seat never makes the other seat's act stale.
const PLAY = new Set(["move", "rotate", "drop", "restart", "trumpet", "guard", "set_next"]);

// Capability table: which seat may ever perform which action. Names come from docs/SPEC.md
// ("Builder moves, rotates and drops"; Watchman trumpet 4:20, guard 4:13, letter 6:3, quarry queue).
// A name here is a capability boundary, not an implemented rule.
export const ROLE_ACTIONS = Object.freeze({
  builder: Object.freeze(["join", "noop", "move", "rotate", "drop", "restart"]),
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
// The caller advances game time first (advance(state, now)) so gravity and the threat clock are current.
export function act(state, action, grant, now = 0) {
  const { seat, type } = action ?? {};
  if (!SEATS.includes(seat)) return reject(state, "unknown_seat");
  if (!granted(grant, seat)) return reject(state, "seat_not_granted");
  const other = SEATS.find((s) => s !== seat);
  if (!ROLE_ACTIONS[seat].includes(type) && ROLE_ACTIONS[other].includes(type)) return reject(state, "cross_role_action");
  return apply(state, action, now);
}

// Advance to `now`, then act. → { ok, state, error, advanced } where `advanced` is the time-advanced state
// (worth saving even when the act is rejected).
export function step(state, action, grant, now = 0) {
  const advanced = advance(state, now).state;
  return { ...act(advanced, action, grant, now), advanced };
}

// apply → { ok, state, error }. Stale or unknown actions never mutate state.
export function apply(state, { seat, type, expectedRev, requestId, arg }, now = 0) {
  if (!SEATS.includes(seat)) return reject(state, "unknown_seat");
  if (!ACTIONS[seat].includes(type)) return reject(state, "unsupported_action");
  if (requestId && state.log.some((e) => e.requestId === requestId)) return reject(state, "duplicate_request");
  if (type !== "join" && !PLAY.has(type) && expectedRev !== state.rev) return reject(state, "stale_revision");
  const next = structuredClone(state);
  if (type === "join") {
    next.seats[seat] = { joinedAt: now };
    if (!next.encounter) Object.assign(next, encounterTables(next.seed ?? 1)); // a room saved before this build
    if (next.encounter?.status === "waiting" && SEATS.every((s) => next.seats[s])) begin(next, now);
  }
  if (PLAY.has(type)) {
    if (!next.encounter) return reject(state, "unsupported_action");
    const r = seat === "builder" ? builderAct(next, type, arg) : watchmanAct(next, type, arg);
    if (r.error) return reject(state, r.error);
    if (r.restart) begin(next, now);
  }
  next.rev += 1;
  next.log.push({ rev: next.rev, seat, type, ...(arg !== undefined ? { arg } : {}), requestId: requestId ?? null, at: now });
  if (next.log.length > 200) next.log.splice(0, next.log.length - 200);
  return { ok: true, state: next };
}

function reject(state, error) {
  return { ok: false, state, error };
}
