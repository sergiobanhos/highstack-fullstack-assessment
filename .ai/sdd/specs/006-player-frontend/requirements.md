# Feature F06: Interface inicial do jogador

> Status: Approved
> Source: `.ai/sdd/PLAN.md` — F06; `ASSESSMENT.md`; specs 001–005; direção do usuário para uma UI funcional com fluxos completos

## Visão geral

Transformar o cliente React diagnóstico em uma primeira interface utilizável pelo jogador. A entrega cobre cadastro e login, jogo Crashsim em tempo real, carteira USD, adição local de saldo, histórico financeiro, aposta, cashout e acompanhamento de payout simulado.

O foco é completar os fluxos e apresentar estados claros. Não se busca criar agora uma identidade visual elaborada, animações avançadas ou uma experiência de jogo de produção.

## Contexto

O operador já oferece REST para auth, carteira e comandos de jogo, além do estado global da rodada via SSE. O cliente atual só exibe conexão, snapshot e eventos; ele ainda não conecta as operações autenticadas do jogador.

Payout local faz parte desta interface por decisão do usuário. O design aprovado de F05 define `POST /payouts`, `GET /payouts/:payoutId` e `GET /payouts`; a implementação dessas rotas está em andamento. F06 depende das rotas reais para entregar o fluxo de saque funcional; a interface não deve simular uma confirmação sem uma resposta persistida do operador.

## Histórias de usuário

### US-001: Criar conta, entrar e sair

**Como** jogador, **quero** criar uma conta, entrar e encerrar minha sessão **para** usar minha carteira e jogar com minha própria identidade.

**Critérios de aceitação:**

- [ ] A interface oferece cadastro com nome, email e senha e login com email e senha.
- [ ] Erros de validação, email já cadastrado, credenciais incorretas, limite de tentativas e indisponibilidade aparecem junto ao fluxo que falhou.
- [ ] Após cadastro válido, o jogador chega ao jogo com sessão ativa; se o login automático falhar, a conta criada continua acessível pelo formulário de login.
- [ ] Ao reabrir ou recarregar a aplicação com sessão válida, o jogador retorna à aplicação sem precisar repetir o login.
- [ ] Logout encerra a sessão no operador e devolve o jogador à tela de autenticação.

### US-002: Ver o estado atual do jogo

**Como** jogador, **quero** ver a rodada e o multiplicador ao vivo **para** saber quando posso apostar ou fazer cashout.

**Critérios de aceitação:**

- [ ] A tela mostra conexão, estado da rodada, multiplicador, rodada atual e saldo disponível.
- [ ] O estado global vem do operador; o navegador não conecta diretamente à engine.
- [ ] Durante conexão inicial, reconexão ou sincronização, a tela comunica que o dado está carregando ou desatualizado.
- [ ] Quando o estado está desatualizado, congela o último valor recebido e desabilita aposta e cashout até nova sincronização.
- [ ] Um tick atrasado depois do crash não reabre visualmente a rodada.

### US-003: Fazer aposta e cashout

**Como** jogador autenticado, **quero** apostar em uma rodada aberta e fazer cashout durante uma rodada em andamento **para** participar do jogo pelo operador.

**Critérios de aceitação:**

- [ ] O formulário permite informar valor em USD e, opcionalmente, um multiplicador de auto-cashout, com validação legível antes do envio.
- [ ] A ação só é habilitada quando a stream está sincronizada, a rodada aceita a ação e não existe aposta aceita ou desconhecida incompatível para o jogador naquela rodada.
- [ ] A UI impede duplo clique e repetição acidental da mesma ação enquanto uma solicitação está em andamento.
- [ ] Saldo insuficiente, rodada encerrada, aposta não ativa, stream não sincronizada e indisponibilidade recebem mensagens distintas e acionáveis.
- [ ] Uma resposta ambígua aparece como “verificando resultado”; a interface consulta o operador e não repete a mutação com uma chave nova.
- [ ] O resultado da aposta, do cashout e do crédito da carteira aparece separado quando o jogo já confirmou o cashout, mas o crédito ainda está pendente.

### US-004: Recuperar minhas apostas após recarga

**Como** jogador, **quero** recuperar minha aposta e seu resultado ao voltar à página **para** não depender do estado que existia apenas no navegador.

**Critérios de aceitação:**

- [ ] Após autenticar ou restaurar uma sessão, a interface busca as apostas/comandos recentes do jogador no operador.
- [ ] A aposta da rodada atual, os resultados recentes e itens pendentes/desconhecidos são identificados sem duplicar registros.
- [ ] Um item desconhecido pode ser atualizado por consulta de leitura ao operador; a interface nunca reenfileira uma aposta/cashout às cegas.
- [ ] Os dados exibidos pertencem somente ao jogador autenticado.

### US-005: Consultar carteira, adicionar saldo de teste e ver movimentações

**Como** jogador, **quero** consultar meu saldo, adicionar saldo de teste e ver movimentações **para** testar os fluxos financeiros locais.

**Critérios de aceitação:**

