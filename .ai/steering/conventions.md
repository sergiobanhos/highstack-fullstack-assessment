# Conventions Steering

## Code Style

- Write operator code in TypeScript and validate all external input at system boundaries.
- Keep money in integer minor units; never use floating-point values for balances or payouts.
- Do not log operator keys, webhook secrets, raw credentials, or sensitive player data.

## Architecture Patterns

- Organize business capabilities as modules under `operator/src/modules/<module>`. Current modules are `auth`, `financial`, and `game`; keep each module's use cases and public service facade inside that module.
- Keep `operator/src/server.ts` as the composition root. Cross-module dependencies use explicitly exported contracts; module internals stay private.
- Keep module files consistent: `*.module.ts` registers routes and composes dependencies; `*.service.ts` is the module's public facade and composition point for its use cases; `usecases/` contains cohesive business flows, not forwarding wrappers.
- Keep transport controllers thin. Game commands go through `game.service`; the realtime stream service owns the upstream connection, snapshot synchronization, reconnect, reduction, and publication workflow. The SSE controller depends on the stream subscription contract, not on the fan-out implementation.
- Keep Crashsim HTTP/WebSocket details and external payload validation in the concrete clients under `operator/src/integrations/crashsim/`. Keep internal event/state types specific to the current Crashsim flow.
- Maintain one upstream Crashsim stream per operator process, not one per browser.
- Do not create generic game/provider ports, catalogs, registries, plugins, or scaffolding for hypothetical games. Supporting a second game requires an explicit future design based on its actual protocol and needs.

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
