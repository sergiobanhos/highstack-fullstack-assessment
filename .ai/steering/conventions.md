# Conventions Steering

## Code Style

- Write operator code in TypeScript and validate all external input at system boundaries.
- Keep money in integer minor units; never use floating-point values for balances or payouts.
- Do not log operator keys, webhook secrets, raw credentials, or sensitive player data.

## Architecture Patterns

- Keep transport controllers thin and move workflows to use cases.
- Keep provider-specific APIs and event translation in `adapters/games/<provider>/` behind application ports.
- Shared use cases and client contracts must not branch on provider names when a provider adapter can own the difference.
- Maintain one upstream engine stream connection per operator process, not one per browser.

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
