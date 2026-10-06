# HighStack Crash Game Operator

A local full-stack implementation of a server-side operator for **Crashsim**, a simulated third-party crash-game engine. The operator keeps engine credentials off the browser, authenticates players, coordinates bets and cashouts, maintains an idempotent wallet ledger, and streams synchronized game state to the React client.

This repository was built for a full-stack engineering assessment focused on integration boundaries, money correctness, realtime recovery, and incident-oriented edge cases. It is a local MVP: wallet top-ups and payouts are simulations, not payment services.

## What is included

| Service | Purpose | Stack |
|---|---|---|
| `engine/` | Simulates a third-party crash game, HTTP API, WebSocket events, and signed wallet webhooks | Node.js 22, JavaScript |
| `operator/` | Auth, wallet and ledger, Crashsim commands, stream synchronization, and REST/SSE APIs | Bun, TypeScript, Fastify, PostgreSQL, Drizzle, Valibot |
| `client/` | Player UI for registration/login, game, wallet, local top-up, and simulated payout | React 19, TypeScript, Vite, Mantine, TanStack Query |
| `postgres` | Persistent operator data | PostgreSQL 16 |

## Run locally

Requirements: Docker and Docker Compose v2. The stack binds host ports to loopback for local use.

```bash
cp .env.example .env
# Edit the local secrets if desired; the checked-in defaults are development-only.
docker compose up --build
```

The first startup waits for PostgreSQL, applies Drizzle migrations, then starts the operator and client.

| URL | Service |
|---|---|
| <http://127.0.0.1:5173> | Player client |
| <http://127.0.0.1:3000> | Operator API |
| <http://127.0.0.1:3000/health> | Process liveness |
| <http://127.0.0.1:3000/ready> | Database and schema readiness |
| <http://127.0.0.1:4000> | Crashsim engine |

To stop the stack while preserving local database data, run `docker compose down`. To reset the local database volume as well, run `docker compose down --volumes`.

### Quick demo

1. Register a player and log in from the client.
2. Add local test funds from the wallet screen.
3. Open the game screen and wait for the SSE connection to report `connected`.
4. Place a bet during `betting`, then cash out while the round is `running`.
5. Check the bet result, wallet history, and round proof after the crash.

The UI disables game actions while the engine state is reconnecting or synchronizing. The local top-up and payout controls exist for demonstrating complete flows and do not move real money.

### Environment variables

Compose reads the optional root `.env` file. `.env.example` contains local defaults for the service credentials, log level, session lifetime, and engine integration settings. The committed credentials are only suitable for this isolated local stack; replace them before exposing any service outside loopback.

| Variable | Default | Purpose |
|---|---|---|
| `ENGINE_OPERATOR_KEY` | `dev-operator-key` | Server-to-server authentication from Operator to Crashsim |
| `WEBHOOK_SECRET` | `dev-webhook-secret` | Shared HMAC secret for Crashsim wallet callbacks |
| `LOG_LEVEL` | `info` | Operator and engine log threshold |
| `AUTH_SESSION_TTL_SECONDS` | `86400` | Player session lifetime; operator accepts 60–604800 seconds |

### Database migrations

Compose runs the one-shot `operator-migrate` service after PostgreSQL is healthy and starts the Operator only after migrations succeed. To migrate manually against the local database:

```bash
cd operator
DATABASE_URL='postgres://operator:operator@127.0.0.1:5432/operator' bun run db:migrate
```

Generate a migration from the Drizzle schema with `bun run db:generate`. Treat applied migrations as immutable; make later schema changes in a new migration. Run only one migrator at a time.

## Architecture at a glance

```mermaid
flowchart LR
  Browser[React client] -->|REST commands| Operator[Fastify Operator]
  Operator -->|SSE: snapshot, events, health| Browser
  Operator <-->|HTTP: session, bets, snapshot| Engine[Crashsim]
  Engine -->|WebSocket round events| Operator
  Engine -->|HMAC wallet callbacks| Operator
  Operator <-->|transactions and migrations| DB[(PostgreSQL)]
```

The browser only talks to the operator. The operator owns the upstream Crashsim connection, validates and reduces its events, and fans state out to browser subscribers. Financial callbacks are verified and applied synchronously so the engine receives success only after the wallet operation is committed.

### How the Operator code is organized

```mermaid
flowchart TD
  Server[server.ts<br/>application composition root]
  Module[Module composition<br/>auth.module / financial.module / game.module]
  Controller[Controllers<br/>HTTP validation and response mapping]
  Service[Module service<br/>public facade and use-case composition]
  Usecases[usecases/<br/>cohesive business workflows]
  Integration[integrations/crashsim/<br/>provider HTTP, WS, HMAC]
  Realtime[game/realtime/<br/>stream, reducer, fan-out]
  Database[(PostgreSQL / Drizzle)]

  Server --> Module
  Module --> Controller
  Controller --> Service
  Service --> Usecases
  Usecases --> Database
  Usecases --> Integration
  Module --> Realtime
  Realtime --> Integration
```

`server.ts` is the only application composition root. The three module files register routes and wire local dependencies. Controllers stay thin and do transport work. Each module's service exposes a stable API and composes its use cases; business decisions stay inside cohesive flows under `usecases/`.

The game module has two clear paths:

