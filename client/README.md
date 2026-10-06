# Player client

React client for the local Crashsim operator. The browser calls only the operator API; engine credentials stay server-side.

## Source layout

- `src/app/` composes session boot, the authenticated shell, and screen-level navigation.
- `src/pages/` contains route-sized views. Each page coordinates its flow and delegates domain work and presentation to its feature.
- `src/features/auth/` owns session and auth mutations.
- `src/features/game/` owns game queries, the SSE stream, bet/cashout reconciliation, fairness verification, and game-specific components.
- `src/features/wallet/` owns wallet queries, payout polling, idempotent pending commands, and wallet components.
- Page orchestration lives in `use-app-session`, `use-auth-form`, `use-game-page-model`, and `use-wallet-page-model`; the page files compose those models into UI.
- `src/lib/operator/` is the typed HTTP boundary. It validates responses and maps failures to `OperatorApiError`.
- `src/lib/query/` centralizes the React Query client, cache keys, and player query context. Tokens are not query keys.
- `src/lib/money/` contains integer-cent parsing, formatting, and payout calculations.

The realtime stream stays outside the REST query cache. Cashout timeouts are reconciled by reading the existing command/bet before any new operation is sent. Wallet retries retain their idempotency key when the outcome may be unknown.

## Local commands

```sh
bun run typecheck
bun run build
bun test
```