- [ ] A carteira mostra saldo em USD com duas casas decimais e informa claramente que o saldo inicial e o top-up são de teste local.
- [ ] O jogador pode solicitar um top-up positivo em centavos inteiros; após confirmação, saldo e histórico são atualizados a partir do operador.
- [ ] O histórico lista as movimentações próprias com direção, valor, origem e data, e permite carregar páginas seguintes quando existirem.
- [ ] Uma resposta perdida ou retry de top-up não duplica o crédito.
- [ ] Erro ou indisponibilidade não altera visualmente o saldo confirmado como se a operação tivesse sido concluída.

### US-006: Solicitar e acompanhar payout local

**Como** jogador, **quero** solicitar um saque simulado parcial e ver seus status e histórico **para** percorrer o fluxo de payout local.

**Critérios de aceitação:**

- [ ] A interface identifica o payout como simulação local, sem sugerir que houve transferência de dinheiro real.
- [ ] O valor solicitado é positivo, em centavos inteiros e não maior que o saldo disponível.
- [ ] Após resposta confirmada do operador, a UI mostra o payout em processamento e depois seu estado concluído, além de permitir recuperar histórico/status após recarga.
- [ ] Retry de solicitação não debita duas vezes nem cria um payout duplicado.
- [ ] O fluxo só é considerado funcional quando integrado à API definida e implementada na spec 005; enquanto essa dependência não estiver disponível, a UI não apresenta sucesso fictício.

### US-007: Diagnosticar a stream no ambiente local

**Como** mantenedor, **quero** expandir um painel de diagnóstico da conexão e dos últimos eventos **para** conferir o caminho engine → operador → browser durante desenvolvimento.

**Critérios de aceitação:**

- [ ] O painel fica recolhido por padrão e mostra estados upstream/downstream, roundId, seq e uma lista limitada de eventos recentes.
- [ ] O painel não mostra operator key, segredo de webhook, token de auth ou dados pessoais de outro jogador.
- [ ] A lista permanece limitada em memória durante uso prolongado.

## Requisitos funcionais

### FR-001: Autenticação do jogador — Must Have

QUANDO uma pessoa cria conta, entra, retoma uma sessão válida ou encerra a sessão
O SISTEMA DEVE apresentar os estados apropriados de cadastro, login, aplicação autenticada ou logout
PARA QUE as operações financeiras e de jogo sejam usadas pela identidade correta.

### FR-002: Reidratação ao abrir ou recarregar — Must Have

QUANDO uma sessão autenticada é restaurada
O SISTEMA DEVE consultar a identidade, saldo e apostas/comandos recentes do jogador antes de mostrar esses dados como atuais
PARA QUE a aplicação recupere seu estado a partir do operador, não da memória da aba.

### FR-003: Estado global em tempo real — Must Have

QUANDO a tela de jogo está aberta
O SISTEMA DEVE exibir snapshots, eventos e saúde da conexão recebidos do operador
PARA QUE o jogador veja a rodada sem expor ou acessar diretamente a engine.

### FR-004: Proteção de ações quando o estado está stale — Must Have

QUANDO a stream está conectando, reconectando ou sincronizando
O SISTEMA DEVE congelar o último estado conhecido, identificá-lo como desatualizado e desabilitar aposta e cashout
PARA QUE nenhuma ação financeira dependa de um multiplicador ou estado antigo.

### FR-005: Aposta e cashout seguros — Must Have

QUANDO o jogador envia uma aposta ou um cashout válido
O SISTEMA DEVE enviar a ação ao operador uma única vez por chave lógica e mostrar o resultado confirmado, recusado ou desconhecido
PARA QUE retries, cliques repetidos e timeouts não se convertam em operações duplicadas.

### FR-006: Recuperação de aposta e liquidação — Must Have

QUANDO a aplicação inicia, uma aposta termina ou um comando fica pendente/desconhecido
O SISTEMA DEVE recuperar ou atualizar o estado pela API do operador, mantendo estados de jogo e de settlement distinguíveis
PARA QUE o jogador consiga retomar o fluxo sem inferir o estado pela conexão SSE global.

### FR-007: Carteira local e histórico — Must Have

QUANDO o jogador abre a carteira ou solicita top-up local
O SISTEMA DEVE mostrar saldo e movimentações confirmados e refletir a adição de saldo somente após confirmação do operador
PARA QUE o jogador teste a carteira sem interpretar um saldo otimista como persistido.

### FR-008: Payout local — Must Have

QUANDO o jogador solicita ou consulta um payout simulado
O SISTEMA DEVE apresentar valor, status, saldo e histórico com base na API de payout definida pela spec 005
PARA QUE o fluxo local seja recuperável e não pareça uma transferência real.

### FR-009: Erros recuperáveis e saída segura — Must Have

QUANDO uma solicitação retorna erro, a sessão expira ou o jogador sai
O SISTEMA DEVE preservar o último estado financeiro confirmado, informar a próxima ação possível e encerrar os recursos de tela/sessão necessários
PARA QUE falhas de rede não pareçam sucesso e uma sessão encerrada não continue em uso pela interface.

