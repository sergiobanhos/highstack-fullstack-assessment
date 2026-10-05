# SDD Handoff Brief: Implementação em ordem de dependências — F02 → F03 → F04

> Status: F02 implementation done; F03 T1–T2 concluídas e verificadas; F04 tasks aprovadas
> Readiness: comitar F03 T2 antes de iniciar T3. F04 depende de F02 e F03 concluídas e verificadas.
> Updated: 2026-10-05

## Metadata

- **Feature atual:** F03 — `.ai/sdd/specs/003-financial-wallet-ledger/`
- **F02 aprovado:** `.ai/sdd/specs/002-database-auth/`
- **F03 requirements:** `.ai/sdd/specs/003-financial-wallet-ledger/requirements.md` (approved)
- **F03 design:** `.ai/sdd/specs/003-financial-wallet-ledger/design.md` (approved)
- **F03 tasks:** `.ai/sdd/specs/003-financial-wallet-ledger/tasks.md` (approved)
- **F03 `.status`:** `.ai/sdd/specs/003-financial-wallet-ledger/.status` (`implementation:in-progress`; T1–T2 complete)
- **F04 `.status`:** `.ai/sdd/specs/004-crashsim-bet-cashout/.status` (`tasks:approved`)
- **F02 `.status`:** `implementation:done`
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
- **Implementação concluída:** T1 banco/schema/migrations, T2 fluxos auth, T3 rotas REST/contrato público e T4 composição/Compose/readiness/documentação.
- **Verificação:** typecheck aprovado; `bun test` passou com 69 testes e 258 expectativas; `docker compose config` passou; Compose executou migration antes do operator; readiness, indisponibilidade e recuperação do banco, login/logout e persistência de sessões após restart passaram; SSE entregou snapshot durante logins concorrentes; imagem de produção contém migrations e não instala `drizzle-kit`.

## F03 aprovado: requirements, design e tasks

- Carteiras e ledger ligados ao jogador persistente; callbacks Crashsim de débito/crédito com assinatura, timestamp e idempotência por `txId`.
- Decisões definidas: USD único, saldo inicial zero com recarga de teste local e replay do `402` original para o mesmo `txId`.
- Decisão definida: aplicar e persistir o débito/crédito antes de confirmar o webhook com `200`.
- Decisão definida: F04 registra o cashout; F06 compara o resultado da engine com o ledger e recupera crédito ausente uma única vez por `betId` (Q-005).
- Limite conhecido: o engine atual guarda apostas em memória; recuperação após reinício do engine exige suporte durável do engine.
- Decisão F03 D-009: não alterar a engine; o operador rejeita `amount` fora de `Number.MAX_SAFE_INTEGER` antes do banco e emite incidente. Se valor seguro ultrapassaria o saldo máximo, registra recusa idempotente sem alterar carteira/ledger. Como a engine encerra retries em 4xx e o GET da aposta usa o mesmo contrato numérico, F06 não credita payout aproximado nem declara o caso automaticamente recuperado.
- **Ordem aprovada:** T1 configuração/schema/migration → T2 serviço financeiro transacional → T3 webhooks HMAC → T4 API autenticada de saldo/histórico/top-up → T5 composição, Compose e documentação.
- **Verificação planejada:** `cd operator && bun run typecheck && bun test`; `cd operator && bun run db:migrate` em PostgreSQL dedicado; `docker compose config`; fluxo manual com Crashsim e testes de concorrência/retry.
- **F03 T1 concluída:** configuração fail-closed, webhook secret redigido, schema e migration financeira aditiva após auth, constraints e índices verificados.
- **Verificação F03 T1:** `bun run typecheck` passou; `bun test` com PostgreSQL dedicado passou (73 testes/293 expectativas); `bun run db:migrate` passou duas vezes; `docker compose config` passou.
- **F03 T2 concluída:** serviço financeiro e contrato público com idempotência, serialização por carteira, débito condicional, rejeições estáveis, reconciliação por `betId`, top-up e ledger paginado.
- **Verificação F03 T2:** `bun run typecheck` passou; `bun test` com PostgreSQL dedicado passou (83 testes/362 expectativas), incluindo concorrência, resposta perdida/replay e rollback após falha ao gravar ledger.
- **Próximo passo:** comitar F03 T2 antes de implementar F03 T3. Depois seguir T3–T5 e então F04 T1–T7. F04 tasks adicionam os contratos públicos financeiros para localizar débito de aposta e consultar liquidação de cashout. O MVP documenta o risco raro de débito persistido com bet rejeitado sem adicionar estorno automático.

## Dependências de roadmap ainda não especificadas

- F04: requirements, design e tasks aprovados para sessão Crashsim, apostas, cashout, propriedade, idempotência e reconciliação de resultados desconhecidos; estorno automático de débito de bet rejeitado foi deixado fora do MVP por decisão do usuário.
- F05: integração do cliente autenticado com saldo, jogo e SSE.

## Prontidão

- F02 requirements, design e tasks estão aprovados; implementação T1–T4 concluída e verificada.
- F03 requirements, design e tasks estão aprovados; F02 foi concluída, então a implementação F03 pode começar.
- F04 requirements, design e tasks estão aprovados; implementar depois de F02/F03 e verificar as consultas financeiras públicas usadas pela reconciliação.
