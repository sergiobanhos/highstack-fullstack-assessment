# Design: Crashsim real-time operator proxy

> Requirements: @requirements.md
> Status: Approved

## 1. Summary

Structure the operator around thin transport controllers, application use cases, and a provider adapter behind a small game port. One Crashsim stream client feeds operator-owned round state and an in-process event hub. Browser clients connect only to the operator and receive a snapshot followed by live events. A minimal React debug client displays connection health, the current snapshot, and a bounded log of received events; it has no betting controls or styling scope.

## 2. Requirements Mapping

| Requirement | Design Coverage |
|-------------|-----------------|
| FR-001 | Sections 3, 4, 6, and 7 |
| FR-002 | Sections 3, 4, and 6 |
| FR-003 | Sections 4, 5, and 6 |
| FR-004 | Sections 5, 6, and 8 |
| FR-005 | Sections 5 and 8 |
| FR-006 | Sections 5, 6, and 8 |
| FR-007 | Sections 3 and 4 |
| FR-008 | Sections 3, 4, 6, and 9 |
| NFR-001 | Section 7 |
| NFR-002 | Sections 5 and 8 |
| NFR-003 | Section 11 |
| NFR-004 | Sections 6, 7, 9, and 12 |

## 3. Technical Approach

Use Bun and TypeScript for the operator, with Fastify at the HTTP boundary. Keep the existing README direction for GraphQL game operations. Use a separate SSE endpoint for one-way game-state fan-out. The Crashsim adapter owns the engine HTTP and WebSocket protocols, the operator key, event validation, and mapping to internal event types.

Use React 19 and TypeScript with Vite for the debug client, as agreed by the user and aligned with `ASSESSMENT.md`. Serve the debug client only in the local development composition until player authentication exists. QuickJS is not part of this browser client.

Use Valibot to validate provider event payloads at the adapter boundary. This feature does not need persistent operator data, so Drizzle is deferred to wallet persistence; keep the existing PostgreSQL compose service available for those later features.

The provider port should expose only capabilities required by the current feature, such as `getCurrentRound()` and `subscribeToRoundEvents()`. Add session, bet, and cashout capabilities when their features are specified. Do not create a generic plugin loader or provider registry for a single implementation.

## 4. Component / Module Structure

```text
operator/
  src/
    server.ts
    domain/
      game-event.ts
      round-state.ts
    ports/
      game-provider.port.ts
    usecases/
      start-game-stream.usecase.ts
      get-current-round.usecase.ts
      subscribe-to-game-events.usecase.ts
    controllers/
      game-events.controller.ts       # downstream SSE
      game-api.resolver.ts            # GraphQL operations as added
    adapters/
      games/
        crashsim/
          crashsim-game.adapter.ts
          crashsim-http.client.ts
          crashsim-stream.client.ts
          crashsim-event.mapper.ts
      realtime/
        in-memory-event-hub.ts
client/
  Dockerfile
  package.json
  vite.config.ts
  src/
    main.tsx
    App.tsx
    operator-events.client.ts
```

Dependency direction: `controllers -> usecases -> ports`; `adapters` implement ports and are wired at startup. Controllers do not call Crashsim directly or own round-transition rules.

## 5. Data Model / State

Keep the live snapshot in process memory for this feature:

- `roundId`, `state`, `seq`, `serverSeedHash`
- betting/running timestamps and current multiplier when provided
- crash point and revealed seed only after the round crashes
- upstream connection state (`connected`, `reconnecting`, `synchronizing`)

Do not persist stream ticks or claim durable event history. Wallet and bet state belong to later domain features and their persistent records.

## 6. API / Integration Contract

### Operator to Crashsim

- WebSocket: `ws://engine:4000/stream?key=<operator-key>` for this engine's stream contract.
- HTTP snapshot: `GET /rounds/current` with `x-operator-key`.
- Keep these URLs and credentials in server configuration; do not expose the key to browsers.

