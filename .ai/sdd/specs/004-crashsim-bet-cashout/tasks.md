# Tasks: Sessão Crashsim, aposta e cashout

> Requirements: @requirements.md
> Design: @design.md
> Status: Approved

## Pré-requisitos para implementação

F04 depende da implementação e verificação de F02 e F03. Iniciar estas tarefas somente depois de:

- F02 concluir sua conexão PostgreSQL/Drizzle, migrations, ciclo de vida da aplicação e contrato público `auth.requireUser(request)`.
- F03 concluir carteira, ledger, webhooks e seu contrato público de carteira/financial, incluindo `ensureWallet` e `creditCashoutOnce`.
- F01 continuar preservando seu comportamento de stream sincronizado e estado monotônico.

T1 completa as duas consultas financeiras específicas que o design F04 precisa. Ela amplia apenas o contrato público de financial e não permite que `game` importe tabelas ou pastas privadas. Estas tarefas não repetem nem substituem a implementação de F02/F03.

## Cobertura dos requisitos

| Requisito | Tasks | Observações |
|-----------|-------|-------------|
| FR-001 / US-001 | T1, T4, T7 | Carteira antes da sessão; identidade vem de auth e `playerId` não é escolhido pelo browser. |
| FR-002 / US-002–US-003 | T4, T5, T6, T7 | Sincronização, rodada atual, ownership e autoridade final da engine. |
| FR-003 / US-002 | T2, T3, T4, T7 | Centavos inteiros, contrato Crashsim e aposta confirmada após débito. |
| FR-004 | T2, T4, T7 | Chave idempotente, reserva única por jogador/rodada e liberação após recusa definitiva. |
| FR-005 / US-004 | T1, T3, T4, T5 | Resultado `unknown`, correlação por débito e consulta da engine sem repetir `POST /bets`. |
| FR-006 / US-003 | T2, T5, T6, T7 | Ownership no servidor e resposta uniforme para aposta ausente/de outro jogador. |
| FR-007 / US-003 | T1, T2, T6, T7 | Estado do jogo separado de crédito confirmado no ledger. |
| FR-008 / US-004 | T3, T6, T7 | Consulta `GET /bets/:id` após resultado ambíguo de cashout. |
| FR-009 | T3, T4 | Renovação de sessão e retry único somente após `session_not_found` definitivo. |
| FR-010 | T3–T7 | Erros estáveis, sem falso sucesso/falha e sem exposição de segredos. |
| NFR-001 | T1–T4, T6 | Centavos inteiros, precisão de autoCashout/payout e limites seguros. |
| NFR-002 | T2, T4–T6 | Idempotência, concorrência, reserva durável e reconciliação. |
| NFR-003 | T3–T7 | Auth por request, schemas de entrada/engine, ownership e dados privados. |
| NFR-004 | T4, T6, T7 | Comandos bloqueados até sincronização e estado monotônico do F01. |
| NFR-005 | T4–T7 | Logs por transição e estados desconhecidos persistidos. |

## Verificação de prontidão da implementação

| Verificação | Estado | Observações |
|-------------|--------|-------------|
| Todos os requisitos Must Have têm tasks | Pass | FR-001–FR-010 e NFR-001–NFR-005 aparecem no mapa acima. |
| Requisitos cobertos pelo design aprovado | Pass | APIs, estados, constraints, erros, falhas e limites constam em `design.md`. |
| Perguntas críticas respondidas | Pass | Q-001 e Q-002 estão respondidas; a ausência de estorno automático é risco aceito para o MVP local. |
| Tasks têm dependências, critérios, arquivos e verificação | Pass | Cada tarefa lista esses elementos e inclui os casos críticos relevantes. |
| Comandos de verificação conhecidos ou marcados como manuais | Pass | Typecheck/testes Bun, migração em PostgreSQL dedicado, Compose e fluxo manual Crashsim estão descritos. |
| F02/F03 implementadas e verificadas | Pass | F02 e F03 foram implementadas e verificadas; F03 está commitada antes do início de F04. |

## Slices de implementação

### Slice 1 — Abrir sessão e apostar com segurança

- **Objetivo:** permitir que jogador autenticado crie sessão e faça uma aposta sem duplicidade, inclusive sob timeout.
- **Histórias:** US-001, US-002 e US-004.
- **Tasks:** T1, T2, T3, T4 e T7.
- **Validação independente:** API Fastify + PostgreSQL dedicado + Crashsim; verificar sessão, débito aceito/recusado, retry idempotente, resultado desconhecido e corrida de apostas.

