# Tasks: Crashsim real-time operator proxy

> Requirements: @requirements.md
> Design: @design.md
> Status: Approved
> Approved scope: one direct Crashsim integration, with existing T1 and initial reducer/event-hub implementation to be aligned to this design.

## Requirement Coverage

| Requirement | Tasks | Notes |
|-------------|-------|-------|
| FR-001 | T1, T4, T5 | Keep the engine behind the server-side operator and route the browser through it. |
| FR-002 | T3 | Maintain one upstream stream per operator process. |
| FR-003 | T2, T3, T4 | Validate, normalize, sequence, and relay Crashsim events. |
| FR-004 | T3 | Snapshot synchronization on initial connect and reconnect. |
| FR-005 | T2, T3 | Monotonic round reducer; ignore stale ticks after crash. |
| FR-006 | T3, T4, T5 | Publish and display upstream health. |
| FR-007 | T2, T3 | Keep Crashsim protocol details at its concrete integration boundary; add no generic game-provider contract. |
| FR-008 | T5 | Provide the local React diagnostic client. |
| NFR-001 | T1, T3, T4, T5 | Keep engine credentials server-side and the debug client local-only. |
| NFR-002 | T2, T3, T4 | Cover reconnect, no-replay resync, sequence gaps, out-of-order events, and subscription races. |
| NFR-003 | T3, T4 | Log health, sync, sequence gaps, and validation outcomes without secrets. |
| NFR-004 | T5 | Bound the debug client's event history. |
| TD-001 | T2, T3 | Keep implementation directly Crashsim-specific without provider abstractions. |
| TD-005 | T2, T4 | Capture the snapshot and subscribe atomically before writing the initial SSE snapshot. |

## Implementation Readiness Check

| Check | Status | Notes |
|-------|--------|-------|
| Must Have requirements have tasks | Pass | FR-001 through FR-008 map to T1 through T5. |
| Requirements are covered by design | Pass | FR-001 through FR-008 map to the direct Crashsim design. |
| Critical questions are answered | Pass | Q-001 is answered; no critical requirement questions remain open. |
| Tasks have dependencies, acceptance criteria, files, and verification | Pass | Each task below includes all four. |
| Verification commands are known or marked manual/N/A | Pass | Existing Bun scripts and local fault scenarios are identified. |

## Implementation Slices

### Crashsim relay

- **Goal:** Maintain one synchronized Crashsim stream and relay current state over SSE.
- **User Stories:** US-001, US-002
- **Tasks:** T1, T2, T3, T4
- **Independent validation:** Reducer and event-hub tests, service recovery checks, and an SSE snapshot/events check.

### Local diagnostic client

- **Goal:** Inspect operator health, current round state, and live events in a browser.
- **User Stories:** US-003
- **Tasks:** T5
- **Independent validation:** Vite build succeeds and Compose client displays the operator SSE stream without engine credentials or game controls.

## Task T1: Bootstrap the Bun and Fastify operator service

**Priority:** P0
**Estimate:** 2h
**Dependencies:** none
**Covers:** FR-001, NFR-001, enabling setup

### Work

- [x] Add the operator Bun package, lockfile, TypeScript configuration, and scripts for `dev`, `start`, `typecheck`, and `test`.
- [x] Create a Fastify application factory and `src/server.ts` entry point that listens on port 3000 and closes cleanly on shutdown.
- [x] Keep `server.ts` as the composition root; keep game workflows inside `modules/game`.
- [x] Add typed configuration for `ENGINE_HTTP_URL`, `ENGINE_STREAM_URL`, and `ENGINE_OPERATOR_KEY`; do not log configuration values or credentials.
- [x] Update the operator Dockerfile to run the server under Bun while retaining `stream-smoke.ts` as a temporary diagnostic.
- [x] Update the root Compose operator service with its engine configuration and a loopback-only host mapping for port 3000.
- [x] Confirm the selected Fastify version runs under the chosen Bun image/runtime.

### Acceptance Criteria

- [x] `bun run start` starts the Fastify operator under Bun and exits cleanly on SIGTERM.
- [x] Operator tests and TypeScript checks run through the scripts added in this task.
- [x] Fastify app construction can be imported and tested without opening a listening socket; process startup remains in the entry point.
- [x] Operator credentials are read server-side and do not appear in startup output.
- [x] `docker compose config` accepts the operator service configuration.

### Files

- `operator/package.json`
- `operator/bun.lock`
- `operator/tsconfig.json`
- `operator/src/config.ts`
- `operator/src/server.ts`
- `operator/Dockerfile`
- `docker-compose.yml`

### Verification

- [x] `cd operator && bun run typecheck`
- [x] `cd operator && bun run test`
- [x] `docker compose config`
- [x] Manual: start the operator with Compose and confirm it remains available if the engine is temporarily unreachable; an unreachable-engine test also confirms startup is non-fatal.

