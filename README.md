# O que eu entendi da arquitetura e do desafio

- A engine é o core da parte da aposta. Esse serviço é o que controla todo o fluxo de vida do jogo da bet. No caso atual, o jogo é o crash.
- A engine tem uma API rest para: Iniciar sessao de um jogador, fazer BET, Cashout, verificar o estado atual.
- A engine comunica os eventos de bet pela stream, mandando os eventos.
- Eventos relacionados a carteira (credito e débito) são enviados pelo webhook
- A stream é autenticada com operator key
- O webhook é autenticada com webhook key
- O objetivo do desafio é criar o serviço do operador (backend) e um pequeno client frontend.
- O operador é o serviço que vai se comunicar com o a engine, tratar da autenticacao dos jogadores, controlar a carteira e as transações (ledger financeiro), integrado a engine.
- O MVP suporta somente Crashsim. Outro jogo exigirá uma decisão explícita baseada no protocolo e nas necessidades daquele jogo; não há registry nem adapter genérico.

# Arquitetura e Decisões

## Arquitetura Geral

Player Client -> Operador (Auth, Game, Financial, DB) <-> Crashsim Engine

## Operador

- O operador expõe comandos e autenticação por API REST (Fastify); o estado realtime é distribuído por SSE.
- A comunicacao da engine com o operador deve ser idempotente
- O MVP processa webhooks financeiros na requisição, persistindo a operação idempotente e a atualização do saldo antes de confirmar sucesso; uma fila não faz parte desta entrega.
- Operações financeiras devem manter saldo e ledger consistentes por transação de banco, usando atualização atômica ou lock de linha quando necessário.
- O saldo corrente será persistido junto do ledger; cache distribuído e filas ficam fora do MVP local.
- Na conexão operador -> cliente, decidi user SSE invez de websocket pois como a direcao da mensagem é unica, apenas servidor para cliente, não tem necessidade de websocket. SSE é mais leve para esse caso.

### Arquitetura banco de dados

- Teremos as tabelas de autenticação. Tabela de User, por exemplo.
- Teremos tambem as tabelas relacionadas a finanças. Wallet, Transaction, fazer um mini ledger.

#### Auth

User

- id
- name
- email
- passwordHash
- walletId

Poderia ter Account e tal mas para o escopo desse desafio não precisa

#### Financial

OBS: Todos os valores de dinheiro serao INT, sendo o valor em CENTAVOS

Wallet

- id: uuid
- document: String
- currency: String / Enum

Transaction

- id: uuid
- transactionKey: String
- value: Integer
- type: String / Enum (credit | debit)
- currency: String / ENUM
- description: String

Payout

- id
- value: Integer
- tax: Integer
- netValue: Integer

# Fluxos de Casos de Uso (Fazer diagramas)

TODO: Fazer diagramas

## Login

## Registro

## Current User

## Iniciar sessão do jogo

Player Cliente -> POST /game/crashsim (Header Berarer Auth Token) (Operator) -> Engine | POST /players/:id/session -> Redirect to /session/:sessionId or /game/crashsim?sessionId=:sessionId

## Criar transacao por PlayerId

Verifica se saldo vai ficar menor que 0 -> Lock no banco -> Criar transação -> Commit -> Recalcula balance -> Atualiza cache

##

# Fluxo de Desenvolvimento

- Vou usar SDD para o desenvolivmento assistido por IA
- Primeiro, montar as SPECS do Operador e do front, para depois iniciar a desenvolver de fato.
- Com o SDD, consigo pensar nos requisitos e nos edge cases antes de colocar em código
- Vou usar o meu prório framework de SDD https://www.npmjs.com/package/@banhosdev/sdd

# Notas de desenvolvimento

3/10 - sabado

- Estruturei os projetos iniciais (operator e cliente)
- Defini, junto com a IA, possíveis edge cases que geralmente acontecem em aplicações real time (desconexao, eventos duplicados, etc)
- Inicializei o framework SDD no repositorio
- Criei a primeira spec, definindo arquitetura do operador, do cliente, pensando já na expansão, edge cases, etc.

## Como eventos e comandos atravessam o operador

