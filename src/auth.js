// Edge auth. Fails closed: no configured key → every protected route 401s.
// AUTH_MODE "key" (default, and what wrangler.jsonc sets for every environment):
//   MCP_KEY grants the Watchman seat; BUILDER_KEY grants the Builder seat. One key → one role.
// AUTH_MODE "capability" (D10 agent-first, dev): no shared key. The edge admits the open transport and only
//   extracts the caller's Bearer seat token; the Room Durable Object verifies it (core/caps.js). MCP_KEY /
//   BUILDER_KEY are not read in this mode, so they can never become a user-access path.
// AUTH_MODE "open": explicit no-key local mode, honoured ONLY when ENVIRONMENT === "local"
//   (set in your own untracked .dev.vars; see .dev.vars.example). Anywhere else it is refused.
const ROLE_KEYS = [
  ["MCP_KEY", "watchman"],
  ["BUILDER_KEY", "builder"],
];

function sameSecret(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length === 0 || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// → { ok: true, grant: { roles } } | { ok: false, error }
export function authenticate(request, env) {
  const mode = env.AUTH_MODE ?? "key";
  if (mode === "open") {
    if (env.ENVIRONMENT === "local") return { ok: true, grant: { roles: ["builder", "watchman"], mode: "open-local" } };
    return { ok: false, error: "unauthorized" }; // open mode outside local is a misconfiguration: refuse
  }
  if (mode === "capability") return { ok: true, grant: { roles: [], mode: "capability" }, bearer: bearerOf(request) };
  if (mode !== "key") return { ok: false, error: "unauthorized" };
  const header = request.headers.get("authorization") || "";
  const m = header.match(/^Bearer\s+(.+)$/i);
  if (!m) return { ok: false, error: "unauthorized" };
  const got = m[1].trim();
  const roles = ROLE_KEYS.filter(([name]) => sameSecret(got, env[name])).map(([, role]) => role);
  if (roles.length === 0) return { ok: false, error: "unauthorized" };
  return { ok: true, grant: { roles, mode: "key" } };
}

export function bearerOf(request) {
  const m = (request.headers.get("authorization") || "").match(/^Bearer\s+(\S+)\s*$/i);
  return m ? m[1] : null;
}