## Task T2: Keep round reduction and fan-out small and Crashsim-specific

**Priority:** P0
**Estimate:** 2h
**Dependencies:** T1
**Covers:** FR-003, FR-005, FR-007, NFR-002, TD-001, TD-005

### Work

- [x] Consolidate the internal Crashsim event/snapshot types and pure round reducer in `modules/game/round-state.ts`.
- [x] Keep reducer transitions for `round.betting`, `round.started`, `tick`, and `round.crashed`, retaining `roundId` and `seq`.
- [x] Ignore duplicate/older sequence values and any `tick` after that round is crashed; allow the next `round.betting` to begin a new round.
- [x] Keep `modules/game/game-event-hub.ts` as a small in-memory fan-out that captures a snapshot and registers a subscriber synchronously.
- [x] Buffer updates during the initial SSE snapshot write; emit queued round events only if their `seq` is above the captured snapshot baseline.
- [x] Remove the generic `GameTypeModule`, provider port, type registry, and per-game-type directory structure from this feature while preserving reducer and hub behavior.
- [x] Add/retain unit tests for state transitions, duplicate/out-of-order events, crash terminality, new-round reset, and the subscribe/snapshot race.

### Acceptance Criteria

- [x] Reducer output never moves a round back to running after `round.crashed`, including when `REORDER=1` delivers a late tick.
- [x] Duplicate and older events do not change state, and a later `round.betting` updates the round identity.
- [x] A subscriber receives the captured snapshot before any later event, with no event lost between snapshot capture and registration.
- [x] Game event/state code lives directly under `modules/game`; no generic provider/game-type extension mechanism remains.

### Files

- `operator/src/modules/game/round-state.ts` — consolidate/move existing Crashsim reducer and types
- `operator/src/modules/game/round-state.test.ts` — consolidate/move tests
- `operator/src/modules/game/game-event-hub.ts` — consolidate/move existing in-memory event hub
- `operator/src/modules/game/game-event-hub.test.ts` — consolidate/move tests
- `operator/src/modules/game/game.module.ts` — remove game-type composition
- Existing `operator/src/modules/game/types/crashsim/` and `operator/src/modules/game/game-type-module.ts` — refactor/remove after alignment

### Verification

- [x] `cd operator && bun test`
- [x] `cd operator && bun run typecheck`
- [x] Re-run those checks after consolidating the files under the simplified module structure.

## Task T3: Connect to Crashsim and recover synchronized state

**Priority:** P0
**Estimate:** 3h
**Dependencies:** T1, T2
**Covers:** FR-002, FR-003, FR-004, FR-005, FR-006, FR-007, NFR-001, NFR-002, NFR-003, TD-001, TD-003

### Work

- [x] Implement `crashsim-http.client.ts` for `GET /rounds/current`, sending `x-operator-key` only from the server.
- [x] Implement `crashsim-stream.client.ts` as the single upstream WebSocket connection per operator process.
- [x] Validate Crashsim snapshots and messages at the client boundary with Valibot, then translate them into the internal Crashsim state/event shapes.
- [x] Implement `game-stream.service.ts` to attach the stream handler, buffer events during snapshot sync, apply the snapshot sequence baseline, and then process applicable newer events.
- [x] Track and publish `connected`, `synchronizing`, and `reconnecting` transitions through the event hub.
- [x] Reconnect with bounded exponential backoff and jitter without terminating the HTTP server or opening overlapping upstream sockets.
- [x] Refresh from a new snapshot after a sequence gap; do not report historical replay or apply a stale `tick` to a crashed round.
- [x] Add service/client tests with controlled HTTP/WebSocket doubles for invalid payloads, early events during sync, stale buffered events, gaps, disconnect/reconnect, and redacted credentials.

### Acceptance Criteria

- [x] Exactly one Crashsim engine stream is maintained per operator process, independent of the number of downstream clients.
- [x] After each connection or reconnect, operator state is based on `GET /rounds/current` and only applicable newer events are applied.
- [x] Engine unavailability leaves the operator alive in a reconnecting state and retries without overlapping connections.
- [x] Invalid payloads are rejected safely; connection, synchronization, retry, gap, and validation events are logged without secrets.
- [x] The implementation treats snapshots as current state and does not claim missed event replay.

### Files

- `operator/src/modules/game/crashsim-http.client.ts`
- `operator/src/modules/game/crashsim-stream.client.ts`
- `operator/src/modules/game/game-stream.service.ts`
- `operator/src/modules/game/game-stream.service.test.ts`
- `operator/src/modules/game/game.module.ts`
- `operator/src/server.ts`
- Existing `operator/src/modules/game/types/crashsim/` — refactor into these direct Crashsim files

