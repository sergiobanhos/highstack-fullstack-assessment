# Design: Interface inicial do jogador (F06)

> Status: Approved
> Feature directory: `.ai/sdd/specs/006-player-frontend/`
> Requisitos: `.ai/sdd/specs/006-player-frontend/requirements.md`

## 1. Objetivo e limite

Trocar a página de diagnóstico puro por uma interface React funcional para os fluxos já definidos. O client continua falando somente com o operador. A tela usa REST para identidade, carteira e estado pessoal das bets; a SSE atual fica restrita à rodada global e à saúde da stream.

O saque local aparece na UX e usa o contrato documentado no design aprovado de F05. A implementação da API está em andamento e deve estar disponível antes da task de integração de payout em F06. Não criar mocks que pareçam operações persistidas nem alterar os endpoints definidos por F05 sem atualizar aquela spec.

## 2. Mapa de fluxos

### 2.1 Primeiro acesso e autenticação

1. Abrir a tela de acesso no modo “Entrar”.
2. Alternar para “Criar conta”, enviar nome/email/senha e apresentar validações e erros inline.
3. Após cadastro, chamar login com os mesmos dados. Se login falhar depois do cadastro, explicar que a conta foi criada e manter o modo “Entrar”.
4. Após login, guardar o token opaco na sessão da aba, obter o usuário por `/auth/me` e abrir o jogo.
5. Logout chama o operador, encerra a SSE, remove a credencial da aba e volta à tela de acesso. Mesmo se a chamada falhar, a UI limpa a credencial local e informa que não conseguiu confirmar o logout remoto.

### 2.2 Retorno após reload

1. Ler a credencial da sessão da aba; se não existir, abrir autenticação.
2. Consultar `/auth/me`. `401` remove a credencial e pede login novamente; indisponibilidade mostra retry sem descartar uma sessão potencialmente válida.
3. Buscar `/wallet` e `/game/bets?limit=10`.
4. Ao entrar em “Jogo”, chamar `/game/session` e abrir `/game/events`.
5. Usar o snapshot SSE para a rodada atual e REST para os estados pessoais de aposta e liquidação. SSE não é replay histórico nem feed de carteira.

### 2.3 Aposta e cashout

1. Aposta habilitada somente com SSE aberta, upstream `connected`, snapshot recebido, fase `betting` e sem bet aceita/desconhecida incompatível na rodada.
2. Validar valor e auto-cashout localmente; enviar centavos inteiros e uma chave UUID por ação lógica.
3. Durante envio, desabilitar o botão. Após sucesso/recusa, atualizar a carteira e a lista de bets pelo operador.
4. Para cashout, exigir bet própria `active`, rodada `running` e conexão sincronizada. Repetir a mesma ação/retry com a mesma chave.
5. Em `202`/resultado desconhecido, mostrar “Verificando resultado” e consultar o comando/bet por REST com backoff limitado; não enviar novo POST automaticamente.
6. Após cashout confirmado, mostrar separadamente o status do jogo e `settlementStatus`. Se o crédito estiver `pending`, continuar consultas de leitura espaçadas e permitir atualização manual.

### 2.4 Carteira e payout

1. Mostrar saldo confirmado pelo operador.
2. Top-up local: validar USD em duas casas, converter exatamente para centavos e enviar `Idempotency-Key`. Atualizar saldo e histórico apenas após resposta confirmada; retry usa a mesma chave.
3. Exibir movimentações do ledger em ordem recente, com paginação via cursor.
4. Payout: enviar `POST /payouts` com `Idempotency-Key` UUID e `{ amount }` em centavos inteiros. Em `201`, guardar `id`, `amountCents`, `currency`, `status`, timestamps e `simulated` retornados pelo operador; o client não marca `done` por temporizador local.
5. Para uma resposta aceita, consultar `GET /payouts/:payoutId` enquanto `status=processing`; F05 não envia atualização pela SSE. Como a simulação dura cinco segundos e o processador verifica a cada 500 ms, consultar após 1s, 2s e 4s; se ainda estiver `processing`, parar o polling automático e oferecer atualização manual.
6. Ao abrir/recarregar a carteira, carregar `GET /payouts?limit=50&cursor=...`; mostrar o mesmo payout com `processing` ou `done`, sem duplicar entrada. Consultar os itens `processing` por ID seguindo a mesma política curta de polling. `done` e `simulated: true` significam somente conclusão do mock.
7. Antes do POST, guardar `{ idempotencyKey, amount }` como comando payout pendente em `sessionStorage`. Em timeout/perda de resposta, repetir o mesmo POST com a mesma chave e payload; o replay recupera o mesmo payout/status. Remover o comando local após resposta conclusiva. Uma recusa `402` fica associada àquela chave; após top-up, uma nova tentativa usa chave nova.
8. Identificar payout como simulação local no formulário, confirmação, status e histórico. O valor debitado fica indisponível para apostas conforme F05.

