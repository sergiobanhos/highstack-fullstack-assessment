# Conventions Steering

## Code Style

- Write operator code in TypeScript and validate all external input at system boundaries.
- Keep money in integer minor units; never use floating-point values for balances or payouts.
- Do not log operator keys, webhook secrets, raw credentials, or sensitive player data.

## Architecture Patterns

- Organize business capabilities as modules under `operator/src/modules/<module>`. In the initial feature, `game` supports Crashsim only and contains the engine clients, stream coordination, round reducer, event hub, and SSE controller.
- Keep `operator/src/server.ts` as the composition root. Cross-module dependencies use explicitly exported contracts; module internals stay private.
- Keep `game.module.ts` as direct wiring for the Crashsim stream service and SSE route. Do not create generic game/provider ports, type folders, catalogs, registries, plugins, or use-case layers for hypothetical games.
- Keep transport controllers thin. The game stream service owns the concrete Crashsim connection, synchronization, reconnect, and event publication workflow.
- Keep Crashsim HTTP/WebSocket details and validation at the concrete client boundary. Keep internal event/state types specific to the current Crashsim flow.
- Maintain one upstream Crashsim stream per operator process, not one per browser.
- Future auth and financial work belong in sibling top-level modules `modules/auth` and `modules/financial`, added by their own specs. Supporting a second game requires an explicit future design based on its actual needs.

## Testing Rules

- Treat disconnect/reconnect, stale snapshots, duplicate webhooks, concurrent debits, out-of-order events, timeouts with unknown outcomes, and invalid signatures as first-class cases.
- Verify Crashsim chaos flags individually and record the observed behavior.

## Security / Reliability Rules

- Browsers connect only to the operator; provider credentials remain server-side.
- Resynchronize current game state from the engine snapshot after reconnect. The current engine stream does not replay missed history.
- Round state must not move backward. Ignore a late `tick` for a round already marked `crashed`.
- Process webhook idempotency and the wallet balance mutation atomically using `txId`.

## Workflow Rules

- Keep SDD requirements, design, and tasks under `.ai/sdd/specs/` and update `.ai/sdd/INDEX.md` with status changes.
- Do not advance a spec gate or begin implementation based only on the existence of a draft artifact.
