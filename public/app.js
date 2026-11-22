// Static client shell. Reads the Builder's slice from the room; the server is authoritative.
// D10 agent-first: the Builder's capability arrives in the link fragment (#cap=…), which browsers never send
// to the server. It is kept in sessionStorage for this room, removed from the address bar, and sent as Bearer.
const $ = (id) => document.getElementById(id);

function roomFromPath() {
  const m = location.pathname.match(/^\/r\/([A-Za-z0-9_-]{16,64})$/);
  return m ? m[1] : null;
}
function takeCap(room) {
  const frag = new URLSearchParams(location.hash.slice(1)).get("cap");
  if (frag) {
    sessionStorage.setItem(`cap:${room}`, frag);
    history.replaceState(null, "", location.pathname); // fragment gone from the URL (and from history) after load
  }
  return sessionStorage.getItem(`cap:${room}`);
}
function makeCall(cap) {
  return (body) =>
    fetch("/v1/execute", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${cap}` },
      body: JSON.stringify(body),
    }).then((r) => r.json());
}
function askAgent() {
  $("room-line").textContent = "Ask your agent for your room link. (Your agent creates the room and sends you a private Builder link.)";
  $("begin").hidden = true;
  $("copy").hidden = true;
}
function render(view) {
  $("seat-builder").textContent = view.seats?.builder ?? "open";
  $("seat-watchman").textContent = view.seats?.watchman ?? "open";
  const field = $("field");
  field.replaceChildren(...(view.grid ?? []).flat().map((v) => { const i = document.createElement("i"); if (v) i.className = "set"; return i; }));
}
async function enter(room, cap) {
  const call = makeCall(cap);
  const joined = await call({ room, seat: "builder", op: "join", requestId: crypto.randomUUID() });
  if (joined.error === "capability_required") return askAgent();
  $("room-line").textContent = "Your wall is ready. Your agent holds the Watchman seat.";
  $("begin").hidden = true;
  $("board").hidden = false;
  const tick = async () => {
    const v = await call({ room, seat: "builder", op: "look" });
    if (v.error === "capability_required") return askAgent();
    render(v);
  };
  await tick();
  setInterval(tick, 2000);
}
const room = roomFromPath();
const cap = room ? takeCap(room) : null;
if (room && cap) enter(room, cap);
else askAgent(); // fail closed: no capability, no board
