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
| F01 | Crashsim adapter, live state relay, and debug client | Operator / game integration | Establish controller/use-case/adapter boundaries, consume and resynchronize the engine stream, fan out state, and inspect it in a minimal React debug client. |

### Later phases

| ID | Feature | Module | Description |
|----|---------|--------|-------------|
| F02 | Player identity and game sessions | Operator / auth | Authenticate players and create provider sessions. |
| F03 | Wallet ledger and webhooks | Operator / wallet | Process signed, retried debit and credit webhooks idempotently and safely under concurrency. |
| F04 | Player game client | Client | Display current state, balance, bet form, and cashout flow after identity and wallet flows exist. |

## Open Questions

- None for the initial Crashsim stream feature. Player behavior during an outage is recorded in its requirements.

## Next Actions

- [x] Approve `.ai/sdd/specs/001-crashsim-realtime-proxy/requirements.md`
- [x] Approve the design for `.ai/sdd/specs/001-crashsim-realtime-proxy/`
- [ ] Create implementation tasks for feature F01
