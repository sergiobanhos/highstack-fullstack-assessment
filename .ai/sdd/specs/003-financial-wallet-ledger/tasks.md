# Tasks: Carteira, ledger e webhooks financeiros

> Requirements: @requirements.md
> Design: @design.md
> Status: Approved

## Pré-requisito para implementação

A F02 (.ai/sdd/specs/002-database-auth/) está em implementation:done e foi verificada. O pré-requisito F02 T1–T4 está concluído: `db.ts`, migrações Drizzle, PostgreSQL no ciclo de vida do operador e o contrato público `auth.requireUser(request)` estão disponíveis. Este plano não repete nem substitui trabalho da F02.

## Cobertura dos requisitos

| Requisito | Tasks | Observações |
|-----------|-------|-------------|
| FR-001 / US-001 | T2, T4 | Carteira USD inicializada pela identidade confiável; consulta autenticada |
| FR-002 / US-002 | T2, T3 | Débito atômico e webhook assinado; recusa 402 persistida |
| FR-003 / US-003 | T2, T3 | Crédito síncrono, retry seguro, chave de cashout e limite de precisão |
| FR-004 / US-005 | T1, T2, T3, T4 | Chaves únicas, replay/conflito, referência por betId e histórico |
| FR-005 | T1, T2 | Constraints e atualização condicional testadas sob concorrência |
| FR-006 / US-004 | T3 | HMAC sobre bytes crus e timestamp dentro da janela |
| FR-007 | T2, T4, T5 | Contrato público para game/F06 e rotas próprias do jogador |
| FR-008 | T2, T3, T5 | Falhas seguras, retry, logs sanitizados e operação |
| FR-009 / US-006 | T1, T2, T4, T5 | Top-up local idempotente, autenticado e fechado fora de local |
| NFR-001 | T1, T2, T3, T4 | Centavos inteiros, BIGINT e faixa segura do protocolo JSON |
| NFR-002 | T1, T2 | Saldo, operação, resultado idempotente e ledger na mesma transação |
| NFR-003 | T1, T3, T4, T5 | Validação, HMAC, identidade, limites e proteção de logs |
| NFR-004 | T1, T3, T5 | Migração, configuração, retries, documentação e diagnóstico |
| NFR-005 | T1, T4, T5 | Top-up desligado por padrão e permitido somente em ambiente local |

## Verificação de prontidão da implementação

| Verificação | Estado | Observações |
|-------------|--------|-------------|
| Todos os requisitos Must Have têm tasks | Pass | FR-001–FR-009 e NFR-001–NFR-005 estão mapeados acima. |
| Requisitos cobertos pelo design aprovado | Pass | Modelo, transações, rotas, segurança, precisão, retries e operação estão definidos em design.md. |
| Perguntas críticas respondidas | Pass | Q-001–Q-005 estão respondidas; D-009 e a exceção de precisão foram aceitas. |
| Tasks têm dependências, critérios, arquivos e verificação | Pass | Cada task lista esses campos e inclui os casos críticos junto da implementação correspondente. |
| Comandos de verificação conhecidos ou identificados como manuais | Pass | cd operator && bun run typecheck && bun test; cd operator && bun run db:migrate em PostgreSQL dedicado; docker compose config e fluxo manual com Crashsim. db:migrate será criado pela F02. |
| Pré-requisito para iniciar a implementação | Completo | F02 T1–T4 está em `implementation:done` e passou por typecheck, testes PostgreSQL, Compose, restart/revogação e regressão SSE. |
| Lacunas de design que bloqueiam este plano | Nenhuma | Compatibilidade real das dependências Bun/Drizzle é verificada durante a implementação, conforme o plano da F02. |

## Fatias de implementação

### Fatia MVP: carteira local e liquidação Crashsim persistente

- **Objetivo:** permitir que um jogador autenticado consulte e carregue sua carteira local e que a engine debite apostas e credite cashouts com persistência idempotente.
- **Histórias:** US-001 a US-006.
- **Tasks:** T1 → T2 → T3 → T4 → T5.
- **Validação independente:** com F02 concluída e PostgreSQL dedicado, subir o Compose, autenticar um jogador, consultar e carregar saldo, fazer uma aposta/cashout pela engine, consultar o histórico e repetir webhooks sem duplicar efeitos.

## Task T1: Configuração financeira, schema e migration

