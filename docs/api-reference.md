# API reference

The local Operator listens on `http://127.0.0.1:3000`. Examples assume the local Compose stack. Player endpoints use `Authorization: Bearer <token>` from `/auth/login`; the authenticated identity supplies `playerId`. Do not send a player ID to choose whose data is read or mutated.

Amounts are positive integer cents in USD. Auth and financial responses use `Cache-Control: no-store`. Request payloads are validated at the HTTP boundary.

## Health

| Method | Route | Success | Notes |
|---|---|---|---|
| `GET` | `/health` | `200 { "status": "ok" }` | Process liveness; stays healthy when the database is unavailable. |
| `GET` | `/ready` | `200 { "status": "ready" }` | Requires a working database connection and expected schema; otherwise `503`. |

The server also checks readiness before listening and fails startup if the database or schema is not available.

## Authentication

| Method | Route | Success | Notes |
|---|---|---|---|
| `POST` | `/auth/register` | `201 { user }` | Body: `{ name, email, password }`. Duplicate normalized email: `409 EMAIL_IN_USE`. Registration does not log in automatically. |
| `POST` | `/auth/login` | `200 { token, expiresAt, user }` | Body: `{ email, password }`. Invalid credentials share one generic `401` response. Only a token hash is stored. |
| `GET` | `/auth/me` | `200 { user }` | Requires a valid, unexpired bearer token. |
| `POST` | `/auth/logout` | `204` | Revokes the presented session; repeated logout is idempotent. |

Registration and login are rate-limited independently by client IP. Session lifetime is configured with `AUTH_SESSION_TTL_SECONDS`.

## Wallet and local payout

All routes in this section require an authenticated player. Top-up and payout routes are registered only when local-development configuration enables them.

| Method | Route | Success | Notes |
|---|---|---|---|
| `GET` | `/wallet` | `200 { balance, currency: "USD" }` | Creates a zero-balance wallet on first access. `balance` is cents. |
| `GET` | `/wallet/transactions?limit=&cursor=` | `200 { items, nextCursor }` | Player-owned ledger history, newest first; default 50, max 100, stable opaque cursor. |
| `POST` | `/wallet/top-ups` | `201 { transactionId, balance, currency }` | Local-only. Body `{ amount }`; amount is cents. Requires UUID `Idempotency-Key`. |
| `POST` | `/payouts` | `201 payout DTO` | Local simulation. Body `{ amount }`; requires UUID `Idempotency-Key`. Request debits the wallet and begins as `processing`. |
| `GET` | `/payouts?limit=&cursor=` | `200 { items, nextCursor }` | Player-owned payout history; default 50, max 100. |
| `GET` | `/payouts/:payoutId` | `200 payout DTO` | Player-owned payout status. Missing and other-player records both return `404`. |

Reusing an idempotency key with the same request replays the stored result. Reusing it with different data returns a conflict. Payout completion is simulated locally and does not represent a real transfer.

## Game commands

All game command routes require an authenticated player. `POST` mutations require a UUID `Idempotency-Key`.

| Method | Route | Purpose |
|---|---|---|
| `POST` | `/game/session` | Ensures the wallet and creates or reuses the server-side Crashsim session. Response is `{ status: "ready" }`; the engine session ID is not exposed. |
| `POST` | `/game/bets` | Places a bet. Body: `{ roundId, amount, autoCashout? }`; `amount` is cents and `autoCashout` is a multiplier. |
| `GET` | `/game/bets?limit=10` | Lists the player's latest bet commands, up to 20. Used to restore state after a page reload. |
| `GET` | `/game/commands/:commandId` | Reads a player's command and performs safe read-only reconciliation when possible. |
| `GET` | `/game/bets/:betId` | Reads an owned bet from persisted state and refreshes the authoritative engine/settlement state. |
| `POST` | `/game/bets/:betId/cashout` | Attempts cashout only for an owned active bet while the stream is synchronized and the round is running. |

A mutation can be `accepted`, `rejected`, or `unknown`. `unknown` returns `202` because a timeout is not proof that the engine rejected the command. Query the same command/bet; do not retry a mutation with a fresh key until reconciliation establishes the prior outcome. Insufficient funds is definitive and allows another bet attempt with a new key while the round is still open.

The game status and financial settlement status are separate. For example, a bet may be `cashed_out` while its webhook credit is still pending. The operator reports settlement as confirmed only after it finds the matching ledger credit.

## Realtime stream

| Method | Route | Transport | Events |
|---|---|---|---|
| `GET` | `/game/events` | Server-Sent Events | `snapshot`, `game-event`, `connection` |

The initial `snapshot` contains the current round state, `seq`, and upstream connection health. It is followed by live game events and connection changes. On reconnect, the browser receives a new current snapshot; missed history is not replayed. While health is `reconnecting` or `synchronizing`, the client freezes the last known state and disables bet/cashout actions.

## Engine wallet webhooks

These are server-to-server routes authenticated with the raw request bytes, not player sessions.

| Method | Route | Body |
|---|---|---|
| `POST` | `/wallet/debit` | `{ txId, playerId, amount, betId, roundId }` |
| `POST` | `/wallet/credit` | `{ txId, playerId, amount, betId, roundId }` |

Required headers:

- `x-timestamp`: Unix seconds, within 60 seconds of Operator time.
- `x-signature`: lowercase or uppercase hex HMAC-SHA256 over `${timestamp}.${rawBody}`, using `ENGINE_WEBHOOK_SECRET`.

The body limit is 16 KiB. Signature and timestamp are verified before JSON parsing and financial mutation. Successful operations return `200 { balance }` only after commit. Debit with insufficient funds returns `402`; invalid authentication returns `401`; invalid JSON/schema returns `400`; idempotency/data conflict returns `409`; unsupported amount/balance limit returns `422`; uncertain persistence returns `503` so Crashsim can retry the same `txId`.

Webhook operations deduplicate by the engine `txId`. Cashout credits also converge on `cashout:<betId>` so webhook delivery and a future recovery path cannot create two credits for the same cashout.

## Example local requests

```bash
curl -i http://127.0.0.1:3000/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"name":"Test Player","email":"player@example.invalid","password":"example password phrase"}'

curl -i http://127.0.0.1:3000/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"player@example.invalid","password":"example password phrase"}'

curl -i http://127.0.0.1:3000/wallet \
  -H "Authorization: Bearer ${AUTH_TOKEN}"
```

Keep tokens in a local shell variable; never place them in URLs or commit them.
