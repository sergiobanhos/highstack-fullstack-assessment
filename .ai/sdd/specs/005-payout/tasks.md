# Tarefas: Payout local de carteira

> Requirements: @requirements.md
> Design: @design.md
> Status: Approved

## Cobertura dos requisitos

| Requisito | Tarefas | Observações |
|---|---|---|
| FR-001 | T5 | Todas as rotas derivam o jogador de `auth.requireUser`. |
| FR-002 | T1, T2 | Persistência relacional e débito/ledger/payout no mesmo commit. |
| FR-003 | T2, T5 | `business_key` persistente, replay e conflito de idempotência na API. |
| FR-004 | T1, T4, T5 | Estado e prazo persistidos, transição recuperável e status exposto. |
| FR-005 | T3, T5 | Consulta por proprietário no serviço e autorização HTTP. |
| FR-006 | T3, T5 | Histórico próprio com cursor estável e contrato HTTP. |
| FR-007 | T5 | Configuração opt-in, válida somente em `APP_ENV=local`. |
| FR-008 | T2, T5 | Resultado só é aceito após commit; erros de saldo, validação e storage são mapeados. |
| NFR-001 | T1, T2 | Unidades menores inteiras, lock da carteira e débito sem saldo negativo. |
| NFR-002 | T1, T2, T4 | Registros atômicos, estado durável e retomada após reinício. |
| NFR-003 | T3, T5 | Escopo por identidade autenticada, resposta uniforme e logs sem dados sensíveis. |
| NFR-004 | T4, T5 | Transição sem transferência externa e respostas identificadas como simulação. |

## Verificação de prontidão para implementação

| Verificação | Estado | Observações |
|---|---|---|
| Todos os requisitos Must Have têm tarefa | Pass | FR-001–FR-008 e NFR-001–NFR-004 estão mapeados acima. |
| Requisitos estão cobertos pelo design | Pass | O design aprovado define persistência, transação, idempotência, processador, APIs, autorização, flag e rollout. |
| Perguntas críticas estão respondidas | Pass | Q-001 está respondida em D-005: o jogador escolhe um valor parcial até o saldo disponível. |
| Tarefas têm dependências, critérios, arquivos e verificação | Pass | Cada tarefa lista esses quatro itens e mantém a ordem sem ciclos. |
| Comandos de verificação são conhecidos | Pass | `operator/package.json` define `bun run typecheck`, `bun test`, `db:generate` e `db:migrate`; verificações PostgreSQL requerem banco de teste dedicado e migrado. |

## Fatias de implementação

### Fatia 1 — Débito durável e idempotente

- **Objetivo:** criar a base relacional e aceitar um payout sem risco de débito duplicado ou parcial.
- **Histórias:** US-001.
- **Tarefas:** T1, T2.
- **Validação independente:** migrar um PostgreSQL de teste dedicado e executar os testes do serviço financeiro para criação, insuficiência, replay e concorrência.

### Fatia 2 — Acompanhamento autenticado da simulação

- **Objetivo:** concluir payouts vencidos após atraso local, recuperar processamento após restart e expor status/histórico próprios.
- **Histórias:** US-002, US-003.
- **Tarefas:** T3, T4, T5.
- **Validação independente:** executar o fluxo composto autenticado: top-up local, solicitar payout, verificar débito e ledger, consultar `processing`, consultar `done` e confirmar histórico sem duplicatas.

## T1 — Persistir payouts e permitir a origem financeira `payout`

**Prioridade:** P0
**Estimativa:** 2h
**Dependências:** nenhuma
**Cobre:** FR-002, FR-004, NFR-001, NFR-002, D-001, D-003

### Trabalho

- [x] Adicionar `payouts` ao schema Drizzle com FK/PK para `financial_operations.id`, estados `processing`/`done`, datas de conclusão e vencimento, checks de consistência e índice parcial para itens vencidos.
- [x] Estender os tipos e constraints de `financial_operations` e `wallet_ledger_entries` para aceitar `source='payout'` somente em débito, sem alterar as combinações já existentes.
- [x] Gerar e revisar a migration aditiva `0003_local_payouts` e atualizar snapshot/journal Drizzle.
- [x] Incluir `payouts` na validação de prontidão de schema em `checkSchema()`.