### Slice 2 — Restaurar apostas após reload

- **Objetivo:** recuperar os comandos e bets persistidos do jogador e reconciliar itens desconhecidos por leitura.
- **Histórias:** US-004 e US-005.
- **Tasks:** T5 e T7.
- **Validação independente:** recriar o serviço/API, autenticar o mesmo jogador e consultar a lista; confirmar isolamento por jogador e ausência de novo `POST /bets` na reconciliação.

### Slice 3 — Cashout e liquidação separada

- **Objetivo:** executar cashout com propriedade verificada e reportar separadamente estado da engine e crédito financeiro.
- **Histórias:** US-003 e US-004.
- **Tasks:** T1, T2, T3, T5, T6 e T7.
- **Validação independente:** API + PostgreSQL dedicado + Crashsim; testar cashout normal, timeout com bet `cashed_out`/`active`, reconciliação desconhecida e crédito pendente/confirmado.

## Task T1: Completar contrato público de consultas financeiras para game

**Prioridade:** P0
**Estimativa:** 2h
**Dependências:** F02 e F03 implementadas e verificadas
**Cobre:** FR-001, FR-005, FR-007, NFR-001, NFR-003, NFR-005, TD-004

### Trabalho

- [x] Exportar de `financial.module.ts` `findBetDebitForCommand({ playerId, roundId, amount, createdAt })`, consultando somente operações do jogador, rodada, valor e intervalo definidos pelo design.
- [x] Retornar todos os candidatos correspondentes, com `betId` e resultado `applied` ou `insufficient_funds`; nenhum candidato, um candidato e múltiplos candidatos devem permanecer distinguíveis.
- [x] Exportar `getCashoutCreditStatus({ playerId, betId })`, retornando `credited`, `pending` ou incidente conhecido sem expor schema/linhas financeiras privadas.
- [x] Manter toda consulta e tipo do módulo financeiro encapsulados; `game` recebe somente os métodos e DTOs públicos.
- [x] Cobrir buscas sem resultado, candidato único, múltiplos candidatos, outro jogador, intervalo anterior/posterior à reserva e crédito pendente/confirmado.

### Critérios de aceite

- [x] Uma busca com candidato único retorna a operação e o `betId` corretos; múltiplos resultados não são reduzidos por heurística.
- [x] `getCashoutCreditStatus` não informa crédito confirmado antes de existir operação financeira persistida para o jogador e `betId`.
- [x] `financial.module.ts` expõe apenas funções/DTOs necessários; `game` não precisa importar schema, tabela ou serviço privado financeiro.
- [x] A consulta usa o mesmo timestamp do banco registrado na reserva do comando e não inclui débitos anteriores a ela.

### Arquivos

- `operator/src/modules/financial/financial.service.ts` — implementar consultas sobre operações/ledger já existentes.
- `operator/src/modules/financial/financial.module.ts` — exportar funções e tipos públicos.
- `operator/src/modules/financial/financial.service.test.ts` — cobrir filtros e resultados com PostgreSQL dedicado.

### Verificação

- [x] `cd operator && bun run typecheck && bun run test:e2e` (a suíte Bun completa executa com PostgreSQL temporário dedicado).
- [x] Em PostgreSQL dedicado, validar candidato único/múltiplo, filtros de jogador/rodada/valor/tempo e estado de crédito.
- [x] Inspecionar imports de `game` e confirmar ausência de dependência em arquivos privados de financial.

## Task T2: Persistir comandos e apostas do módulo game

**Prioridade:** P0
**Estimativa:** 3h
**Dependências:** F02 T1 (base Drizzle/migrations) implementada e verificada
**Cobre:** FR-004–FR-007, NFR-001, NFR-002, NFR-003, TD-002, TD-003

### Trabalho

- [x] Criar `game_commands` e `game_bets` conforme o modelo de dados aprovado, com tipos explícitos para tentativas de aposta/cashout e estados conhecidos/desconhecidos.
- [x] Persistir `amount_cents` e `auto_cashout_hundredths` como inteiros; payout fora da faixa segura não pode ser persistido aproximado.
- [x] Criar unique `(player_id, idempotency_key)`, unique parcial para aposta `pending`/`unknown`/`accepted` por `(player_id, round_id)` e unique parcial para cashout `pending`/`unknown` por `bet_id`.
- [x] Criar migration Drizzle aditiva após as migrations F02/F03, mantendo os schemas/tabelas dos outros módulos e o migrador único da F02.
- [x] Testar constraints com tentativas concorrentes, incluindo liberar vaga de aposta após `rejected` definitivo e mantê-la para `unknown`/`accepted`.

