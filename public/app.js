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
function render(view) {
  $("seat-builder").textContent = view.seats?.builder ?? "open";
  $("seat-watchman").textContent = view.seats?.watchman ?? "open";
  const playing = view.encounter?.status === "building";
  const done = ["won", "lost"].includes(view.encounter?.status);
  $("status").textContent = view.encounter?.status === "waiting" ? "Waiting for your Watchman to join" :
    done ? view.encounter.outcome : "Build two courses at the Fish Gate";
  $("courses").textContent = `${view.encounter?.courses ?? 0} / ${view.encounter?.goal ?? 2} courses locked into the wall`;
  $("next").textContent = view.next ? `${view.next.kind} stone${view.next.by === "watchman" ? " · Watchman's pick" : ""}` : "—";
  $("cue").textContent = playing && view.cue?.length ? "A stir at the left edge. Talk to your Watchman." : "";
  $("restart").hidden = !done;
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
    if (phase !== "won" && phase !== "lost") $("restart").disabled = false;
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
          $("restart").disabled = false;
        } else $("notice").textContent = "That move could not be made. Your wall is safe.";
        return out;
      }
      $("notice").textContent = "";
      show(out.view ?? out);
      return out;
    } catch {
      $("notice").textContent = "Connection interrupted. Your finished courses are saved. Reconnecting…";
      if (body.action === "restart") $("restart").disabled = false; // let the Builder press it again
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
  $("restart").onclick = () => {
    if (!accepts(phase, "restart")) return;
    input("restart");
    $("restart").disabled = true; // one restart per finished round; re-enabled by the next view or a failure
    $("notice").textContent = "Starting the next round…";
  };
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