### Critérios de aceitação

- [x] A migration parte de um banco no schema `0002` e cria a tabela, índice e constraints sem reescrever operações existentes.
- [x] A chave primária da linha `payouts` referencia uma operação financeira; status e timestamps inválidos são rejeitados pelo banco.
- [x] Origem `payout` fica disponível para operação/ledger de débito sem liberar combinações de origem e tipo não previstas no design.
- [x] `checkSchema()` falha se a tabela `payouts` estiver ausente e passa após a migration.

### Arquivos

- `operator/src/modules/financial/financial.schema.ts` — tabela, tipos e relações/constraints Drizzle.
- `operator/drizzle/0003_local_payouts.sql` — migration aditiva gerada e revisada.
- `operator/drizzle/meta/0003_snapshot.json` — snapshot da migration.
- `operator/drizzle/meta/_journal.json` — registro da migration.
- `operator/src/db.ts` — checagem de prontidão da tabela.

### Verificação

- [x] `cd operator && bun run db:generate` gera a migration esperada; revisar SQL e snapshot antes de aplicar.
- [x] Com `DATABASE_URL` apontando para um PostgreSQL dedicado de teste no schema `0002`, `cd operator && bun run db:migrate` aplica a migration e `checkSchema()` reconhece o schema atualizado.
- [x] `cd operator && bun run typecheck` passa.

## T2 — Solicitar payout com débito transacional e idempotência

**Prioridade:** P0
**Estimativa:** 4h
**Dependências:** T1
**Cobre:** FR-002, FR-003, FR-008, NFR-001, NFR-002, D-003, D-004, D-005

### Trabalho

- [x] Adicionar `requestPayout` ao contrato/implementação do serviço financeiro, reutilizando o núcleo transacional de débito em vez de chamar `debit()` e inserir o payout em uma segunda transação.
- [x] Validar valor como inteiro positivo seguro em centavos e criar a chave `payout:<playerId>:<Idempotency-Key>` no namespace `business_key`.
- [x] Na mesma transação, bloquear a carteira, reservar/verificar idempotência, atualizar saldo, inserir operação e ledger e criar `payouts(status='processing', complete_after=now()+5s)`.
- [x] Persistir a recusa `insufficient_funds` para repetição estável da chave, sem alterar saldo, ledger ou criar linha em `payouts`.
- [x] Devolver o mesmo payout em replay aceito e recusar reutilização conflitante da chave; falha de qualquer escrita deve reverter toda a transação.

### Critérios de aceitação

- [x] Uma solicitação aceita grava exatamente um débito, uma operação, um lançamento de ledger e um payout no mesmo commit.
- [x] Duas solicitações concorrentes com a mesma chave e conteúdo não duplicam débito, ledger ou payout; uma chave com valor divergente resulta em conflito sem nova mutação.
- [x] Payout concorrente com débito de aposta não permite saldo negativo; valor acima do saldo não cria payout nem ledger.
- [x] A repetição da chave recusada por saldo insuficiente continua recusada; após funding, uma chave nova pode ser aceita.
- [x] Erro entre atualização da carteira e gravação do payout reverte todas as alterações; o sucesso não é retornado antes da confirmação do commit.

### Arquivos

- `operator/src/modules/financial/financial.service.ts` — entrada e resultado do comando, idempotência e transação.
- `operator/src/modules/financial/financial.service.test.ts` — cenários PostgreSQL do comando, retries, falhas e concorrência.

### Verificação

- [x] Com PostgreSQL de teste dedicado migrado, `cd operator && bun test src/modules/financial/financial.service.test.ts` cobre saldo, replay, conflito, rollback e concorrência.
- [x] `cd operator && bun run typecheck` passa.

