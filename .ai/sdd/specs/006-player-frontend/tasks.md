# Tarefas: Interface inicial do jogador (F06)

> Requirements: @requirements.md
> Design: @design.md
> Status: Approved

## Cobertura dos requisitos

| Requisito | Tarefas | Observações |
|---|---|---|
| FR-001 | T1, T2 | Transporte autenticado, cadastro, login, restauração e logout. |
| FR-002 | T2, T3, T5, T6 | Reidratar identidade, carteira, bets/comandos e payouts por REST. |
| FR-003 | T4 | SSE do operador é a fonte global da rodada. |
| FR-004 | T4, T5 | Estado stale congela o snapshot e desabilita mutações até novo snapshot sincronizado. |
| FR-005 | T5 | Comandos usam chave idempotente estável e não repetem mutação desconhecida às cegas. |
| FR-006 | T5 | Recuperação pessoal usa lista de bets e consultas de comando/bet. |
| FR-007 | T3 | Saldo e ledger confirmados pelo operador; top-up local idempotente. |
| FR-008 | T6 | Payout usa contrato implementado de F05; esta task depende da conclusão de F05. |
| FR-009 | T1, T2, T3, T5, T6 | Erros por operação, preservação de estado confirmado, expiração e cleanup. |
| FR-010 | T4 | Painel diagnóstico local recolhido, seguro e limitado a 100 eventos. |
| FR-011 | T7 | Prova da rodada calculada no navegador com o algoritmo do engine; sem expor seed de rodada aberta. |
| NFR-001 | T3, T5, T6 | Parsing monetário decimal exato; requests enviam centavos inteiros. |
| NFR-002 | T4, T5 | Saúde upstream/downstream distinta e controles bloqueados durante estado stale. |
| NFR-003 | T1, T2, T4, T5, T6 | Mesmo origin via operador; sem segredos, tokens em URL/logs ou `playerId` escolhido pelo browser. |
| NFR-004 | T2, T3, T4, T5, T6 | Rótulos, erros, loading, teclado, texto além de cor e viewport estreito. |
| NFR-005 | T3, T6 | Top-up e payout identificados como operações locais de teste. |

## Verificação de prontidão para implementação

| Verificação | Estado | Observações |
|---|---|---|
| Todos os requisitos Must Have têm tarefa | Pass | FR-001–FR-009 e NFR-001–NFR-005 estão mapeados. FR-010, Should Have, também tem cobertura. |
| Requisitos estão cobertos pelo design | Pass | O design aprovado define telas, fluxos REST/SSE, erros, idempotência, recuperação, Mantine e ownership de estado. |
| Perguntas críticas estão respondidas | Pass | Q-001 está respondida; payout foi incluído e seu contrato está no design aprovado F05. |
| Tarefas têm dependências, critérios, arquivos e verificação | Pass | T1–T6 listam cada item; T6 explicita a dependência externa de F05. |
| Comandos de verificação são conhecidos | Pass | `client/package.json` já define `bun run typecheck`, `bun test` e `bun run build`; a validação completa com Compose é manual. |
| Dependências externas estão prontas | Parcial | F05 está em implementação. T1–T5 podem avançar; T6 e a validação completa do payout aguardam as rotas F05 e seu mock local habilitado. |

## Fatias de implementação

### Fatia 1 — Client autenticado e jogável

- **Objetivo:** permitir cadastro/login, acompanhar a rodada, consultar carteira e realizar/recuperar ações de jogo.
- **Histórias:** US-001–US-005 e US-007.
- **Tarefas:** T1–T5.
- **Validação independente:** testes do client, build e fluxo local de cadastro, reload, top-up, aposta/cashout e reconexão, sem depender de payout.

### Fatia 2 — Payout local e fluxo completo

- **Objetivo:** solicitar e acompanhar payout real da API local, sem simulação no browser.
- **Histórias:** US-006.
- **Tarefas:** T6.
- **Dependência:** F05 com as rotas implementadas e habilitadas no Compose local.
- **Validação independente:** solicitar payout, confirmar débito/histórico, acompanhar `processing` → `done`, recarregar e recuperar o mesmo registro.

### Fatia 3 — Prova da rodada

