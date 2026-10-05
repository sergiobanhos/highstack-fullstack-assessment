# Design: Crashsim real-time operator proxy

> Requirements: @requirements.md
> Status: Approved

## 1. Summary

Keep the operator's `game` module focused on one job: maintain the Crashsim connection, keep the current round state synchronized, and fan it out to browser clients over SSE. Use direct Crashsim HTTP/WebSocket clients, one stream service for lifecycle and recovery, a small round-state reducer, an in-memory event hub, and a thin SSE controller. Do not add a generic game-provider port, game-type modules, catalog, registry, or plugin mechanism. Future `auth` and `financial` features remain separate top-level modules; adding another game is a future design decision.

A local React diagnostic client displays connection health, the current snapshot, and recent events. It has no gameplay controls or styling scope.

## 2. Requirements Mapping

| Requirement | Design Coverage |
|-------------|-----------------|
| FR-001 | Sections 3, 5, 6, and 7 |
| FR-002 | Sections 3, 4, and 8 |
| FR-003 | Sections 3, 5, 6, and 7 |
| FR-004 | Sections 4, 5, and 8 |
| FR-005 | Sections 4, 5, and 8 |
| FR-006 | Sections 5, 6, and 8 |
| FR-007 | Sections 3 and 4 |
| FR-008 | Sections 3, 6, and 9 |
| NFR-001 | Section 7 |
| NFR-002 | Section 8 |
| NFR-003 | Section 10 |
| NFR-004 | Sections 6, 7, and 9 |

## 3. Technical Approach

Use Bun and TypeScript for the operator, with Fastify at the HTTP boundary. Use REST endpoints for future game commands; this feature uses SSE for one-way state updates. Use React 19 and TypeScript with Vite for the local diagnostic client. QuickJS is not part of the browser client.

The `game` module contains only Crashsim-specific implementation. It communicates with the engine, maintains synchronized in-memory state, and publishes that state. Do not add ports or interfaces intended to support other games, a registry, type folders, or use-case classes for simple internal calls. Keep responsibilities visible through a few concrete files; add no layer unless this flow needs it.

Use Valibot to validate Crashsim snapshots and stream messages at the HTTP/WebSocket boundary. No database writes are needed for this feature; Drizzle remains for later persistent features. PostgreSQL remains in the existing Compose setup.

## 4. Component Structure

```text
operator/src/
  server.ts                         # Fastify setup and module composition
  config.ts                         # typed environment configuration
  modules/
    game/
      game.module.ts                # construct service and register the route
      crashsim-http.client.ts       # GET /rounds/current and server-side auth
      crashsim-stream.client.ts    # one upstream WebSocket connection
      game-stream.service.ts       # connect, synchronize, reconnect, reduce, publish
      round-state.ts                # internal Crashsim event/state types and pure reducer
      game-event-hub.ts             # snapshot + downstream subscriber fan-out
      game-events.controller.ts     # thin GET /game/events SSE endpoint
      game-events.controller.test.ts
      game-stream.service.test.ts
      round-state.test.ts
      game-event-hub.test.ts
client/
  Dockerfile
  package.json
  vite.config.ts
  src/
    main.tsx
    App.tsx
    operator-events.client.ts
```

Flow: Crashsim HTTP/WebSocket clients → `game-stream.service.ts` → `round-state.ts` and `game-event-hub.ts` → thin SSE controller → browser `EventSource`. `game.module.ts` wires these concrete pieces. `server.ts` composes `game` with Fastify and does not contain stream workflows.

The service owns one upstream stream per operator process, regardless of downstream browser count. Keep all Crashsim protocol details, credentials, and raw event shapes in the HTTP/WebSocket client and its validation/mapping boundary. Internal types stay small and specific to this Crashsim flow.

## 5. State and Event Handling

Keep the latest Crashsim snapshot and upstream status in process memory. The round state includes `roundId`, `state`, `seq`, the current multiplier when available, and crash details only after a crash. The status is `synchronizing`, `connected`, or `reconnecting`; a missing initial snapshot is represented explicitly.