- **Prioridade:** P0
- **Estimativa:** 3h
- **Dependências:** F02 T1–T4 implementadas e verificadas
- **Cobre:** FR-001, FR-004, FR-005, FR-009, NFR-001, NFR-002, NFR-003, NFR-004, NFR-005, TD-001, TD-006, TD-008

### Trabalho

- [x] Estender a configuração validada com ENGINE_WEBHOOK_SECRET, APP_ENV (local, test ou production) e WALLET_TEST_TOPUP_ENABLED, com default fechado; nunca usar segredo padrão no operador.
- [x] Fazer a inicialização falhar se top-up estiver habilitado fora de APP_ENV=local; incluir o segredo Crashsim na redação do logger/configuração.
- [x] Criar financial.schema.ts com wallets, financial_operations e wallet_ledger_entries, usando centavos inteiros, PostgreSQL BIGINT, checks de faixa, FKs, timestamps e índices do design.
- [x] Definir unicidade parcial para engine_tx_id e business_key, incluindo a chave de cashout cashout:<betId> e as chaves de top-up por jogador.
- [x] Integrar o schema ao drizzle.config.ts e ao fluxo de migrations criado pela F02; gerar e revisar uma migration aditiva posterior à migration de auth.
- [x] Cobrir validação de configuração, redação de segredo, constraints, indexes e migração/reexecução sem remover dados existentes.

### Critérios de aceite

- [x] A migration cria somente as tabelas e constraints financeiras, pode ser reexecutada pelo migrador e preserva jogadores/sessões da F02.
- [x] O banco impede saldo negativo ou acima de Number.MAX_SAFE_INTEGER, valores financeiros fora da faixa e duas operações com a mesma chave única.
- [x] APP_ENV inválido é rejeitado; a flag local defaulta para false; combinação habilitada fora de local impede startup.
- [x] ENGINE_WEBHOOK_SECRET e DATABASE_URL não aparecem em erros de configuração nem logs.

### Arquivos

- operator/src/config.ts e operator/src/config.test.ts — configuração, validação e redação.
- operator/src/modules/financial/financial.schema.ts — tabelas e constraints financeiras.
- operator/drizzle.config.ts — integrar schema sem substituir configuração da F02.
- operator/drizzle/ — migration financeira aditiva e metadados gerados.
- operator/src/modules/financial/financial.schema.test.ts ou testes de migration — constraints e execução em PostgreSQL dedicado.
- operator/package.json e operator/bun.lock — somente se dependências/scripts aprovados pela F02 precisarem de ajuste.

### Verificação

- [x] `cd operator && bun run typecheck` — exit 0; `bun test` com `TEST_DATABASE_URL` dedicado — 73 pass, 0 fail, 293 expectations.
- [x] Executar `bun run db:migrate` duas vezes contra PostgreSQL dedicado `operator_financial_test`; migração repetida dentro do teste preservou player, sessão, wallet, operations e ledger.
- [x] Testar top-up ausente (false), habilitado em local, habilitado fora de local, `APP_ENV` inválido e segredo ausente/vazio; logger capturado não contém o webhook secret.

## Task T2: Serviço financeiro transacional e contrato público

- **Prioridade:** P0
- **Estimativa:** 4h
- **Dependências:** T1
- **Cobre:** FR-001, FR-002, FR-003, FR-004, FR-005, FR-007, FR-008, FR-009, US-001, US-002, US-003, US-005, US-006, NFR-001, NFR-002, TD-001, TD-003, TD-005, TD-008

### Trabalho

- [x] Criar financial.service.ts com ensureWallet, consulta de saldo, listagem do ledger, débito, crédito de cashout e top-up; receber playerId somente de contrato confiável.
- [x] Manter a aritmética em bigint e converter entradas JSON para inteiro somente depois de validar Number.isSafeInteger e positividade.
- [x] Na mesma transação PostgreSQL, reservar/verificar idempotência, alterar saldo, gravar resultado da operação e inserir ledger somente para movimentos aplicados.
- [x] Fazer débito por UPDATE condicional ao saldo disponível. Persistir insufficient_funds com o saldo da resposta, sem mutar carteira nem criar ledger.
- [x] Implementar replay por txId, conflito 409 para conteúdo divergente e concorrência de duplicatas sem deixar erro de unicidade escapar como falso sucesso ou efeito duplicado.
- [x] Implementar crédito idempotente por cashout:<betId> e creditCashoutOnce para o webhook e a futura reconciliação F06; conferir jogador e valor quando webhook e reconciliação concorrem ou chegam fora de ordem.
- [x] Se a reconciliação creditar primeiro, associar o txId do webhook tardio à operação existente após validar jogador/valor, sem criar novo movimento; preservar unicidade de txId e betId.
- [x] Persistir balance_limit e o saldo original quando crédito/top-up exceder o teto seguro, sem alterar carteira/ledger; preservar o resultado em replays.
- [x] Implementar idempotência de top-up por jogador e Idempotency-Key; conflito de mesmo identificador com outro conteúdo retorna conflito.
- [x] Testar service contra PostgreSQL dedicado, incluindo corridas, commit de resultado desconhecido, rollback e consistência entre saldo, operação e ledger.