## T3 — Consultar status e histórico no escopo do jogador

**Prioridade:** P1
**Estimativa:** 2h
**Dependências:** T2
**Cobre:** FR-005, FR-006, NFR-003, D-001, D-005

### Trabalho

- [ ] Adicionar ao serviço financeiro consulta de payout por `payoutId` e identidade do jogador, retornando nenhum resultado para referência ausente ou alheia.
- [ ] Adicionar listagem do histórico próprio por `(created_at, id)` em ordem decrescente, com cursor keyset opaco e limite padrão 50/máximo 100.
- [ ] Projetar os campos do DTO a partir da operação e estado persistidos: `id`, `amountCents`, `currency`, `status`, `requestedAt`, `completedAt` e `simulated`.
- [ ] Manter precisão de timestamp suficiente para a paginação keyset e serializar somente valores dentro do limite seguro de número.

### Critérios de aceitação

- [ ] Consulta individual sempre filtra pelo jogador autenticado e payout; referência pertencente a outra pessoa não retorna valor, status ou proprietário.
- [ ] Histórico contém só registros próprios, ordena por data e ID de forma estável e não duplica/omite itens ao paginar enquanto chegam novas solicitações.
- [ ] Itens `processing` e `done` aparecem sob o mesmo ID; `completedAt` é nulo antes da conclusão e preenchido depois.
- [ ] Cursor inválido, limite fora de 1–100 ou resultado monetário inseguro é recusado sem ampliar escopo ou truncar silenciosamente dados.

### Arquivos

- `operator/src/modules/financial/financial.service.ts` — métodos de leitura, DTOs e paginação.
- `operator/src/modules/financial/financial.service.test.ts` — ownership, paginação, limite e estados.

### Verificação

- [ ] Com PostgreSQL de teste dedicado migrado, `cd operator && bun test src/modules/financial/financial.service.test.ts` cobre isolamento de proprietário, ordenação, paginação e estados.
- [ ] `cd operator && bun run typecheck` passa.

## T4 — Concluir a simulação local e recuperar após restart

**Prioridade:** P0
**Estimativa:** 2h
**Dependências:** T3 — a sequência evita alterações concorrentes nos mesmos métodos de `financial.service.ts`.
**Cobre:** FR-004, NFR-002, NFR-004, D-002

### Trabalho

- [ ] Implementar varredura de payouts vencidos e transição atômica apenas de `processing` para `done`, preenchendo `completed_at` sem tocar em saldo, operação ou ledger.
- [ ] No módulo financeiro, executar varredura imediata ao iniciar e repetir a cada 500 ms, com no máximo uma varredura ativa por instância.
- [ ] Capturar falhas da varredura para permitir retry no ciclo seguinte; encerrar e limpar o timer em `onClose`.
- [ ] Retomar no startup itens que venceram durante interrupção a partir de `complete_after` persistido; não depender de timer em memória para definir o estado final.

### Critérios de aceitação

- [ ] Um payout não é concluído antes de `complete_after`; após o vencimento, muda uma vez para `done` e recebe `completed_at`.
- [ ] Duas varreduras concorrentes não produzem transições ou lançamentos financeiros duplicados.
- [ ] Reiniciar o módulo depois do prazo conclui o payout persistido; indisponibilidade temporária do banco deixa o item `processing` e uma tentativa posterior pode concluí-lo.
- [ ] Concluir a simulação não altera saldo, ledger ou resultado da operação financeira.
- [ ] Fechar o módulo não deixa timer ativo nem trabalho sobreposto.

### Arquivos

- `operator/src/modules/financial/financial.service.ts` — conclusão condicional e varredura de vencidos.
- `operator/src/modules/financial/financial.module.ts` — hooks de ciclo de vida e timer local.
- `operator/src/modules/financial/financial.service.test.ts` — transição, retry e concorrência.
- `operator/src/modules/financial/financial.module.test.ts` — startup, restart, sobreposição e cleanup de timer.

### Verificação