### FR-010: Diagnóstico local da stream — Should Have

QUANDO um mantenedor expande o painel de diagnóstico no ambiente local
O SISTEMA DEVE mostrar saúde, identidade/seq da rodada e uma lista limitada de eventos recebidos
PARA QUE seja possível inspecionar a integração sem transformar o fluxo normal de jogo em uma tela de debug.

## Requisitos não funcionais

### NFR-001: Exatidão monetária

- Valores apresentados usam USD com duas casas; conversão de entrada não aceita fração de centavo.
- Saldo, top-up, aposta e payout não são arredondados em ponto flutuante para enviar comandos.
- Somente respostas do operador atualizam valores financeiros confirmados.

### NFR-002: Consistência em tempo real

- A UI distingue conexão do navegador ao operador e saúde upstream do operador para a engine.
- Um estado congelado nunca recebe aparência de estado live.
- O stream global não é usado para recuperar histórico pessoal de bets ou carteira.

### NFR-003: Segurança e privacidade

- O browser se comunica somente com o operador; operator key, segredo de webhook e sessionId Crashsim nunca chegam à interface.
- A UI não permite escolher `playerId` para carteira, bets ou payouts.
- Tokens, senhas e headers de autenticação não aparecem em URLs, mensagens visíveis ou logs de debug.
- O estado SSE global não inclui dados pessoais de bets ou saldo.

### NFR-004: Usabilidade e acessibilidade básica

- Formulários têm rótulos, validação junto ao campo, estados de carregamento e mensagens de erro compreensíveis.
- A navegação essencial funciona com teclado, e status não dependem só de cor.
- A tela se reorganiza para viewport estreito sem esconder saldo, conexão, aposta ativa ou ação principal.

### NFR-005: Limite de ambiente

- Top-up e payout são identificados como operações de teste local; payout não representa envio de dinheiro.
- A aplicação inicial permanece para o ambiente local do assessment, não um cliente pronto para produção.

## Fora do escopo

- Integração com meios de pagamento reais, KYC, conversão de moedas ou saques reais.
- Verificação de email, recuperação de senha, OAuth, MFA, edição de perfil ou área administrativa.
- Outro jogo ou engine, aplicação nativa/QuickJS, WebSocket para o browser ou replay histórico da stream.
- Gráficos/canvas avançados, animações elaboradas, tema visual de produção ou otimização para competição profissional.
- Reconciliação operacional de payouts de cashout de aposta, coberta pela fase posterior F07.

## Dependências e limites

- F01 fornece stream e estado da rodada.
- F02 fornece identidade e sessão do jogador.
- F03 fornece saldo, top-up local e ledger.
- F04 fornece sessão Crashsim, apostas, cashout e consultas para recuperação.
- F05 (spec 005) tem o design de API aprovado; as rotas precisam estar implementadas antes da integração de saque por F06.
- A interface não altera contratos do engine nem calcula por conta própria se uma aposta, cashout ou crédito foi aceito.

## Decisões

### D-001: Incluir payout local na primeira interface

**Decisão:** incluir a solicitação e o acompanhamento do payout simulado na tela de carteira, usando as rotas e o DTO definidos no design aprovado de F05 assim que a implementação estiver disponível.
**Motivo:** entregar no client os fluxos financeiros previstos pelo usuário; a interface não deve inventar uma simulação independente do backend.
**Fonte:** resposta do usuário à Q-001.
**Impacta:** US-006, FR-008, NFR-005 e dependências.

### D-002: Entrar automaticamente após cadastro

**Decisão:** após cadastro bem-sucedido, a interface inicia o fluxo de login com as credenciais recém-informadas; se o login falhar, informa que a conta foi criada e mantém acesso ao formulário de login.
**Motivo:** não há etapa de verificação de email e o cadastro básico não cria uma sessão por si só; pedir que o jogador redigite os dados não agrega proteção.
**Impacta:** US-001 e FR-001.

### D-003: Consumir somente contratos públicos do operador

**Decisão:** manter engine e seus segredos atrás do operador; usar REST para dados/ações pessoais e SSE apenas para estado global da rodada e saúde.
**Motivo:** bets e carteira são dados/ações do usuário autenticado, enquanto a rodada é compartilhada entre todos.
**Impacta:** US-002–US-006, FR-002–FR-009 e NFR-003.

## Perguntas

### Q-001: O payout local deve fazer parte da primeira interface?

**Status:** answered
**Resposta:** incluir nesta spec. A API está especificada no design aprovado de F05; a implementação está em andamento.
**Decisão:** D-001; F06 depende da implementação da API em F05.
**Impacta:** US-006, FR-008, NFR-005 e dependências.

## Glossário

- **Estado stale:** último snapshot/evento conhecido enquanto a conexão ou sincronização não está confirmada.
- **Comando desconhecido:** ação enviada ao operador/engine sem resposta suficiente para confirmar aceite ou recusa.
- **Payout local:** saque simulado do saldo da carteira, sem provedor ou transferência real.
- **Settlement:** estado financeiro do crédito associado a um cashout de aposta; não é o status do jogo.