```mermaid
flowchart LR
  Browser["Cliente React<br/>EventSource"]

  subgraph Operator[Operador — módulo game]
    EventsController["game-events.controller<br/>GET /game/events"]
    CommandsController["game-commands.controller<br/>REST autenticada"]
    Hub["game-event-hub<br/>fan-out SSE"]
    Service["game-stream.service<br/>sync, reconnect, reduce"]
    Commands["game-command.service<br/>sessão, bet, cashout, reconciliação"]
    Reducer["round-state<br/>transições da rodada"]
    WsClient["crashsim-stream.client<br/>WebSocket + validação"]
    HttpClient["crashsim-http.client<br/>snapshot, session, bet, cashout"]
    Module["game.module<br/>composição"]
  end

  subgraph Shared[Operador — módulos compartilhados]
    Auth["auth.requireUser"]
    Financial["financial<br/>wallet + webhook"]
    DB[(PostgreSQL)]
  end

  Engine["Engine Crashsim"]

  Browser -->|SSE: GET /game/events| EventsController
  EventsController -->|inscreve com snapshot| Hub
  Hub -->|captura estado atual| Service
  Service -->|snapshot atual| Hub
  Service -->|publica estado, eventos e health| Hub
  Hub -->|snapshot primeiro, depois updates| EventsController
  EventsController -->|snapshot, game-event, connection| Browser

  Browser -->|REST: sessão, bet, leituras, cashout| CommandsController
  CommandsController -->|identidade autenticada| Auth
  CommandsController -->|comando validado| Commands
  Commands -->|estado de round| Service
  Commands -->|persistência idempotente| DB
  Commands -->|status do crédito| Financial
  Commands -->|HTTP autenticado server-side| HttpClient
  Engine -->|webhook de débito/crédito| Financial
  Financial -->|ledger e saldo| DB

  Engine -->|eventos WS| WsClient
  WsClient -->|eventos validados| Service
  Service -->|aplica evento ou snapshot| Reducer
  Reducer -->|novo estado da rodada| Service
  Service -->|busca snapshot via HTTP| HttpClient
  HttpClient -->|GET + operator key server-side| Engine
  Engine -->|snapshot + seq| HttpClient

  Module -. instancia e liga .-> Service
  Module -. instancia e liga .-> Commands
  Module -. instancia e liga .-> Hub
  Module -. registra .-> EventsController
  Module -. registra .-> CommandsController
```

O browser faz um `GET /game/events` para abrir SSE. Depois da requisição, os dados fluem do operador para o browser; o browser não conecta à engine. Dentro do operador, o serviço mantém uma única conexão WebSocket upstream, busca o snapshot por HTTP ao conectar ou ressincronizar, aplica o reducer e publica eventos e saúde no hub. O hub atende vários clientes SSE e entrega a cada novo cliente o snapshot antes dos eventos concorrentes.

As ações de jogo usam REST autenticada. O controller valida a entrada e obtém a identidade em `auth.requireUser`; `game-command.service` coordena o snapshot, os comandos persistidos, o contrato público de financial e as chamadas Crashsim. O status do cashout no jogo fica separado do status do crédito no ledger. Uma resposta ambígua leva a uma consulta `GET /bets/:id`; se ainda não for possível confirmar, o comando fica `unknown` e uma nova tentativa fica bloqueada.

# Crashsim realtime proxy (spec 001) — local run

Services (all local-only):

- engine on `http://localhost:4000`
- operator on `http://127.0.0.1:3000` (loopback-only until player auth exists)
- debug client on `http://127.0.0.1:5173` (loopback-only, proxies `/game/events` to the operator)

```bash
docker compose up --build
```

Open `http://localhost:5173` and confirm: upstream status, the current snapshot, and the live event log.

## Fault verification (reconnect, reorder, snapshot recovery)

```bash
DROP_WS_EVERY=8 REORDER=1 docker compose up --build
```

Expected in the debug client:

1. Upstream status flips to `reconnecting` on each forced drop, and the snapshot freezes (stale indicator) instead of projecting forward.
2. After reconnect, the operator resynchronizes from `GET /rounds/current` and the snapshot recovers to the engine's current state.
3. No tick for a round already marked `crashed` moves state backward, including late ticks delivered out of order.
4. The operator key never appears in browser payloads or in operator logs.