- **Commands:** `commands.controller` → `game.service` → session/bet/cashout/read/reconciliation use cases → PostgreSQL, the financial contract, or the concrete Crashsim HTTP client.
- **Realtime:** Crashsim WebSocket → validated stream client → `realtime/stream.service` → `round-state` reducer → `GameEventFanout` → SSE controller → browser.

`GameEventFanout` is an in-process subscriber registry. It captures a snapshot and buffers concurrent messages until the SSE controller writes that snapshot, preventing a new client from seeing a newer event before its baseline. The stream service owns synchronization and publication; the controller only writes SSE frames and cleans up disconnected subscribers.

See [Architecture and code map](docs/architecture.md) for responsibilities of each source directory and detailed sequence diagrams. See [Failure scenarios](docs/failure-scenarios.md) for the reconnect, reorder, duplicate webhook, concurrency, and unknown-command protections.

### Documentation

The `docs/` directory keeps the deeper material close to the code while this README remains the starting point:

- [Architecture and code map](docs/architecture.md) — module responsibilities, source layout, realtime delivery, and command composition.
- [Design decisions](docs/decisions.md) — tradeoffs, deliberate scope limits, and the requirements-first development approach.
- [API reference](docs/api-reference.md) — REST, SSE, authentication, money units, idempotency, and webhook contracts.
- [Failure scenarios](docs/failure-scenarios.md) — duplicate callbacks, concurrent money operations, stream recovery, out-of-order events, timeouts, and known recovery limits.
- [UI references](highstack-design-references/screens/README.md) — screen concepts and local visual assets.

## Main decisions

- **REST for commands, SSE for game state.** Commands are request/response operations; the live stream is one-way from server to browser. The operator still uses WebSocket upstream because that is the engine protocol.
- **One concrete provider integration.** The current game module supports Crashsim directly. There is no generic game registry or speculative adapter layer; another engine would justify a design based on its actual protocol.
- **Cents and database transactions for money.** Amounts are integer minor units. Idempotency and the balance/ledger update are persisted together; concurrent debits cannot take a wallet below zero.
- **Unknown means unknown.** If a bet or cashout mutation times out, the operator reconciles using persisted command state and an authoritative engine read. It does not blindly repeat a mutation.
- **Snapshot recovery, not event replay.** Crashsim does not expose stream history. After reconnect or a sequence gap, the operator restores the current state from `GET /rounds/current` and does not claim missed events were replayed.
- **Local payout simulation.** The payout flow demonstrates idempotent request, debit, status polling, and restart recovery without a payment provider.

More context and tradeoffs are in [Design decisions](docs/decisions.md).

## API overview

| Capability | Main routes |
|---|---|
| Authentication | `POST /auth/register`, `POST /auth/login`, `GET /auth/me`, `POST /auth/logout` |
| Wallet | `GET /wallet`, `GET /wallet/transactions`, local-only `POST /wallet/top-ups` |
| Simulated payout | `POST /payouts`, `GET /payouts`, `GET /payouts/:payoutId` |
| Game commands | `POST /game/session`, `POST /game/bets`, `GET /game/bets`, `GET /game/commands/:commandId`, `GET /game/bets/:betId`, `POST /game/bets/:betId/cashout` |
| Realtime | `GET /game/events` (SSE) |
| Engine callbacks | `POST /wallet/debit`, `POST /wallet/credit` (HMAC-authenticated) |

Authenticated player routes derive `playerId` from the session, never from browser input. Money values in API payloads are integer cents. See the [API reference](docs/api-reference.md) for authentication, idempotency, response semantics, and webhook details.

## Tests and checks

Run the Operator checks from its package directory:

```bash
cd operator
bun install --frozen-lockfile
bun run typecheck
bun run test:e2e
```

`test:e2e` starts a temporary PostgreSQL container and runs the full Operator suite, including migrations, financial concurrency/idempotency, authenticated game commands, SSE synchronization, and Crashsim integration behavior. The suite uses test doubles for external engine calls; use the local Compose walkthrough to inspect the running services together.

Run the client checks:

```bash
cd client
bun install --frozen-lockfile
bun run typecheck
bun test
bun run build
```

Run the engine checks:

```bash
cd engine
npm ci
npm test
```

## Deliberate MVP limits

- One Operator process is supported. The upstream stream, Crashsim player sessions, and request coalescing are process-local; multi-instance fan-out and shared session storage are out of scope.
- The engine stream has no historical replay. Current state is recoverable from snapshots, but transient missed ticks are not.
- Top-ups and payouts are local simulations. There is no payment provider or production cash movement.
- An ambiguous bet debit followed by an engine rejection is not automatically compensated. The command records the conflict; the wallet operation needs investigation rather than an unsafe guessed reversal.
- The current JSON money contract uses JavaScript safe integers. Values outside that range are rejected instead of rounded.

These limits are described alongside recovery behavior in the [failure scenarios](docs/failure-scenarios.md).

## Engineering workflow

The work was developed requirements-first: clarify boundaries and failure cases, write and review the design and tasks, then implement one module slice at a time. AI tools assisted with exploration and implementation; behavior was checked against the code, typed contracts, and automated tests, especially around retries, ordering, unknown outcomes, and money. The repository keeps the resulting specifications and implementation history so the decisions can be discussed and changed deliberately.
