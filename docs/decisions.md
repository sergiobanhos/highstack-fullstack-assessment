# Design decisions and tradeoffs

These notes summarize the choices that shaped the implementation and why they fit this assessment. They are not claims that the MVP is a production payment platform.

## 1. Keep the browser behind the Operator

**Decision:** the client calls Operator REST and SSE; only the Operator calls Crashsim HTTP/WebSocket and receives its wallet webhooks.

**Why:** provider credentials remain server-side, the Operator can authenticate the player and validate commands, and financial state has one persistence boundary. The React client is never an authority for balance or bet result.

## 2. REST for commands and SSE for downstream state

**Decision:** use REST for registration, wallet operations, bet/cashout commands and reads; use SSE for the one-way Operator-to-browser live feed. Keep WebSocket only on the Operator-to-Crashsim link because that is the provider protocol.

**Why:** browser-to-server commands need request/response status and idempotency headers. The browser's live game feed is server-to-client, so SSE gives automatic reconnect and event framing without a second bidirectional protocol in the client.

**Tradeoff:** SSE does not provide durable replay. The client reconnects and receives the current snapshot, not every event it missed.

## 3. Crashsim-only integration, no speculative provider framework

**Decision:** `integrations/crashsim/` contains concrete clients and payload validation. `modules/game` directly owns Crashsim session, bet, cashout, and reconciliation flows. There is no provider registry, plugin system, generic game port, or empty module scaffold.

**Why:** there is one known game with one known protocol. A generic boundary before a second provider exists would add names and indirection without proven shared behavior. If another game is introduced, first compare its real authentication, event ordering, settlement, and recovery needs, then extract only the seams that are genuinely shared.

## 4. Module facades and cohesive use cases

**Decision:** auth, financial, and game are peer modules. Each service is the public facade and local composition point; use cases implement named business workflows; controllers translate transport input/output. `server.ts` is the only application composition root.

**Why:** this gives maintainers a predictable route from HTTP to business behavior without a generic DI container or repository layer. The game facade wires real use cases; it does not hide a second oversized runtime wrapper.

**Tradeoff:** the game service contains visible wiring. That is useful composition, while bet, cashout, persistence, and reconciliation behavior stays in the use-case files.

## 5. Treat money as integer cents and commit ledger effects atomically

**Decision:** store USD amounts in integer cents, use PostgreSQL uniqueness for idempotency, lock the player's wallet row, and persist the operation, balance change, and ledger entry in one transaction.

**Why:** webhook retries and concurrent debits are expected failure modes. A read-then-write balance check could overspend; floating-point values could round money. The wallet row lock and transaction serialize balance mutations, while the unique `txId` prevents duplicate effects.

**Tradeoff:** the current JSON contract transports safe JavaScript integers only. Larger values are rejected rather than approximated; preserving larger exact values would require a compatible engine contract such as decimal strings.

## 6. Model mutation timeouts as unknown outcomes

**Decision:** persist a command before calling the engine, preserve its idempotency key, and distinguish `accepted`, `rejected`, and `unknown`. After an ambiguous mutation, query the existing command or `GET /bets/:id`; do not blindly send another POST.

**Why:** a timeout tells the Operator that it did not receive a response, not whether the engine applied the mutation. Repeating a non-idempotent engine request could create a second bet or cashout.

**Scope choice:** the MVP permits one bet per player per round. A definitively rejected attempt such as insufficient funds can be tried again with a new key while betting remains open; an unresolved outcome blocks another key for that round.

## 7. Resynchronize from snapshots instead of claiming replay

**Decision:** use event `seq` for ordering and detect gaps. On disconnect or a gap, fetch `GET /rounds/current` and start from the authoritative current state. A crash is terminal for that round in the reducer, including when a late tick has a higher `seq`.

**Why:** the provider does not expose event history. A snapshot can restore current game state, but it cannot recover transient ticks or prove the client saw every event.

## 8. Process wallet webhooks synchronously for this MVP

**Decision:** the webhook request runs the financial transaction before returning to Crashsim. There is no Inbox, Outbox, queue, or financial worker in this scope. The local payout simulation has its own due-item processor because it demonstrates pending/completed payout lifecycle.

**Why:** Crashsim waits for the debit response before accepting the bet, so the synchronous transaction directly answers whether the bet may proceed. Idempotent `txId` retries handle duplicate delivery. A separate worker would add operations and recovery rules without removing this request-time dependency.

**Tradeoff:** financial database availability affects bet placement. A production deployment may need durable callback intake, retry monitoring, and reconciliation depending on provider guarantees and service-level requirements.

## 9. Make local money flows useful but explicit

**Decision:** local Compose enables test top-up and simulated payout. Payout requests debit the wallet and become `processing`; a local processor marks them complete without a payment provider.

**Why:** the UI can demonstrate wallet history and payout states end-to-end without real credentials or transfers.

**Boundary:** these routes are gated to `APP_ENV=local`; they are not real payment integrations and must not be enabled in a deployed environment.

## 10. Use a requirements-first AI-assisted workflow

**Decision:** define requirements, design, edge cases, and tasks before implementing each feature slice; keep the SDD artifacts and focused commits with the repository.

**Why:** AI can produce a plausible happy path while missing duplicate delivery, event reordering, partial failure, or money races. Requirements and failure cases were reviewed before implementation, and critical behavior was checked against automated tests and running services.

**Use of AI:** AI tools assisted with codebase exploration, documentation/spec drafting, implementation, and review. The implementation was treated as a proposal to verify, not as an authority; human decisions set scope and tradeoffs, and tests/code review checked results. The process and commit history are visible in the repository.

## Known residual limits

- One Operator instance: stream fan-out and Crashsim sessions are process-local; there is no cross-instance pub/sub or distributed coordination.
- No historical stream replay; only current snapshot recovery.
- No automatic compensating credit if the engine rejects a bet after the debit committed but every result response was lost. The conflict must be investigated; an unsafe guessed reversal is not performed.
- No production payment provider, email verification, password reset, or withdrawal rails.
- A real Crashsim deployment smoke test and production operational runbooks are outside this local assessment build.
