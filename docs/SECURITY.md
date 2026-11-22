# Security note — scaffold (local, 2026-11-21)

These are pre-hosting fixes for the three gaps named in `GATE-RECEIPTS.md`. They are engineering bounds, not product decisions. D1–D10 stay open.

## 1. Auth fails closed
- **Modes:** `AUTH_MODE=key` is the default and is set explicitly in `wrangler.jsonc` for production and staging. Dev sets `AUTH_MODE=capability` (D10 agent-first, [AUTH.md](AUTH.md)). Capability mode is **code-gated** in `src/auth.js` to `ENVIRONMENT` `dev` or `local`: a staging/production var flip to `capability` is refused with 401, so unauthenticated room creation cannot open there before D10-a is decided.
- **Protected routes (key mode):** `/v1/docs`, `/v1/execute`, `/v1/telemetry` and `/mcp` all require `Authorization: Bearer <key>`. In dev capability mode `/mcp`, `docs` and `telemetry` are open and `execute` needs a per-room seat token (header or `cap` argument), except `create` and `claim`. A missing key, a wrong key or a missing configured key returns **401**. Only `/health` is public.
- **Keys:** keys are Worker secrets set per environment and are never in config or the repo. `MCP_KEY` grants the Watchman seat. `BUILDER_KEY` grants the Builder seat. **Dev (`nehemiahs-wall-dev`) now runs `AUTH_MODE: "capability"` instead (D10 agent-first, per-room seat tokens, no shared key; PRD: cookbook `design/proposals/2026-11-21-d10-agent-first-auth-prd.md` @ `ca36fb87`). In that mode these keys are never read. Staging and production stay `key` until D10-a is confirmed before staging goes public.**
- **Open mode:** `AUTH_MODE=open` is an explicit no-key local mode. It is honoured **only** when `ENVIRONMENT=local`, through an untracked `.dev.vars` (see `.dev.vars.example`) or `wrangler dev --var`. In any other environment it is refused with 401.

## 2. Builder and Watchman powers are separate
- **The rule lives in core** (`src/core/game.js`): `ROLE_ACTIONS`, `granted`, `view` and `act`.
- **Which seat a caller holds:** a caller holds only the seat(s) its key grants. Asking for another seat's look, join or act returns `seat_not_granted`. So a Watchman key can never receive the Builder slice, which carries the grid.
- **Cross-role actions:** an action belonging to the other role (for example Watchman `drop`, Builder `trumpet`) returns `cross_role_action`, even under the local open-mode grant.
- **Where it's checked:** at the edge (`tools.js`) and again in core.
- **Action names:** these come from `docs/SPEC.md`. Only `join` and `noop` are implemented; the rules for the rest arrive in M2.

## 3. Rooms and storage are bounded
| Bound | Value | Why |
| --- | --- | --- |
| Rooms per environment | **200** (hard ceiling; `MAX_ROOMS` may only lower it) | v1 is a private playtest with one Builder and one Watchman per room. 200 leaves wide headroom for the persona harness matrix (15 runs) plus repeats, while capping storage and abuse. New rooms past the cap return `room_cap_reached` and are not created. In dev capability mode a room's slot is freed when its TTL alarm deletes it (24 h never joined, 7 days idle) |
| Room creation (dev capability) | **5 / 10 min per IP, 50 / h per env** | Over the limit → 429 `rate_limited` + `retry-after`. IPs are bucketed (IPv6 by /64) and stored only as salted, truncated hashes in one pruned map |
| Seat-token calls (dev capability) | **120 / min per token; 30 bad tokens and 10 bad claim codes per IP per room per 10 min** | Only failures count toward the bad-token/claim limits, per address, so spam from one IP cannot lock out a legitimate holder |
| State per room | **64 KiB** serialized | A full room (14×10 grid plus a log capped at 200 entries) measures ~20–30 KB. Writes over the bound return `state_too_large` and are not stored |
| Request body | **8 KiB** | An execute call is under 1 KB. Larger bodies return 413 before any room call, `/mcp` included |
| Room id | 16–64 chars, `[A-Za-z0-9_-]` | 22-char base64url ids from 16 random bytes: minted by the client in key mode, by the `RoomRegistry` on `create` in dev capability mode |

- **What creates a room:** in key mode only a `join` creates one; a `look` on an unknown room returns `room_not_found`. In dev capability mode only `execute { op: "create" }` creates one, and seat-token calls on an unknown room return `capability_required`.
- **How the cap is counted:** by the `RoomRegistry` Durable Object, one per environment and single-threaded, so the check and the insert are atomic.

## Still open
- **The browser shell can't play under key mode yet.** `public/app.js` calls `/v1/execute` without a key, and how the Builder credential reaches the browser is D10, a captain decision. Under key mode the browser gets 401 until D10 is decided. Planned direction (no shared user keys; per-room seat capabilities via the link fragment): [AUTH.md](AUTH.md). **Dev capability mode (implemented):** the browser reads its Builder capability from the link fragment `#cap=…` (never sent to the server), clears it from the address bar, and sends it as Bearer. With no capability it shows "ask your agent for your room link".
- **Seat binding (key mode only):** there is no binding of a seat to one holder. Anyone holding the Watchman key can be the Watchman in any room they know the id of. Dev capability mode binds each seat to one token holder per room.
- **Unbuilt pieces (key mode, staging/production):** no room retention or expiry, no freeing of registry slots, no rate limiting, and no key rotation runbook. Dev capability mode has all four (TTL alarm, slot release, rate limits, `rotate`); see [AUTH.md](AUTH.md).
