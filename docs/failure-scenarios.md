# Failure scenarios and recovery guarantees

A crash-game Operator sits between a browser, a stateful external engine, and a wallet. The design assumes callbacks can be delivered more than once, network responses can be lost after an operation succeeds, streams can disconnect, and event order can differ from send order. This document describes those risks and how the current implementation responds.

## Protection and verification map

| Failure mode | Protection | Evidence in the codebase |
|---|---|---|
| The same wallet callback is delivered more than once | Unique engine `txId`, matching request validation, and an atomic operation/wallet/ledger transaction. A replay returns the original persisted outcome and balance without another ledger entry. Cashout credits also converge on `cashout:<betId>`. | `operator/src/modules/financial/financial.service.test.ts`, `financial.controller.test.ts`, and `server.financial.integration.test.ts`. |
| Two different debits race against one wallet | Lock the wallet row inside the transaction, check the latest balance, then update balance and insert the ledger row before commit. The insufficient outcome is persisted without a balance or ledger change. | `operator/src/modules/financial/financial.service.test.ts` and `financial.controller.test.ts`. |
| A webhook has invalid signature, stale timestamp, or malformed body | Verify HMAC-SHA256 over the exact raw bytes and enforce the ±60 second timestamp window before parsing/financial mutation. Validate a strict schema and body-size limit. | `operator/src/integrations/crashsim/webhook-auth.test.ts` and `operator/src/modules/financial/financial.controller.test.ts`. |
| Engine WebSocket disconnects or becomes unavailable | Publish connection health, freeze the last known state, reconnect with backoff, and synchronize from `GET /rounds/current`. Game actions remain disabled until the synchronized state is live. | `operator/src/modules/game/realtime/stream.service.test.ts`; client SSE/recovery tests under `client/src/features/game/`. |
| Stream events are duplicated, delayed, or arrive out of order | Ignore duplicates and old sequence numbers, request a fresh snapshot for a sequence gap, and keep `crashed` terminal for the current round even if a later tick arrives. | `operator/src/modules/game/realtime/round-state.test.ts` and `stream.service.test.ts`; client stream reducer tests under `client/src/features/game/data/`. |
| Browser SSE disconnects while events continue | Unsubscribe the closed response. On reconnect, capture and write a new snapshot first; queue concurrent events and deliver only those above the snapshot sequence. No historical replay is claimed. | `operator/src/modules/game/controllers/events.controller.test.ts` and `realtime/event-fanout.test.ts`. |
| Bet/cashout request times out after the engine may have applied it | Persist the command before the external mutation. Keep the result `unknown`, perform a read-only `GET /bets/:id` reconciliation, and do not repeat a non-idempotent POST blindly. An unresolved command blocks a new key for that bet/round. | `operator/src/modules/game/game.service.test.ts` and `operator/src/integrations/crashsim/http.client.test.ts`. |
| The round crashes but the bet result has not been confirmed | Do not infer `lost` from `round.crashed`. Reconcile persisted active bets against authoritative engine reads in bounded background work; preserve the last result on active/failed reads. | `operator/src/modules/game/game.service.test.ts`, `realtime/stream.service.test.ts`, and `server.game.integration.test.ts`. |
| Cashout is confirmed by the game but its wallet credit is delayed | Track game result separately from settlement. Confirm settlement only after the matching financial ledger entry exists. If the callback's game-side recording fails, return failure so the engine retries; the wallet `txId` makes that retry safe. | `operator/src/modules/financial/financial.service.test.ts`, `financial.controller.test.ts`, and `game.service.test.ts`. |

The automated tests exercise the financial and realtime guarantees with deterministic test doubles; they do not replace a live-provider smoke test.

## Duplicate callback and financial atomicity

```mermaid
sequenceDiagram
  participant Engine as Crashsim
  participant Webhook as Financial webhook controller
  participant Financial as Financial use case
  participant DB as PostgreSQL
  participant Game as Game settlement listener

  Engine->>Webhook: POST /wallet/credit with txId T
  Webhook->>Webhook: Verify raw-body HMAC, timestamp, and schema
  Webhook->>Financial: creditCashoutOnce(T, betId)
  Financial->>DB: Begin transaction, lock wallet, reserve txId and business key
  Financial->>DB: Update balance and insert ledger operation
  DB-->>Financial: Commit confirmed
  Financial-->>Game: Record cashout settlement on the bet
  Webhook-->>Engine: 200 with committed balance

  Engine->>Webhook: Retry callback with the same txId T
  Webhook->>Financial: creditCashoutOnce(T, betId)
  Financial->>DB: Find the matching committed operation
  DB-->>Financial: Existing result and original response balance
  Financial-->>Game: Retry idempotent settlement recording
  Webhook-->>Engine: Same result, no second balance or ledger movement
```

