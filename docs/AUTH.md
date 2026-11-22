# Auth: D10 agent-first room capabilities (implemented on dev only)

**Status:** implemented on `nehemiahs-wall-dev` only (`AUTH_MODE: "capability"`, `src/core/caps.js`), 2026-11-21. Staging and production stay `key`. D10 stays the named open fork (D10-a) until confirmed before staging goes public. The full PRD is in the private cookbook: `klappy/nehemiahs-wall-cookbook` `design/proposals/2026-11-21-d10-agent-first-auth-prd.md`.

**Direction (captain, 2026-11-21, relayed, sanitized):** 9:38 PM ET: no handing out MCP keys to everyone, since it is not scalable; every user uses their own agent. 9:40 PM ET: "Later we can add email."

## Model
- **No shared keys for users.** `MCP_KEY` / `BUILDER_KEY` are never a user-access path. If they are set on dev, they are an internal operator smoke credential only, disabled when unset.
- **Per-seat room capabilities.** A seat token is 32 CSPRNG bytes (base64url), scoped to one room, one seat and an expiry. The Room Durable Object stores only `SHA-256(token)`. Revocation is deletion. There is no global signing secret.
- **Create:** any agent connects to `/mcp` with no key and calls `execute { op: "create" }`. That returns `room`, a `watchmanToken` for the agent, and `builderLink = /r/<room>#cap=<builderToken>` for its human.
- **Browser:** `app.js` reads `#cap` from the fragment (never sent to the server, so never logged), clears it from the address bar, and sends it as `Authorization: Bearer`. With no `#cap`, it fails closed.
- **Joining agent:** the Watchman makes `invite` → a single-use 15-minute claim code. The joiner calls `claim` → its own seat token. `rotate` revokes and re-issues a link.
- **`/mcp`:** an open transport. `docs`/`telemetry` need no key. `execute` needs a seat token (header, or the `cap` argument for MCP clients). Still three tools: `create`/`invite`/`claim`/`rotate` are `execute` ops.

## Fail-closed and abuse bounds
- Missing, unknown, expired or foreign tokens → `401 capability_required`. Wrong seat → `seat_not_granted`. `AUTH_MODE` adds `"capability"`, code-gated to `ENVIRONMENT` dev/local (a staging/production flip is refused with 401 until D10-a); `"open"` stays local-only.
- Kept: 200 rooms/env (`room_cap_reached`) and the 64 KiB body cap (`413`).
- Added:
  - `create` is limited to 5 per 10 min per IP and 50/h per env, with `429` + `retry-after` past that.
  - `execute` is limited to 120/min per token. Failures are limited per IP per room per 10 min: 30 bad tokens, 10 bad claim codes. Only failures count, so spam from one address cannot lock out a legitimate claimer. The cookbook PRD §6 is amended to say the same ([klappy/nehemiahs-wall-cookbook#2](https://github.com/klappy/nehemiahs-wall-cookbook/pull/2)).
  - IPs are stored only as salted, truncated hashes (IPv6 bucketed by /64; IPv4-mapped `::ffff:a.b.c.d` unwrapped to its IPv4 address) in one map pruned on use. Every room has its own random salt; a room from before #8 that lacks one mints it on first use, so the public room id is never a salt. The registry sweeps the unsalted `ip:` keys left by #7 once.
  - The TTL alarm releases the registry slot before deleting the room. If the release fails, the room is kept and the alarm re-arms itself 5 min later, so a stuck release never strands the room or its slot.
  - Rooms idle for 7 d are deleted by a DO alarm, and a room never joined is deleted after 24 h.
  - Tokens are never logged or put in a path or query.
- **Remaining gap D10-a:** whether room creation stays open or gets gated (e.g. Turnstile) before staging goes public. This rides SPEC D10's existing "Klappy confirms before staging goes public". It is not a new step.

## Later: email
Email would be another way to deliver the same room-scoped links and claim codes. It is not an account system and not a shared-key path. Not in v1.
