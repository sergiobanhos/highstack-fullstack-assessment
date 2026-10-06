# Tasks: Reconciliação das apostas ao fim da rodada

> Requirements: @requirements.md
> Design: @design.md
> Status: Implementation in progress — T1 complete

## Cobertura dos requisitos

| Requisito | Tasks | Observação |
|-----------|-------|------------|
| FR-001 | T1, T2 | Consulta final das bets e gatilho no crash |
| FR-002 | T1 | Preservar cashout e estado independente do crédito |
| FR-003 | T1, T2 | Recuperar por snapshot quando o evento histórico foi perdido |
| FR-004 | T3 | Projeção visual “Verificando resultado” e consulta manual |
| FR-005 | T1, T2, T3 | Persistência idempotente, gatilhos repetíveis e client sem estado terminal inventado |
| NFR-001 | T1, T3 | Autoridade da engine e separação de settlement |
| NFR-002 | T1, T2, T3 | Crash, ressincronização, falha temporária e nova tentativa |

## Checagem de prontidão

| Verificação | Estado | Observação |
|-------------|--------|------------|
| Todos os requisitos Must Have têm tasks | Pass | FR-001–FR-005 estão cobertos |
| Requisitos estão cobertos pelo design | Pass — draft | Mapeamento completo em `design.md`; ainda depende de aprovação |
| Perguntas críticas foram respondidas | Pass | `requirements.md` não possui questões críticas abertas |
| Tasks têm dependências, critérios, arquivos e verificação | Pass | Detalhes abaixo |
| Comandos de verificação são conhecidos | Pass | Scripts Bun existentes; testes de banco exigem `TEST_DATABASE_URL` dedicado |
| Design aprovado para implementação | Pass | Design e tasks F07 explicitamente aprovados pelo usuário |

## Fatia MVP

- **Objetivo:** fazer o operador persistir o resultado autoritativo das bets fechadas e impedir que o client apresente uma bet antiga como em andamento.
- **Histórias:** US-001, US-002.
- **Tasks:** T1, T2, T3.
- **Validação independente:** testar resultados lost/cashed_out e falhas no serviço; simular crash e ressincronização por snapshot; validar o label e consulta individual no client.

## Task T1: Reconciliar as bets fechadas pelo estado autoritativo

**Prioridade:** P0  
**Estimativa:** 3h  
**Dependências:** nenhuma  
**Cobre:** FR-001, FR-002, FR-003, FR-005, NFR-001, NFR-002, TD-001, TD-004

### Trabalho

- [x] Adicionar ao `GameCommandService` uma operação interna que localiza bets persistidas com `engineStatus = 'active'` em rodadas fechadas.
- [x] Para cada bet, chamar a lógica existente de `getBet` usando `playerId` e `betId` persistidos, sem aceitar IDs do browser.
- [x] Incluir a rodada atual somente quando o estado conhecido for `crashed`; em `betting`/`running`, deixar as bets da rodada atual fora da reconciliação.
- [x] Coalescer chamadas concorrentes para uma mesma rodada/aposta e isolar a falha de cada bet para continuar o lote.
- [x] Persistir somente o estado confirmado pela engine; não chamar cashout, não criar crédito e não reabrir status terminal.
- [x] Adicionar índice parcial por `round_id` para linhas com `engine_status = 'active'` e gerar a migração Drizzle aditiva.
- [x] Cobrir estados `lost`, `cashed_out`, settlement pendente/confirmado, engine indisponível/404, bet ainda `active` e retry idempotente.

### Critérios de aceitação

- [x] Uma bet consultada como `lost` persiste como `lost`; uma bet consultada como `cashed_out` persiste multiplicador, payout seguro e settlement atual.
- [x] O processo não transforma `active` em `lost` por inferência e não chama uma operação financeira de crédito.
- [x] Falha em uma consulta deixa essa bet sem falso resultado final e não interrompe as demais.
- [x] Repetir o método mantém estados terminais e não cria movimentação financeira duplicada.
- [x] Migração e schema registram o índice parcial; dados e contratos atuais permanecem compatíveis.

### Arquivos prováveis

- `operator/src/modules/game/game-command.service.ts`
- `operator/src/modules/game/game-command.service.test.ts`
- `operator/src/modules/game/game.schema.ts`
- `operator/src/modules/game/game.schema.test.ts`
- `operator/drizzle/0004_*.sql`
- `operator/drizzle/meta/_journal.json` e snapshot Drizzle mais recente

### Verificação

- [x] `cd operator && bun run typecheck`
- [x] Com `TEST_DATABASE_URL` configurada para um banco dedicado cujo nome contém `test`: `cd operator && bun test src/modules/game/game-command.service.test.ts src/modules/game/game.schema.test.ts`
- [x] Inspecionar SQL gerado e confirmar que a migração contém apenas o índice aditivo esperado.