### Critérios de aceite

- [x] Débito, crédito e top-up aplicados atualizam saldo, operação e ledger atomicamente; recusas não criam lançamento nem saldo negativo.
- [x] Dois débitos simultâneos não consomem mais que o saldo; duas chamadas iguais em paralelo geram no máximo um efeito e retornam o resultado vencedor.
- [x] Replay de débito insuficiente continua recusado mesmo após top-up; nova tentativa exige novo txId.
- [x] Webhook e creditCashoutOnce para o mesmo betId resultam em um crédito; divergência de jogador/valor não muda saldo e é sinalizada como conflito.
- [x] Webhook tardio após reconciliação vincula seu txId à operação já aplicada e devolve o resultado persistido sem segundo lançamento.
- [x] Valor ou saldo acima da faixa segura não é arredondado; top-up/crédito com limite excedido tem resultado idempotente, sem movimento.
- [x] ensureWallet cria saldo zero idempotentemente apenas quando chamado com identidade confiável; débito/crédito de player sem carteira não cria carteira órfã.
- [x] listEntries retorna somente dados do jogador solicitado e usa ordenação estável por (created_at, id).

### Arquivos

- operator/src/modules/financial/financial.service.ts — regras, queries Drizzle e transações.
- operator/src/modules/financial/financial.service.test.ts — unitários e integração em PostgreSQL dedicado.
- operator/src/modules/financial/financial.schema.ts — consultar schema de T1; ajustar somente se necessário para cumprir o design.
- operator/src/modules/financial/financial.module.ts — exportar o contrato usado por F04/F06, sem exportar tabelas privadas.

### Verificação

- [x] `cd operator && bun run typecheck` — exit 0; `bun test` com `TEST_DATABASE_URL` dedicado — 83 pass, 0 fail, 362 expectations.
- [x] Testes PostgreSQL cobrem débito coberto/insuficiente, crédito, top-up, replay, payload conflitante, limite de saldo, wallet ausente e rollback.
- [x] Testes concorrentes cobrem dois débitos sobre saldo limitado, txId/top-up duplicados e webhook/reconciliação pelo mesmo betId; saldo final confere com o net do ledger.
- [x] Simular resposta perdida depois do commit; retry pelo mesmo txId devolve o resultado salvo sem repetir o movimento.

## Task T3: Autenticação HMAC e rotas financeiras da engine

- **Prioridade:** P0
- **Estimativa:** 3h
- **Dependências:** T1 e T2
- **Cobre:** FR-002, FR-003, FR-004, FR-006, FR-008, US-002, US-003, US-004, US-005, NFR-001, NFR-002, NFR-003, TD-002, TD-004, TD-007, TD-008

### Trabalho

- [ ] Criar crashsim-webhook-auth.ts para validar x-timestamp, x-signature, HMAC-SHA256 sobre o timestamp textual e bytes exatos do corpo e janela de frescor de ±60 segundos.
- [ ] Comparar digests de tamanho igual em tempo constante; validar HMAC antes de parsear/validar payload e manter o segredo somente no servidor.
- [ ] Registrar parser application/json baseado em Buffer em escopo Fastify encapsulado somente para webhooks Crashsim, com limite de 16 KiB.
- [ ] Registrar POST /wallet/debit e POST /wallet/credit; validar estrutura com Valibot e chamar o serviço financeiro sem exigir sessão de navegador.
- [ ] Mapear resultados para o contrato da engine: 200 { balance } somente após commit, 402 para débito recusado, 409 para conflito, 422 para faixa/limite, 404 para carteira inexistente, 401 para autenticação e 503 para falha de persistência.
- [ ] Para payout inteiro mas inseguro, responder 422 antes de mutação e registrar wallet.cashout.precision_incident sem valor, corpo, assinatura, segredo ou dados pessoais.
- [ ] Registrar eventos estruturados de aplicado, recusado, rejeitado, replay e conflito com categorias e correlação permitidas pelo design.
- [ ] Adicionar testes Fastify inject para HMAC válido sobre bytes crus, corpo adulterado, timestamp antigo/futuro, headers ausentes/malformados, body acima do limite, payload inválido e respostas do engine.