- **Objetivo:** conferir o compromisso e recalcular o resultado de uma rodada finalizada no navegador.
- **Histórias:** US-008.
- **Tarefas:** T7.
- **Validação independente:** vetores do engine reproduzidos pelo módulo do client e rodada real conferida na tela.

## T1 — Preparar UI, transporte tipado e proxy local

**Prioridade:** P0  
**Estimativa:** 2h  
**Dependências:** nenhuma  
**Cobre:** FR-001, FR-009, NFR-003, NFR-004, TD-001, D-003

### Trabalho

- [x] Instalar `@mantine/core`, `@mantine/hooks`, `@mantine/form` e `@mantine/notifications` em versões alinhadas; configurar estilos e `MantineProvider` no ponto de entrada.
- [x] Criar `operator-api.ts` para chamadas same-origin tipadas, `Authorization: Bearer` quando autenticado, leitura segura do envelope `{ error: { code, message } }` e respostas sem corpo como `204`.
- [x] Distinguir erro HTTP conhecido, erro de rede e resposta inválida sem mostrar o corpo bruto, stack trace, token ou senha.
- [x] Configurar o proxy Vite para `/auth`, `/wallet`, `/game` e `/payouts` com destino somente ao operador definido por `OPERATOR_URL`; manter a engine inacessível ao browser.
- [x] Atualizar o comentário do serviço `client` no Compose para refletir a aplicação de jogador local autenticada, mantendo o bind em loopback.

### Critérios de aceitação

- [x] `main.tsx` renderiza sob `MantineProvider` com os estilos oficiais e o build segue em React 19 + Vite + TypeScript.
- [x] Todas as chamadas REST e SSE usam caminhos relativos do operador; nenhum endereço/chave da engine entra no bundle ou nas requests do browser.
- [x] O client trata `204` sem tentar parsear JSON e converte o envelope de erro em erro tipado seguro.
- [x] Não é introduzido React Query nem outra camada global de cache; chamadas ficam no client simples definido pelo design.

### Arquivos

- `client/package.json` e `client/bun.lock` — dependências Mantine.
- `client/src/main.tsx` — provider e imports de estilo.
- `client/src/operator-api.ts` — criar transporte e tipos compartilhados.
- `client/src/operator-api.test.ts` — parsing de sucesso, `204`, erros e request autenticada.
- `client/vite.config.ts` — proxy para as rotas do operador.
- `docker-compose.yml` — comentário do serviço client.

### Verificação

- [x] `cd client && bun run typecheck`.
- [x] `cd client && bun test` cobre parsing de resposta/erro e header de auth sem registrar credenciais.
- [x] `cd client && bun run build`.
- [x] Manual: com `docker compose up --build`, abrir o client e confirmar que uma chamada relativa chega ao operador; conferir no browser que nenhuma chamada vai direto à engine.

## T2 — Cadastro, login, retomada e logout

**Prioridade:** P0  
**Estimativa:** 2h  
**Dependências:** T1  
**Cobre:** FR-001, FR-002, FR-009, NFR-003, NFR-004, D-002

### Trabalho

- [x] Implementar estados de boot (`checking-session`, `unauthenticated`, `authenticated`) em `App.tsx`; validar token do `sessionStorage` por `/auth/me` antes de mostrar dados pessoais.
- [x] Criar a tela de login/cadastro com nome, email e senha, alternância entre modos, erros inline, loading e bloqueio de submissões repetidas.
- [x] Após `POST /auth/register`, iniciar login com os mesmos dados; se login falhar, informar que a conta foi criada e manter acesso ao modo login.
- [x] Em `401` no boot, remover token e pedir login; em erro transitório, preservar token e oferecer retry sem descartar uma sessão válida.
- [x] No logout, chamar `/auth/logout`, limpar o token e desmontar a tela de jogo mesmo se o operador estiver indisponível; mostrar quando o encerramento remoto não foi confirmado.

### Critérios de aceitação

- [x] Login guarda o token opaco somente no `sessionStorage`; reload consulta `/auth/me` antes de renderizar a aplicação autenticada.
- [x] Cadastro seguido de login abre o app; falha no login posterior ao cadastro não perde a indicação de conta criada.
- [x] Erros de validação, email em uso, credenciais inválidas, rate limit e indisponibilidade têm mensagens acionáveis sem revelar detalhes internos.
- [x] Logout sempre encerra recursos da tela e remove a credencial local; o stream da tela de jogo fecha ao desmontar.
- [x] Formulários têm labels, navegação por teclado e estado de envio perceptível sem depender só de cor.

