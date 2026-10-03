# Product Steering

## Purpose

The operator is the server-side boundary between player clients and third-party game engines. It authenticates players, proxies game actions, protects provider credentials, maintains wallet correctness, and distributes real-time game state.

## Target Users

- **Player:** needs a responsive game view and reliable bets, cashouts, and balance updates.
- **Operator maintainer:** needs provider integrations that are observable and recover safely from failures.

## Current State

The repository contains the Crashsim engine, PostgreSQL in Docker Compose, and a Bun/TypeScript smoke client that connects to the engine stream and prints events. The operator API, player client, authentication, and wallet are not implemented yet.

## Goals

- Keep engine credentials on the server and prevent browsers from calling the engine directly.
- Keep game state correct during disconnects, reconnects, delayed events, and out-of-order delivery.
- Make wallet operations safe under retries and concurrent requests.
- Isolate provider-specific behavior behind adapters while starting with Crashsim only.

## Non-Goals

- Build a multi-provider marketplace or dynamic plugin registry before a second game provider exists.
- Treat a live event stream as a durable event history.
- Let the UI be the authority for wallet balances or bet outcomes.

## Open Questions

- None currently. During an engine stream outage, the player sees the last state frozen with a reconnecting indicator, and game actions are disabled until resynchronization completes.
