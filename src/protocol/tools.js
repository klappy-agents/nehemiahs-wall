// The ONE tool surface: docs · execute · telemetry (klappy://canon/constraints/mcp-tool-surface-ceiling).
// HTTP twins at POST /v1/<tool> share these handlers with the MCP face.
export const DOCS = `Nehemiah's Wall — co-op Bible game (first play: one Fish Gate encounter). Dev only: no shared key, your own agent holds its own seat.
You are the Watchman. You never see the grid; you see sections, threats and the stone queue.
  execute { op: "create" } → { room, watchmanToken, builderLink }. Keep watchmanToken secret; give builderLink to your human (it opens the board; the token rides in the #fragment, never sent to the server).
  execute { room, cap: watchmanToken, op: "join" | "look" | "act", action?, expectedRev?, requestId? }
  execute { room, cap: watchmanToken, op: "invite", seat } → a single-use 15-minute claim code for another agent.
  execute { room, op: "claim", code } → that agent's own seat token (the previous holder of that seat is revoked).
  execute { room, cap: watchmanToken, op: "rotate", seat: "builder" } → a new builderLink; the old one stops working.
Errors: capability_required (missing/unknown/revoked token; HTTP 401) · seat_not_granted (the other seat) · rate_limited (+ retryAfter; HTTP 429) · room_cap_reached.
Limits: create 5/10 min per IP and 50/h per environment; execute 120/min per token; 30 bad tokens or 10 bad claim codes per IP per room per 10 min. Rooms never joined are deleted after 24 h, idle rooms after 7 days.
First play: one Fish Gate encounter. Two courses, one threat, a visible finish (about three minutes).
  The round starts when both seats have joined: join yourself, then send your human the builderLink.
  look (Watchman) → encounter { status waiting|building|won|lost, courses, goal }, threats [{ id, by, gate, side, secondsLeft, status }],
    queue [{ id, slot, kind }] (the quarry), watch { acts, secondsLeft }, guard, effects. Never the grid.
  You get ONE act per watch. The first watch lasts until the raid lands. Acts name their target, so the Builder's moves never make them stale:
    execute { op: "act", action: "trumpet", arg: <threat id> }  rally to that gate: the raid is turned back (Neh 4:20)
    execute { op: "act", action: "guard", arg: <column 0-9> }   post a guard (4:13): a landed raid's rubble row leaves that column open, for the rest of the round
    execute { op: "act", action: "set_next", arg: <quarry id> } send that stone next (e.g. the long stone; quarry_slot_gone if it already fell)
  An unanswered raid raises one row of rubble from the bottom (4:10). Rubble or stones at the top lose the round; the second finished course wins it.
  Errors on acts: watch_spent · threat_closed · unknown_threat · quarry_slot_gone · bad_arg · waiting_for_builder · round_over.
  answer_letter is not in this encounter (unsupported_action). Governing spec: docs/SPEC.md; auth: docs/AUTH.md.
Tool ceiling: klappy://canon/constraints/mcp-tool-surface-ceiling`;

import { validRoomId } from "../core/limits.js";
import { SEATS, granted } from "../core/game.js";
import { VERSION } from "../version.js";

// grant comes from the edge (src/auth.js). Key mode: the seats this caller holds, checked here and again in core.
// Capability mode: grant.roles is empty; the seat comes from the token, verified by the Room DO.
// ctx: { bearer, ip, origin } from the request (capability mode only).
export function makeHandlers(env, grant, ctx = {}) {
  const stub = (room) => env.ROOM.get(env.ROOM.idFromName(room));
  const capability = grant?.mode === "capability";
  return {
    async docs() {
      return { text: DOCS };
    },
    async execute(args = {}) {
      if (capability) return capExecute(args);
      const { room, seat = "watchman", op = "look", action = "noop", arg, expectedRev, requestId } = args;
      if (!validRoomId(room)) return { error: "room_capability_required" };
      if (!SEATS.includes(seat)) return { error: "unknown_seat" };
      if (!granted(grant, seat)) return { error: "seat_not_granted" };
      const s = stub(room);
      if (op === "look") return s.look(room, seat, grant);
      if (op === "join") return s.act(room, { seat, type: "join", requestId }, grant);
      if (op === "act") return s.act(room, { seat, type: action, arg, expectedRev, requestId }, grant);
      return { error: "unsupported_op" };
    },
    async telemetry() {
      return { environment: env.ENVIRONMENT ?? "unknown", version: VERSION, authMode: env.AUTH_MODE ?? "key", note: "counters arrive in M3" };
    },
  };

  async function capExecute({ room, seat, op = "look", action = "noop", arg, expectedRev, requestId, cap, code }) {
    if (op === "create") {
      const registry = env.REGISTRY.get(env.REGISTRY.idFromName("registry"));
      const made = await registry.capCreate(ctx.ip ?? "unknown");
      if (!made.ok) return { error: made.error, ...(made.retryAfter ? { retryAfter: made.retryAfter } : {}) };
      const init = await stub(made.room).capInit(made.room);
      if (!init.ok) return { error: init.error };
      return { room: made.room, seat: "watchman", watchmanToken: init.watchmanToken, builderLink: builderLink(made.room, init.builderToken) };
    }
    if (!validRoomId(room)) return { error: "room_capability_required" };
    if (seat !== undefined && !SEATS.includes(seat)) return { error: "unknown_seat" };
    if (op === "claim") return shape(await stub(room).capClaim(code, ctx.ip ?? "unknown"), room);
    const token = cap ?? ctx.bearer;
    if (!token) return { error: "capability_required" };
    if (!["look", "join", "act", "invite", "rotate"].includes(op)) return { error: "unsupported_op" };
    return shape(await stub(room).capCall(token, { op, seat, action, arg, expectedRev, requestId }, ctx.ip ?? "unknown"), room);
  }
  function builderLink(room, token) {
    return `${ctx.origin ?? ""}/r/${room}#cap=${token}`;
  }
  // A fresh Builder token is returned as a link (for a human); a Watchman token as a token (for an agent).
  function shape(res, room) {
    if (!res || res.ok !== true || !res.token) return res?.ok === false ? strip(res) : res;
    if (res.seat === "builder") return { ok: true, room, seat: "builder", builderLink: builderLink(room, res.token) };
    return { ok: true, room, seat: res.seat, watchmanToken: res.token };
  }
  function strip({ ok, ...rest }) {
    return rest;
  }
}