### Arquivos

- `client/src/App.tsx` — boot de sessão e shell autenticado.
- `client/src/auth-screen.tsx` — criar login e cadastro.
- `client/src/operator-api.ts` — operações e tipos de auth.
- `client/src/operator-api.test.ts` — cenários de sessão/401 se forem funções puras do client.

### Verificação

- [x] `cd client && bun run typecheck && bun test && bun run build`.
- [x] Manual: cadastrar, entrar, recarregar com sessão, expirar/remover a sessão e sair com operador disponível e indisponível.

## T3 — Carteira, top-up de teste e histórico

**Prioridade:** P0  
**Estimativa:** 3h  
**Dependências:** T1, T2  
**Cobre:** FR-002, FR-007, FR-009, NFR-001, NFR-004, NFR-005

### Trabalho

- [x] Criar `wallet-screen.tsx` para carregar saldo e `GET /wallet/transactions`, renderizar histórico próprio e paginação por `nextCursor`.
- [x] Criar conversão de texto USD → centavos por parsing decimal estrito; rejeitar zero, negativos, mais de duas casas, notação exponencial e valores fora da faixa segura.
- [x] Implementar top-up com `POST /wallet/top-ups`, header `Idempotency-Key` e persistência da chave/valor da tentativa pendente no `sessionStorage` para retry sem duplicar crédito.
- [x] Após confirmação/replay confirmado, atualizar saldo e primeira página do ledger pelo operador; durante timeout, manter o saldo confirmado e oferecer retry com a mesma chave.
- [x] Identificar permanentemente o saldo e o top-up como teste local e manter saldo/valor monetário legíveis em viewport estreito.

### Critérios de aceitação

- [x] `$12.34` vira `1234` cents sem aritmética de ponto flutuante; entradas inválidas não chegam ao endpoint.
- [x] Saldo e ledger só mudam visualmente com respostas do operador; retry da mesma operação reutiliza chave e valor.
- [x] Histórico respeita cursor e escopo da identidade autenticada; “carregar mais” só aparece quando houver página seguinte.
- [x] `401`, saldo/limite recusado e indisponibilidade não aparentam sucesso nem apagam o último saldo confirmado.

### Arquivos

- `client/src/wallet-screen.tsx` — criar consulta e formulário de top-up.
- `client/src/money.ts` e `client/src/money.test.ts` — parsing/formatting exatos de centavos.
- `client/src/operator-api.ts` — tipos e chamadas de carteira.

### Verificação

- [x] `cd client && bun run typecheck && bun test && bun run build`.
- [x] Testar valores válidos/inválidos e paginação; manualmente repetir top-up após resposta perdida e confirmar saldo/ledger sem crédito duplicado.

## T4 — Rodada ao vivo, estado stale e diagnóstico da stream

**Prioridade:** P0  
**Estimativa:** 2h  
**Dependências:** T1, T2  
**Cobre:** FR-003, FR-004, FR-010, NFR-002, NFR-003, NFR-004

### Trabalho

- [x] Criar `game-screen.tsx` e mover/ampliar a apresentação React existente para incluir fase, multiplicador, roundId, saúde upstream/downstream e navegação Jogo/Carteira.
- [x] Manter o `operator-events.client.ts` como reducer SSE, preservando dedupe/ordenação por `seq`, round monotônico e buffer de no máximo 100 eventos.
- [x] Representar reconexão do `EventSource` como stale desde o erro até receber um novo snapshot com upstream `connected`; `onopen` sozinho não pode reabilitar comandos usando snapshot velho.
- [x] Congelar o último snapshot com rótulo textual e expor carregando/reconectando/sincronizando; ocultar qualquer aparência de live enquanto downstream/upstream não estiverem sincronizados.
- [x] Manter painel diagnóstico recolhido por padrão, com eventos recentes, `roundId`, `seq` e estados de conexão, sem token, segredos, sessão Crashsim ou dados pessoais.

### Critérios de aceitação