## Banco de dados e autenticação do jogador (specs 002 e 003)

O serviço `operator-migrate` aplica as migrations Drizzle de auth e financial uma vez, depois que o PostgreSQL passa no healthcheck. O serviço `operator` só inicia depois que essas migrations terminam com sucesso. Reiniciar os containers não remove o volume `postgres-data` nem invalida sessões ainda válidas.

```bash
docker compose up --build
```

O Compose mantém engine, operador, cliente diagnóstico e PostgreSQL acessíveis pelo host somente em `127.0.0.1`. Os valores locais de PostgreSQL e das chaves da engine no Compose são credenciais de desenvolvimento; não os reutilize em outros ambientes.

O operador exige `DATABASE_URL` no formato `postgres://` ou `postgresql://`. `AUTH_SESSION_TTL_SECONDS` é opcional e usa `86400` por padrão; valores aceitos vão de 60 a 604800 segundos. A URL e a senha ficam somente no servidor, migrador ou ambiente de teste e não devem ser enviadas ao navegador.

### Migrations

O caminho recomendado é deixar o Compose executar a migration. Para operar manualmente, suba o PostgreSQL e execute somente um migrador por vez:

```bash
cd operator
DATABASE_URL='postgres://operator:operator@127.0.0.1:5432/operator' bun run db:migrate
```

`bun run db:generate` cria uma migration nova a partir dos schemas Drizzle. Migrations aplicadas não devem ser editadas; mudanças posteriores entram em outra migration. Não use `drizzle-kit push` nem remova o volume para atualizar o schema.

### Endpoints REST

Todas as respostas de auth incluem `Cache-Control: no-store`. O cliente envia credenciais no corpo JSON e a sessão no header `Authorization`; não coloque senha ou token em URL ou query string.

| Método e rota | Sucesso | Comportamento |
|---|---:|---|
| `POST /auth/register` | `201 { user }` | Cria conta; email duplicado retorna `409 EMAIL_IN_USE`. Cadastro não autentica automaticamente. |
| `POST /auth/login` | `200 { token, expiresAt, user }` | Token opaco aparece uma vez na resposta; o banco armazena somente seu hash. Credencial inválida retorna `401`. |
| `GET /auth/me` | `200 { user }` | Exige Bearer válido; credencial ausente, expirada ou revogada retorna `401`. |
| `POST /auth/logout` | `204` | Revoga apenas o token apresentado; repetir logout continua retornando `204`. |

Exemplo de cadastro local com credenciais fictícias:

```bash
curl -i http://127.0.0.1:3000/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"name":"Test Player","email":"player@example.invalid","password":"example password phrase"}'
```

Exemplo de login:

```bash
curl -i http://127.0.0.1:3000/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"player@example.invalid","password":"example password phrase"}'
```

Copie o token retornado para `AUTH_TOKEN` apenas no terminal local:

```bash
curl -i http://127.0.0.1:3000/auth/me -H "Authorization: Bearer ${AUTH_TOKEN}"
curl -i -X POST http://127.0.0.1:3000/auth/logout -H "Authorization: Bearer ${AUTH_TOKEN}"
```

`/health` mede se o processo está vivo e continua retornando `200` durante indisponibilidade do banco. `/ready` confere conexão e tabelas de auth e financial, retornando `503` enquanto o PostgreSQL ou o schema não estiver pronto. O operador não abre a porta HTTP se a verificação inicial falhar.

Tentativas de cadastro e login são limitadas separadamente por endereço IP: 5 cadastros e 10 logins por minuto. O limite é local ao processo, conta também payload inválido e não usa `X-Forwarded-For`. Hashes Argon2id simultâneos também têm um teto de duas operações.

## Carteira, ledger e webhooks financeiros (spec 003)

O saldo é USD e todas as quantias da API são inteiros em centavos. A carteira começa em zero e é criada no primeiro `GET /wallet` autenticado. O top-up é uma ferramenta local de desenvolvimento, sem integração com pagamento: o Compose define `APP_ENV=local` e `WALLET_TEST_TOPUP_ENABLED=true`. Em outras configurações, a flag fica desligada e a rota não é registrada; a configuração também rejeita habilitá-la fora do ambiente local.

