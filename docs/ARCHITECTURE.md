# Architecture

This architecture is mostly borrowed:
- [Cloudflare Durable Objects](https://developers.cloudflare.com/durable-objects/): one object per room as the single writer.
- The official [MCP SDK](https://github.com/modelcontextprotocol/typescript-sdk): Streamable HTTP.
- Cloudflare Workers Builds: git-hook deploys.
- [klappy/hud](https://github.com/klappy/hud): capability-URL access and the touchscreen Worker UI.

The 1:1 HTTP twins and the pure `src/core/` are this project's own design.

*Correction, captain 2026-11-21 7:42 PM ET: ARS not used.* ARS is `klappy/agent-role-service`, which an earlier draft cited as the source of this shape.

```
browser (Builder) ──HTTP /v1/execute──┐
                                      ├─► Worker (src/index.js) ──► Room DO (src/room.js) ──► pure core (src/core/game.js)
Oddie sidecar (Watchman) ──MCP /mcp───┘          └─ static assets (public/)
```

| Path | Role |
| --- | --- |
| `src/index.js` | Worker entry; exports `Room` and `RoomRegistry` and hands every request to `src/router.js` |
| `src/router.js` | Edge routing: `/health` (public), `/mcp` and `/v1/<tool>` twins (all keyed, body-size bounded), `/r/<room>`, which serves the client shell, and static assets |
| `src/auth.js` | Fails closed. `AUTH_MODE=key` everywhere: `MCP_KEY` grants the Watchman seat and `BUILDER_KEY` the Builder seat. Open no-key mode only when `ENVIRONMENT=local` (see `docs/SECURITY.md`) |
| `src/core/limits.js` | Pure caps: room count, state size, body size and room-id shape |
| `src/room.js` | `Room` Durable Object, SQLite-backed. The single writer: it creates tables only on an explicit join admitted by `RoomRegistry` (the per-environment room cap), applies capability-checked actions (`core.act`) and stores the snapshot only if it is within the size bound |
| `src/core/game.js` | Pure rules with clock and seed injected. Tables, seat slices, apply/reject. No I/O |
| `src/protocol/tools.js` | The one tool surface: `docs`, `execute`, `telemetry` (tool ceiling canon) |
| `src/protocol/mcp.js` | `@modelcontextprotocol/sdk` 1.32.2, `WebStandardStreamableHTTPServerTransport`, stateless, JSON responses |
| `public/` | Client shell (stone-and-dusk tokens). The engine is undecided (D9) |
| `wrangler.jsonc` | `env.dev` → `nehemiahs-wall-dev`, `env.staging` → `nehemiahs-wall-staging`, top level → `nehemiahs-wall` (production). Each is its own Worker with its own `Room` namespace |
| `.github/workflows/ci.yml` | `npm ci`, `npm test`, `wrangler deploy --dry-run --env dev` (bundles, never deploys) |

## Environments and deploys
These follow [per-environment-worker-projects](https://github.com/klappy/klappy.dev/blob/main/canon/constraints/per-environment-worker-projects.md): dev, staging and production are separate Workers with their own Durable Object state. There are no preview deploys.

Deploys go through **Workers Builds git hooks only**, with `wrangler.jsonc` as config. Nobody runs a wrangler CLI workflow by hand. The planned Workers Builds triggers:

| Worker | Branch | Deploy command |
| --- | --- | --- |
| `nehemiahs-wall-dev` | `main` | `npx wrangler deploy --env dev` |
| `nehemiahs-wall-staging` | `staging` | `npx wrangler deploy --env staging` |
| `nehemiahs-wall` (production) | `production` | `npx wrangler deploy`. Created only after the captain's production go |

**Resolved (2026-11-21, ~9:31 PM ET):** the repo moved to `klappy/nehemiahs-wall`. Workers Builds sees it (repo connection under GitHub owner id 118073); `nehemiahs-wall-dev` has a `main`-only trigger (`npm ci && npm test`, then `npx wrangler deploy --env dev`), and the first build deployed `56f6a003` to https://nehemiahs-wall-dev.klappy.workers.dev. *History:* at ~18:07 ET `config_autofill` returned 404 / 12000 for the old `klappy-agents/nehemiahs-wall` location.

## MCP
- Endpoint: `https://<worker>/mcp` (Streamable HTTP, stateless).
- Tools: `docs`, `execute { room, seat, op: join | look | act, action, expectedRev, requestId }` and `telemetry`.
- The Watchman's `look` omits the grid.
- Stale revisions, duplicate request ids, unknown seats and unsupported actions are rejected without mutating the room.
- MCP App (`ui://`, `text/html;profile=mcp-app`): planned for M7 and unverified.