- [x] Browser consome somente `GET /game/events` do operador; novo snapshot substitui a rodada atual e não afirma replay dos eventos perdidos.
- [x] Ao cair e reabrir a SSE, o multiplicador antigo fica congelado e ações continuam bloqueadas até o snapshot sincronizado chegar.
- [x] Tick atrasado após crash não reabre a rodada nem altera o multiplicador terminal; eventos duplicados/antigos não fazem a sequência retroceder.
- [x] Diagnóstico permanece limitado aos 100 eventos mais recentes e não revela credenciais nem estado de outro jogador.

### Arquivos

- `client/src/App.tsx` — navegação Jogo/Carteira e ciclo de vida da tela.
- `client/src/game-screen.tsx` — criar tela de jogo e saúde de conexão.
- `client/src/operator-events.client.ts` — sincronização após reconnect, parsing/reducer e buffer.
- `client/src/operator-events.client.test.ts` — snapshot pós-reconnect, tick após crash, dedupe e limite 100.

### Verificação

- [x] `cd client && bun run typecheck && bun test && bun run build`.
- [x] Exercitar queda/reconexão; repetir localmente com `DROP_WS_EVERY=8 REORDER=1 docker compose up --build` e confirmar congelamento e recuperação por snapshot.

## T5 — Aposta, cashout e recuperação de estado pessoal

**Prioridade:** P0  
**Estimativa:** 4h  
**Dependências:** T2, T3, T4  
**Cobre:** FR-002, FR-004, FR-005, FR-006, FR-009, NFR-001, NFR-002, NFR-003, NFR-004

### Trabalho

- [x] Ao entrar em Jogo, chamar `POST /game/session`; buscar `GET /game/bets?limit=10` após login/reload e apresentar tentativas, bets e settlement em campos distintos.
- [x] Implementar formulário de aposta com valor em centavos inteiros e `autoCashout` validado em centésimos; habilitar somente com snapshot sincronizado, fase `betting` e sem tentativa aceita/desconhecida conflitante para a rodada.
- [x] Implementar cashout somente para bet própria `active` com rodada `running` e stream sincronizada; usar uma chave por comando lógico e bloquear double-click/Enter repetido.
- [x] Para `202`, timeout ou resposta insuficiente, mostrar estado desconhecido e consultar lista/comando/bet por GET com backoff limitado; não repetir criação com uma nova chave nem enviar POST novo às cegas.
- [x] Após resposta confirmada, atualizar saldo e bets via REST; mostrar separadamente status da bet e `settlementStatus`, com consulta manual quando o crédito continuar pendente.
- [x] Tratar `402`, fase incompatível, bet já existente, sessão expirada e engine/operator indisponíveis por mensagens distintas, sem alterar otimisticamente o saldo.

### Critérios de aceitação

- [x] Aposta e cashout ficam indisponíveis durante estado stale, mutação em andamento ou estado de bet/comando incompatível.
- [x] Reload recupera bets e comandos da API e não exige `betId` ou estado guardado somente em memória do browser.
- [x] Comando desconhecido permanece visível e só usa consultas de leitura; timeout não cria novo comando nem gera uma nova chave para contornar o estado.
- [x] Cashout aceito com crédito pendente aparece como jogo confirmado e settlement pendente, sem repetir o cashout.
- [x] Requests não enviam `playerId`, saldo local não autoriza mutações e valores não usam conversão monetária com float.

### Arquivos

- `client/src/game-screen.tsx` — controles, status da bet e apostas recentes.
- `client/src/operator-api.ts` — tipos e operações REST de sessão, bet, cashout e consulta.
- `client/src/money.ts` — validação/formatação usada pelos comandos.
- `client/src/operator-events.client.test.ts` — gates stale em conjunto com a tela/reducer, quando testáveis como estado puro.

### Verificação

- [x] `cd client && bun run typecheck && bun test && bun run build`.
- [x] Manual com operador/engine locais: apostar, impedir duplicidade, recarregar a página, consultar comando desconhecido e realizar cashout com settlement pendente.
- [x] Exercitar saldo insuficiente, rodada encerrada e reconexão; confirmar que o saldo exibido vem do operador.

## T6 — Integrar payout local ao histórico da carteira

**Prioridade:** P0  
**Estimativa:** 3h  
**Dependências:** T3; F05 deve estar `implementation:done` e as rotas de payout disponíveis no ambiente local.  
**Cobre:** FR-002, FR-008, FR-009, NFR-001, NFR-003, NFR-004, NFR-005, D-001

