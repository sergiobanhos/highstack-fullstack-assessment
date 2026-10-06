# Architecture and code map

## System boundary

```mermaid
flowchart LR
  subgraph Player[Player browser]
    React[React 19 client]
  end

  subgraph Operator[Operator process]
    HTTP[Fastify REST controllers]
    SSE[SSE controller]
    Auth[auth module]
    Game[game module]
    Financial[financial module]
    Crashsim[concrete Crashsim clients]
    Stream[realtime stream service]
    Fanout[GameEventFanout]
    Reducer[round-state reducer]
    DB[(PostgreSQL)]
  end

  Engine[Crashsim engine]

  React -->|REST + bearer token| HTTP
  React -->|GET /game/events| SSE
  HTTP --> Auth
  HTTP --> Game
  HTTP --> Financial
  Auth --> DB
  Financial --> DB
  Game --> DB
  Game --> Financial
  Game --> Crashsim
  Engine -->|signed debit/credit webhooks| Financial
  Engine -->|WebSocket events| Crashsim
  Crashsim --> Stream
  Stream <--> Reducer
  Stream --> Fanout
  SSE --> Fanout
  Stream <-->|HTTP snapshot| Engine
  Fanout -->|snapshot, game events, connection health| SSE
```

The browser never connects directly to Crashsim. `ENGINE_OPERATOR_KEY` and `ENGINE_WEBHOOK_SECRET` are server-side configuration. `server.ts` creates the database, logger, and three business modules; modules exchange capabilities through exported contracts.

## Repository map

```text
.
├── client/                         # React 19 + Vite player application
│   └── src/
│       ├── app/                    # session boot and authenticated shell
│       ├── pages/                  # auth, game, and wallet screens
│       ├── features/
│       │   ├── auth/               # player session and auth commands
│       │   ├── game/               # SSE, game commands, proof and UI
│       │   └── wallet/             # wallet/payout queries and UI
│       └── lib/
│           ├── operator/           # typed, validated HTTP boundary
│           ├── query/              # React Query client and cache keys
│           └── money/              # integer-cent parsing and formatting
├── operator/
│   ├── src/server.ts               # application composition root
│   ├── src/config.ts               # validated env and redacted logging
│   ├── src/db.ts                   # PostgreSQL and Drizzle connection
│   ├── src/migrate.ts              # migration entrypoint for Compose
│   ├── drizzle/                    # checked-in SQL migrations
│   └── src/
│       ├── integrations/crashsim/  # concrete HTTP, WS, HMAC protocol code
│       └── modules/
│           ├── auth/               # identity, sessions, auth use cases
│           ├── financial/          # wallet, ledger, payouts, webhook routes
│           └── game/               # Crashsim commands and realtime state
├── engine/                         # simulated third-party provider
├── docs/                           # architecture, API, decisions, failures
└── docker-compose.yml              # local development stack
```

### Operator module responsibilities

| Path | Responsibility |
|---|---|
| `operator/src/server.ts` | Composition root, readiness/liveness, startup and graceful shutdown. It imports only public module contracts. |
| `operator/src/integrations/crashsim/` | Provider-specific HTTP and WebSocket transport, schemas, operator-key handling, and HMAC verification. This code does not own wallet or game business rules. |
| `modules/auth/` | Registration, login, session resolution/revocation, and request-scoped authenticated identity. `auth.service.ts` composes the auth use cases. |
| `modules/financial/` | Wallet, integer-cent ledger, top-up/payout flows, idempotent engine callbacks, and callback HTTP boundary. `financial.service.ts` composes the financial use cases. |
| `modules/game/controllers/` | Thin REST and SSE transport boundaries. The command controller authenticates and validates; the SSE controller writes the captured snapshot and then activates subscription delivery. |
| `modules/game/usecases/` | Session creation, bet/cashout commands, command reads, reconciliation, and recording a financially confirmed cashout. |
| `modules/game/game.service.ts` | Public game facade and composition point for game use cases. It connects shared dependencies and returns the stable module API. |
| `modules/game/realtime/stream.service.ts` | One upstream stream lifecycle, snapshot sync, reconnect/backoff, sequence-gap recovery, reduction, and event publication. |
| `modules/game/realtime/round-state.ts` | Pure state reducer. Duplicate/old sequence values are ignored; a crashed round cannot return to running. |
| `modules/game/realtime/event-fanout.ts` | Private in-process subscription fan-out. It captures a snapshot and queues concurrent events until the subscriber activates. |

