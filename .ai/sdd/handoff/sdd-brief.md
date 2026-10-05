# SDD Handoff Brief: F03 Financeiro — F02 como pré-requisito

> Status: F03 tasks aprovadas; implementação não iniciada
> Readiness: Não pronta para implementação; F02 precisa ser implementada primeiro e o usuário pediu seguir para F04
> Updated: 2026-10-05

## Metadata

- **Feature atual:** F03 — `.ai/sdd/specs/003-financial-wallet-ledger/`
- **F02 aprovado:** `.ai/sdd/specs/002-database-auth/`
- **F03 requirements:** `.ai/sdd/specs/003-financial-wallet-ledger/requirements.md` (approved)
- **F03 design:** `.ai/sdd/specs/003-financial-wallet-ledger/design.md` (approved)
- **F03 tasks:** `.ai/sdd/specs/003-financial-wallet-ledger/tasks.md` (approved)
- **F03 `.status`:** `.ai/sdd/specs/003-financial-wallet-ledger/.status` (`tasks:approved`)
- **F02 `.status`:** `tasks:approved`
- **F02 requirements:** `.ai/sdd/specs/002-database-auth/requirements.md` (approved)
- **F02 design:** `.ai/sdd/specs/002-database-auth/design.md` (approved; REST)
- **F02 tasks:** `.ai/sdd/specs/002-database-auth/tasks.md` (approved)
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

## F03 aprovado: requirements, design e tasks

- Carteiras e ledger ligados ao jogador persistente; callbacks Crashsim de débito/crédito com assinatura, timestamp e idempotência por `txId`.
- Decisões definidas: USD único, saldo inicial zero com recarga de teste local e replay do `402` original para o mesmo `txId`.
- Decisão definida: aplicar e persistir o débito/crédito antes de confirmar o webhook com `200`.
- Decisão definida: F04 registra o cashout; F06 compara o resultado da engine com o ledger e recupera crédito ausente uma única vez por `betId` (Q-005).
- Limite conhecido: o engine atual guarda apostas em memória; recuperação após reinício do engine exige suporte durável do engine.
- Decisão F03 D-009: não alterar a engine; o operador rejeita `amount` fora de `Number.MAX_SAFE_INTEGER` antes do banco e emite incidente. Se valor seguro ultrapassaria o saldo máximo, registra recusa idempotente sem alterar carteira/ledger. Como a engine encerra retries em 4xx e o GET da aposta usa o mesmo contrato numérico, F06 não credita payout aproximado nem declara o caso automaticamente recuperado.
- **Ordem aprovada:** T1 configuração/schema/migration → T2 serviço financeiro transacional → T3 webhooks HMAC → T4 API autenticada de saldo/histórico/top-up → T5 composição, Compose e documentação.
- **Verificação planejada:** `cd operator && bun run typecheck && bun test`; `cd operator && bun run db:migrate` em PostgreSQL dedicado; `docker compose config`; fluxo manual com Crashsim e testes de concorrência/retry.
- **Próximo passo:** iniciar requirements F04 (sessão Crashsim, aposta e cashout). A implementação F03 permanece adiada até F02 T1–T4 concluídas e não foi autorizada agora.

## Dependências de roadmap ainda não especificadas

- F04: sessão Crashsim, apostas, cashout, propriedade e reconciliação.
- F05: integração do cliente autenticado com saldo, jogo e SSE.

## Prontidão

- F02 requirements, design e tasks estão aprovados. Nenhum código F02 foi iniciado.
- F03 requirements, design e tasks estão aprovados; implementação não foi iniciada.
- F03 só pode ser implementada depois de F02 T1–T4; o usuário escolheu continuar agora com a especificação F04.
- O ambiente não conseguiu acessar o daemon Docker durante uma consulta; validações que dependem dele devem ser tentadas quando F02 for implementada.