### Rotas do jogador

Todas as rotas exigem `Authorization: Bearer <token>` emitido por `/auth/login`. A identidade vem da sessão e não pode ser escolhida por `playerId` em body ou query. Respostas financeiras usam `Cache-Control: no-store`.

| Método e rota | Sucesso | Notas |
|---|---:|---|
| `GET /wallet` | `200 { balance, currency: "USD" }` | Cria a carteira zero na primeira consulta. `balance` está em centavos. |
| `GET /wallet/transactions?limit=&cursor=` | `200 { items, nextCursor }` | Histórico próprio, mais novo primeiro; `limit` default 50, máximo 100. Cursor opaco e estável. |
| `POST /wallet/top-ups` | `201 { transactionId, balance, currency: "USD" }` | Apenas no Compose local. Body `{ "amount": 1000 }` adiciona USD 10,00. |

Exemplo de top-up local (use uma chave UUID nova por ação e mantenha o token no terminal):

```bash
curl -i -X POST http://127.0.0.1:3000/wallet/top-ups \
  -H "Authorization: Bearer ${AUTH_TOKEN}" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: 7b7a2c9d-08b8-44c5-b735-49f2f41c993d' \
  -d '{"amount":1000}'

curl -i http://127.0.0.1:3000/wallet -H "Authorization: Bearer ${AUTH_TOKEN}"
curl -i 'http://127.0.0.1:3000/wallet/transactions?limit=50' \
  -H "Authorization: Bearer ${AUTH_TOKEN}"
```

O mesmo `Idempotency-Key` com o mesmo valor devolve o resultado persistido sem novo crédito; reutilizá-lo com conteúdo diferente retorna `409`. Top-ups também respeitam o saldo máximo seguro e retornam `422` sem ultrapassá-lo.

### Webhooks privados da engine

`POST /wallet/debit` e `POST /wallet/credit` são endpoints servidor-servidor. A engine envia `{ txId, playerId, amount, betId, roundId }`, onde `amount` está em centavos. Essas rotas não usam sessão de jogador: validam `x-timestamp` (Unix em segundos) e `x-signature` antes de parsear o JSON. A assinatura é HMAC-SHA256 em hexadecimal sobre os bytes exatos `${timestamp}.${rawBody}` com `ENGINE_WEBHOOK_SECRET`; o timestamp deve estar dentro de ±60 segundos. O corpo tem limite de 16 KiB.

O Compose injeta o mesmo valor local de `WEBHOOK_SECRET` no Crashsim como `WEBHOOK_SECRET` e no Operator como `ENGINE_WEBHOOK_SECRET`. `ENGINE_OPERATOR_KEY` autentica as chamadas do Operator para a engine e é um segredo diferente. Nenhuma dessas chaves deve ser enviada ao browser ou incluída em logs.

| Resultado | HTTP | Efeito |
|---|---:|---|
| Débito/crédito aplicado ou replay equivalente | `200 { balance }` | Só responde sucesso após o commit; saldo em centavos. |
| Débito com saldo insuficiente | `402` | Resultado idempotente salvo; saldo e ledger não mudam. |
| HMAC ausente/inválido ou timestamp vencido | `401` | Nenhuma operação financeira é chamada. |
| Body inválido ou assinatura correta sobre JSON inválido | `400` | Sem mutação. |
| Mesmo identificador com dados divergentes | `409` | Sem segundo movimento. |
| Carteira inexistente | `404` | Webhook não cria carteira órfã. |
| Quantia insegura ou saldo resultante acima do limite | `422` | Sem movimento; limite de saldo fica idempotente. |
| Banco indisponível ou resultado de commit não confirmado | `503` | A engine pode repetir com o mesmo `txId`; o operador não declara sucesso. |