The listener runs after the financial transaction. If settlement recording fails after the wallet credit commits, the callback does not report full success. A retry reuses the committed financial operation and repeats only the idempotent game-side recording.

## Concurrent debits

```mermaid
sequenceDiagram
  participant A as Debit request A
  participant B as Debit request B
  participant DB as PostgreSQL

  par Concurrent financial commands
    A->>DB: Begin transaction, lock wallet row, reserve txId A
  and
    B->>DB: Begin transaction, wait for wallet row lock, reserve txId B
  end
  A->>DB: Check latest balance and subtract A
  A->>DB: Insert operation and ledger, then commit
  DB-->>B: Release row lock
  B->>DB: Check latest committed balance
  alt Enough balance remains
    B->>DB: Subtract B, insert operation and ledger, then commit
  else Insufficient balance
    B->>DB: Persist decline without changing balance or ledger
  end
```

The wallet balance and ledger are changed in the same database transaction. A duplicate transaction ID resolves to the existing operation; distinct debits serialize against the wallet row. These rules keep the balance from going negative and prevent the ledger from diverging from the committed balance.

## Engine stream recovery and event ordering

```mermaid
flowchart TD
  Input[Connection change or validated event] --> Check{Sequence and connection check}
  Check -->|Disconnected| Down[Publish reconnecting and freeze last state]
  Check -->|seq <= current seq| Ignore[Ignore duplicate or old event]
  Check -->|seq > current seq + 1| Gap[Mark synchronizing and fetch current snapshot]
  Check -->|Expected next seq| Reduce[Apply through round-state reducer]
  Reduce --> Terminal{Round already crashed?}
  Terminal -->|Late tick for the same round| Ignore
  Terminal -->|No| Publish[Publish new state and event]
  Down --> Reconnect[Reconnect with backoff]
  Reconnect --> Snapshot[GET /rounds/current]
  Gap --> Snapshot
  Snapshot -->|Valid snapshot| Baseline[Replace state and sequence baseline]
  Baseline --> Connected[Publish synchronized health]
  Connected --> Publish
  Snapshot -->|Unavailable or invalid| Retry[Keep last state frozen and schedule another sync]
  Retry --> Snapshot
```

Crashsim does not expose a historical event log. The snapshot restores its present state and sequence; missed transient ticks are not replayed. The downstream SSE controller also sends a fresh snapshot before live events after a browser reconnect.

## Unknown bet or cashout outcome

```mermaid
sequenceDiagram
  participant Client
  participant Game as Operator game use case
  participant Engine as Crashsim
  participant DB as PostgreSQL

  Client->>Game: Submit command with idempotency key K
  Game->>DB: Persist pending command K
  Game->>Engine: POST bet or cashout
  Engine->>Engine: Apply operation, then response is lost or delayed in transit
  Game--xEngine: Request times out
  Game->>DB: Persist unknown outcome
  Game->>Engine: GET /bets/:id (read-only lookup)
  alt Engine confirms applied result
    Engine-->>Game: Authoritative current bet
    Game->>DB: Persist confirmed result
    Game-->>Client: Return the reconciled command
  else Engine confirms no cashout / active bet
    Engine-->>Game: Current bet is active
    Game-->>Client: Keep active, a later attempt uses a new key
  else Engine lookup is unavailable
    Engine--xGame: No authoritative answer
    Game-->>Client: Keep unknown and read the same command again
  end
```

A timeout only proves that the Operator did not receive a response. It does not prove that the engine rejected the operation. The persisted `unknown` status prevents a second mutation from being sent while that uncertainty remains.

## Crash and bet result reconciliation

A `round.crashed` event marks the round as ended, but it is not proof that every bet lost. The Operator queries each persisted active bet from Crashsim in bounded background work. Only the engine's bet response can change that bet to `lost` or `cashed_out`; an `active` response or failed read preserves the prior persisted result and allows a later reconciliation. This path never creates wallet credit from the round event.

## Known recovery limits

- There is no cross-process stream fan-out, shared session store, or distributed lock; this build supports one Operator instance.
- A current snapshot cannot reconstruct transient events or historical ticks missed during an outage.
- The MVP does not automatically compensate a committed bet debit if the engine later reports rejection after the command response was lost. It records the conflict for investigation instead of applying a guessed reversal.
- A production rollout would need explicit alerting/replay procedures with the real provider, database backup/recovery, and operational ownership for unresolved financial exceptions.