### Debug / player client to operator

- `GET /game/events` over SSE for one-way game updates and connection state. The debug client consumes this endpoint and prints event type, sequence, round ID, and relevant snapshot fields.
- On every new SSE connection, send an operator snapshot first, then live normalized events. Resubscription gets a new current snapshot; do not depend on historical SSE replay.
- Serve the initial Vite client locally and proxy its `/game/events` request to the operator; do not enable public access without player authentication.
- Authenticate the stream with the operator's player session before public exposure.
- Keep the initial debug client development-only; it is not a public player surface and exposes no bet/cashout controls.
- For later game commands, keep GraphQL resolvers/controllers separate from the SSE controller.

The client keeps only the latest snapshot and a bounded in-memory list of the most recent 100 received messages. It renders the payload fields as readable text and does not extrapolate a multiplier while disconnected.

## 7. Security / Permissions / Privacy

- Only the Crashsim adapter knows the engine operator key.
- Do not put the engine key in SSE URLs, client messages, logs, or error details.
- Validate engine event envelopes and player authorization at the boundary.
- Follow the existing webhook signature requirements in the later wallet feature; this stream feature does not implement webhooks.

## 8. Resynchronization and Edge Cases

1. Open the engine WebSocket and attach the message handler immediately; buffer events while synchronization is in progress.
2. Fetch `GET /rounds/current` and replace the operator's round state with that snapshot.
3. Set the applied sequence baseline to the snapshot's `seq`; discard buffered events at or below it.
4. Apply buffered events above the snapshot sequence, then process live events. Ignore duplicate or older sequence values.
5. If a sequence gap is observed during a live session, fetch a fresh snapshot. This restores current state, not the missing event history.
6. If a `round.crashed` has been applied, ignore any later-delivered `tick` for that same `roundId`. Accept the next `round.betting` as the next round transition.
7. During upstream loss, publish `reconnecting`, freeze the last snapshot, and tell clients to disable bets/cashouts. After synchronization, publish the new snapshot before returning to `connected`.
8. Reconnect with bounded exponential backoff and jitter. A browser reconnect never opens another upstream engine socket.

## 9. User Flows

```mermaid
sequenceDiagram
    participant C as Local debug client
    participant O as Operator
    participant E as Crashsim engine
    C->>O: Connect to SSE (local development)
    O-->>C: Current snapshot
    E-->>O: round events over one WebSocket
    O-->>C: Normalized live events
    E--xO: Stream disconnects
    O-->>C: reconnecting; freeze state and disable actions
    O->>E: Reconnect WebSocket
    O->>E: GET /rounds/current
    E-->>O: Snapshot + seq
    O-->>C: Resynchronized snapshot
    O-->>C: Resume live events
```

## 10. Edge Cases

| Case | Expected Behavior |
|------|-------------------|
| Engine unavailable on startup | Keep operator alive, report reconnecting, retry with bounded backoff; the debug client shows that no synchronized snapshot is available yet. |
| Stream drops mid-round | Freeze client state, disable actions, reconnect, then snapshot-sync. |
| `round.crashed` arrives before a delayed `tick` | Keep the round crashed and ignore that same-round tick. |
| Duplicate or older event sequence | Do not apply it to current state. |
| Malformed or unsupported event | Reject it at the adapter boundary and log a safe validation error. |
| Snapshot request fails after socket reconnect | Keep clients in reconnecting state and retry synchronization before resuming. |
| Operator restarts | Reconnect and fetch current snapshot; prior event history is unavailable. |
| Multiple operator replicas | Not supported by the in-memory hub in this feature; add cross-instance pub/sub in a later scale spec. |
| Debug client reloads during an outage | Reconnect to the operator; display the latest operator state and connection status, without claiming missed event history. |

## 11. Observability / Operations

