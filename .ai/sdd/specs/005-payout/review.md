# Revisão: Payout local de carteira

> Requirements: @requirements.md
> Design: @design.md
> Tasks: @tasks.md
> Estado inicial: `implementation:done`
> Escopo revisado: commits F05 `6035c9b` e `e659d39`; alterações locais paralelas em `client/`, `docker-compose.yml` e `engine/src/config.js` ficaram fora do escopo.

## Verificação de cobertura

| Requisito | Cobertura esperada | Estado | Evidência / observações |
|---|---|---|---|
| FR-001 | Identidade autenticada em todas as rotas | Pass | Rotas usam `resolvePlayer`/`auth.requireUser`; owner é derivado de `player.id`. `financial.controller.ts`; testes de auth e player forjado. |
| FR-002 | Débito seguro, limitado ao saldo e atômico com operação, ledger e payout | Pass | `requestPayout` reutiliza `applyOperation`; lock da carteira e efeito de inserir `payouts` ocorrem na mesma transação. Testes cobrem saldo, concorrência e rollback. |
| FR-003 | Replay sem segundo débito e conflito sem mutação | Pass | `business_key` por jogador/chave, comparação de conteúdo e recuperação do mesmo payout; testes concorrentes e HTTP cobrem replay/conflito. |
| FR-004 | Simulação persistida, monotônica e recuperável | Pass | `complete_after` persistido; update condicional `processing` → `done`; varredura no startup e a cada 500 ms. Testes cobrem vencimento, concorrência, restart e retry. |
| FR-005 | Status acessível somente pelo proprietário | Pass | Consulta filtra por payout e `financial_operations.player_id`; ausência e payout alheio retornam o mesmo `404`. |
| FR-006 | Histórico próprio, ordenado e paginado | Pass | Consulta keyset `(created_at, id)`, limite 1–100, cursor opaco e timestamp com microssegundos; testes cobrem isolamento e paginação. |
| FR-007 | Mock disponível somente em local e opt-in | Pass com follow-up | `loadConfig` rejeita flag fora de `APP_ENV=local`; default é `false`. O override testável do módulo descrito na seção de achados consegue contornar o gate se usado por outro compositor. |
| FR-008 | Falhas controladas sem sucesso prematuro | Pass | Sucesso retorna após commit; saldo insuficiente, conflito e indisponibilidade têm mapeamentos `402`, `409` e `503`; teste verifica `503` sanitizado. |
| NFR-001 | Centavos inteiros, lock e saldo não negativo | Pass | Validação de inteiro seguro e débito sob lock/condição de saldo no serviço financeiro existente. |
| NFR-002 | Atomicidade, persistência e retomada sem segundo movimento | Pass | Migration/payout persistidos; conclusão altera apenas status/data; testes verificam saldo e ledger invariantes. |
| NFR-003 | Autorização, isolamento e logs contidos | Pass | Schemas estritos, ownership autenticado, `no-store`, erro uniforme; logs omitem jogador, valor e chave. |
| NFR-004 | Simulação local identificada, sem transferência externa | Pass com follow-up | DTO inclui `simulated: true`, não há integração com provedor e rotas dependem da flag; mesma ressalva do override do módulo em FR-007. |

## Verificação de tarefas

| Tarefa | Estado | Evidência / observações |
|---|---|---|
| T1 — Schema e migration | Pass | Migration `0003_local_payouts`, constraints de origem/direção e `checkSchema`; cobertos por teste PostgreSQL e verificação de migration. |
| T2 — Pedido idempotente | Pass | `requestPayout` e testes de replay, conflito, saldo insuficiente, concorrência e rollback. |
| T3 — Status e histórico | Pass | Consultas por proprietário e cursor keyset; testes de ownership, ordenação e estabilidade. |
| T4 — Worker e recuperação | Pass | Startup, timer/reentrância, retry e fechamento cobertos em `financial.module.test.ts`; serviço não altera saldo ou ledger ao concluir. |
| T5 — API e gate local | Pass com follow-up | Rotas, validação, autenticação, configuração, Compose e fluxo composto conferidos. O gate pode ser contornado pelo override interno público em um compositor não canônico. |

## Verificação do design

