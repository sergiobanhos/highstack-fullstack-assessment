# SDD Handoff Brief: Implementação em ordem de dependências — F02 → F03 → F04

> Status: F02 e F03 implementation done; F04 implementation in progress (T5)
> Readiness: F03 passou por testes PostgreSQL dedicados e fluxo Compose isolado com Crashsim. F04 T1–T5 estão concluídas e verificadas.
> Updated: 2026-10-05

## Metadata

- **Feature atual:** F04 — `.ai/sdd/specs/004-crashsim-bet-cashout/` (T5)
- **F02 aprovado:** `.ai/sdd/specs/002-database-auth/`
- **F03 requirements:** `.ai/sdd/specs/003-financial-wallet-ledger/requirements.md` (approved)
- **F03 design:** `.ai/sdd/specs/003-financial-wallet-ledger/design.md` (approved)
- **F03 tasks:** `.ai/sdd/specs/003-financial-wallet-ledger/tasks.md` (approved)
- **F03 `.status`:** `.ai/sdd/specs/003-financial-wallet-ledger/.status` (`implementation:done`; T1–T5 complete and verified)
- **F04 `.status`:** `.ai/sdd/specs/004-crashsim-bet-cashout/.status` (`implementation:in-progress`)
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
- **F03 T3 concluída:** validação HMAC específica de Crashsim antes de parsear o payload, parser JSON cru isolado com limite de 16 KiB, rotas de débito/crédito e respostas/logs sanitizados; `createFinancialModule` agora recebe o app e registra as próprias rotas, no mesmo padrão de Auth e Game.
- **Verificação F03 T3:** `bun run typecheck`, `docker compose config --quiet` e suíte completa com PostgreSQL dedicado `operator_financial_test` passaram (93 testes/426 expectativas). Cobertos HMAC/bytes crus, timestamps, payload, limite de corpo, status, persistência/idempotência e sanitização dos logs.
- **F03 T4 concluída:** rotas autenticadas de saldo, histórico paginado e top-up local; o controller depende somente do contrato público `auth.requireUser`, filtra playerId do request e retorna cursores estáveis do ledger.
- **Verificação F03 T4:** `bun run typecheck`, `docker compose config --quiet` e suíte completa com PostgreSQL dedicado `operator_financial_test` passaram (98 testes/472 expectativas). Cobertos identidade ausente, isolamento, cursor, top-up idempotente e limite de saldo; testes de config cobrem flag fora de local.
- **F03 T5 concluída:** composição financeira registrada em `server.ts`, com contrato público retornado por `buildOperatorApp`; o README documenta rotas, assinatura, retries, idempotência, top-up e limites. `server.financial.integration.test.ts` cobre Auth + carteira + webhooks + histórico com PostgreSQL.
- **Verificação F03 T5:** `bun run typecheck`, `bun run test:e2e` e `docker compose config --quiet` passaram. A suíte PostgreSQL dedicada passou com 99 testes/503 expectativas. Em projeto Compose isolado, auth → top-up → bet → cashout → histórico passou com `DUPLICATE_WEBHOOKS=1` e somente um crédito no ledger; `CLOCK_SKEW=90` foi rejeitado sem mutação; durante parada do PostgreSQL, health retornou 200, readiness e webhook 503; depois da recuperação, reenvio do mesmo `txId` aplicou e reproduziu o resultado sem duplicação.
- **F04 T1 concluída:** o contrato público de financial localiza todos os débitos elegíveis usando jogador, rodada, valor e timestamp UTC exato com microssegundos; status `credited` exige operação e entrada de crédito no ledger. Múltiplos débitos permanecem explícitos, e limites/incidentes conhecidos não são apresentados como crédito confirmado.
- **Verificação F04 T1:** `bun run typecheck` e `bun run test:e2e` passaram; PostgreSQL temporário isolado executou 101 testes/514 expectativas. Cobertos candidato ausente/único/múltiplo, jogador/rodada/valor, débito anterior e no timestamp de reserva, outcomes aplicado/insuficiente, cashout pendente/creditado, ledger ausente e limite do saldo. O módulo game não importa arquivos privados de financial.
- **F04 T2 concluída:** `game_commands` e `game_bets` com tipos/check constraints, idempotency key, reservas parciais para aposta/cashout, valores em inteiros e payout limitado ao inteiro JSON seguro. Migration Drizzle aditiva `0002_rich_gladiator` adiciona somente as tabelas/índices de game; o schema compartilhado e a prontidão incluem as tabelas. Nenhum `sessionId` é persistido.
- **Verificação F04 T2:** `bun run typecheck` e `bun run test:e2e` passaram; PostgreSQL temporário isolado executou 104 testes/530 expectativas. A migration foi reaplicada e preservou comando/bet; testes concorrentes confirmaram uma única reserva de aposta e cashout, estados `unknown`/`accepted` mantêm a vaga, `rejected` libera nova tentativa e o limite de payout é imposto pelo banco.
- **F04 T3 concluída:** o cliente Crashsim agora cria sessão, envia aposta, consulta bet e faz cashout; valida IDs, identidade quando retornada, status, multiplicador e payout. Erros tipados distinguem rejeição, conflito, indisponibilidade, bet ausente e resultado desconhecido. Apenas `404 session_not_found` estruturado e consistente é definitivo para renovação. Payout inseguro vira `payoutCents=null`/`precision=unsafe`; o cliente não repete comandos nem envia chave de idempotência não suportada.
- **Verificação F04 T3:** `bun run typecheck` e `bun run test:e2e` passaram; PostgreSQL temporário isolado executou 111 testes/582 expectativas. Testes simulados cobrem os quatro endpoints, identidade divergente, sessão inválida, 402, conflitos, bet ausente, timeout, 5xx, JSON inválido, limites e ausência de valores sensíveis em erros.
- **F04 T4 concluída:** `game-command.service.ts` provisiona a carteira antes da sessão, guarda `sessionId` somente em memória, exige stream sincronizado e rodada em betting, e reserva o comando antes da chamada externa. Idempotência e slot da rodada são protegidos pelo banco; 402 libera o slot. Somente `session_not_found` permite um retry. Resultados ambíguos são reconciliados por débito exato e `GET /bets/:id`, sem um segundo `POST /bets`. Débito aplicado seguido de bet rejeitado permanece sem compensação automática.
- **Verificação F04 T4:** `bun run typecheck` passou; `bun run test:e2e` passou em PostgreSQL Compose isolado com 121 testes/630 expectativas. Cobertos ordem carteira/sessão, conexão e rodada, limites, fingerprints e tipo da chave, concorrência, 402 após top-up, renovação de sessão, timeout sem retry, candidato financeiro único/múltiplo e ausência de estorno. O serviço usou contrato Crashsim simulado; o fluxo com engine real será exercitado em T7 após a composição da API.
- **F04 T5 concluída:** `game-command.service.ts` agora lista as últimas 10 tentativas próprias (máximo 20), consulta comando e bet por identidade do jogador, reconcilia `unknown` com leituras financeiras/Crashsim e atualiza engine/settlement. Quando a engine reinicia e perdeu um bet já persistido, consulta retorna o estado local conhecido. Respostas atrasadas não regridem um bet terminal.
- **Verificação F04 T5:** `bun run typecheck && bun run test:e2e` passou em PostgreSQL Compose isolado com 126 testes/657 expectativas. Cobertos serviço recriado, ordenação/limites, isolamento de jogador, unknown sem novo POST ou alteração de saldo pela leitura, settlement pending/confirmed, ownership antes de chamar Crashsim e fallback para estado persistido quando o Crashsim não encontra o bet.
- **F04 T6 concluída:** `game-command.service.ts` autoriza cashout apenas para bet próprio/ativo com stream sincronizado e rodada `running`; reserva comando idempotente e slot único por `betId`; persiste estado de jogo separado do crédito; após resposta ambígua consulta a engine e mantém `unknown` se o GET falhar. A leitura de `commandId` também retenta reconciliação. Payout inseguro não é persistido como dinheiro e gera evento de incidente. O fluxo não chama `creditCashoutOnce`.
- **Verificação F04 T6:** `bun run typecheck && bun run test:e2e` passou; PostgreSQL temporário isolado executou 133 testes/688 expectativas. Cobertos cashout normal, replay e conflito de chave, concorrência de chaves, timeout com GET `active`/`cashed_out`, consulta indisponível, recuperação de unknown após recriar o serviço sem novo POST, ownership, stream/fase/status, settlement pendente/confirmado e payout inseguro. O teste com Crashsim real e `CASHOUT_TIMEOUT=1` fica para T7 após a composição REST.
- **F04 T7 implementada:** REST autenticada para sessão, apostas, leituras e cashout; `server.ts` monta `auth` e `financial` antes de injetar seus contratos públicos em `game.module.ts`. `GET /game/bets/:betId` também retoma a reconciliação de cashout desconhecido após reload, sem novo POST. O README agora documenta o fluxo REST, unknown, cashout, settle e limites do MVP.
- **Verificação F04 T7:** `bun run typecheck`, `bun run test:e2e` e `docker compose config --quiet` passaram. O PostgreSQL temporário isolado executou 141 testes/774 expectativas; a integração cobre cadastro/login, top-up, sessão sem expor `sessionId`, aposta/débito, replay idempotente, resposta de cashout perdida após mutação, GET autoritativo, crédito financeiro atrasado, reload e saldo final correto. O HTTP Crashsim e o stream foram simulados pelo contrato; o smoke test com o processo Crashsim real ainda está pendente.
- **Próximo passo:** executar o smoke test manual com Crashsim real registrado em T6/T7; depois disso, revisar e marcar F04 completa.

## Dependências de roadmap ainda não especificadas

- F04: requirements, design e tasks aprovados para sessão Crashsim, apostas, cashout, propriedade, idempotência e reconciliação de resultados desconhecidos; estorno automático de débito de bet rejeitado foi deixado fora do MVP por decisão do usuário.
- F05: integração do cliente autenticado com saldo, jogo e SSE.

## Prontidão

- F02 requirements, design e tasks estão aprovados; implementação T1–T4 concluída e verificada.
- F03 requirements, design e tasks estão aprovados; implementação e verificação PostgreSQL/Crashsim foram concluídas.
- F04 requirements, design e tasks estão aprovados; T1–T7 implementadas e verificadas com PostgreSQL isolado e contrato Crashsim simulado. A verificação pendente é executar a integração com o processo Crashsim real e suas flags de falha antes de marcar F04 concluída.
