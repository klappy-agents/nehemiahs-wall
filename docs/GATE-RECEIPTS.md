# Gate receipts — November 21, 2026 (~18:12 ET)

Local draft only. No PR or deployment.

- OddKit preflight: FOUND (~18:05 ET); separate Worker environments, reviewability and policy-before-build surfaced.
- OddKit challenge: CHALLENGED (~18:09 ET); separate-environment MUST, confidence and generalization questioned.
- Local tests (initial scaffold): 5 passed. Local Wrangler dry-run bundled. Local tools/list returned exactly docs/execute/telemetry.
- GitHub branch create failed HTTP 403: Resource not accessible by integration. No alternate write route attempted.
- Cloudflare account read worked; config_autofill for the new repo returned HTTP 404 Not found, vs successful existing klappy/hud control. Root cause unverified.
- PR review: not run. Independent review: not run. Bugbot: paused, not run; blocker retained. CI remote: not run.
- Security review required before hosting: optional MCP key fails open; room id is not a separate role capability; room creation/quota/retention need bounds. Local integration checks do not establish deploy readiness. *(Superseded by the security-fix receipts below.)*

## Security fixes — November 21, 2026 (~19:30 ET), local only

No push, deploy or live URL. See `docs/SECURITY.md`.

- **Tests written first** against a behaviour-preserving router extraction (`src/router.js`): 17 tests, 8 pass, 9 fail. The 9 failures:
  - 7 auth, role and bound assertions in `test/auth.test.js`;
  - `test/capability.test.js` and `test/limits.test.js`, which failed at import because the core APIs didn't exist yet.
- **After the fixes:** `npm test` (node --test test/*.test.js) gives 26 tests, 26 pass, 0 fail. That includes the original 5.
- **`npx wrangler deploy --dry-run --env dev --outdir dist`:** bundled. Bindings are ROOM, REGISTRY, ASSETS, ENVIRONMENT=dev and AUTH_MODE=key.
- **Local `wrangler dev` on 127.0.0.1 only (Miniflare, no deploy).**
  - With `--var ENVIRONMENT:local AUTH_MODE:open MAX_ROOMS:2`:
    - `look` on an unknown room returned `room_not_found`;
    - two joins created rooms, and the third returned `room_cap_reached`;
    - Watchman `drop` returned `cross_role_action`;
    - the Watchman look had no grid.
  - With the plain dev config and no key set: `/v1/execute` and `/mcp` returned 401; `/health` returned 200.
- **Fixed:**
  - (1) auth fails closed on every tool route;
  - (2) Builder and Watchman capabilities are enforced in core;
  - (3) 200-room cap per environment, 64 KiB state, 8 KiB body, room-id shape.
- **Open:**
  - the browser Builder credential (D10), so the browser shell 401s under key mode;
  - seat-to-holder binding;
  - retention and expiry;
  - rate limits;
  - key rotation;
  - independent review not run; Bugbot paused.