### Critérios de aceite

- [ ] Alterar whitespace/bytes do body invalida assinatura quando os bytes assinados não correspondem; validação de assinatura acontece antes da operação financeira.
- [ ] HMAC ausente, inválido ou fora da janela não chama o service nem altera banco; timestamp com skew de 90s continua sendo rejeitado.
- [ ] Valor de cashout fora de Number.MAX_SAFE_INTEGER recebe 422, não cria operação/ledger e emite incidente sem registrar o valor aproximado.
- [ ] A engine recebe 200 somente depois do commit; indisponibilidade ou resultado de commit não confirmado retorna erro não-success para retry com o mesmo txId.
- [ ] Os webhooks não dependem de auth.requireUser; nenhum endpoint permite escolher uma identidade autenticada via browser.

### Arquivos

- operator/src/modules/financial/crashsim-webhook-auth.ts — HMAC e frescor específicos de Crashsim.
- operator/src/modules/financial/financial.controller.ts — parser isolado e rotas de webhook.
- operator/src/modules/financial/financial.controller.test.ts — testes Fastify e persistência.
- operator/src/modules/financial/crashsim-webhook-auth.test.ts — assinatura, bytes crus e timestamp.
- operator/src/config.ts — consumir segredo adicionado em T1, sem expô-lo.

### Verificação

- [ ] cd operator && bun run typecheck && bun test.
- [ ] Executar testes HTTP com body assinado e body alterado, assinatura ausente/incorreta, timestamp em ambos os lados da janela e body maior que 16 KiB.
- [ ] Confirmar no banco de teste que requisições não autenticadas/inválidas não criam operações, não mudam saldo e não escrevem ledger.
- [ ] Conferir logs capturados dos casos de precisão, assinatura e conflito; nenhum deve conter secret, signature, raw body, amount, balance ou Authorization.

## Task T4: API autenticada de saldo, histórico e top-up local

- **Prioridade:** P0
- **Estimativa:** 3h
- **Dependências:** T1, T2 e T3
- **Cobre:** FR-001, FR-004, FR-007, FR-009, US-001, US-005, US-006, NFR-001, NFR-003, NFR-005, TD-005, TD-006

### Trabalho

- [ ] Registrar GET /wallet usando auth.requireUser(request), ensureWallet(player.id) e consulta do saldo persistido.
- [ ] Registrar GET /wallet/transactions com limite padrão 50, máximo 100 e cursor estável (created_at, id); limitar a consulta ao jogador autenticado.
- [ ] Registrar POST /wallet/top-ups somente quando a configuração local habilitar a função; validar centavos positivos e Idempotency-Key UUID.
- [ ] Obter o jogador exclusivamente da sessão autenticada; rejeitar playerId extra e nunca aceitar um ID do browser como destino do crédito.
- [ ] Mapear erros para o envelope REST da F02, incluindo autenticação, validação, conflito de idempotência, limite de saldo e indisponibilidade.
- [ ] Testar inject para identidade ausente/inválida, isolamento entre jogadores, paginação, criação de carteira zero, top-up, replay e chave conflitante.
- [ ] Validar cursor malformado, limit fora da faixa e header Idempotency-Key ausente/malformado sem mutar saldo.

### Critérios de aceite

- [ ] GET saldo e histórico exigem auth e não retornam carteira/lançamentos de outro jogador.
- [ ] A primeira consulta cria uma carteira zero vinculada ao ID retornado pelo contrato auth.
- [ ] Top-up só existe em APP_ENV=local com flag explícita; quando desabilitado, a rota não é registrada.
- [ ] Top-up credita somente o jogador autenticado; corpo com playerId é rejeitado e não muda qualquer outra carteira.
- [ ] Repetir a mesma chave e conteúdo devolve o resultado original sem novo ledger; repetir a chave com outro valor retorna 409.
- [ ] Histórico contém apenas movimentos aplicados e sua paginação não repete nem perde entradas na fronteira do cursor.

