# SDD Handoff Brief: Operador Crashsim — F02 atual

> Status: F02 tasks aprovadas; implementação não iniciada
> Readiness: F02 pronta para implementação; execução adiada pelo usuário enquanto F03 é especificada
> Updated: 2026-10-05

## Metadata

- **Feature atual:** F02 — `.ai/sdd/specs/002-database-auth/`
- **Current `.status`:** `tasks:approved`
- **Requirements:** `.ai/sdd/specs/002-database-auth/requirements.md` (approved)
- **Design:** `.ai/sdd/specs/002-database-auth/design.md` (approved; REST)
- **Tasks:** `.ai/sdd/specs/002-database-auth/tasks.md` (approved)
- **Plano:** `.ai/sdd/PLAN.md`
- **Pré-requisito concluído:** F01 — `.ai/sdd/specs/001-crashsim-realtime-proxy/` (`implementation:done`, aguardando revisão)

## Contexto concluído: F01

- O módulo `game` conecta diretamente ao Crashsim, mantém uma WebSocket por processo, ressincroniza com `GET /rounds/current`, aplica reducer monotônico e distribui snapshot/eventos/health por SSE.
- A implementação F01 foi verificada com testes/typecheck de operator e client, build do client, Compose config e cenário de desconexão/reordenação; commit `ebb9f95`.
- F01 não inclui autenticação, carteira ou comandos de aposta.

## F02 aprovado

- **Resultado:** cadastro, login, logout e consulta do jogador atual, com identidade persistente para os módulos futuros.
- **Escopo:** PostgreSQL/Drizzle, migrations, módulo `auth` e API REST. Sessões do operador opacas, com token original retornado uma vez e hash armazenado; senha derivada com Argon2id.
- **Rotas:** `POST /auth/register`, `POST /auth/login`, `GET /auth/me`, `POST /auth/logout`.
- **Contrato entre módulos:** `requireUser(request)` retorna identidade confiável isolada por solicitação. O ID da conta é o `playerId` usado futuramente por game e financial.
- **Próxima implementação quando autorizada:** T1 banco/schema/migrations → T2 fluxos auth → T3 rotas REST/contrato público → T4 composição, Compose, readiness e documentação.
- **Verificação planejada:** `cd operator && bun run typecheck && bun test`; `docker compose config`; integração com PostgreSQL dedicado, restart/revogação e regressão SSE.

## Dependências de roadmap ainda não especificadas

- F03: carteira, ledger e webhooks assinados — próxima spec a construir.
- F04: sessão Crashsim, apostas, cashout, propriedade e reconciliação.
- F05: integração do cliente autenticado com saldo, jogo e SSE.

## Prontidão

- F02 requirements, design e tasks estão aprovados. Nenhum código F02 foi iniciado.
- F03 requirements ainda precisam esclarecer moeda, saldo de demonstração e replay de débito recusado.
- O ambiente não conseguiu acessar o daemon Docker durante uma consulta; validações que dependem dele devem ser tentadas quando F02 for implementada.