### 2.5 Reconexão da stream

- `reconnecting` ou `synchronizing`: manter o multiplicador na tela, marcá-lo como congelado/desatualizado e bloquear bet/cashout.
- Ao receber novo snapshot sincronizado, substituir a rodada apresentada, reconciliar visualmente os controles com o novo estado e só então habilitar ações compatíveis.
- Não exibir eventos perdidos como se tivessem sido reproduzidos; o snapshot recupera apenas o estado corrente.
- Erro SSE downstream também deixa a tela sem garantia de atualização e mantém ações desabilitadas.

## 3. Protótipos ASCII

São wireframes funcionais, sem definir cores, tipografia final, ilustração ou animação.

### 3.1 Entrar

```text
┌──────────────────────────────────────────────────────────────┐
│ Crashsim                                      Ambiente local │
│                                                              │
│                         Bem-vindo                            │
│                    [ Entrar ] [ Criar conta ]                │
│                                                              │
│ Email                                                        │
│ [________________________________________________________]   │
│ Senha                                                        │
│ [________________________________________________________]   │
│                                                              │
│ [ Entrar ]                                                    │
│                                                              │
│ Credenciais inválidas / serviço indisponível aparecem aqui.  │
│ Ainda não tem conta? Criar conta                             │
└──────────────────────────────────────────────────────────────┘
```

### 3.2 Criar conta

```text
┌──────────────────────────────────────────────────────────────┐
│ Crashsim                                      Ambiente local │
│                                                              │
│                   [ Entrar ] [ Criar conta ]                 │
│ Nome                                                         │
│ [________________________________________________________]   │
│ Email                                                        │
│ [________________________________________________________]   │
│ Senha                                                        │
│ [________________________________________________________]   │
│ Use uma senha com pelo menos 12 caracteres.                  │
│                                                              │
│ [ Criar conta e entrar ]                                      │
│ Erros aparecem junto ao campo ou nesta área.                 │
└──────────────────────────────────────────────────────────────┘
```

### 3.3 Jogo — estado sincronizado

```text
┌────────────────────────────────────────────────────────────────────────┐
│ Crashsim       [Jogo] [Carteira]           USD 125.40   Jogador [Sair] │
├────────────────────────────────────────────────────────────────────────┤
│ Engine: CONECTADA     Stream: ABERTA     Rodada: 8f2…                  │
│                                                                        │
│                              RODADA RUNNING                             │
│                                 2.34x                                  │
│                                                                        │
│ ┌ Minha aposta ─────────────────┐  ┌ Ação ──────────────────────────┐  │
│ │ Valor: $10.00                 │  │ Valor da aposta                │  │
│ │ Cashout alvo: —               │  │ [ $________________ ]          │  │
│ │ Status: Ativa                 │  │ Auto-cashout (opcional)        │  │
│ │                               │  │ [  __.__ x          ]          │  │
│ │                               │  │ [ Apostar ] [ Cashout $… ]     │  │
│ └───────────────────────────────┘  └────────────────────────────────┘  │
│                                                                        │
│ Minhas apostas recentes                                                │
│ Rodada       Valor       Jogo         Liquidação       Ação             │
│ 8f2…         $10.00      active       —                Verificar        │
│ 8e1…         $5.00       cashed_out   pending          Verificar crédito│
│                                                                        │
│ [Diagnóstico da stream ▸]                                              │
└────────────────────────────────────────────────────────────────────────┘
```

### 3.4 Jogo — conexão stale ou comando desconhecido

