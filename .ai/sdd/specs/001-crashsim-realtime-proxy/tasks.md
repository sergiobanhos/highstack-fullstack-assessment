# Tasks: Crashsim real-time operator proxy

> Requirements: @requirements.md
> Design: @design.md
> Status: Approved

## Requirement Coverage

| Requirement | Tasks | Notes |
|-------------|-------|-------|
| FR-001 | T1, T4, T5 | Keep the engine behind a server-side operator and route the debug browser through it. |
| FR-002 | T3 | Own one Crashsim stream connection per operator process. |
| FR-003 | T2, T3, T4 | Define, validate, normalize, and relay sequenced events. |
| FR-004 | T3 | Synchronize from the current-round snapshot during startup and reconnect. |
| FR-005 | T2, T3 | Reduce round state monotonically and reject stale or terminal-round ticks. |
| FR-006 | T3, T4, T5 | Publish upstream health and display it in the debug client. |
| FR-007 | T2, T3 | Keep the provider-neutral port separate from the Crashsim adapter. |
| FR-008 | T5 | Build the minimal local React debug client. |
| NFR-001 | T1, T3, T4, T5 | Keep engine credentials on the server and restrict the debug surface to local development. |
| NFR-002 | T2, T3, T4 | Cover reconnect, no-replay resynchronization, sequence gaps, and out-of-order events. |
| NFR-003 | T3, T4 | Log connection, synchronization, sequence-gap, and validation state without secrets. |
| NFR-004 | T5 | Keep the diagnostic UI local-only and bound its in-memory event list. |
| TD-005 | T2, T4 | Capture snapshot and subscribe atomically before writing the initial SSE snapshot. |
| TD-006 | T1, T2, T3, T4 | Keep current game behavior inside its module and leave auth/financial as future peer modules. |

## Implementation Readiness Check

| Check | Status | Notes |
|-------|--------|-------|
| Must Have requirements have tasks | Pass | FR-001 through FR-008 map to T1 through T5. |
| Requirements are covered by design | Pass | `design.md` maps the requirements to sections and records atomic SSE subscription (TD-005) and module boundaries (TD-006). |
| Critical Questions are answered | Pass | Q-001 is answered; no critical requirement questions remain open. |
| Tasks have dependencies, acceptance criteria, files, and verification | Pass | Each task below includes all four. |
| Verification commands are known or marked manual/N/A | Pass | Package scripts are established in T1/T5; commands and manual fault checks are listed below. |

## Implementation Slices

### Operator relay slice

- **Goal:** Synchronize one server-side Crashsim stream and relay an ordered current state through SSE.
- **User Stories:** US-001, US-002, US-003
- **Tasks:** T1, T2, T3, T4
- **Independent validation:** Operator tests cover reducers, the atomic snapshot subscription, and reconnect synchronization; an SSE integration check observes a snapshot and subsequent events.

### Local debug client slice

- **Goal:** Inspect operator health, current round state, and live events in a browser.
- **User Stories:** US-004
- **Tasks:** T5
- **Independent validation:** Vite build succeeds and the Compose client displays the operator SSE stream without engine credentials or game controls.

## Task T1: Bootstrap the Bun and Fastify operator service

**Priority:** P0  
**Estimate:** 2h  
**Dependencies:** none  
**Covers:** FR-001, NFR-001, TD-006, enabling setup

### Work

- [ ] Add the operator Bun package, lockfile, TypeScript configuration, and scripts for `dev`, `start`, `typecheck`, and `test`.
- [ ] Create a Fastify application factory and `src/server.ts` entry point that listens on port 3000 and closes cleanly on shutdown.
- [ ] Keep `server.ts` as the composition root; do not put game, auth, or financial workflows in it.
- [ ] Add typed configuration for `ENGINE_HTTP_URL`, `ENGINE_STREAM_URL`, and `ENGINE_OPERATOR_KEY`; do not log configuration values or credentials.
- [ ] Update the operator Dockerfile to run the server under Bun while retaining `stream-smoke.ts` as a temporary diagnostic.
- [ ] Update the root Compose operator service with its engine configuration and a loopback-only host mapping for port 3000.
- [ ] Confirm the selected Fastify version runs under the chosen Bun image/runtime.