### Verification

- [x] `cd operator && bun test`
- [x] `cd operator && bun run typecheck`
- [x] Manual: verify a snapshot baseline and live events against the local Crashsim engine.
- [x] Manual: verify reconnect and state recovery with `DROP_WS_EVERY=8`; late/out-of-order ticks with `REORDER=1` are covered by the manual run and reducer tests.

## Task T4: Relay synchronized Crashsim state over SSE

**Priority:** P0
**Estimate:** 2h
**Dependencies:** T2, T3
**Covers:** FR-001, FR-003, FR-004, FR-006, NFR-001, NFR-002, NFR-003, TD-002, TD-005

### Work

- [x] Implement `GET /game/events` as a thin SSE controller using the event hub.
- [x] Call the synchronous snapshot-and-subscribe operation before the controller's first `await`; write the captured snapshot before draining queued updates.
- [x] Remove a downstream subscription when the HTTP connection closes; browser reconnects must use the existing upstream engine connection.
- [x] Set SSE headers and serialize only operator-owned event data; do not include engine credentials or authentication tokens.
- [x] Add endpoint checks for snapshot-first ordering, an event arriving during subscription, upstream status changes, and client disconnect cleanup.

### Acceptance Criteria

- [x] Every new SSE connection receives a current operator snapshot and health status before subsequent round events.
- [x] An event concurrent with downstream subscription is neither lost nor sent before the snapshot; events at or below its sequence are discarded.
- [x] Disconnecting an SSE client removes it from the hub without affecting other clients or the upstream stream.
- [x] The endpoint publishes upstream health and serves only operator-owned event data.

### Files

- `operator/src/modules/game/game-events.controller.ts`
- `operator/src/modules/game/game-events.controller.test.ts`
- `operator/src/modules/game/game-event-hub.ts`
- `operator/src/modules/game/game.module.ts`
- `operator/src/server.ts`

### Verification

- [x] `cd operator && bun test`
- [x] `cd operator && bun run typecheck`
- [x] Manual: connect two SSE clients, disconnect one, and verify the other continues receiving events over the same upstream connection; endpoint tests cover independent subscriptions and cleanup.

## Task T5: Build the local React diagnostic client and Compose flow

**Priority:** P0
**Estimate:** 3h
**Dependencies:** T4
**Covers:** FR-001, FR-006, FR-008, NFR-001, NFR-004, TD-004

### Work

- [x] Create the client package with React 19, TypeScript, Vite, Bun scripts, and a minimal Dockerfile.
- [x] Implement an `EventSource` client for `/game/events` through the Vite proxy; display downstream reconnect errors separately from engine upstream health when both are available.
- [x] Render plain text for connection status and the latest round snapshot (`roundId`, state, `seq`, multiplier, and crash details when supplied).
- [x] Show received events with type, sequence, round ID, and payload; retain no more than the most recent 100 entries.
- [x] Freeze the displayed snapshot while the operator reports reconnecting; do not estimate a multiplier or offer bet/cashout controls.
- [x] Configure Vite to proxy `/game/events` to the operator service over the Compose network.
- [x] Add the client service to root Docker Compose, bind its host port to loopback only, and pass engine fault flags through for local recovery checks.
- [x] Add tests for the client event-state reducer and make the client typecheck/build scripts available.
- [x] Document the local client URL and `DROP_WS_EVERY=8` / `REORDER=1` verification flow in local run instructions.

### Acceptance Criteria

- [x] `docker compose up --build` starts the engine, operator, PostgreSQL, and debug client; the client is reachable only through a local host binding.
- [x] The browser displays connection status, the current synchronized snapshot, and a bounded event log without styling or gameplay controls.
- [x] On upstream loss, the last snapshot remains frozen and visibly stale/reconnecting; after snapshot resync, the new state is displayed.
- [x] The browser never receives the engine operator key and never connects directly to Crashsim.
- [x] The debug page is documented as local-development-only until player authentication exists.

### Files

- `client/package.json`
- `client/bun.lock`
- `client/tsconfig.json`
- `client/index.html`
- `client/vite.config.ts`
- `client/Dockerfile`
- `client/src/main.tsx`
- `client/src/App.tsx`
- `client/src/operator-events.client.ts`
- `client/src/operator-events.client.test.ts`
- `docker-compose.yml`
- `README.md`

### Verification

- [x] `cd client && bun run typecheck`
- [x] `cd client && bun test`
- [x] `cd client && bun run build`
- [x] `docker compose config`
- [x] Manual: run `docker compose up --build` and inspect the client at `http://localhost:5173`.
- [x] Manual: run with `DROP_WS_EVERY=8 REORDER=1`, confirm reconnect status, frozen snapshot, snapshot recovery, and no post-crash same-round tick regression.