```text
┌────────────────────────────────────────────────────────────────────────┐
│ Crashsim       [Jogo] [Carteira]           USD 125.40   Jogador [Sair] │
├────────────────────────────────────────────────────────────────────────┤
│ ⚠ Reconectando com a engine. O estado abaixo está congelado.            │
│                                                                        │
│ Rodada: 8f2…          RUNNING (desatualizado)                           │
│ Multiplicador visto: 2.34x                                              │
│                                                                        │
│ [ Apostar — indisponível ]       [ Cashout — indisponível ]            │
│                                                                        │
│ Cashout enviado; verificando o resultado. Não envie outro comando.      │
│ Status: desconhecido             [ Consultar novamente ]                │
└────────────────────────────────────────────────────────────────────────┘
```

### 3.5 Carteira

```text
┌────────────────────────────────────────────────────────────────────────┐
│ Crashsim       [Jogo] [Carteira]           USD 125.40   Jogador [Sair] │
├────────────────────────────────────────────────────────────────────────┤
│ Minha carteira                                                        │
│ Saldo disponível                                                       │
│ $125.40 USD       Saldo e operações de teste — ambiente local          │
│                                                                        │
│ ┌ Adicionar saldo de teste ───────┐ ┌ Solicitar payout simulado ─────┐ │
│ │ Valor USD [ $___________ ]      │ │ Valor USD [ $___________ ]   │ │
│ │ [ Adicionar saldo ]             │ │ Até o saldo disponível        │ │
│ │ Crédito local; sem pagamento.   │ │ [ Solicitar saque ]           │ │
│ └────────────────────────────────┘ └─────────────────────────────────┘ │
│                                                                        │
│ [Movimentações] [Payouts]                                              │
│ Data         Tipo              Valor          Saldo após   Status       │
│ 10/05 10:20  Top-up de teste   +$100.00       $125.40      concluído    │
│ 10/05 10:14  Aposta            -$10.00        $25.40       concluído    │
│                                                                        │
│ [Carregar mais]     Payouts: referência · valor · solicitado · status  │
└────────────────────────────────────────────────────────────────────────┘
```

Em viewport estreito, a hierarquia vira uma coluna: navegação/saldo, saúde da conexão, multiplicador, aposta ativa, controles e lista. A carteira empilha os formulários e mantém saldo, tipo de operação e status legíveis.

O painel “Diagnóstico da stream” fica recolhido por padrão. No ambiente local, mostra upstream/downstream, roundId, seq e até 100 eventos recentes, sem credenciais, tokens ou dados pessoais.

## 4. Biblioteca de UI

### TD-001: Usar Mantine no client React

**Decisão proposta:** instalar `@mantine/core`, `@mantine/hooks`, `@mantine/form` e `@mantine/notifications`, mantendo os componentes visuais simples e usando a biblioteca para campos, botões, alertas, tabelas, navegação e estados de carregamento.

**Motivo:** Mantine documenta Vite como opção recomendada para SPA, oferece pacotes separados para componentes, forms e notifications, e o resolver de formulário aceita Valibot pelo padrão Standard Schema. Isso reduz CSS/componentes próprios sem exigir um trabalho de design visual nesta etapa. Manter as versões dos pacotes `@mantine/*` alinhadas.

**Alternativas:**

| Opção | Vantagem | Custo para este client |
|---|---|---|
| Mantine (proposta) | Componentes/forms/notifications integrados e bom encaixe com Vite | Adiciona estilo base e uma dependência de UI ampla |
| MUI | Biblioteca madura e compatível com React 19 | O visual Material é mais opinativo do que precisamos nesta etapa |
| Componentes próprios | Controle total e nenhuma biblioteca de UI | Mais CSS e trabalho de acessibilidade para formularios, alertas e estados |