`service.ts` files are not intended to duplicate business logic. They compose use cases and expose the operations controllers or another module need. A use case is introduced for a coherent business flow, rather than as a forwarding wrapper. Persistence uses Drizzle directly where a flow needs a transaction; there is no generic repository or dependency-injection framework.

## Realtime path: Engine to browser

```mermaid
sequenceDiagram
  participant Engine as Crashsim
  participant Client as integrations/crashsim/stream.client
  participant Stream as game/realtime/stream.service
  participant Reducer as round-state
  participant Hub as GameEventFanout
  participant SSE as events.controller
  participant Browser as React EventSource

  Engine-->>Client: WebSocket event + seq
  Client->>Stream: validated provider event
  Stream->>Reducer: apply event
  Reducer-->>Stream: next monotonic round state
  Stream->>Hub: publish game-event or connection health
  Browser->>SSE: GET /game/events
  SSE->>Hub: subscribe and capture snapshot
  Hub-->>SSE: snapshot + current connection state
  SSE-->>Browser: event: snapshot
  SSE->>Hub: activate subscription
  Hub-->>SSE: queued messages newer than snapshot baseline
  SSE-->>Browser: event: game-event / connection
```

There is one upstream WebSocket per Operator process, regardless of the number of browsers. A new browser receives a consistent snapshot first. Events published while the snapshot is being written are queued and then delivered only if newer than its `seq` baseline.

After an upstream disconnect or a sequence gap, the stream service keeps the last state but marks the connection as `reconnecting` or `synchronizing`. It gets the present state from `GET /rounds/current`, applies that snapshot as the new baseline, then accepts newer events. Crashsim provides no history endpoint, so missed ticks are not replayed. Clients freeze the last known state and disable bet/cashout until synchronization completes.

On `round.crashed`, the stream service schedules bet reconciliation in the background. Publishing the crash event does not wait for database reads or per-bet engine requests. Reconciliation reads each persisted bet from Crashsim and never infers a loss or creates a payout solely from a round event.

## Command and money path

```mermaid
sequenceDiagram
  participant Browser
  participant Controller as game commands.controller
  participant Auth as auth.requireUser
  participant Game as game.service + use cases
  participant DB as PostgreSQL
  participant Engine as Crashsim HTTP
  participant Financial as financial contract

  Browser->>Controller: POST /game/bets + Idempotency-Key
  Controller->>Auth: resolve bearer identity
  Auth-->>Controller: authenticated playerId
  Controller->>Game: validated command
  Game->>DB: reserve command before external side effects
  Game->>Engine: POST /bets (server-side session)
  Engine->>Financial: signed POST /wallet/debit
  Financial->>DB: unique txId + locked wallet + ledger in transaction
  Financial-->>Engine: 200 after commit (or 402 if insufficient)
  Engine-->>Game: authoritative command response
  Game->>DB: persist accepted/rejected/unknown result
  Game-->>Controller: stable command result
  Controller-->>Browser: HTTP response
```

The financial service processes engine webhooks synchronously. It does not answer success until the wallet operation is committed. A cashout result in the game and its wallet credit are separate facts: the financial module applies the credit, then calls the game module through a late-bound exported callback so the bet can reflect confirmed settlement without a module import cycle.

For an ambiguous bet or cashout timeout, the command remains `unknown` until a read-only reconciliation determines the engine state. Repeating the original idempotency key returns the stored outcome; a new key cannot bypass an unresolved command. See the [API reference](api-reference.md) for route contracts and the [failure scenarios](failure-scenarios.md) for recovery details.

## Client organization

The browser uses React Query for REST reads and mutations. Its API boundary under `client/src/lib/operator/` validates response shapes and maps errors. Auth, game, and wallet features own their query/mutation hooks and UI components. SSE stays outside the REST query cache because it has its own snapshot, ordering, and connection-health semantics. The game screen uses it to freeze state during recovery and gate commands; after a reload, persisted game command reads restore the player's recent bets.

The client verifies a finished round locally: the engine publishes `SHA-256(serverSeed)` before betting, reveals `serverSeed` after crash, and computes the crash point with `HMAC-SHA256(key=serverSeed, message=roundId)`. The browser reproduces both checks using Web Crypto and integer arithmetic.