The reducer accepts only validated internal events. It ignores duplicate or older sequence numbers and ignores a `tick` for a round already marked `crashed`, even if `REORDER=1` delivers that tick late. A new `round.betting` starts the next round. The reducer should remain a small pure function, not a generic state-machine framework.

Do not persist ticks or claim to retain history. The browser receives an operator snapshot and subsequent events; `seq` identifies stale updates but does not enable replay.

## 6. API and Integration Contract

### Operator to Crashsim

- WebSocket: `ws://engine:4000/stream?key=<operator-key>` using the current engine contract.
- HTTP snapshot: `GET /rounds/current` with `x-operator-key`.
- Configure URLs and credentials on the operator only. Do not send the operator key to the browser.

### Browser to operator

- `GET /game/events` using SSE.
- Send the current operator snapshot and connection status when the subscription opens, then forward new normalized round events and status changes.
- Use operator-owned event names and payloads. Do not expose raw engine messages, engine secrets, or authentication tokens.
- Remove each downstream subscriber when its HTTP connection closes. A browser connection must not create a new Crashsim stream.
- Keep the diagnostic client local-only and proxy `/game/events` through Vite to the operator. Before public exposure, require the player session provided by a future auth feature.

When an SSE connection is accepted, synchronously register the subscriber and capture the current snapshot before the controller's first `await`. Send that snapshot first. Queue changes that race with the initial write and then drain them in order, discarding round events at or below the snapshot's `seq`. This small hub operation prevents a lost or reordered event at subscription time.

The client retains only the latest snapshot and the most recent 100 messages. It renders plain text and does not estimate a multiplier while disconnected.

## 7. Security and Privacy

- Keep the engine operator key inside server-side configuration and the Crashsim clients.
- Do not put engine credentials in SSE URLs, browser payloads, logs, or error details.
- Validate engine snapshots and event envelopes before state mutation; report safe validation errors.
- Do not expose the local debug client as a public unauthenticated player surface.
- Webhook HMAC verification and player authentication are separate future feature requirements.

## 8. Connection Recovery and Ordering

1. Start one WebSocket connection and attach its message handler immediately. Buffer messages while obtaining the snapshot.
2. Fetch `GET /rounds/current`; replace the current state with that authoritative snapshot and use its `seq` as the baseline.
3. Discard buffered events at or below the snapshot sequence. Apply newer events in sequence order, then report `connected` and continue processing live messages.
4. Ignore duplicate or older events. If a live sequence gap is detected, fetch a fresh snapshot. This restores current state only; it does not recover missed event history.
5. On disconnect, publish `reconnecting`, freeze the last snapshot, and let clients show stale state. Do not show a stale multiplier as live.
6. Reconnect with bounded exponential backoff and jitter. Retry snapshot synchronization before reporting the stream as live. Do not open overlapping upstream sockets.
7. If the socket connects but snapshot synchronization fails, remain `reconnecting`/`synchronizing` and retry; do not accept its state as current.
8. Ignore a late `tick` after `round.crashed` for that same round. A subsequent `round.betting` may start the next round.

## 9. User Flow

```mermaid
sequenceDiagram
    participant C as Local debug client
    participant O as Operator
    participant E as Crashsim engine
    C->>O: Connect to GET /game/events (SSE)
    O-->>C: Current snapshot and connection status
    O->>E: One WebSocket connection
    O->>E: GET /rounds/current
    E-->>O: Snapshot + seq
    E-->>O: Round events over WebSocket
    O-->>C: Normalized round events over SSE
    E--xO: Stream disconnects
    O-->>C: reconnecting; freeze last snapshot
    O->>E: Reconnect with backoff
    O->>E: GET /rounds/current
    E-->>O: Replacement snapshot + seq
    O-->>C: Synchronized snapshot, then live events
```

## 10. Observability and Operations

Log upstream connect/disconnect, reconnect attempts, snapshot synchronization, sequence gaps, and invalid message types. Include safe round identifiers where useful. Never log credentials or raw auth tokens. Expose connection health to SSE clients so the UI can distinguish synchronized from stale state.

## 11. Migration and Rollout

No database migration is required. Keep the engine, operator, PostgreSQL, and local diagnostic client in the root Compose setup. Bind local diagnostic ports to loopback for development. Replace the smoke entrypoint with the operator only after the existing code has been aligned with this direct single-Crashsim design and its integration path is verified.