O Crashsim faz retries síncronos para timeout e respostas `5xx` (atrasos locais de 500 ms, 1 s, 2 s, 4 s e 8 s); `402` recusa a aposta e outras respostas `4xx` são terminais para a engine atual. A deduplicação usa `txId`; crédito de cashout também converge por `cashout:<betId>`, permitindo que webhook e futura reconciliação não dupliquem o payout. Não há Inbox, Outbox ou worker nesta entrega: o débito precisa ser concluído antes de a engine aceitar a aposta.

O contrato numérico atual só transporta inteiros até `Number.MAX_SAFE_INTEGER` centavos. Um payout inseguro é recusado com `422` e gera `wallet.cashout.precision_incident`, sem registrar valor, corpo ou assinatura. Como a engine converte seu payout de `BigInt` para `number`, o valor exato já não pode ser recuperado pelo contrato atual; F06 não credita o valor aproximado automaticamente. Esse limite permanece até que a engine ofereça um contrato exato, por exemplo uma string decimal.

## Comandos de jogo Crashsim (spec 004)

Todas as rotas REST de jogo exigem `Authorization: Bearer <token>`. O `playerId` vem da sessão autenticada, nunca do corpo ou da query. O SSE `/game/events` continua separado e fornece o snapshot usado para habilitar ações.

| Método e rota | Sucesso | Comportamento |
|---|---:|---|
| `POST /game/session` | `200 { status: "ready" }` | Garante a carteira e cria ou reutiliza a sessão Crashsim; não retorna `sessionId`. |
| `POST /game/bets` | `201` | Exige `Idempotency-Key` UUID e body `{ roundId, amount, autoCashout? }`; `amount` é centavos inteiros. |
| `GET /game/bets?limit=10` | `200` | Lista até 20 comandos/apostas próprios, mais recentes primeiro; restaura o jogo após reload. |
| `GET /game/commands/:commandId` | `200` | Consulta comando próprio; um comando `unknown` pode ser reconciliado por leitura, sem repetir a mutação. |
| `GET /game/bets/:betId` | `200` | Consulta o estado atualizado da aposta, retoma a reconciliação de um cashout `pending`/`unknown` após reload e atualiza a liquidação financeira. |
| `POST /game/bets/:betId/cashout` | `200` | Exige `Idempotency-Key` UUID; só tenta cashout de uma aposta própria, ativa, com stream sincronizado e rodada `running`. |

A chave idempotente deve ser reutilizada no retry da mesma ação. Uma chave diferente não contorna um comando pendente ou desconhecido. Se uma chamada de cashout terminar sem resposta conclusiva, o operador consulta o bet na engine: `cashed_out` confirma o estado do jogo, `active` libera uma tentativa futura com uma chave nova, e uma consulta indisponível mantém o comando `unknown`. Nesse estado, o cliente consulta o mesmo comando em vez de disparar outro cashout.

Erros de validação retornam `400`, falta de autenticação retorna `401`, saldo insuficiente retorna `402`, bet/comando próprio ausente retorna `404`, conflitos de rodada, idempotência ou cashout retornam `409`, e indisponibilidade operacional retorna `503`. Uma mutação com resultado `unknown` retorna `202` com `{ error: { code: "COMMAND_OUTCOME_UNKNOWN" }, command }`; uma leitura de comando retorna `200` com o estado persistido, inclusive quando continua `unknown`.

O jogo pode estar `cashed_out` enquanto o crédito ainda está pendente. O operador só mostra `settlementStatus: "confirmed"` depois de encontrar o crédito correspondente no ledger; o endpoint de cashout não cria crédito. O webhook da engine continua sendo o caminho normal, e F06 cobre a recuperação operacional de crédito ausente.

### Limites conhecidos do MVP

- Se o débito da aposta foi confirmado no financial, mas todas as respostas entre engine e operador se perderam e a engine depois indicar rejeição, F04 não cria uma compensação automática. O comando registra o conflito e o saldo continua dependendo de investigação; não se deve assumir que foi estornado.
- Não há worker nesta entrega. Cashout `pending`/`unknown` é reconciliado por uma leitura posterior de comando ou aposta; recuperação operacional de um webhook de crédito que não chegou pertence a F06.
- A integração atual suporta uma instância do operador e a engine Crashsim. Sessões Crashsim ficam em memória do processo; os comandos e apostas ficam no PostgreSQL.
