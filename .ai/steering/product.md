# Product Steering

## Purpose

The operator is the server-side boundary between player clients and third-party game engines. It authenticates players, proxies game actions, protects provider credentials, maintains wallet correctness, and distributes real-time game state.

## Target Users

- **Player:** needs a responsive game view and reliable bets, cashouts, and balance updates.
- **Operator maintainer:** needs provider integrations that are observable and recover safely from failures.

## Current State

The repository contains the Crashsim engine, the Bun/TypeScript Fastify operator, PostgreSQL with Drizzle migrations, and a React diagnostic/player client. The operator provides player auth, wallet and ledger operations, game commands, and Crashsim realtime state over SSE.

## Goals

- Keep engine credentials on the server and prevent browsers from calling the engine directly.
- Keep game state correct during disconnects, reconnects, delayed events, and out-of-order delivery.
- Make wallet operations safe under retries and concurrent requests.
- Keep the current Crashsim integration concrete and direct; do not add a generic provider layer before another real integration requires it.

## Non-Goals

- Build a multi-provider marketplace or dynamic plugin registry before a second game provider exists.
- Treat a live event stream as a durable event history.
- Let the UI be the authority for wallet balances or bet outcomes.

## Open Questions

- None currently. During an engine stream outage, the player sees the last state frozen with a reconnecting indicator, and game actions are disabled until resynchronization completes.
