// Temporary first-play UI, not a D1–D8 decision. Server-authoritative snapshots, no engine choice.
// The Builder's capability arrives in the link fragment, is kept for this room in sessionStorage,
// removed from the address bar, and sent only as Bearer (never a path or query).
const $ = (id) => document.getElementById(id);

function roomFromPath() {
  const m = location.pathname.match(/^\/r\/([A-Za-z0-9_-]{16,64})$/);
  return m ? m[1] : null;
}
function takeCap(room) {
  const frag = new URLSearchParams(location.hash.slice(1)).get("cap");
  if (frag) {
    sessionStorage.setItem(`cap:${room}`, frag);
    history.replaceState(null, "", location.pathname);
  }
  return sessionStorage.getItem(`cap:${room}`);
}
// A call that never settles would leave the client busy forever (a frozen board), so each one is bounded.
const CALL_TIMEOUT_MS = 8000;
function makeCall(cap) {
  return (body) => {
    const ctl = typeof AbortController === "function" ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => ctl.abort(), CALL_TIMEOUT_MS) : null;
    return fetch("/v1/execute", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${cap}` },
      body: JSON.stringify(body),
      ...(ctl ? { signal: ctl.signal } : {}),
    }).then((r) => r.json()).finally(() => timer && clearTimeout(timer));
  };
}
function askAgent() {
  $("room-line").textContent = "Ask your agent for your room link. (Your agent creates the room and sends you a private Builder link.)";
  $("begin").hidden = true;
  $("copy").hidden = true;
  $("board").hidden = true;
}
// Round-end, raid and Watchman notices (ticket fish-gate-ux-pass). The Builder slice carries a side-only raid
// cue and no timer, so "how soon" is an estimate: game seconds since "The work begins" against the rules' lead.
const RAID_LEAD_S = 30; // src/core/rules.js RULES.THREAT_LEAD_MS / 1000
const ACT_SHOW_MS = 6000; // a Watchman act notice stays up at least this long (ticket: ≥ 4 s)
const AFTER_RAID_S = 8; // how long the raid's result stays in the raid notice
const WATCH_ACTS = [
  { re: /^Trumpet sounds/, label: "Trumpet", say: (e) => `${e.text}. The raid will be turned back.` },
  { re: /^A guard is posted/, label: "Guard", say: (e) => `A guard is posted at column ${(e.col ?? 0) + 1} from the left. The raid's gap will open there.` },
  { re: /^The Watchman sends/, label: "Next stone", say: (e) => `${e.text}.` },
];
const ui = { round: null, startedAt: null, known: false, seen: new Set(), act: null, calls: [] };
const clockOf = (ms) => { const t = Math.max(0, Math.round((ms ?? 0) / 1000)); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`; };
const sideWord = (side) => (side ? `the ${side}` : "the edge");
function track(view) {
  const now = Date.now();
  const round = view.encounter?.round ?? null;
  const effects = view.effects ?? [];
  if (round !== ui.round) {
    ui.round = round;
    ui.startedAt = now;
    ui.known = false;
    ui.seen = new Set();
    ui.act = null;
    ui.calls = [];
    if (round > 1) $("howto").open = false; // first-time guidance stays open for round 1 only
  }
  const begun = effects.find((e) => /^The work begins/.test(e.text));
  if (begun) { ui.startedAt = now - (begun.ago ?? 0) * 1000; ui.known = true; }
  for (const e of effects) {
    const kind = WATCH_ACTS.find((k) => k.re.test(e.text ?? ""));
    const key = `${e.at}|${e.text}`;
    if (!kind || ui.seen.has(key)) continue;
    ui.seen.add(key);
    ui.calls.push({ at: e.at, line: `${clockOf(e.at)} · ${kind.label}: ${e.text}` });
    if ((e.ago ?? 0) * 1000 < ACT_SHOW_MS) ui.act = { label: kind.label, text: kind.say(e), shownAt: now };
  }
}
function raidLine(view, playing) {
  const effects = view.effects ?? [];
  const trumpet = effects.find((e) => /^Trumpet sounds/.test(e.text));
  if (playing && view.cue?.length) {
    const c = view.cue[0];
    const left = Math.ceil(RAID_LEAD_S - (Date.now() - ui.startedAt) / 1000);
    // Joined mid-round without the round's first line: no honest estimate, so say so.
    const when = !ui.known ? "landing soon (your Watchman sees the timer)" : left > 1 ? `lands in about ${left} s` : "lands any moment now";
    const where = `from ${sideWord(c.side)}${trumpet?.gate ? ` at the ${trumpet.gate} Gate` : ""}`;
    return trumpet ? `Raid coming ${where}, ${when}. The trumpet has sounded: it will be turned back.`
      : `Raid coming ${where}, ${when}. It will push up a row of rubble. Ask your Watchman to sound the trumpet or post a guard.`;
  }
  const after = effects.filter((e) => /^Raid/.test(e.text) && (e.ago ?? 0) < AFTER_RAID_S).at(-1);
  if (playing && after) return after.text === "Raid turned back" ? `The raid from ${sideWord(after.side)} was turned back.` : `The raid hit from ${sideWord(after.side)}: a row of rubble rose at the bottom.`;
  return "";
}
function render(view) {
  $("seat-builder").textContent = view.seats?.builder ?? "open";
  $("seat-watchman").textContent = view.seats?.watchman ?? "open";
  track(view);
  const st = view.encounter?.status;
  const playing = st === "building";
  const done = st === "won" || st === "lost";
  $("status").textContent = st === "waiting" ? "Waiting for your Watchman to join" :
    st === "won" ? "You won! The Fish Gate doors are hung." :
    st === "lost" ? "Round lost" : "Build two courses at the Fish Gate";
  $("status").className = st === "won" ? "won" : st === "lost" ? "lost" : "";
  $("end").hidden = !done;
  $("end-cause").textContent = st === "won" ? "Two courses are locked into the wall. Press Next round to build again." :
    st === "lost" ? `Why it stopped: ${view.encounter.outcome ?? "the wall could not hold"}.` : "";
  $("next-round").hidden = st !== "won"; // a win moves on: never "Try again" after a win
  $("restart").hidden = st !== "lost"; // "Try again" only after a loss
  $("courses").textContent = `${view.encounter?.courses ?? 0} / ${view.encounter?.goal ?? 2} courses locked into the wall`;
  $("next").textContent = view.next ? `${view.next.kind} stone${view.next.by === "watchman" ? " · Watchman's pick" : ""}` : "—";
  const raid = raidLine(view, playing);
  $("raid").textContent = raid;
  $("raid").hidden = !raid;
  const act = ui.act && Date.now() - ui.act.shownAt < ACT_SHOW_MS ? ui.act : null;
  $("watch-act").textContent = act ? `Watchman just acted · ${act.label}. ${act.text}` : "";
  $("watch-act").hidden = !act;
  $("calls").replaceChildren(...ui.calls.slice(-5).reverse().map((c) => { const li = document.createElement("li"); li.textContent = c.line; return li; }));
  $("calls-empty").hidden = ui.calls.length > 0;
  for (const id of ["left", "right", "turn", "soft", "drop"]) $(id).disabled = !playing;
  const f = view.falling;
  const has = (cells, x, y) => (cells ?? []).some(([a, b]) => a === x && b === y);
  const nodes = (view.grid ?? []).flatMap((row, y) => row.map((v, x) => {
    const i = document.createElement("i");
    i.className = [v === 2 ? "rubble" : v ? "set" : "", has(f?.landing, x, y) && !v ? "landing" : "", has(f?.cells, x, y) ? `falling ${f.by === "watchman" ? "picked" : ""}` : "", view.guard === x ? "guarded" : ""].filter(Boolean).join(" ");
    return i;
  }));
  $("field").replaceChildren(...nodes);
  // Permanent built wall below the playfield: a completed course never consumes play space.
  $("wall").replaceChildren(...Array.from({ length: Math.min(2, view.encounter?.courses ?? 0) }, () => {
    const row = document.createElement("div"); row.className = "saved-course"; return row;
  }));
  $("effects").textContent = (view.effects ?? []).filter((e) => e.ago < 12 || done).map((e) => e.text).join(" · ");
}
// The seat allows 120 calls a minute, so the client sends at most one call per GAP ms. Taps that arrive
// in between are coalesced (three quick lefts become one move of −3) instead of being dropped.
const GAP = 520;
function coalesce(queue, action, arg) {
  const tail = queue[queue.length - 1];
  if (tail && action === "move" && tail.action === "move" && Math.abs(tail.arg + arg) <= 9) {
    tail.arg += arg;
    if (tail.arg === 0) queue.pop();
    return queue;
  }
  if (tail && action === "rotate" && tail.action === "rotate") {
    tail.arg = ((tail.arg ?? 1) % 4) + 1;
    if (tail.arg === 4) queue.pop();
    return queue;
  }
  if (queue.length < 6) queue.push({ action, ...(arg !== undefined ? { arg } : {}) });
  return queue;
}
// Move, rotate and drop only make sense while the round is building; restart only once it is won or lost.
// Taps that arrive in the wrong phase are not queued: a queue full of stale drops used to swallow the restart.
const STONE_ACTS = new Set(["move", "rotate", "drop"]);
function accepts(phase, action) {
  if (action === "restart") return phase === "won" || phase === "lost";
  return STONE_ACTS.has(action) && phase === "building";
}
// Restart jumps the line: any stone taps still waiting are for the finished round and can only fail.
function enqueue(queue, phase, action, arg) {
  if (!accepts(phase, action)) return queue;
  if (action === "restart") {
    queue.length = 0;
    queue.push({ action });
    return queue;
  }
  return coalesce(queue, action, arg);
}
const endDisabled = (v) => { $("restart").disabled = v; $("next-round").disabled = v; };
async function enter(room, cap) {
  const call = makeCall(cap);
  const pending = [];
  let busy = false;
  let last = 0;
  let lastInput = 0;
  let stopped = false;
  let waitUntil = 0;
  let phase = null; // encounter status from the latest view: waiting | building | won | lost
  function show(v) {
    const before = phase;
    phase = v?.encounter?.status ?? phase;
    // The round just ended (or restarted under us): taps queued for the old phase can never land.
    if (phase !== before) for (let i = pending.length - 1; i >= 0; i--) if (!accepts(phase, pending[i].action)) pending.splice(i, 1);
    if (phase !== "won" && phase !== "lost") endDisabled(false);
    render(v);
  }
  async function send(body) {
    busy = true;
    last = Date.now();
    try {
      const out = await call({ room, seat: "builder", ...body });
      if (out.error === "capability_required" || out.error === "seat_not_granted") { stopped = true; askAgent(); return; }
      if (out.error === "rate_limited") {
        waitUntil = Date.now() + (out.retryAfter ?? 5) * 1000;
        // A rate-limited call never reached the rules, so a restart is kept and goes out after the wait.
        if (body.action === "restart" && !pending.length) pending.push({ action: "restart" });
        $("notice").textContent = "Rest a moment. Reconnecting to your wall…";
        return;
      }
      if (out.error) {
        if (["round_over", "round_in_progress", "waiting_for_watchman"].includes(out.error)) {
          // Our picture of the round is out of date: drop queued taps and look again right away.
          for (let i = pending.length - 1; i >= 0; i--) if (STONE_ACTS.has(pending[i].action)) pending.splice(i, 1);
          last = 0;
          lastInput = 0;
          endDisabled(false);
        } else $("notice").textContent = "That move could not be made. Your wall is safe.";
        return out;
      }
      $("notice").textContent = "";
      show(out.view ?? out);
      return out;
    } catch {
      $("notice").textContent = "Connection interrupted. Your finished courses are saved. Reconnecting…";
      if (body.action === "restart") endDisabled(false); // let the Builder press it again
    } finally { busy = false; }
  }
  function pump() {
    const now = Date.now();
    if (stopped || busy || now < waitUntil || now - last < GAP) return;
    const next = pending.shift();
    if (next) {
      lastInput = now;
      send({ op: "act", ...next, requestId: crypto.randomUUID() });
    } else if (now - lastInput > 1500 && now - last >= 1500) send({ op: "look" });
  }
  const joined = await send({ op: "join", requestId: crypto.randomUUID() });
  if (stopped || !joined) return;
  $("room-line").textContent = "Your wall is ready. Your agent holds the Watchman seat.";
  $("begin").hidden = true;
  $("board").hidden = false;
  const input = (action, arg) => { enqueue(pending, phase, action, arg); pump(); };
  $("left").onclick = () => input("move", -1);
  $("right").onclick = () => input("move", 1);
  $("turn").onclick = () => input("rotate");
  $("soft").onclick = () => input("drop", "soft");
  $("drop").onclick = () => input("drop", "hard");
  // "Next round" (after a win) and "Try again" (after a loss) both send the existing restart act.
  const again = () => {
    if (!accepts(phase, "restart")) return;
    input("restart");
    endDisabled(true); // one restart per finished round; re-enabled by the next view or a failure
    $("notice").textContent = "Starting the next round…";
  };
  $("restart").onclick = again;
  $("next-round").onclick = again;
  document.onkeydown = (e) => {
    if (e.altKey || e.ctrlKey || e.metaKey || e.repeat) return;
    const k = { ArrowLeft: ["move", -1], ArrowRight: ["move", 1], ArrowUp: ["rotate"], ArrowDown: ["drop", "soft"], " ": ["drop", "hard"] }[e.key];
    if (!k) return;
    e.preventDefault();
    input(...k);
  };
  await send({ op: "look" });
  setInterval(pump, 100);
}
const room = roomFromPath();
const cap = room ? takeCap(room) : null;
if (room && cap) enter(room, cap);
else askAgent();
