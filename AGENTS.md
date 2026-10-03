# Agent Instructions

## Project Context

This repository is building an operator for a third-party crash game engine. Treat it as a critical, real-time system: money correctness, game-state consistency, and recovery from partial failures are core requirements.

Before changing product behavior, read the relevant `.ai/steering/` files and the active spec under `.ai/sdd/specs/`. SDD artifacts live under `.ai/`; Codex skills are in `.agents/skills/`, and Claude originals are retained in `.claude/skills/`.

Use `$sdd-*` skills for the corresponding SDD stages. Keep feature status in `.status` accurate; a draft is not approval to implement. An explicit user instruction authorizes the requested artifact or code change, so do not ask again for permission already given.

## Operator Boundaries

- Organize operator business capabilities as modules under `operator/src/modules/<module>`. Each module owns its domain, ports, use cases, controllers, adapters, and composition function.
- Keep `operator/src/server.ts` as the application composition root. Modules may depend on another module only through an explicitly exported contract; do not reach into its private folders.
- Add only the `game` module in the current feature. Future auth and financial specs add `auth` and `financial` as peer modules; do not create empty module scaffolds.
- Keep controllers thin: validate transport input, call a use case, and map its result to the transport response.
- Put application workflows in use cases. Keep provider-specific HTTP, WebSocket, authentication, and event-shape details inside a game adapter.
- Define a small game-provider port for capabilities the operator uses. Start with Crashsim; do not build a dynamic plugin registry before a second provider exists.
- The browser talks to the operator. The engine operator key and webhook secret stay server-side and must never appear in browser payloads or logs.
- Use Bun and TypeScript for the operator unless the user changes that choice. Preserve the project direction toward Fastify, PostgreSQL, Drizzle, Valibot, and React from the assessment and README.

## Critical Failure Cases

Consider relevant edge cases in every design and implementation:

- Engine stream disconnects, reconnect backoff, and snapshot resynchronization through `GET /rounds/current`.
- The engine stream has no historical replay. Use the snapshot's `seq` to restore current state; do not claim missed events were replayed.
- Events can arrive out of order with `REORDER=1`. Round state must only move forward; ignore a late `tick` for a round already marked `crashed`.
- Webhook retries can duplicate financial operations. Enforce idempotency by `txId` in the same database transaction as the balance update.
- Concurrent debits must not take a wallet below zero. Use an atomic update or row lock, and store money as integer minor units.
- A cashout timeout can have an unknown outcome. Reconcile with `GET /bets/:id` before reporting failure or retrying.
- Validate engine and browser payloads. Verify webhook HMAC over the raw body and enforce timestamp freshness.
- Expose connection health to clients so stale state is not presented as live. Freeze the last known state, show a reconnecting indicator, and disable bets/cashouts until synchronized.

The initial Crashsim stream feature includes a local-only React diagnostic client, but does not implement wallet settlement, player authentication, or the full gameplay UI. Keep those capabilities as separate specs while preserving these failure requirements for later features.
