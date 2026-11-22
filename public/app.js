// Static client shell. Reads the Builder's slice from the room; the server is authoritative.
const $ = (id) => document.getElementById(id);
const call = (body) => fetch("/v1/execute", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());

function roomFromPath() {
  const m = location.pathname.match(/^\/r\/([A-Za-z0-9_-]{16,})$/);
  return m ? m[1] : null;
}
function newRoomId() {
  const b = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...b)).replace(/[+/=]/g, (c) => ({ "+": "-", "/": "_", "=": "" })[c]);
}
function render(view) {
  $("seat-builder").textContent = view.seats?.builder ?? "open";
  $("seat-watchman").textContent = view.seats?.watchman ?? "open";
  const field = $("field");
  field.replaceChildren(...(view.grid ?? []).flat().map((v) => { const i = document.createElement("i"); if (v) i.className = "set"; return i; }));
}
async function enter(room) {
  $("room-line").textContent = "Your wall is ready. Share the link with your Watchman.";
  $("copy").hidden = false;
  $("copy").onclick = () => navigator.clipboard?.writeText(location.href);
  await call({ room, seat: "builder", op: "join", requestId: crypto.randomUUID() });
  $("board").hidden = false;
  const tick = async () => render(await call({ room, seat: "builder", op: "look" }));
  await tick();
  setInterval(tick, 2000);
}
$("begin").onclick = () => {
  const room = roomFromPath() ?? newRoomId();
  if (!roomFromPath()) history.replaceState(null, "", `/r/${room}`);
  enter(room);
};
if (roomFromPath()) enter(roomFromPath());