### Acceptance Criteria

- [ ] `bun run start` starts the Fastify operator under Bun and exits cleanly on SIGTERM.
- [ ] Operator tests and TypeScript checks run through the scripts added in this task.
- [ ] Fastify app construction can be imported and tested without opening a listening socket; process startup remains in the entry point.
- [ ] Operator credentials are read server-side and do not appear in startup output.
- [ ] `docker compose config` accepts the operator service configuration.

### Files

- `operator/package.json` — create
- `operator/bun.lock` — create
- `operator/tsconfig.json` — create
- `operator/src/config.ts` — create
- `operator/src/server.ts` — create
- `operator/Dockerfile` — update
- `docker-compose.yml` — update

### Verification

- [ ] `cd operator && bun run typecheck`
- [ ] `cd operator && bun run test`
- [ ] `docker compose config`
- [ ] Manual: start the operator with Compose and confirm it remains available if the engine is temporarily unreachable.

## Task T2: Define game contracts, round reducer, and atomic event hub

**Priority:** P0  
**Estimate:** 3h  
**Dependencies:** T1  
**Covers:** FR-003, FR-005, FR-007, NFR-002, TD-001, TD-005, TD-006

### Work

- [ ] Create the initial `modules/game/` structure and define its provider-neutral event, snapshot, and connection-state types.
- [ ] Define the narrow game-module `GameProviderPort` for reading the current round and subscribing to normalized provider events.
- [ ] Implement the round reducer for `round.betting`, `round.started`, `tick`, and `round.crashed`, retaining `roundId` and `seq`.
- [ ] Ignore duplicate/older sequence values and any `tick` after that round is crashed; allow the next `round.betting` to begin a new round.
- [ ] Implement the in-memory event hub and a synchronous `subscribeWithSnapshot()` operation that registers the subscriber and captures its snapshot/sequence baseline before yielding control.
- [ ] Buffer events published during the initial snapshot write; emit only messages with `seq` above that snapshot baseline, in sequence order.
- [ ] Add Bun unit tests for state transitions, duplicate/out-of-order events, crash terminality, new-round reset, and the subscribe/snapshot race.

### Acceptance Criteria

- [ ] Reducer output never moves a round back to running after `round.crashed`, including when `REORDER=1` delivers a late tick.
- [ ] Duplicate and older events do not change state, and a later `round.betting` updates the round identity.
- [ ] A subscriber receives the captured snapshot before any later event, with no event lost between snapshot capture and registration.
- [ ] Provider-neutral contracts do not expose Crashsim transport details.
- [ ] All feature-specific domain, port, use-case, controller, and adapter code belongs to the `game` module; do not create empty auth/financial modules.

### Files

- `operator/src/modules/game/domain/game-event.ts` — create
- `operator/src/modules/game/domain/round-state.ts` — create
- `operator/src/modules/game/ports/game-provider.port.ts` — create
- `operator/src/modules/game/adapters/realtime/in-memory-event-hub.ts` — create
- `operator/src/modules/game/domain/round-state.test.ts` — create
- `operator/src/modules/game/adapters/realtime/in-memory-event-hub.test.ts` — create

### Verification

- [ ] `cd operator && bun test`
- [ ] `cd operator && bun run typecheck`

## Task T3: Implement the Crashsim adapter and upstream recovery

**Priority:** P0  
**Estimate:** 3h  
**Dependencies:** T1, T2  
**Covers:** FR-002, FR-003, FR-004, FR-005, FR-006, FR-007, NFR-001, NFR-002, NFR-003, TD-001, TD-003, TD-006