- [ ] Com PostgreSQL de teste dedicado migrado, `cd operator && bun test src/modules/financial/financial.service.test.ts src/modules/financial/financial.module.test.ts` verifica vencimento, reinício, retry e fechamento.
- [ ] `cd operator && bun run typecheck` passa.

## T5 — Expor API autenticada e habilitação local opt-in

**Prioridade:** P0
**Estimativa:** 4h
**Dependências:** T2, T3 e T4
**Cobre:** FR-001, FR-003, FR-004, FR-005, FR-006, FR-007, FR-008, NFR-003, NFR-004, D-001, D-002, D-004, D-005

### Trabalho

- [ ] Adicionar `PAYOUT_MOCK_ENABLED` à configuração, default `false`, aceito como `true` somente com `APP_ENV=local`; configurar explicitamente a variável somente no serviço `operator` do Compose local.
- [ ] Registrar as rotas `POST /payouts`, `GET /payouts/:payoutId` e `GET /payouts` somente quando o mock estiver habilitado; não alterar o composition root além da passagem de configuração já prevista no design.
- [ ] Validar UUID de `Idempotency-Key`, body estrito com `amount` em centavos, ID, cursor e limite usando Valibot; rejeitar `playerId` enviado pelo cliente.
- [ ] Derivar proprietário de `auth.requireUser`, devolver DTO e códigos de erro definidos no design, aplicar `Cache-Control: no-store` e responder `simulated: true`.
- [ ] Manter resposta `404` uniforme para payout ausente/alheio, `402` para saldo insuficiente, `409` para conflito de idempotência e `503` quando persistência não confirmar a solicitação.
- [ ] Cobrir no controller e no fluxo composto autenticação, isolamento, configuração desligada, criação/replay, consulta individual, histórico e transição para `done`.

### Critérios de aceitação

- [ ] Sem flag, nenhuma rota de payout é registrada; `PAYOUT_MOCK_ENABLED=true` fora de `APP_ENV=local` impede configuração válida/startup.
- [ ] As três rotas exigem autenticação e usam exclusivamente o ID da sessão validada; payloads e queries com campos desconhecidos são recusados sem mutação.
- [ ] A API segue os códigos, DTOs, limites e comportamento de replay definidos na seção 6 do design; respostas não revelam payouts de terceiros.
- [ ] O fluxo composto executa top-up local, solicitação, confirmação de saldo/ledger, consulta `processing`, conclusão simulada, consulta `done` e histórico sem duplicata.
- [ ] Nenhuma rota chama provedor de pagamentos; todo resultado da simulação sinaliza `simulated: true`.

### Arquivos

- `operator/src/config.ts` — variável, default e validação de ambiente.
- `operator/src/config.test.ts` — default, opt-in local e rejeição fora de local.
- `docker-compose.yml` — flag explícita no operador local.
- `operator/src/modules/financial/financial.controller.ts` — schemas, rotas, auth e mapeamento HTTP.
- `operator/src/modules/financial/financial.module.ts` — configuração da rota e composição do processador.
- `operator/src/modules/financial/financial.controller.test.ts` — autenticação, payloads, códigos, ownership e feature gate.
- `operator/src/server.financial.integration.test.ts` — fluxo composto com PostgreSQL de teste.

### Verificação

- [ ] `cd operator && bun run typecheck` passa.
- [ ] Com PostgreSQL dedicado configurado e migrado para a última migration, `cd operator && bun test src/config.test.ts src/modules/financial/financial.controller.test.ts src/server.financial.integration.test.ts` passa.
- [ ] `docker compose config` confirma a flag no serviço local; configuração com flag ligada fora de `APP_ENV=local` falha sem expor valores sensíveis.

## Ordem de execução

```text
T1 → T2 → T3 → T4 → T5
```

T3 e T4 são mantidas em sequência porque alteram os mesmos métodos do serviço financeiro; T5 depende de todas as capacidades de serviço e do ciclo de vida antes de expor o contrato HTTP.
