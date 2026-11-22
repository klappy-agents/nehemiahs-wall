// The ONE tool surface: docs · execute · telemetry (klappy://canon/constraints/mcp-tool-surface-ceiling).
// HTTP twins at POST /v1/<tool> share these handlers with the MCP face.
export const DOCS = `Nehemiah's Wall — co-op Bible game (scaffold).
You are the Watchman. You never see the grid; you see sections, threats and the stone queue.
No shared key. Your own agent gets its own room capability:
  execute { op: "create" } → { room, watchmanToken, builderLink }. Keep watchmanToken; give builderLink to your human (it opens the board, no paste).
  execute { room, cap: watchmanToken, op: "join" | "look" | "act", action?, expectedRev?, requestId? }
  execute { room, cap: watchmanToken, op: "invite", seat } → a single-use 15-minute claim code for another agent.
  execute { room, op: "claim", code } → that agent's own seat token.
  execute { room, cap: watchmanToken, op: "rotate", seat: "builder" } → a new builderLink; the old one stops working.
A token grants one seat. Missing/unknown token → capability_required; the other seat → seat_not_granted.
Scaffold stage: only join/look/noop exist. Rules arrive in M2. Governing spec: docs/SPEC.md; auth: docs/AUTH.md.
Tool ceiling: klappy://canon/constraints/mcp-tool-surface-ceiling`;

import { validRoomId } from "../core/limits.js";
import { SEATS, granted } from "../core/game.js";
import { sha256hex } from "../core/caps.js";

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
      const { room, seat = "watchman", op = "look", action = "noop", expectedRev, requestId } = args;
      if (!validRoomId(room)) return { error: "room_capability_required" };
      if (!SEATS.includes(seat)) return { error: "unknown_seat" };
      if (!granted(grant, seat)) return { error: "seat_not_granted" };
      const s = stub(room);
      if (op === "look") return s.look(room, seat, grant);
      if (op === "join") return s.act(room, { seat, type: "join", requestId }, grant);
      if (op === "act") return s.act(room, { seat, type: action, expectedRev, requestId }, grant);
      return { error: "unsupported_op" };
    },
    async telemetry() {
      return { environment: env.ENVIRONMENT ?? "unknown", version: env.VERSION ?? "0.0.0-scaffold", authMode: env.AUTH_MODE ?? "key", note: "counters arrive in M3" };
    },
  };

  async function capExecute({ room, seat, op = "look", action = "noop", expectedRev, requestId, cap, code }) {
    if (op === "create") {
      const registry = env.REGISTRY.get(env.REGISTRY.idFromName("registry"));
      const made = await registry.capCreate(await sha256hex(`ip:${ctx.ip ?? "unknown"}`));
      if (!made.ok) return { error: made.error, ...(made.retryAfter ? { retryAfter: made.retryAfter } : {}) };
      const init = await stub(made.room).capInit(made.room);
      if (!init.ok) return { error: init.error };
      return { room: made.room, seat: "watchman", watchmanToken: init.watchmanToken, builderLink: builderLink(made.room, init.builderToken) };
    }
    if (!validRoomId(room)) return { error: "room_capability_required" };
    if (seat !== undefined && !SEATS.includes(seat)) return { error: "unknown_seat" };
    if (op === "claim") return shape(await stub(room).capClaim(code), room);
    const token = cap ?? ctx.bearer;
    if (!token) return { error: "capability_required" };
    if (!["look", "join", "act", "invite", "rotate"].includes(op)) return { error: "unsupported_op" };
    return shape(await stub(room).capCall(token, { op, seat, action, expectedRev, requestId }), room);
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