### Work

- [ ] Implement the Crashsim HTTP client for `GET /rounds/current`, sending `x-operator-key` only from the server.
- [ ] Implement one upstream WebSocket client per operator process, using the engine stream contract and keeping the operator key out of logs and client messages.
- [ ] Validate snapshots and event envelopes at the adapter boundary with Valibot, then map supported events to provider-neutral types.
- [ ] Implement the startup use case: attach the stream handler, buffer events while fetching the snapshot, apply the snapshot baseline, then process applicable newer events.
- [ ] Track `connected`, `synchronizing`, and `reconnecting` states and publish transitions through the shared event hub.
- [ ] Create `game.module.ts` to wire the game adapter and startup use case; expose module composition to the application root without leaking internal files.
- [ ] Wire the game module from `server.ts` through its exported composition function; keep module internals out of the root imports.
- [ ] Reconnect with bounded exponential backoff and jitter without terminating the HTTP server or opening parallel upstream sockets.
- [ ] Refresh from a new snapshot after a sequence gap; do not report historical replay or apply an old `tick` to a crashed round.
- [ ] Add tests with controlled HTTP/WebSocket doubles for early events during sync, stale buffered events, gaps, disconnect/reconnect, and redacted credentials.

### Acceptance Criteria

- [ ] Exactly one engine stream is maintained per operator process, independent of the number of downstream clients.
- [ ] After each connection or reconnect, the operator state is based on `GET /rounds/current` and only applicable newer events are applied.
- [ ] Engine unavailability leaves the operator alive in a reconnecting state and retries without overlapping connections.
- [ ] Invalid payloads are rejected safely; connection, synchronization, retry, gap, and validation events are logged without secrets.
- [ ] The implementation explicitly treats snapshots as current state and does not claim missed event replay.

### Files

- `operator/src/modules/game/adapters/crashsim/crashsim-game.adapter.ts` — create
- `operator/src/modules/game/adapters/crashsim/crashsim-http.client.ts` — create
- `operator/src/modules/game/adapters/crashsim/crashsim-stream.client.ts` — create
- `operator/src/modules/game/adapters/crashsim/crashsim-event.mapper.ts` — create
- `operator/src/modules/game/usecases/start-game-stream.usecase.ts` — create
- `operator/src/modules/game/game.module.ts` — create
- `operator/src/server.ts` — update
- `operator/src/modules/game/adapters/crashsim/crashsim-game.adapter.test.ts` — create

### Verification

- [ ] `cd operator && bun test`
- [ ] `cd operator && bun run typecheck`
- [ ] Manual: verify a snapshot baseline and live events against the local Crashsim engine.
- [ ] Manual: verify reconnect and state recovery with `DROP_WS_EVERY=8` and verify no regression with `REORDER=1`.

## Task T4: Expose the synchronized operator state over SSE

**Priority:** P0  
**Estimate:** 2h  
**Dependencies:** T2, T3  
**Covers:** FR-001, FR-003, FR-004, FR-006, NFR-001, NFR-002, NFR-003, TD-002, TD-005, TD-006

### Work

- [ ] Add game-module use cases for the current operator snapshot and subscribing to normalized game events.
- [ ] Implement `GET /game/events` as an SSE controller that sends the initial snapshot first, with the current connection state available to the client.
- [ ] Call `subscribeWithSnapshot()` before the controller's first `await`, then write the captured snapshot and drain queued newer events before live events.
- [ ] Remove downstream subscriptions when the HTTP connection closes; browser reconnects must use the same upstream engine connection.
- [ ] Set SSE response headers and serialize only operator-owned events; do not include engine credentials or authentication tokens.
- [ ] Add endpoint tests for snapshot-first ordering, an event arriving during subscription, upstream status changes, and client disconnect cleanup.

### Acceptance Criteria