### Trabalho

- [x] Adicionar ao `wallet-screen.tsx` o formulário de payout e histórico usando exatamente o contrato aprovado em `.ai/sdd/specs/005-payout/design.md`; não criar mocks nem estado de sucesso local.
- [x] Antes de `POST /payouts`, persistir `{ idempotencyKey, amount }` em `sessionStorage`; retry após timeout usa a mesma chave e valor para recuperar o mesmo payout.
- [x] Depois de `201`, mostrar referência, valor, `processing`, timestamps e `simulated: true`; consultar por ID após 1s, 2s e 4s, encerrar polling automático e oferecer atualização manual.
- [x] No reload, buscar `GET /payouts?limit=50&cursor=...`, manter um item por ID e consultar itens `processing`; atualizar saldo/ledger a partir do operador após confirmar o débito.
- [x] Distinguir `402` terminal para aquela chave, `409` de chave/conteúdo, `503` pré-commit, timeout ambíguo, `GET /payouts` 404 (mock indisponível) e `GET /payouts/:id` 404 (item ausente/alheio).
- [x] Manter indicação visível de simulação local no formulário e em cada status/histórico; após top-up, tentativa recusada por saldo usa chave nova.

### Critérios de aceitação

- [x] A UI só apresenta sucesso/status quando confirmado pela API persistida; `done` nunca é inferido por timer local.
- [x] Timeout não debita/cria outro payout em retry; mesma chave e mesmo valor recuperam a operação original.
- [x] Reload recupera payouts e paginação sem duplicar entradas, inclusive para item ainda `processing`.
- [x] Mock desabilitado aparece como indisponível e não permite envio; 404 de item não é confundido com mock desabilitado.
- [x] Payout e top-up enviam centavos inteiros exatos e nenhum endpoint aceita `playerId` da interface.

### Arquivos

- `client/src/wallet-screen.tsx` — criar solicitação e painel/histórico de payout.
- `client/src/operator-api.ts` — tipos e métodos de payout do contrato F05.
- `client/src/money.ts` — validação e exibição de valores.
- `client/src/operator-api.test.ts` — replay com chave estável e mapeamento dos erros payout.

### Verificação

- [x] `cd client && bun run typecheck && bun test && bun run build`.
- [x] Com F05 implementada e mock local ativo, validar top-up → payout parcial → `processing` → `done`, consulta após reload, retry com mesmo key e histórico sem duplicatas.
- [x] Confirmar que o saldo cai somente conforme a resposta do operador e que toda confirmação mostra “simulação local”.

## T7 — Prova da rodada (provably fair)

**Prioridade:** P1
**Estimativa:** 1.5h
**Dependências:** T4 (estado global e painéis recolhidos)

### Trabalho

- [x] Criar `client/src/fairness.ts` espelhando `engine/src/fair.js`: `commitmentMatches` (SHA-256), `crashPointFromDigest` (primeiros 52 bits + aritmética BigInt) e `reproduceCrashPoint` (HMAC-SHA256 do seed sobre o roundId), tudo com Web Crypto.
- [x] Combinar as checagens em `verifyRound`, devolvendo compromisso e resultado como `match | mismatch | unavailable` e o valor recalculado em centésimos.
- [x] Reter a última rodada revelada no reducer (`lastRevealed`), preservando o compromisso publicado antes da rodada mesmo quando o `round.betting` seguinte substitui o snapshot.
- [x] Adicionar o painel recolhido "Prova da rodada" na tela de jogo: compromisso da rodada atual, seed revelado, ponto de crash, selos de compromisso/resultado, alerta de divergência e "Verificar novamente".
- [x] Nunca exibir nem solicitar seed de rodada aberta; a prova é somente leitura e não decide aposta, cashout ou crédito.

### Critérios de aceitação

- [x] A rodada em aberto mostra apenas o compromisso (`serverSeedHash`).
- [x] Depois do crash, a prova mostra seed, ponto de crash e os dois selos, verificando automaticamente.
- [x] Divergência aparece como alerta vermelho com o roundId; dados ausentes aparecem como "indisponível", nunca como sucesso.
- [x] A prova continua visível depois que a rodada seguinte começa.
- [x] O recálculo não envia nada ao operador e não altera estado financeiro.

