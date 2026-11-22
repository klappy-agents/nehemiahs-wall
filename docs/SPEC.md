# Nehemiah's Wall — product spec v0.1 (planning)

**Status:** planning. This PR holds the spec and a scaffold. No rules engine yet; production is not in scope.
**Sources:**
- Ticket spec v2 (live, ARS-corrected): [klappy/kitchen `rail/2-cooking/2026-11-21-nehemiahs-wall-coop-game/TICKET.md` @ 5043d0f1](https://github.com/klappy/kitchen/blob/5043d0f1ba2149726b3dbf92d05b3240a051be27/rail/2-cooking/2026-11-21-nehemiahs-wall-coop-game/TICKET.md). Historical snapshot: [`rail/1-ordered/…/TICKET.md` @ f44bc460](https://github.com/klappy/kitchen/blob/f44bc460ada0ee25d21c1d6fbc4baf51f22d0fdd/rail/1-ordered/2026-11-21-nehemiahs-wall-coop-game/TICKET.md) remains the pre-correction record (before the captain's 2026-11-21 7:42 PM ET "ARS not used" correction).
- Design contract round 1: [design/CONTRACT.md @ d2057149](https://github.com/klappy/kitchen/blob/d20571495cd437bed1fac9c203a9d5ba0435f6f0/rail/1-ordered/2026-11-21-nehemiahs-wall-coop-game/design/CONTRACT.md), with 17 renders indexed in `DESIGN-LOOP.md`.

## What it is
Nehemiah's Wall is a real-time, Tetris-style co-op Bible game.

- **Builder (human, browser):** Cut-stone blocks fall into the breach, and the Builder moves, rotates and drops them.
- **Courses lock as wall:** a completed course locks as built wall instead of clearing. That is the one deliberate twist on Tetris.
- **Watchman (AI teammate, MCP):** the Watchman plays from a sidecar session running an OODA loop (observe, orient, decide, act). He sees threats coming that the Builder can't: Sanballat, Tobiah, Geshem, the Ono letter (Neh 4, 6). He acts by:
  - sounding the trumpet (4:20)
  - posting a guard (4:13)
  - answering a letter (6:3)
  - setting the next stone from the quarry queue
- **Shared goal:** all ten sections at full height and the gates hung by day 52 (Neh 6:15).
- **Lose conditions:** rubble reaches the top, or day 52 passes.

## Players and surfaces
| Who | Surface | Status |
| --- | --- | --- |
| Builder | Browser on phone, iPad or laptop, via a private room link | Planned; the shell exists in this PR |
| Builder | MCP App card (`ui://`) in Grok, ChatGPT or Claude | **Unverified** in every host; not in v1 acceptance |
| Watchman | MCP tools `docs` · `execute` · `telemetry` at `/mcp` | Stub in this PR (join/look/noop) |
| Voice | Existing Grok Bot in-app voice call plus the sidecar | Outside the product: no audio in the Worker, no voice API |

## Vodka boundary
- **Knows:**
  - one room and two seats
  - the wall grid, the falling stone and the stone queue
  - threats, sections, morale and the day clock
  - the action log, revisions and save snapshots
- **Does NOT know:**
  - voice or model output
  - identity beyond the room capability (and the MCP key)
  - user data
- **Is NOT:**
  - a voice adapter, an account system or a general game engine
  - a copy of Co-op Sidekick (klappy/kitchen, scope lock b8cd6fb9) or Follow That Star

## State
State is plain tables in one Durable Object per room: `grid` (14 × 10), `falling`, `queue`, `threats`, `sections`, `seats` and `log`. A save is a snapshot of those tables.

Each seat gets a slice, and **the Watchman's slice never contains the grid**. The asymmetry is enforced by the server, not by a prompt (CONTRACT §4). The scaffold test `test/core.test.js` already checks it.

## Real-time and latency (estimates, measured in M5)
| | Estimate |
| --- | --- |
| MCP round trip | about 0.3–1.5 s |
| Watchman OODA cycle | about 2–8 s |
| Threat lead time | ≥ 15 s |
| Quarry decision window | about 10 s |

The agent never plays per tick. If measured p95 OODA is longer than the lead time, lengthen the lead time or cut actions.

## Look (CONTRACT §2, provisional)
- Stone and dusk: limestone ashlar, mortar lines and a dusk sky. Minimal and early-web simple, with no stick figures.
- Signal colours carry one meaning each: torch amber is the Builder, watch blue is the Watchman, threat red is threats only, guarded green is saved or guarded.
- Player-facing words never include MCP, rev, token, sidecar or tool.

## Open decisions (captain)
- **D1–D8 (design contract):** all open.
  - D1: stone-and-dusk vs house Glass.
  - D2: how finished courses render.
  - D3: controls by pointer type vs width.
  - D4: role-coded primaries.
  - D5: dark-only theme.
  - D6: self-hosted OFL fonts vs system fonts.
  - D7: human Watchman screen in v1?
  - D8: teaching panel behind `?`.
- **D9 (new, engine):** Oddie's research recommends Phaser 4.2.1 with PartyServer on the room DO, with PixiJS 8 as runner-up. This is research, not a ruling. It gets decided in M4 with a 6B table and a bundle-size check (MCP App cards care about size). The scaffold uses no engine so that either choice stays cheap.
- **D10 (new, access):** room links are capability URLs, and the MCP door uses a Bearer key (`MCP_KEY` secret per environment, set in M3). Klappy confirms before staging goes public.

## Gates
- **Modes:** exploration → planning (this PR) → execution.
- **Every PR passes:** PR review, an independent review from a seat other than the author, and Bugbot.
  - **Bugbot is paused by the captain:** it is logged as a named blocker on each PR, never bypassed.
  - No admin or bypass merges, and no self-approval.
- **Promotion:** dev → staging → production. Production needs a separate, explicit captain go.
- **Receipts:** test output, deployed `/health` version, screenshots for UI, and links naming the app and the full repo.

## Milestones
- **M1:** this spec plus scaffold.
- **M2:** rules core (falling stone, course lock, rubble, threats, win and lose, save and restore).
- **M3:** Worker, DO and MCP on dev, with a key and telemetry.
- **M4:** browser UI, engine D9.
- **M5:** typed co-play trial, with latency p50/p95.
- **M6:** staging playtest with Klappy on iPad or phone and voice.
- **M7:** MCP App card spike.
- **M8:** production, captain only.

## Done-means (agent-observable)
1. Klappy opens one private link on iPad or phone and on laptop, and finishes a round with Oddie without debugging.
2. A reviewer sees both seats acting at once on one room, with the Watchman's acts arriving over MCP.
3. `tools/list` returns exactly 3 tools, and the Watchman's `look` never includes the grid.
4. A seeded round reproduces win, lose, stale and duplicate outcomes in test output.
5. Each PR shows review, independent review, Bugbot (or its logged blocker), and dev → staging receipts.
6. The MCP App card path is reported as observed working or as a documented gap, separately from the browser path.