- [ ] Every new SSE connection receives a current snapshot before game events; queued events newer than its `seq` follow in order.
- [ ] An event concurrent with downstream subscription is neither lost nor sent before the snapshot; events at or below the snapshot sequence are discarded.
- [ ] Disconnecting an SSE client removes it from the in-memory event hub without affecting other clients or the upstream stream.
- [ ] The endpoint publishes upstream connection health and serves only operator-owned event data.

### Files

- `operator/src/modules/game/usecases/get-current-round.usecase.ts` — create
- `operator/src/modules/game/usecases/subscribe-to-game-events.usecase.ts` — create
- `operator/src/modules/game/controllers/game-events.controller.ts` — create
- `operator/src/server.ts` — update
- `operator/src/modules/game/game.module.ts` — update
- `operator/src/modules/game/controllers/game-events.controller.test.ts` — create

### Verification

- [ ] `cd operator && bun test`
- [ ] `cd operator && bun run typecheck`
- [ ] Manual: connect two SSE clients, disconnect one, and verify the other continues receiving events over the same upstream connection.

## Task T5: Build the local React debug client and Compose flow

**Priority:** P0  
**Estimate:** 3h  
**Dependencies:** T4  
**Covers:** FR-001, FR-006, FR-008, NFR-001, NFR-004, TD-004

### Work

- [ ] Create the client package with React 19, TypeScript, Vite, Bun scripts, and a minimal Dockerfile.
- [ ] Implement an `EventSource` client for `/game/events` through the Vite proxy; display downstream reconnect errors separately from engine upstream health when both are available.
- [ ] Render plain text for connection status and the latest round snapshot (`roundId`, state, `seq`, multiplier, and crash details when supplied).
- [ ] Show received events with type, sequence, round ID, and payload; retain no more than the most recent 100 entries.
- [ ] Freeze the displayed snapshot while the operator reports reconnecting; do not estimate a multiplier or offer bet/cashout controls.
- [ ] Configure Vite to proxy the SSE path to the operator service over the Compose network.
- [ ] Add a client service to root Docker Compose, bind its host port to loopback only, and pass engine fault flags through for local recovery checks.
- [ ] Add tests for the client event-state reducer and make the client typecheck/build scripts available.
- [ ] Document the local client URL and the `DROP_WS_EVERY=8` / `REORDER=1` verification flow in the project run instructions.

### Acceptance Criteria

- [ ] `docker compose up --build` starts the engine, operator, PostgreSQL, and debug client; the client is reachable only through a local host binding.
- [ ] The browser displays connection status, the current synchronized snapshot, and a bounded event log without styling or gameplay controls.
- [ ] On upstream loss, the last snapshot remains frozen and visibly stale/reconnecting; after snapshot resync, the new state is displayed.
- [ ] The browser never receives the engine operator key and never connects directly to Crashsim.
- [ ] The debug page is documented as local-development-only until player authentication exists.

### Files

- `client/package.json` — create
- `client/bun.lock` — create
- `client/tsconfig.json` — create
- `client/index.html` — create
- `client/vite.config.ts` — create
- `client/Dockerfile` — create
- `client/src/main.tsx` — create
- `client/src/App.tsx` — create
- `client/src/operator-events.client.ts` — create
- `client/src/operator-events.client.test.ts` — create
- `docker-compose.yml` — update
- `README.md` — update local run and fault-verification instructions
- `.ai/steering/tech-stack.md` — update local Compose/client commands if needed

### Verification

- [ ] `cd client && bun run typecheck`
- [ ] `cd client && bun test`
- [ ] `cd client && bun run build`
- [ ] `docker compose config`
- [ ] Manual: run `docker compose up --build` and inspect the client at `http://localhost:5173`.
- [ ] Manual: run with `DROP_WS_EVERY=8 REORDER=1`, confirm reconnect status, frozen snapshot, snapshot recovery, and no post-crash same-round tick regression.