## 12. Technical Decisions

### TD-001: Direct Crashsim integration

- **Decision:** Keep the implementation specific to Crashsim and use concrete HTTP/WebSocket clients. Do not create a game-provider port, type registry, or plugin contract.
- **Why:** This delivery has one engine and needs one clear communication and relay path. Abstractions for hypothetical games would add structure without solving a current requirement.
- **Trade-off:** Supporting another game later will require a deliberate design change based on that game's protocol and state model.
- **Alternatives considered:** Generic provider interface; per-game-type modules; dynamic registry.

### TD-002: SSE for downstream fan-out

- **Decision:** Use SSE for one-way game events; specify game commands as REST endpoints in their own feature design.
- **Why:** The browser only needs server-to-client updates in this stream.
- **Trade-off:** Browser-to-server messages use a separate request path.
- **Alternatives considered:** A downstream WebSocket for both directions.

### TD-003: Snapshot resynchronization, not event replay

- **Decision:** Restore current round state from the engine snapshot and use `seq` to discard stale updates.
- **Why:** The current engine exposes no replay endpoint or durable event log.
- **Trade-off:** Transient events from a missed interval cannot be recovered from the engine stream alone.
- **Alternatives considered:** Add event persistence/replay, requiring a new engine contract.

### TD-004: Minimal browser diagnostic client

- **Decision:** Use React 19 + TypeScript + Vite for a local debug page showing status, the current snapshot, and a bounded event log.
- **Why:** It verifies the full event path in a browser while remaining outside the gameplay UI scope.
- **Trade-off:** Adds a small client package and Compose service.
- **Alternatives considered:** Rely only on operator console output; use QuickJS as the client runtime.

### TD-005: Atomic SSE snapshot subscription

- **Decision:** Synchronously register a subscriber and capture its snapshot before emitting the initial SSE snapshot; queue concurrent updates until that write completes.
- **Why:** Reading the snapshot and subscribing in separate operations can lose an event between them.
- **Trade-off:** The small in-memory event hub tracks a short pending queue per newly connected subscriber.
- **Alternatives considered:** Snapshot-then-subscribe with a race; client recovery without an authoritative snapshot.

## 13. Risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| A missing event is mistaken for a harmless gap | High | Fetch a current snapshot; do not claim replay. Keep financial outcomes in later durable operator records. |
| Out-of-order delivery regresses a client | High | Apply sequence-aware reduction and reject same-round ticks after crash. |
| In-memory fan-out is used with multiple replicas | Medium | This feature targets one operator instance; add shared pub/sub only when deployment needs multiple instances. |
| SSE is exposed without player authentication | High | Keep the diagnostic client local-only until the auth feature is implemented. |
| Existing type/port scaffolding obscures the direct flow | Medium | Align current files to the listed Crashsim-only module structure before continuing implementation. |

## 14. Verification Strategy

- Unit: validate event mapping, round-state reducer, late `tick` after crash, duplicate/older sequence handling, and atomic hub subscription.
- Integration: connect to Crashsim, receive a snapshot and subsequent round events through SSE.
- Fault scenarios: `DROP_WS_EVERY=8` and `REORDER=1`; verify stale client state, snapshot recovery, and no same-round regression after crash.
- Manual: confirm downstream client count does not increase the number of upstream sockets and the engine key never appears in browser traffic or logs.
- Manual: inspect status, snapshot, and bounded event messages in the local React client.

## 15. Implementation FAQ

**Q:** Does `seq` let the operator replay messages after reconnect?
**A:** No. It identifies stale or out-of-order messages. `GET /rounds/current` restores current state only.

**Q:** Should the server estimate the multiplier while disconnected?
**A:** No. Freeze the last known state, label it reconnecting, and disable money-affecting actions until a fresh snapshot is applied.

**Q:** Should a late `tick` be applied after `round.crashed` if its `seq` is lower?
**A:** No. The round is terminal; ignore that same-round tick.

**Q:** How will a second game be added?
**A:** It is outside this design. Revisit the module boundaries only when a concrete second game's protocol and requirements exist.