### Arquivos

- operator/src/modules/financial/financial.controller.ts — rotas REST de jogador, em sequência com T3.
- operator/src/modules/financial/financial.controller.test.ts — cobertura autenticada e de isolamento.
- operator/src/modules/financial/financial.module.ts — receber o contrato público requireUser da F02.
- operator/src/modules/financial/financial.service.ts — usar métodos implementados em T2.

### Verificação

- [ ] cd operator && bun run typecheck && bun test.
- [ ] Testar GET sem sessão, dois jogadores com carteiras diferentes, histórico paginado e tentativa de playerId forjado.
- [ ] Testar top-up local com primeira execução, replay equivalente, chave/conteúdo conflitante e saldo acima do teto seguro.
- [ ] Inicializar com a flag ligada fora de local e confirmar falha segura; iniciar com flag desligada e confirmar rota ausente.

## Task T5: Composição, Compose e documentação operacional

- **Prioridade:** P0
- **Estimativa:** 3h
- **Dependências:** T1, T2, T3 e T4
- **Cobre:** FR-007, FR-008, FR-009, NFR-003, NFR-004, NFR-005, US-001–US-006, TD-002, TD-006, TD-008

### Trabalho

- [ ] Finalizar financial.module.ts para compor service/controller e exportar o contrato do design: ensureWallet, getBalance, listEntries e creditCashoutOnce; manter tabelas internas.
- [ ] Integrar financial em server.ts como composição de módulos, usando a conexão, logger e auth da F02; preservar lifecycle/shutdown e o módulo game existente.
- [ ] Atualizar Compose local para fornecer o mesmo segredo de webhook ao engine e ao operador, configurar APP_ENV=local e habilitar top-up somente na composição local; manter o segredo fora do client.
- [ ] Atualizar README com setup/migration, variáveis, assinatura e janela, respostas HTTP, retries, idempotência, top-up local, precisão máxima e limite de recuperação do payout inseguro.
- [ ] Adicionar teste de integração do servidor para composição financeira, rotas, fechamento de recursos e preservação das rotas game/health/readiness da F02.
- [ ] Executar a verificação ponta a ponta com PostgreSQL de teste e Crashsim: cadastro/login, carteira, top-up, débito, cashout, histórico, webhook duplicado, CLOCK_SKEW=90 e indisponibilidade do banco.

### Critérios de aceite

- [ ] server.ts injeta dependências públicas sem importar tabelas nem pastas privadas de auth; F04/F06 podem usar o contrato financeiro exportado.
- [ ] Operator e engine recebem localmente o mesmo WEBHOOK_SECRET, sem segredos em variáveis do client, resposta HTTP ou logs.
- [ ] Migrations são executadas pelo migrador único da F02, antes da API; Compose existente mantém o volume PostgreSQL.
- [ ] O fluxo local completa auth → top-up → débito da aposta → crédito do cashout → consulta de histórico, sem divergência entre carteira e ledger.
- [ ] Duplicar um webhook não duplica movimento; banco indisponível não produz falso 200; clock skew continua visível e rejeitado.
- [ ] README descreve limites conhecidos: retries síncronos, cashout por betId, ausência de Inbox/worker/Outbox nesta feature e payout fora da faixa sem recuperação automática exata.

### Arquivos

- operator/src/modules/financial/financial.module.ts — composição e contrato do módulo.
- operator/src/server.ts — registrar financial no composition root e integrar ciclo de vida F02.
- operator/src/server.test.ts e/ou operator/src/modules/financial/financial.module.test.ts — integração e lifecycle.
- docker-compose.yml — segredo compartilhado localmente e configuração explícita do top-up.
- README.md — operação, endpoints, retries, configuração e limites conhecidos.

### Verificação

- [ ] cd operator && bun run typecheck && bun test.
- [ ] docker compose config.
- [ ] Com PostgreSQL dedicado, executar migration e testes de integração sem apontar operações destrutivas ao banco de desenvolvimento.
- [ ] Fazer fluxo manual local com Crashsim e verificar no histórico o único débito/crédito após retry/duplicação.
- [ ] Induzir indisponibilidade do banco e verificar resposta não-success; validar que health/readiness e shutdown continuam seguindo o contrato da F02.