### Arquivos

- `client/src/fairness.ts`
- `client/src/fairness.test.ts`
- `client/src/operator-events.client.ts`
- `client/src/operator-events.client.test.ts`
- `client/src/game-screen.tsx`

### Verificação

- [x] `cd client && bun run typecheck && bun test && bun run build`.
- [x] Testes com vetores gerados pelo engine: seed `c…` → 9.98x; digest divisível por 100 → exatamente 1; segundo vetor → 2.96x; digest extremo reproduzido igual ao engine.
- [x] Rodada real do Compose conferida na tela: seed revelado reproduziu o ponto de crash exibido (`compromisso=match resultado=match recalculado=248` para 2.48x).

## Ordem e dependências

```text
T1 → T2 → T3 → T4 → T5
          └────────────→ T6 (aguarda também F05 implementation:done)
T4 → T7 (reaproveita o snapshot e os painéis recolhidos)
```

T4 pode ser implementada depois de T2, em paralelo com T3. T5 requer estado global, carteira e sessão autenticada. T6 pode ser implementada após T3, mas sua integração verificável aguarda a API F05. O fluxo completo local só fica pronto depois de T1–T6 e F05.

## Evidências de execução (F06)

Data: 2026-10-05. Stack: `docker compose` local (engine, operator, client em `:5173`, postgres).

- Verificação automatizada: `cd client && bun run typecheck` (0 erros), `bun test` (51 pass / 0 fail), `bun run build` (build ok).
- T1: `POST /auth/register` e `GET /auth/me` respondem pelo proxy do client em `:5173`; o bundle (`dist/assets/*.js`) não contém `dev-operator-key`, `dev-webhook-secret`, `ENGINE_OPERATOR_KEY`, `WEBHOOK_SECRET`, `localhost:4000`, `/rounds/current` nem `x-operator-key`, e as rotas são relativas.
- T2/T3: cadastro → login → `/auth/me`; top-up de `50.00` → `201` com `balance: 5000`; replay com a mesma chave devolveu o mesmo `transactionId`; mesma chave com outro valor → `409 IDEMPOTENCY_CONFLICT`.
- T4: captura real de SSE sob `DROP_WS_EVERY=8 REORDER=1` alimentada no reducer do client: 7 ciclos de congelamento e 7 recuperações em `connection:connected`, terminando sincronizado; queda apenas do stream do browser mantém o estado congelado até chegar o snapshot novo.
- T5: `POST /game/bets` `201 accepted` (10.00); replay com a mesma chave devolveu o mesmo `commandId`; segunda aposta na mesma rodada → `409 BET_ALREADY_EXISTS`; `POST /game/bets/:id/cashout` `200` com `engineStatus: cashed_out`, `multiplierHundredths: 101`, `payoutCents: 1010` e `settlementStatus: pending`, creditado depois no ledger.
- T6: `POST /payouts` `201 processing` (`simulated: true`) → `done` após ~5s com `completedAt`; replay com a mesma chave devolveu o mesmo payout; mesma chave com outro valor → `409`; saque acima do saldo → `402 INSUFFICIENT_FUNDS`; ledger registrou `debit/payout`; `GET /payouts?limit=50` respondeu `200` e, com `PAYOUT_MOCK_ENABLED=false` (override de Compose em `/tmp`), `404` sem envelope — o caso que a UI trata como mock indisponível.
- T7: vetores do próprio engine reproduzidos pelo módulo do client (9.98x, 2.96x, borda = 1, digest extremo) e rodada real do Compose conferida de ponta a ponta: compromisso e resultado `match`, recalculado `2.48x`.
- Correção durante a execução: o sinal de sincronização do client passou a considerar o `snapshot` como autoritativo e `connection:connected` como fim do resync; antes disso, o aviso "Estado não sincronizado" ficava permanente após qualquer queda do upstream (comportamento reproduzido e corrigido com os frames reais do operador).
- Correção vinda da revisão de F06: a chave idempotente só é liberada em recusas garantidamente pré-commit (`isTerminalRefusal`). `POST /payouts` grava o débito e relê a linha depois; falha nessa releitura vira 503 pós-commit, e a regra anterior (limpar a chave em qualquer erro HTTP) permitiria uma segunda solicitação com chave nova depois de um débito já efetivado.