### Critérios de aceite

- [x] Reexecutar a migration não apaga nem recria dados existentes.
- [x] Duas reservas concorrentes para o mesmo jogador/rodada não deixam duas apostas `pending`, `unknown` ou `accepted`.
- [x] Recusa definitiva libera a vaga para nova chave; aposta aceita ou desconhecida continua ocupando-a.
- [x] Chave idempotente não pode ser reutilizada com tipo ou fingerprint diferente; reserva de cashout incerta é única por `betId`.
- [x] Os dados necessários para correlacionar débito e resultado após restart persistem; `sessionId` não é armazenado.

### Arquivos

- `operator/src/modules/game/game.schema.ts` — criar tabelas, índices e tipos Drizzle.
- `operator/src/db.ts` — incluir as tabelas no schema compartilhado e na checagem de prontidão.
- `operator/drizzle/` — migration SQL e metadados aditivos.
- `operator/src/modules/game/game.schema.test.ts` — validar constraints e migration em banco dedicado.
- `operator/drizzle.config.ts` — incluir o schema game sem substituir auth/financial.

### Verificação

- [x] `cd operator && bun run typecheck && bun run test:e2e` (suíte Bun completa em PostgreSQL temporário dedicado).
- [x] Com PostgreSQL dedicado, aplicar migration duas vezes e confirmar tabelas/índices e preservação de dados.
- [x] Fazer reservas paralelas para aposta/cashout e conferir as constraints e transições aceitas.

## Task T3: Completar cliente HTTP concreto do Crashsim

**Prioridade:** P0
**Estimativa:** 3h
**Dependências:** F01; config/contrato de HTTP atual disponíveis
**Cobre:** FR-003, FR-005, FR-008–FR-010, NFR-001, NFR-003, TD-001

### Trabalho

- [x] Estender `crashsim-http.client.ts` com `createSession`, `placeBet`, `getBet` e `cashout`, usando `ENGINE_HTTP_URL` e `ENGINE_OPERATOR_KEY` somente no servidor.
- [x] Validar respostas relevantes da engine com Valibot, inclusive identidade da aposta, jogador/rodada quando retornados, status, multiplicador e payout.
- [x] Classificar `session_not_found` validado como recusa definitiva que permite uma renovação de sessão; timeout, desconexão, 5xx e JSON inválido após envio permanecem ambíguos.
- [x] Implementar timeout limitado e erros tipados para recusa, conflito, indisponibilidade e resultado desconhecido, sem retry automático genérico no cliente.
- [x] Preservar somente valores monetários JSON seguros; sinalizar precisão não representável sem arredondar nem fabricar resultado.
- [x] Adicionar testes do cliente para headers, payloads, validação de resposta, timeout, status HTTP e redação de credenciais.

### Critérios de aceite

- [x] Os quatro métodos usam o contrato atual do Crashsim e não alteram a engine.
- [x] Nenhuma chamada envia chave de idempotência fingindo suporte na engine, e cliente não implementa retry de `POST /bets` para timeout/5xx/JSON inválido.
- [x] `session_not_found` só é definitivo quando a resposta estruturada correspondente foi validada.
- [x] `ENGINE_OPERATOR_KEY`, `sessionId` e corpo sensível não aparecem em resposta de erro nem nos logs.
- [x] Payout fora de `Number.MAX_SAFE_INTEGER` não é arredondado ou aceito como valor financeiro.

### Arquivos

- `operator/src/modules/game/crashsim-http.client.ts` — métodos e validação do protocolo Crashsim.
- `operator/src/modules/game/crashsim-http.client.test.ts` — testes com fetch/servidor simulado.

### Verificação

- [x] `cd operator && bun run typecheck && bun run test:e2e` (suíte completa em PostgreSQL temporário dedicado).
- [x] Executar testes simulados para respostas válidas/inválidas, `session_not_found`, 402, timeout, 5xx e payout inseguro.
- [x] Inspecionar erros e requests capturados; chave, session ID e body cru não são devolvidos em erros nem registrados pelo cliente.

## Task T4: Implementar abertura de sessão, aposta e reconciliação

**Prioridade:** P0
**Estimativa:** 4h
**Dependências:** T1, T2 e T3; F02/F03 implementadas
**Cobre:** FR-001–FR-005, FR-009–FR-010, US-001–US-002, US-004, NFR-001–NFR-005, TD-001–TD-005