Log upstream connect/disconnect, reconnect attempt, snapshot synchronization, sequence gap, and invalid event type. Include provider and round IDs where safe. Never log secrets. Expose current upstream health to operator clients.

## 12. Migration / Rollout

No database migration is required. Replace the current smoke container entrypoint with the operator server after the new service can connect, snapshot-sync, and fan out events. Keep the smoke client available until the integration check proves the new adapter works. Add a local-only Vite client service to the root Docker Compose file, expose it on a development port, and proxy its SSE request to the operator service over the Compose network. Do not expose this unauthenticated debug page as a public deployment.

## 13. Technical Decisions

### TD-001: Provider port with one concrete adapter

- **Decision:** Define a narrow shared game-provider port and implement it with Crashsim.
- **Why:** Provider protocol details stay isolated without creating a speculative plugin system.
- **Trade-off:** Shared capabilities may expand when the next provider is known.
- **Alternatives considered:** Direct engine calls from use cases; a dynamic multi-provider registry.

### TD-002: SSE for downstream fan-out

- **Decision:** Use SSE for one-way game events; use GraphQL/HTTP for commands.
- **Why:** The browser only needs server-to-client updates in this stream.
- **Trade-off:** Browser-to-server real-time messages use a separate request path.
- **Alternatives considered:** A downstream WebSocket for both directions.

### TD-003: Snapshot resync, not event replay

- **Decision:** Restore current round state from the engine snapshot and use `seq` to discard stale updates.
- **Why:** The current engine exposes no replay endpoint or durable event log.
- **Trade-off:** Transient events from a missed interval cannot be recovered from the engine stream alone.
- **Alternatives considered:** Add event persistence/replay, requiring a new engine contract.

### TD-004: Minimal browser debug client

- **Decision:** Use React 19 + TypeScript + Vite for a local debug page; keep it plain and limited to connection status, the current snapshot, and a bounded event log.
- **Why:** The assessment specifies React 19 and TypeScript, and the browser page makes the end-to-end integration observable. React's web renderer targets a browser DOM; QuickJS is an embeddable JavaScript runtime and is not needed here.
- **Trade-off:** Adds a small client package and local Compose service; the page remains diagnostic rather than a gameplay UI.
- **Alternatives considered:** Rely only on operator console output; use QuickJS as the client runtime.

## 14. Risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| A missing event is mistaken for a harmless gap | High | Snapshot-sync current state; keep financial outcomes in durable operator records, not the stream. |
| Out-of-order delivery regresses client state | High | Keep sequence-aware state reduction and reject same-round ticks after crash. |
| In-memory fan-out is used with multiple replicas | Medium | Keep one upstream connection per process and defer multi-instance deployment until shared pub/sub exists. |
| Stream endpoint is exposed without player auth | High | Keep the debug client local-only; require operator session authorization before public rollout. |

## 15. Verification Strategy

- Unit: event validation and round-state reducer, including a late `tick` after crash.
- Integration: connect to Crashsim, receive round events, and verify the snapshot baseline.
- Fault scenarios: `DROP_WS_EVERY=8` and `REORDER=1`; verify client stale state and recovery behavior.
- Manual: confirm one upstream socket remains regardless of downstream client count, and verify the engine key never appears in browser traffic or logs.
- Manual: open the React debug client and observe connection state, a current snapshot, live events, and reconnect/resynchronization behavior.
- Exact automated commands will be recorded when the operator package and test scripts are created.

## 16. Implementation FAQ

**Q:** Does `seq` let the operator replay messages after reconnect?  
**A:** No. It lets the operator identify stale or out-of-order messages. `GET /rounds/current` restores the latest state only.

**Q:** Should the server estimate the multiplier while disconnected?  
**A:** No. Freeze the last known state, label it reconnecting, and disable money-affecting actions until a fresh snapshot is applied.

**Q:** Should a late `tick` be applied after `round.crashed` if its `seq` is lower?  
**A:** No. The round is terminal; ignore that same-round tick.