| Área / decisão | Estado | Observações |
|---|---|---|
| TD-001 — Uma transação para débito, ledger e payout | Pass | O payout é inserido pelo efeito transacional de `applyOperation`; falha de insert reverte a operação inteira. |
| TD-002 — Worker local recuperável | Pass | Due date persistido; varredura imediata e periódica; condição SQL permite somente transição a partir de `processing`. |
| TD-003 — Flag local fail-closed | Pass com follow-up | A configuração carregada protege o composition root real; o override público da opção do módulo enfraquece a garantia para outros chamadores. |
| TD-004 — Rotas e idempotência | Pass | Contratos `/payouts`, chave UUID no header, replay de estado atual e conflito `409`. |
| TD-005 — Cursor keyset | Pass | Página ordenada por timestamp/ID, cursor opaco e limite máximo de 100. |
| Segurança e privacidade | Pass | Validação estrita, autenticação, filtros de proprietário, `no-store` e logs sem os dados sensíveis definidos no design. |
| Migration e rollout | Pass | Migration aditiva, Compose local opt-in e config que rejeita flag ligada fora de local. |

## Qualidade do código

- [x] Segue a arquitetura do módulo `financial` e mantém `server.ts` como composition root.
- [x] Reutiliza o caminho transacional existente em vez de duplicar regras de débito.
- [x] Trata validação, saldo insuficiente, conflito, ausência e indisponibilidade com respostas controladas.
- [x] Tipos e unidades monetárias permanecem em centavos inteiros; a serialização só recebe valores validados como seguros.
- [x] Autorização e privacidade cobertas; não há UI nesta spec, portanto acessibilidade visual não se aplica.
- [ ] Gate do mock é invariável também no contrato público do módulo; ver achado de baixa severidade.
- [x] Worker é pequeno, recuperável e não introduz provedor, fila ou camada desnecessária.

## Verificação executada

```text
Command: /Users/sergiobanhos/.nvm/versions/node/v22.18.0/bin/bun run typecheck (cwd: operator)
Exit code: 0
Summary: TypeScript sem erros.
Verdict: PASS

Command: /Users/sergiobanhos/.nvm/versions/node/v22.18.0/bin/bun run test:e2e (cwd: operator)
Exit code: 0
Summary: PostgreSQL temporário isolado; 153 testes passaram, 0 falharam, 899 expectativas.
Verdict: PASS

Command: docker compose config --quiet (cwd: repository root)
Exit code: 0
Summary: Configuração Compose atual válida, incluindo as alterações locais presentes durante esta revisão.
Verdict: PASS

Command: Revisão manual de `.ai/sdd/specs/005-payout/requirements.md`, `design.md`, `tasks.md` e do código listado em T1–T5
Exit code: N/A
Summary: FR-001–FR-008, NFR-001–NFR-004, critérios de tarefa e decisões TD-001–TD-005 comparados com implementação e testes.
Verdict: PASS WITH FOLLOW-UP
```

## Achados

### Achado 1 — Override do módulo pode habilitar o mock fora de local

- **Severidade:** Baixa
- **Arquivo:** `operator/src/modules/financial/financial.module.ts:24-43`
- **Problema:** `createFinancialModule` aceita `payoutMockEnabled` como override e o usa diretamente para registrar as rotas e iniciar o worker. Um chamador que forneça `true` junto a uma configuração `APP_ENV=test` ou `production` pode habilitar o mock, apesar do guard em `loadConfig`. O composition root atual não envia esse override e continua protegido; o risco está em outros usos do contrato público do módulo.
- **Impacto:** FR-007, NFR-004 e TD-003; não reproduzido no composition root de produção/local atual.
- **Correção sugerida:** remover o override e criar configurações locais habilitadas nos testes, ou validar no próprio módulo que `config.appEnv === 'local'` antes de aceitar um override `true`.

## Parecer

- [ ] Aprovado
- [x] Aprovado com follow-up
- [ ] Precisa de correções

Os requisitos Must Have passam no fluxo oficial montado por `buildOperatorApp`; typecheck, suíte PostgreSQL e Compose passaram. O único follow-up é endurecer o contrato programático do módulo contra habilitação explícita fora de local. Esse ponto não bloqueia QA da integração atual.