### Trabalho

- [x] Criar `game-command.service.ts` para obter/criar sessão por `playerId` autenticado, chamando `financial.ensureWallet` antes de `createSession`; manter `sessionId` em memória somente no servidor.
- [x] Validar aposta em centavos inteiros de 1 a 1.000.000.000 e normalizar `autoCashout` para centésimos dentro da faixa Crashsim.
- [x] Antes de enviar aposta, exigir snapshot conectado/sincronizado, estado `betting` e rodada correspondente; persistir comando e reservar vaga em transação curta antes da chamada externa.
- [x] Implementar replay da mesma chave/fingerprint, conflito para reuso divergente e serialização concorrente por constraints do banco; 402 persistido libera slot para nova chave.
- [x] Recriar sessão e repetir `POST /bets` no máximo uma vez somente após `session_not_found` definitivo; nunca repetir por timeout, conexão fechada, 5xx ou resposta inválida.
- [x] Para resposta ambígua, manter `unknown`, correlacionar débito via contrato financeiro e consultar `getBet` somente se houver candidato único; nunca escolher por aproximação nem repetir `POST /bets`.
- [x] Tratar débito `applied` com bet `rejected` como risco documentado: sem estorno automático nesta entrega; não declarar saldo compensado.
- [x] Adicionar testes de estado e integração com PostgreSQL dedicado para chave repetida, concorrência, 402, sessão inválida, timeout e reconciliação.

### Critérios de aceite

- [x] O `playerId` usado em sessão, aposta e correlação vem da identidade autenticada fornecida pela camada pública; carteira é garantida antes da sessão.
- [x] Snapshot `reconnecting`/`synchronizing` ou rodada que não esteja `betting` impede chamada à engine.
- [x] Só um bet aceito/desconhecido por jogador/rodada permanece ativo; recusa 402 permite nova chave, resultado desconhecido bloqueia nova aposta na rodada.
- [x] Uma chave igual com mesmo conteúdo devolve resultado/reconcilia; conteúdo ou tipo diferente retorna conflito sem efeito externo.
- [x] Nenhum caminho de resultado ambíguo reenvia aposta; falha sem evidência autoritativa persiste como `unknown`.
- [x] Uma sessão perdida só provoca retry da aposta quando o Crashsim confirma `session_not_found`; falha de rede não é convertida nessa condição.

### Arquivos

- `operator/src/modules/game/game-command.service.ts` — abrir sessão, aposta, persistência e reconciliação.
- `operator/src/modules/game/game-command.service.test.ts` — transições, limites, retry e falhas.
- `operator/src/modules/game/game.schema.ts` — consumir tabelas/constraints T2 sem duplicar schema.
- `operator/src/modules/financial/financial.module.ts` — consumir apenas contrato público T1.

### Verificação

- [x] `cd operator && bun run typecheck && bun run test:e2e` (a suíte Bun completa executa em PostgreSQL temporário dedicado).
- [x] Em PostgreSQL dedicado, testar duas apostas concorrentes, replay de chave, reuso conflitante, 402 após top-up e slot desconhecido.
- [x] Com o contrato Crashsim simulado no serviço, validar débito aceito/recusado, `session_not_found`, timeout e consulta de bet por candidato único; o fluxo com engine real será exercitado em T7 após a composição da API.
- [x] Confirmar nos testes que não ocorre segundo `POST /bets` após resposta ambígua e que nenhuma compensação automática é criada.

## Task T5: Implementar leitura autenticada e recuperação após reload

**Prioridade:** P0
**Estimativa:** 3h
**Dependências:** T1, T2 e T4
**Cobre:** FR-002, FR-005–FR-007, FR-010, US-003–US-005, NFR-002–NFR-005

### Trabalho

- [x] Implementar consulta de bets/comandos próprios ordenados do mais recente, com `limit` padrão 10 e máximo 20, combinando comandos sem duplicar bets aceitos.
- [x] Incluir comandos `pending`, `unknown` e `rejected` sem `betId` na lista; retornar `commandId`, `roundId`, valor, status do comando e dados de bet/settlement quando conhecidos.
- [x] Implementar leitura de comando por `commandId`, filtrada por jogador autenticado; para `unknown`, tentar somente reconciliação por financial e GET da engine, sem nova mutação.
- [x] Implementar leitura de bet por `betId` após confirmar ownership persistido; atualizar status atual da engine e consultar estado de liquidação financeira.
- [x] Retornar `404` uniforme para bet/comando inexistente ou pertencente a outro jogador, sem chamar a engine para dados sem ownership confirmado.
- [x] Cobrir reload após reinício do processo, isolamento entre jogadores, limite/paginação, estado unknown e settlement pending/confirmed.

