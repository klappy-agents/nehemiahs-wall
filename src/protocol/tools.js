// The ONE tool surface: docs · execute · telemetry (klappy://canon/constraints/mcp-tool-surface-ceiling).
// HTTP twins at POST /v1/<tool> share these handlers with the MCP face.
export const DOCS = `Nehemiah's Wall — co-op Bible game (scaffold).
You are the Watchman. You never see the grid; you see sections, threats and the stone queue.
execute { room, seat, op: "join" | "look" | "act", action?, expectedRev?, requestId? }\nYour key grants one seat (the MCP key is the Watchman). Other seats return seat_not_granted.
Scaffold stage: only join/look/noop exist. Rules arrive in M2. Governing spec: docs/SPEC.md.
Tool ceiling: klappy://canon/constraints/mcp-tool-surface-ceiling`;

import { validRoomId } from "../core/limits.js";
import { SEATS, granted } from "../core/game.js";

// grant comes from the edge (src/auth.js): the seats this caller holds. Checked here and again in core.
export function makeHandlers(env, grant) {
  const stub = (room) => env.ROOM.get(env.ROOM.idFromName(room));
  return {
    async docs() {
      return { text: DOCS };
    },
    async execute({ room, seat = "watchman", op = "look", action = "noop", expectedRev, requestId }) {
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
      return { environment: env.ENVIRONMENT ?? "unknown", version: env.VERSION ?? "0.0.0-scaffold", note: "counters arrive in M3" };
    },
  };
}
