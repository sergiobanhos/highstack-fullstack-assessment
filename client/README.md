# Player client

React client for the local Crashsim operator. The browser calls only the operator API; the engine credentials remain server-side.

## Frontend boundaries

- `src/operator-api.ts` is the typed HTTP boundary. It validates operator responses and maps failures to `OperatorApiError`.
- `src/hooks/use-auth-commands.ts` owns register, login, and logout mutations; `src/hooks/use-auth-session.ts` restores the tab session. `src/App.tsx` composes those states.
- `src/hooks/use-game-data.ts` owns game-session creation, the player's bet query, safe bet/command lookups, and bet/cashout mutations.
- `src/hooks/use-game-stream.ts` owns the SSE connection, reconnect loop, and silence watchdog.
- `src/hooks/use-wallet-data.ts` owns wallet, cursor-paged ledger and payout queries, payout lookups, and top-up/payout mutations.
- `src/query-keys.ts` centralizes cache keys and scopes player data by the authenticated player id. Session tokens are not query keys.
- `src/query-client.ts` defines shared retry, staleness, and focus-refetch defaults. Mutations are never retried automatically.
- `src/operator-events.client.ts` and the stream effect in `game-screen.tsx` own SSE parsing, order, synchronization, reconnect, and bounded event history. The live stream stays outside the REST query cache.
- `src/components/` contains presentational panels extracted from the larger screens; screen files coordinate the player flows and their local command states.

## Local checks

```sh
bun run typecheck
bun run build
bun test
```
