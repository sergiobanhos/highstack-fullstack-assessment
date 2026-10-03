# Tech Stack Steering

## Runtime & Languages

- Operator: Bun and TypeScript (selected by the user).
- Engine simulator: Node.js, JavaScript, and the `ws` package.
- Player/debug client: React 19 and TypeScript, per the assessment brief; Vite for the local browser dev server and build.

## Frameworks & Libraries

| Layer | Choice | Notes |
|-------|--------|-------|
| Operator HTTP | Fastify | Assessment stack; GraphQL is the current API direction in the root README. |
| Database | PostgreSQL + Drizzle | Schema changes should be migrations. |
| Validation | Valibot | Validate browser input and third-party payloads. |
| Realtime to clients | SSE | Initial operator design uses SSE for one-way event fan-out. |

## Infrastructure

- Docker Compose runs the engine, operator, and PostgreSQL.
- Redis or another cross-instance event bus is deferred until the operator scales beyond one instance.

## Commands

| Action | Command |
|--------|---------|
| Compose configuration check | `docker compose config` |
| Start engine and operator smoke client | `docker compose up --build operator` |
| Follow smoke client events | `docker compose logs -f operator` |

## Open Questions

- Verify Bun compatibility with the selected Fastify and Drizzle versions when implementation begins.
- Confirm the player-session authentication integration before exposing the event stream publicly.
