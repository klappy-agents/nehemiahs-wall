// M2 first play: one Fish Gate encounter (kitchen design board 09). Pure: no I/O; clock and RNG injected.
// Two courses, one threat, a visible finish. All ten gates, the day clock and letters are later milestones.
// Every time here is GAME time (state.clock, ms). The wall clock only feeds advance(), which caps a jump so a
// closed tab slips the clock instead of collapsing the wall (CONTRACT g15 "Away pauses" is still open).
export const RULES = Object.freeze({
  TICK_MS: 900, // the falling stone drops one row per tick
  MAX_CATCHUP_MS: 5000, // most game time one advance() may cover; beyond that the clock slips (away)
  COURSES_TO_WIN: 2, // board 09: the second course locks and the Fish Gate doors are hung
  THREAT_LEAD_MS: 30000, // Watchman lead time on the raid (SPEC: ≥ 15 s)
  WATCH_MS: 20000, // after the threat resolves, the Watchman gets one act per watch of this length
  QUARRY: 3, // stones the Watchman can see and pick from
  EFFECTS: 4, // recent "what changed" lines kept for both seats
  MAX_EVENTS: 64, // safety bound on events one advance() may process
});
export const KINDS = Object.freeze(["long", "square", "tee", "corner", "hook", "step", "zig"]);
const BASE = {
  long: { n: 4, cells: [[0, 1], [1, 1], [2, 1], [3, 1]] },
  square: { n: 2, cells: [[0, 0], [1, 0], [0, 1], [1, 1]] },
  tee: { n: 3, cells: [[1, 0], [0, 1], [1, 1], [2, 1]] },
  corner: { n: 3, cells: [[2, 0], [0, 1], [1, 1], [2, 1]] },
  hook: { n: 3, cells: [[0, 0], [0, 1], [1, 1], [2, 1]] },
  step: { n: 3, cells: [[1, 0], [2, 0], [0, 1], [1, 1]] },
  zig: { n: 3, cells: [[0, 0], [1, 0], [1, 1], [2, 1]] },
};
// Rotations precomputed once: (x, y) → (n-1-y, x), clockwise.
const SHAPES = Object.fromEntries(
  Object.entries(BASE).map(([k, { n, cells }]) => {
    const rots = [cells];
    for (let r = 1; r < 4; r++) rots.push(rots[r - 1].map(([x, y]) => [n - 1 - y, x]));
    return [k, rots];
  }),
);
export const EMPTY = 0;
export const STONE = 1;
export const RUBBLE = 2;