### Critérios de aceite

- [x] Jogador autenticado recupera bets/comandos persistidos após recarregar página ou recriar serviço, sem depender de memória do browser.
- [x] Lista e consultas nunca retornam registro de outro jogador nem revelam sua existência por status/campos distintos.
- [x] A reconciliação de um comando desconhecido usa leituras; ela não cria aposta nem repete chamada de cashout.
- [x] Um bet com cashout confirmado pode retornar `engineStatus=cashed_out` e `settlementStatus=pending` até financial confirmar o crédito.
- [x] Estado ainda desconhecido permanece persistido e consultável; timeout local não o remove.

### Arquivos

- `operator/src/modules/game/game-command.service.ts` — operações de leitura e reconciliação read-only.
- `operator/src/modules/game/game-command.service.test.ts` — ownership, recuperação e settlement.
- `operator/src/modules/game/game.schema.ts` — queries Drizzle sobre dados persistidos.

### Verificação

- [x] `cd operator && bun run typecheck && bun run test:e2e` (suíte completa com PostgreSQL temporário dedicado).
- [x] Criar bet/comando, recriar serviço e recuperar pela lista com mesma identidade; validar lista vazia/limite e isolamento de duas contas.
- [x] Para item `unknown`, confirmar lookup financeiro/GET da engine sem `POST /bets` nem mutação de saldo durante a leitura.
- [x] Validar retorno uniforme de ausência para IDs inexistentes e de terceiro, sem consulta à engine antes da verificação de ownership.

## Task T6: Implementar cashout, reconciliação e estado de liquidação

**Prioridade:** P0
**Estimativa:** 4h
**Dependências:** T1, T2, T3, T4 e T5
**Cobre:** FR-002, FR-006–FR-008, FR-010, US-003–US-004, NFR-001–NFR-005, TD-004

### Trabalho

- [ ] Exigir bet persistido pertencente ao jogador, engine status `active`, rodada atual `running` e stream sincronizado antes de reservar ou chamar Crashsim.
- [ ] Reservar comando/idempotency key e slot do `betId` em transação curta; enviar um único `POST /bets/:id/cashout` para aquela tentativa.
- [ ] Persistir status, multiplicador e payout validados; manter `settlementStatus=pending` até `financial.getCashoutCreditStatus` confirmar crédito pelo mesmo jogador e `betId`.
- [ ] Em timeout, erro ou resposta inválida, consultar `GET /bets/:id`: `cashed_out` confirma resultado do jogo, `active` permite tentativa futura com chave nova e validações renovadas; indisponibilidade mantém `unknown`.
- [ ] Deduplicar a mesma chave/fingerprint, rejeitar reuso divergente e impedir cashouts concorrentes enquanto exista operação `pending`/`unknown`.
- [ ] Não chamar `creditCashoutOnce` no fluxo do jogador; webhook/F06 seguem responsáveis pelo crédito idempotente.
- [ ] Testar cashout normal, timeout com leitura `active`/`cashed_out`, estado unknown, propriedade, concorrência, precisão e webhook de crédito pendente/tardio.

### Critérios de aceite

- [ ] Conta que não possui o bet não aciona `POST /cashout` nem altera estado financeiro.
- [ ] Estado não sincronizado, rodada não `running` ou aposta resolvida impede comando à engine.
- [ ] Timeout de cashout nunca vira falha definitiva antes de GET autoritativo; consulta indisponível mantém `unknown`.
- [ ] `cashed_out` do jogo e confirmação do crédito são campos/estados distintos; saldo só é descrito como creditado após confirmação do financial.
- [ ] Payout fora do limite seguro não é aproximado, persistido como valor financeiro ou apresentado como crédito confirmado.
- [ ] Constraint e transação impedem duas chamadas concorrentes incertas para o mesmo `betId`.

### Arquivos

- `operator/src/modules/game/game-command.service.ts` — cashout e reconciliação.
- `operator/src/modules/game/game-command.service.test.ts` — cenários concorrentes e de timeout.
- `operator/src/modules/game/crashsim-http.client.ts` — usar método de cashout/getBet T3.
- `operator/src/modules/financial/financial.module.ts` — consumir somente status público de crédito.

