# Product Plan: Crash Game Operator

> Status: Draft
> Steering: @.ai/steering/product.md · @.ai/steering/tech-stack.md · @.ai/steering/conventions.md

## Vision

Build a server-side operator that safely proxies player actions to game engines, maintains wallet correctness, and keeps clients synchronized with real-time game state through provider failures.

## Steering Context

- Product: @.ai/steering/product.md
- Tech Stack: @.ai/steering/tech-stack.md
- Conventions: @.ai/steering/conventions.md

## Personas

- **Player:** needs accurate game state, balance, and bet outcomes.
- **Operator maintainer:** needs clear provider boundaries and recoverable integrations.

## MVP Boundary

### Must Have

- Keep the engine private behind the operator and protect provider credentials.
- Synchronize and fan out Crashsim state through disconnects and out-of-order delivery.
- Keep wallet debits and credits idempotent and concurrency-safe.
- Provide a minimal React debug client for inspecting connection health, the current snapshot, and received events.

### Won't Have Yet

- A second game provider or dynamic adapter registry.
- Multi-instance fan-out infrastructure such as Redis Pub/Sub.
- Durable replay of engine events unless the provider adds a replay contract.
- Full player gameplay UI, including balance, bet, and cashout controls.

## Feature Map

### Phase 1 — Operator foundation

| ID | Feature | Module | Description |
|----|---------|--------|-------------|
| F01 | Crashsim live state relay and debug client | Operator / game | Keep one direct Crashsim integration in a small `game` module, resynchronize the engine stream, fan out state over SSE, and inspect it in a minimal React debug client. |

### Later phases

| ID | Feature | Module | Description |
|----|---------|--------|-------------|
| F02 | Player identity and game sessions | Operator / auth | Add the `auth` module for player identity and provider sessions. |
| F03 | Wallet ledger and webhooks | Operator / financial | Add the `financial` module for signed, retried debit and credit webhooks processed idempotently and safely under concurrency. |
| F04 | Player game client | Client | Display current state, balance, bet form, and cashout flow after identity and wallet flows exist. |

## Open Questions

- None for the initial Crashsim stream feature. Player behavior during an outage is recorded in its requirements.

## Next Actions

- [x] Approve narrowed requirements for `.ai/sdd/specs/001-crashsim-realtime-proxy/`
- [x] Approve the initial design for `.ai/sdd/specs/001-crashsim-realtime-proxy/`
- [x] Draft implementation tasks for feature F01
- [x] Review and approve tasks for feature F01
- [x] Approve the simplified Crashsim-only design and task plan
- [x] Implement feature F01, aligning existing code with the direct Crashsim structure
