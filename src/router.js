import { handleMcp } from "./protocol/mcp.js";
import { makeHandlers } from "./protocol/tools.js";
import { authenticate } from "./auth.js";
import { LIMITS } from "./core/limits.js";

const json = (v, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });

async function readBody(request) {
  const declared = Number(request.headers.get("content-length") || 0);
  if (declared > LIMITS.MAX_BODY_BYTES) return { tooLarge: true };
  const text = await request.text();
  if (new TextEncoder().encode(text).length > LIMITS.MAX_BODY_BYTES) return { tooLarge: true };
  try {
    return { body: text ? JSON.parse(text) : {} };
  } catch {
    return { body: {} };
  }
}

export async function route(request, env) {
  const url = new URL(request.url);
  if (url.pathname === "/health") return json({ ok: true, app: "nehemiahs-wall", environment: env.ENVIRONMENT, version: env.VERSION });

  const twin = url.pathname.match(/^\/v1\/(docs|execute|telemetry)$/);
  if (url.pathname === "/mcp" || (twin && request.method === "POST")) {
    const auth = authenticate(request, env); // every tool route, MCP and HTTP twin alike
    if (!auth.ok) return json({ error: auth.error }, 401);
    if (Number(request.headers.get("content-length") || 0) > LIMITS.MAX_BODY_BYTES) return json({ error: "body_too_large" }, 413);
    if (url.pathname === "/mcp") {
      if (request.method !== "POST") return handleMcp(request, env, auth.grant);
      const text = await request.text(); // re-read so a body without content-length is still bounded
      if (new TextEncoder().encode(text).length > LIMITS.MAX_BODY_BYTES) return json({ error: "body_too_large" }, 413);
      return handleMcp(new Request(request.url, { method: "POST", headers: request.headers, body: text }), env, auth.grant);
    }
    const { body, tooLarge } = await readBody(request);
    if (tooLarge) return json({ error: "body_too_large" }, 413);
    return json(await makeHandlers(env, auth.grant)[twin[1]](body));
  }
  if (url.pathname.startsWith("/r/")) return env.ASSETS.fetch(new Request(new URL("/", url), request));
  return env.ASSETS.fetch(request);
}