// Seeded RNG (mulberry32). state.rng is the whole generator state, so a save replays exactly.
function rand(s) {
  s.rng = (s.rng + 0x6d2b79f5) >>> 0;
  let t = s.rng;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const pick = (s, list) => list[Math.floor(rand(s) * list.length)];

export function encounterTables(seed) {
  return {
    clock: 0,
    lastNow: null,
    rng: seed >>> 0,
    encounter: { gate: "Fish", goal: RULES.COURSES_TO_WIN, courses: 0, status: "waiting", outcome: null, round: 0 },
    watch: null,
    guard: null,
    quarrySeq: 0,
    effects: [],
  };
}

export function cellsOf(f) {
  return SHAPES[f.kind][f.rot].map(([x, y]) => [f.x + x, f.y + y]);
}
function fits(grid, f) {
  const cols = grid[0].length;
  return cellsOf(f).every(([x, y]) => x >= 0 && x < cols && y < grid.length && (y < 0 || grid[y][x] === EMPTY));
}
function effect(s, text, extra = {}) {
  s.effects.push({ at: s.clock, text, ...extra });
  if (s.effects.length > RULES.EFFECTS) s.effects.splice(0, s.effects.length - RULES.EFFECTS);
}
function end(s, status, outcome) {
  s.encounter.status = status;
  s.encounter.outcome = outcome;
  s.falling = null;
  effect(s, outcome);
}
function refill(s) {
  while (s.queue.length < RULES.QUARRY) s.queue.push({ id: `q-${s.encounter.round}-${++s.quarrySeq}`, kind: pick(s, KINDS), by: "quarry" });
}
function spawn(s) {
  refill(s);
  const { kind, by } = s.queue.shift();
  refill(s);
  const n = SHAPES[kind][0].reduce((m, [x]) => Math.max(m, x), 0) + 1;
  const f = { kind, rot: 0, x: Math.floor((s.grid[0].length - n) / 2), y: kind === "long" ? -1 : 0, by, stepAt: s.clock + RULES.TICK_MS };
  if (!fits(s.grid, f)) return end(s, "lost", "The stones reached the top");
  s.falling = f;
}

// Both seats here → the round begins. Called after every join, and by restart.
export function begin(s, now) {
  const cols = s.grid[0].length;
  s.grid = s.grid.map(() => Array(cols).fill(EMPTY));
  s.clock = 0;
  s.lastNow = now;
  s.encounter = { ...s.encounter, courses: 0, status: "building", outcome: null, round: (s.encounter.round ?? 0) + 1 };
  s.sections = s.sections.map((x) => (x.gate === "Fish" ? { ...x, height: 0, hung: false } : x));
  s.guard = null;
  s.effects = [];
  s.queue = [];
  s.quarrySeq = 0;
  refill(s);
  const landsAt = RULES.THREAT_LEAD_MS;
  s.threats = [{ id: `raid-${s.encounter.round}`, kind: "raid", by: "Sanballat", gate: "Old", side: "left", ref: "Neh 4:8", landsAt, status: "incoming", trumpet: false }];
  s.watch = { n: 1, acts: 1, endsAt: landsAt };
  spawn(s);
  // The opening choice (Oddie review §2): the long stone sits in the quarry while the raid comes.
  if (!s.queue.some((q) => q.kind === "long")) s.queue[RULES.QUARRY - 1].kind = "long";
  effect(s, "The work begins at the Fish Gate");
}

function lockCourses(s) {
  const full = s.grid.map((row, i) => (row.every((v) => v !== EMPTY) ? i : -1)).filter((i) => i >= 0);
  if (!full.length) return;
  // A finished course does not vanish: it locks into the built wall below the field (the field keeps its rows).
  const cols = s.grid[0].length;
  s.grid = [...full.map(() => Array(cols).fill(EMPTY)), ...s.grid.filter((_, i) => !full.includes(i))];
  s.encounter.courses += full.length;
  s.sections = s.sections.map((x) => (x.gate === "Fish" ? { ...x, height: x.height + full.length } : x));
  effect(s, s.encounter.courses >= s.encounter.goal ? "The second course locks into the wall" : `Course ${s.encounter.courses} locks into the wall`);
  if (s.encounter.courses >= s.encounter.goal) {
    s.sections = s.sections.map((x) => (x.gate === "Fish" ? { ...x, hung: true } : x));
    end(s, "won", "Doors hung at the Fish Gate");
  }
}
function lock(s) {
  const f = s.falling;
  const cells = cellsOf(f);
  if (cells.some(([, y]) => y < 0)) return end(s, "lost", "The stones reached the top");
  for (const [x, y] of cells) s.grid[y][x] = STONE;
  s.falling = null;
  lockCourses(s);
  if (s.encounter.status === "building") spawn(s);
}
function step(s) {
  const f = s.falling;
  const down = { ...f, y: f.y + 1 };
  if (fits(s.grid, down)) {
    s.falling = { ...down, stepAt: f.stepAt + RULES.TICK_MS };
    return;
  }
  lock(s);
}
function land(s, t) {
  if (t.trumpet) {
    t.status = "turned_back";
    effect(s, "Raid turned back", { side: t.side, gate: t.gate });
  } else {
    t.status = "landed";
    // Neh 4:10: rubble rises from the bottom. One gap, at the guarded column if a guard is posted (4:13).
    if (s.grid[0].some((v) => v !== EMPTY)) return end(s, "lost", "Rubble reached the top");
    const cols = s.grid[0].length;
    const gap = s.guard ?? Math.floor(rand(s) * cols);
    s.grid.shift();
    s.grid.push(Array.from({ length: cols }, (_, x) => (x === gap ? EMPTY : RUBBLE)));
    if (s.falling && !fits(s.grid, s.falling)) {
      const up = { ...s.falling, y: s.falling.y - 1 };
      if (fits(s.grid, up)) s.falling = up;
      else lock(s);
    }
    effect(s, "Raid: +1 row of rubble", { side: t.side, gate: t.gate, row: s.grid.length - 1 });
  }
  s.watch = { n: s.watch.n + 1, acts: 1, endsAt: s.clock + RULES.WATCH_MS };
}

// Advance game time to the wall clock `now`. → { state, changed }. Never mutates the input.
export function advance(state, now) {
  if (!state.encounter || state.encounter.status !== "building") return { state, changed: false };
  const s = structuredClone(state);
  const dt = s.lastNow == null ? 0 : Math.max(0, Math.min(now - s.lastNow, RULES.MAX_CATCHUP_MS));
  s.lastNow = now;
  const target = s.clock + dt;
  for (let i = 0; i < RULES.MAX_EVENTS && s.encounter.status === "building"; i++) {
    const threat = s.threats.find((t) => t.status === "incoming");
    const next = [
      s.falling && { at: s.falling.stepAt, run: () => step(s) },
      threat && { at: threat.landsAt, run: () => land(s, threat) },
      !threat && s.watch && { at: s.watch.endsAt, run: () => (s.watch = { n: s.watch.n + 1, acts: 1, endsAt: s.watch.endsAt + RULES.WATCH_MS }) },
    ]
      .filter(Boolean)
      .sort((a, b) => a.at - b.at)[0];
    if (!next || next.at > target) break;
    s.clock = Math.max(s.clock, next.at);
    next.run();
  }
  s.clock = Math.max(s.clock, target);
  return { state: s, changed: true };
}

const fail = (error) => ({ error });

// Builder inputs act on the live falling stone. arg: move → dx (−9…9); rotate → turns (1…3); drop → "soft" | "hard".
export function builderAct(s, type, arg) {
  const st = s.encounter.status;
  if (type === "restart") {
    if (st === "building" || st === "waiting") return fail("round_in_progress");
    return { restart: true };
  }
  if (st === "waiting") return fail("waiting_for_watchman");
  if (st !== "building" || !s.falling) return fail("round_over");
  const f = s.falling;
  if (type === "move") {
    const dx = Number.isInteger(arg) ? arg : NaN;
    if (!(Math.abs(dx) >= 1 && Math.abs(dx) <= 9)) return fail("bad_arg");
    let cur = f;
    for (let i = 0; i < Math.abs(dx); i++) {
      const n = { ...cur, x: cur.x + Math.sign(dx) };
      if (!fits(s.grid, n)) break;
      cur = n;
    }
    s.falling = cur;
    return {};
  }
  if (type === "rotate") {
    const turns = arg === undefined ? 1 : arg;
    if (!Number.isInteger(turns) || turns < 1 || turns > 3) return fail("bad_arg");
    const r = { ...f, rot: (f.rot + turns) % 4 };
    for (const kick of [0, -1, 1, -2, 2]) {
      const k = { ...r, x: r.x + kick };
      if (fits(s.grid, k)) {
        s.falling = k;
        return {};
      }
    }
    return {}; // no room to turn: the stone stays as it was (not an error)
  }
  if (type === "drop") {
    const mode = arg ?? "hard";
    if (mode !== "soft" && mode !== "hard") return fail("bad_arg");
    if (mode === "soft") {
      step(s);
      if (s.falling) s.falling.stepAt = s.clock + RULES.TICK_MS;
      return {};
    }
    let cur = f;
    while (fits(s.grid, { ...cur, y: cur.y + 1 })) cur = { ...cur, y: cur.y + 1 };
    s.falling = cur;
    lock(s);
    return {};
  }
  return fail("unsupported_action");
}

// Watchman acts name their target (a threat id, a column, a quarry slot), so Builder motion never
// invalidates them (Oddie review §4). A late or repeated act fails on its target, not on the revision;
// the target is checked before the watch budget so a stale act says why.
export function watchmanAct(s, type, arg) {
  if (s.encounter.status === "waiting") return fail("waiting_for_builder");
  if (s.encounter.status !== "building") return fail("round_over");
  const spent = !s.watch || s.watch.acts < 1;
  if (type === "trumpet") {
    const t = s.threats.find((x) => x.id === arg);
    if (!t) return fail("unknown_threat");
    if (t.status !== "incoming" || t.trumpet) return fail("threat_closed");
    if (spent) return fail("watch_spent");
    t.trumpet = true;
    s.watch.acts -= 1;
    effect(s, `Trumpet sounds at the ${t.gate} Gate`, { side: t.side, gate: t.gate });
    return {};
  }
  if (type === "guard") {
    const cols = s.grid[0].length;
    if (!Number.isInteger(arg) || arg < 0 || arg >= cols) return fail("bad_arg");
    if (spent) return fail("watch_spent");
    s.guard = arg;
    s.watch.acts -= 1;
    effect(s, "A guard is posted at the low place", { col: arg });
    return {};
  }
  if (type === "set_next") {
    const slot = s.queue.findIndex((q) => q.id === arg);
    if (slot < 0) return fail("quarry_slot_gone");
    if (spent) return fail("watch_spent");
    const [stone] = s.queue.splice(slot, 1);
    s.queue.unshift({ ...stone, by: "watchman" });
    s.watch.acts -= 1;
    effect(s, `The Watchman sends the ${stone.kind} stone next`);
    return {};
  }
  return fail("unsupported_action");
}

// Read-only helpers for the seat slices.
export function landing(grid, f) {
  let cur = f;
  while (fits(grid, { ...cur, y: cur.y + 1 })) cur = { ...cur, y: cur.y + 1 };
  return cellsOf(cur);
}
export const secondsLeft = (s, at) => Math.max(0, Math.ceil((at - s.clock) / 1000));