### Verificação

- [ ] `cd operator && bun run typecheck && bun test`.
- [ ] Com PostgreSQL dedicado e Crashsim, testar cashout normal e flag `CASHOUT_TIMEOUT=1`, consultas que retornam `active` e `cashed_out`, além de GET indisponível.
- [ ] Confirmar corrida de duas chaves no mesmo bet e replay da mesma chave sem segundo efeito.
- [ ] Confirmar estados de crédito pending/confirmed e ausência de crédito iniciado pela API game.

## Task T7: Expor REST autenticada e integrar o módulo game

**Prioridade:** P0
**Estimativa:** 4h
**Dependências:** T1–T6; F02/F03 implementadas e verificadas
**Cobre:** FR-001–FR-010, US-001–US-005, NFR-001–NFR-005, TD-001

### Trabalho

- [ ] Criar controller REST fino para `POST /game/session`, `POST /game/bets`, `GET /game/bets`, `GET /game/commands/:commandId`, `GET /game/bets/:betId` e `POST /game/bets/:betId/cashout`.
- [ ] Usar `auth.requireUser(request)` em cada rota; validar body, query, UUID e `Idempotency-Key` com Valibot; nenhum input do browser escolhe `playerId`, `sessionId`, owner, status ou payout.
- [ ] Mapear resultados e erros para os códigos/status REST aprovados, incluindo `401`, `404` uniforme, `402`, `409`, `202 unknown`, `503` e sucessos sem envelope inconsistente.
- [ ] Manter controller responsável por transporte e mapeamento; concentrar sincronização, persistência, chamadas Crashsim e reconciliação no serviço game existente.
- [ ] Injetar DB e contratos públicos de auth/financial em `game.module.ts` a partir de `server.ts`; registrar rotas apenas quando a composição completa estiver válida.
- [ ] Preservar `/game/events`, health/readiness, lifecycle e uma conexão Crashsim compartilhada do F01; não criar worker, adapter genérico, módulo hipotético ou contrato privado entre módulos.
- [ ] Adicionar testes Fastify `inject` para todas as rotas, autenticação, schemas, status, isolamento, respostas unknown e ausência de segredo/session na resposta/log.
- [ ] Atualizar README com endpoints, fluxo de reload, idempotência, estados unknown, restrição de cashout, dependências e limites conhecidos do MVP.

### Critérios de aceite

- [ ] Todas as seis rotas exigem autenticação e usam somente o jogador retornado por `requireUser`.
- [ ] `GET /game/bets?limit=10` restaura bets/comandos do jogador; comando unknown pode ser consultado sem repetir mutação.
- [ ] Respostas e erros diferenciam recusa definitiva, conflito, indisponibilidade e estado desconhecido conforme o design.
- [ ] `sessionId`, `ENGINE_OPERATOR_KEY`, segredo de webhook e payload upstream integral não aparecem no browser ou nos logs.
- [ ] F01 SSE, reducer, reconnect e snapshot continuam funcionando; durante reconnect/synchronizing aposta e cashout são recusados antes de qualquer chamada de engine.
- [ ] O fluxo local completa cadastro/login → sessão → aposta/débito → cashout → confirmação financeira → recuperação da aposta após reload sem saldo divergente.
- [ ] README registra o limite de não compensar automaticamente bet rejeitado após débito confirmado e a recuperação de cashout pendente atribuída a F06.

### Arquivos

- `operator/src/modules/game/game-commands.controller.ts` — rotas e schemas HTTP.
- `operator/src/modules/game/game.module.ts` — composição e registro REST junto do stream existente.
- `operator/src/modules/game/game.module.test.ts` — composição e regressão das rotas SSE/health.
- `operator/src/modules/game/game-commands.controller.test.ts` — Fastify inject, auth e códigos HTTP.
- `operator/src/server.ts` — injetar dependências públicas e lifecycle.
- `README.md` — API, fluxo e limitações da F04.

### Verificação

- [ ] `cd operator && bun run typecheck && bun test`.
- [ ] `docker compose config`.
- [ ] Com PostgreSQL de teste dedicado, aplicar todas as migrations e executar integração sem apontar operações destrutivas para banco de desenvolvimento.
- [ ] Fazer fluxo manual com Compose e Crashsim, incluindo reload, reconnect/reorder, 402 + nova chave, timeout de bet e timeout de cashout.
- [ ] Conferir logs e respostas para ausência de credenciais; confirmar que `/game/events` e readiness permanecem disponíveis.