Fontes oficiais consultadas: [Mantine com Vite](https://mantine.dev/getting-started/?g=vite), [validação de formulários com Standard Schema e Valibot](https://mantine.dev/form/schema-validation/), [instalação e suporte do MUI a React 19](https://mui.com/material-ui/getting-started/installation/).

**Implementação:** adicionar os pacotes quando os tasks F06 forem aprovados; importar os estilos no ponto de entrada e envolver o client em `MantineProvider`. Não adicionar Tailwind nem adotar um segundo sistema de componentes.

## 5. Estrutura do client e ownership de estado

Manter a aplicação pequena. Proposta inicial:

```text
client/src/
  App.tsx                         # restauração de sessão e navegação Jogo/Carteira
  main.tsx                        # MantineProvider e ponto de entrada
  operator-api.ts                 # REST tipada; Bearer e parsing de erros
  auth-screen.tsx                 # entrar/criar conta
  game-screen.tsx                 # estado de rodada, controles e apostas recentes
  wallet-screen.tsx               # saldo, top-up, ledger e payout
  operator-events.client.ts       # parser/reducer SSE existente, mantido e ampliado
```

Evitar Redux, cache framework, provider genérico de jogos e camadas de domínio no browser nesta etapa. Cada tela mantém apenas estado transitório de formulários/loading; snapshots REST/SSE são substituídos por respostas autoritativas do operador.

| Dado | Fonte de verdade | Uso no client |
|---|---|---|
| Identidade | `/auth/me` | cabeçalho, saudação e sessão autenticada |
| Sessão local do browser | token Bearer devolvido por login | `sessionStorage`; não vai em URL ou log |
| Saúde e rodada atual | SSE `/game/events` | estado global; desconectado/stale bloqueia ações |
| Saldo e ledger | `/wallet`, `/wallet/transactions` | mostrar respostas confirmadas; sem mutação otimista |
| Bet e settlement | endpoints `/game/bets*` e `/game/commands/:id` | recuperar e reconciliar dados pessoais |
| Payout | Design aprovado F05 define API; implementação em andamento | chamadas autenticadas; sem estado falso local |

O SSE atual só carrega estado global e não inclui dados da carteira nem eventos privados. O cliente conecta ao SSE quando a tela do jogo está ativa e autenticada, mas a proteção HTTP da stream para exposição pública continua sendo a obrigação descrita em F01 antes de qualquer deploy público. O escopo atual segue local.

## 6. Integração com o operador

| Fluxo | Contrato atual | Atualização visual |
|---|---|---|
| Cadastro/login/logout | `/auth/register`, `/auth/login`, `/auth/me`, `/auth/logout` | identidade só após resposta autenticada |
| Preparar jogo | `POST /game/session` | mostrar indisponibilidade sem esconder a rodada global |
| Ler rodada | SSE `/game/events` | snapshot, eventos e estados connected/reconnecting/synchronizing |
| Aposta/cashout | `POST /game/bets`, `POST /game/bets/:betId/cashout` | usar `Idempotency-Key` estável para retry da mesma ação |
| Recuperar comando | `GET /game/bets?limit=10`, `GET /game/commands/:commandId`, `GET /game/bets/:betId` | recuperar após reload e resolver estados unknown/pending |
| Carteira | `GET /wallet`, `GET /wallet/transactions`, `POST /wallet/top-ups` | recarregar após uma operação confirmada |
| Payout local | `POST /payouts`, `GET /payouts/:payoutId`, `GET /payouts?limit=50&cursor=...` conforme design aprovado F05 | só integrar após implementação de F05 |

As mensagens de erro são apresentadas por categoria funcional: dados inválidos, autenticação, saldo insuficiente, conflito de fase/estado, resultado ainda desconhecido e serviço indisponível. Não expor stack trace nem corpo bruto do engine.

### 6.1 Contrato de payout documentado em F05

O arquivo `.ai/sdd/specs/005-payout/design.md` define este contrato aprovado; a implementação F05 está em andamento:

| Operação | Request | Resposta usada pelo client |
|---|---|---|
| Criar payout | `POST /payouts`, `Idempotency-Key: <UUID>`, body `{ "amount": 500 }` em centavos inteiros | `201 { id, amountCents, currency: "USD", status: "processing", requestedAt, completedAt: null, simulated: true }`; replay retorna o mesmo `id` e status atual |
| Consultar um payout | `GET /payouts/:payoutId` | `200` com os mesmos campos e status atual (`processing` ou `done`) |
| Listar payouts | `GET /payouts?limit=50&cursor=...` | `200 { items, nextCursor }`; cada item inclui `id`, `amountCents`, `currency`, `status`, `requestedAt`, `completedAt`, `simulated` |

`limit` usa default 50, aceita 1–100; `nextCursor` é opaco. Todas as rotas autenticam o jogador e usam o usuário do token, sem `playerId` no client. `402 INSUFFICIENT_FUNDS` é uma recusa terminal para aquela chave e, após top-up, exige nova chave. `409 IDEMPOTENCY_CONFLICT` significa chave reaproveitada com valor incompatível. `503 SERVICE_UNAVAILABLE` ocorre antes do commit; permitir retry com a mesma chave e o mesmo valor. Timeout de rede pode ter resultado desconhecido; replay com a mesma chave recupera o payout existente sem novo débito.

Se `GET /payouts` retornar 404, as rotas do mock não estão registradas neste ambiente; informar indisponibilidade e desabilitar o formulário. Em `GET /payouts/:payoutId`, 404 indica payout inexistente ou de outro jogador e não deve ser apresentado como “feature desabilitada”.

## 7. Regras para valores e comandos

- O input USD aceita no máximo duas casas decimais; converter por parsing decimal para centavos inteiros, sem `parseFloat * 100` como autoridade.
- A chave UUID é criada uma vez por ação lógica. Retry mantém a mesma chave; nova tentativa após uma recusa definitiva gera nova chave.
- Bloquear botões enquanto o POST da ação está em andamento e evitar submissão por Enter duplicada.
- Após uma resposta perdida, primeiro recuperar pela lista de bets/comandos ou repetir a mesma chave apenas quando o contrato do endpoint permitir; nunca gerar nova chave para contornar `unknown`.
- Não usar saldo atual mostrado no client como autorização para apostar ou sacar; o operador revalida tudo.

## 8. Estados e falhas de UX

| Situação | Apresentação | Ação permitida |
|---|---|---|
| Sem snapshot / conexão inicial | carregando estado da rodada | nenhuma mutação |
| `reconnecting`/`synchronizing` ou SSE fechada | faixa de reconexão, valor congelado | aposta/cashout bloqueados |
| Stream conectada e fase `betting` | multiplicador/contador conforme dados disponíveis | apostar se não houver comando/bet incompatível |
| Bet POST retorna `402` | saldo insuficiente; link/CTA para carteira | nova tentativa só com nova ação após top-up e se rodada ainda aceitar bets |
| Bet/cashout `202` ou resposta perdida | “verificando resultado”, `unknown` persistente | consultas de leitura; sem novo comando |
| Cashout aceito e crédito pendente | mostrar cashout como aceito e settlement pendente em campos distintos | consultas de leitura; não repetir cashout |
| Payout `201 processing` | referência, valor, solicitação e selo `simulated: true` / “simulação local” | consultar o mesmo `payoutId`; atualizar linha existente |
| Payout `402 INSUFFICIENT_FUNDS` | erro de saldo e atalho para movimentações/top-up | nova solicitação após top-up exige nova chave |
| Payout `409 IDEMPOTENCY_CONFLICT` | informar que a solicitação conflita com uma tentativa anterior | não gerar automaticamente outra chave |
| Payout `503 SERVICE_UNAVAILABLE` | avisar que a solicitação não foi confirmada | permitir retry com a mesma chave/valor |
| Timeout/perda de resposta do POST de payout | estado desconhecido; não declarar sucesso ou falha | repetir POST com a mesma chave/valor para recuperar o mesmo payout |
| Rotas payout indisponíveis (`GET /payouts` retorna 404) | indicar que o mock não está habilitado neste ambiente; ocultar/desabilitar formulário | nenhuma tentativa de saque |
| Payout `done` | atualizar o mesmo item e mostrar data de conclusão e `simulated: true` | nenhuma nova mutação |
| Sessão de auth expirada (`401`) | limpar sessão da aba e mostrar login | não fazer retry da mutação sem reautenticar e reconciliar |
| API indisponível | erro junto ao painel, preservar último saldo confirmado | retry de leitura; mutação só após estado conhecido |
| Payout `processing` | status e aviso “simulação local” | consultar a mesma referência, sem novo débito |

Consultas de reconciliação usam backoff limitado e terminam com um controle explícito de “Consultar novamente”; não repetir POST automaticamente. Exibir a causa conhecida em texto simples e preservar `commandId`/referências somente no estado necessário à recuperação.

## 9. Segurança, privacidade e acessibilidade

- Nunca chamar `ENGINE_HTTP_URL` ou `ENGINE_STREAM_URL` do browser, nem incluir chaves da engine nos bundles, requests, erros ou logs.
- O token atual de login fica apenas no `sessionStorage` da aba para sobreviver ao reload sem persistir indefinidamente em `localStorage`; sempre validar no boot por `/auth/me`.
- Não aceitar `playerId` informado em formulários; o operador vincula REST ao token autenticado.
- Não colocar token ou senha em query, URL, storage de longo prazo ou telemetria. Remover a credencial local no logout e em resposta `401`.
- Formulários têm `label`, mensagens associadas ao campo, indicação de foco, botão com estado de loading e navegação por teclado. Status de stream/settlement usa texto além da cor.
- A tela inicial continua limitada ao ambiente local. Top-up e payout levam rótulo permanente de teste.

## 10. Requisitos → design

| Requisito | Cobertura de design |
|---|---|
| FR-001 Autenticação | §§ 2.1, 3.1–3.2, 5, 6, 9 |
| FR-002 Reidratação | §§ 2.2, 5, 6 |
| FR-003 Estado em tempo real | §§ 2.2, 2.5, 3.3–3.4, 5–6 |
| FR-004 Estado stale bloqueia ações | §§ 2.5, 3.4, 8 |
| FR-005 Bet/cashout seguros | §§ 2.3, 6–8 |
| FR-006 Recuperação e settlement | §§ 2.2–2.3, 6–8 |
| FR-007 Saldo/top-up/ledger | §§ 2.4, 3.5–6 |
| FR-008 Payout local | §§ 2.4, 3.5, 6, dependência F05 |
| FR-009 Erros/logout | §§ 2.1, 8–9 |
| FR-010 Diagnóstico local (Should Have) | §§ 3.3, 5, painel colapsado |

## 11. Verificação proposta

Executar na implementação F06, depois que a API de payout necessária estiver disponível:

- `cd client && bun run typecheck`
- `cd client && bun test`
- `cd client && bun run build`
- Fluxo integrado local com Docker Compose: cadastro/login, reload autenticado, top-up e ledger, apostar/cashout, resultado desconhecido, reconexão `DROP_WS_EVERY`/`REORDER`, payout `processing` → `done` e logout.
- Verificar manualmente viewport estreito, teclado, leitor de status em reconexão e mensagens de erro.

Testes do client cobrem parsing de dinheiro, status do formulário, reaproveitamento da chave idempotente, restauração de sessão, estados stale/connected, reconciliação e respostas de erro. A stream real não tem replay histórico; testes não devem alegar que eventos perdidos foram reproduzidos.

## 12. Riscos e mitigação

| Risco | Mitigação |
|---|---|
| API F05 ainda em implementação | depender das rotas reais antes de concluir a integração de payout; não criar sucesso fictício |
| UI interpreta saldo de forma otimista | atualizar somente por resposta/consulta do operador |
| Retry pode duplicar mutação | chaves idempotentes estáveis; estado unknown usa GET/reconciliação |
| UI aparenta live durante drop | estado stale explícito, último valor congelado e botões desativados |
| Token Bearer lido por script injetado | app local nesta fase, storage limitado à sessão da aba; antes de exposição pública, reavaliar contrato de auth/CSP e estratégia de cookie |
| Stream SSE hoje não autenticada | só contém dados globais e client permanece local; autenticação da rota é gate explícito para deploy público em F01 |

## 13. FAQ de implementação

**A SSE mostra o status individual das apostas?** Não. Ela só fornece rodada global. Buscar bets/comandos próprios por REST e atualizar após comandos/reload.

**O que a página mostra se o operador estiver reconectando?** Mantém o último snapshot congelado, identifica que está desatualizado e bloqueia bet/cashout.

**O payout deve parecer instantâneo?** Não. Mostrar `processing` e depois `done` conforme API F05; explicitar que é local/simulado.

**Podemos instalar Mantine antes de concluir a spec?** A decisão proposta fica neste design; adicionar dependências e implementar somente após approval de design e tasks F06.

**A página precisa de Redux, WebSocket ou outro jogo?** Não. O estado do React e a SSE existente bastam para esta tela; o client fala com um único operador/Crashsim.