**Evidência T1:** typecheck passou; 30 testes de serviço/schema passaram em `operator_test`, incluindo índice parcial, resultados `lost`/`cashed_out`, falha isolada, retry e snapshot. Migração `0004_reconcile_active_bets_by_round.sql` contém somente o índice parcial novo.

## Task T2: Disparar reconciliação no crash e na ressincronização

**Prioridade:** P0  
**Estimativa:** 2h  
**Dependências:** T1  
**Cobre:** FR-001, FR-003, FR-005, NFR-002, TD-002

### Trabalho

- [ ] Adicionar callbacks específicos ao `GameStreamService` para crash aplicado e snapshot sincronizado; sem introduzir um event bus paralelo.
- [ ] Conectar os callbacks ao serviço de comandos em `game.module.ts`, garantindo que ambos existam antes de `game.start()`.
- [ ] No crash, reconciliar as bets da rodada; no snapshot, localizar bets de rodadas não atuais e incluir a rodada snapshot quando ela estiver `crashed`.
- [ ] Executar o trabalho em background e registrar falhas sem atrasar a publicação de eventos, snapshot ou estado `connected` para o SSE.
- [ ] Garantir que eventos repetidos, sequence gap e snapshot após desconexão acionem um fluxo idempotente.
- [ ] Adicionar testes unitários do callback e de composição do módulo, incluindo snapshot já avançado para a rodada seguinte.

### Critérios de aceitação

- [ ] Um `round.crashed` aplicado aciona reconciliação da rodada sem aguardar as consultas upstream para publicar o evento.
- [ ] Snapshot `crashed` reconcilia a rodada snapshot; snapshot `betting`/`running` reconcilia bets antigas e preserva bets `active` da rodada atual.
- [ ] Um evento perdido ou sequence gap é recuperado pelo snapshot, sem assumir replay histórico.
- [ ] Erros do fluxo são registrados com referências seguras e não quebram a conexão/fan-out do stream.

### Arquivos prováveis

- `operator/src/modules/game/game-stream.service.ts`
- `operator/src/modules/game/game-stream.service.test.ts`
- `operator/src/modules/game/game.module.ts`
- `operator/src/modules/game/game.module.test.ts`

### Verificação

- [ ] `cd operator && bun run typecheck`
- [ ] `cd operator && bun test src/modules/game/game-stream.service.test.ts src/modules/game/game.module.test.ts`
- [ ] Conferir que a suite mantém as garantias atuais de sequence gap, snapshot e reconnect.

## Task T3: Mostrar apostas encerradas como em verificação no client

**Prioridade:** P1  
**Estimativa:** 2h  
**Dependências:** T1, T2  
**Cobre:** FR-004, FR-005, NFR-001, NFR-002, TD-003

### Trabalho

- [ ] Criar uma regra pura para distinguir `active` de “Verificando resultado” usando o snapshot: fase `crashed` da mesma rodada ou `roundId` da aposta diferente da rodada atual.
- [ ] Recarregar a lista ao observar crash e quando um snapshot conectado mudar a rodada, sem disparar reload em todo `tick`.
- [ ] Após a leitura da lista, consultar `GET /game/bets/:betId` para bets aceitas e `active` de rodadas conhecidamente encerradas, atualizando cada linha pela resposta.
- [ ] Exibir “Verificando resultado” enquanto o status persistido continuar ativo; oferecer ação “Verificar resultado” para repetir uma consulta que falhou.
- [ ] Manter resultado de jogo e status de liquidação em colunas/labels diferentes; não exibir perda com base apenas no crash.
- [ ] Adicionar testes da regra de projeção e atualizar teste/manual check do fluxo de lista e consulta individual.

### Critérios de aceitação

- [ ] Bet ativa da rodada atual continua “Em andamento”.
- [ ] Bet ativa de uma rodada crashed ou anterior à rodada corrente é exibida como “Verificando resultado”, nunca “Em andamento”.
- [ ] Resposta individual `lost` ou `cashed_out` substitui o label pendente e atualiza a linha sem reload completo.
- [ ] Falha de GET preserva “Verificando resultado” e deixa a ação manual disponível.
- [ ] Conexão stale continua identificada e o client não interpreta ausência de evento como resultado final.

### Arquivos prováveis

- `client/src/game-screen.tsx`
- `client/src/bet-status.ts`
- `client/src/bet-status.test.ts`
- `client/src/operator-api.ts` apenas se o contrato atual não expuser a consulta individual

### Verificação

- [ ] `cd client && bun test src/bet-status.test.ts`
- [ ] `cd client && bun run typecheck`
- [ ] `cd client && bun run build`
- [ ] Verificar manualmente loss, auto-cashout, reload já em nova rodada, desconexão/reconexão e engine indisponível.
