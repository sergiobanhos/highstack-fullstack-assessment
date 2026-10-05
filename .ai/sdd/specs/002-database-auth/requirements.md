# Feature: Base de persistência e autenticação de jogadores

> Status: Approved
> Source: `.ai/sdd/PLAN.md` — F02; `ASSESSMENT.md`; `README.md`; decisões do usuário sobre email/senha e cadastro básico

## Visão geral

Estabelecer a persistência do operador e permitir que um jogador crie uma conta, entre com email e senha, consulte sua identidade autenticada e encerre sua sessão. A identidade persistente será usada pelas próximas entregas de carteira e comandos de jogo.

O escopo inclui a base PostgreSQL/Drizzle com migrações e o módulo `auth`. As tabelas de carteira e ledger serão introduzidas pelo módulo `financial` na F03. O modelo completo das tabelas, o transporte da API e o formato das credenciais de sessão pertencem ao design desta spec.

## Contexto

O operador já mantém a stream Crashsim e o cliente diagnóstico local. Ainda não possui persistência de jogadores nem autenticação. Como as próximas funcionalidades movimentam dinheiro, o servidor precisa obter a identidade de uma sessão validada e impedir que o cliente escolha o jogador de outra conta.

Esta entrega segue Bun/TypeScript, Fastify, PostgreSQL, Drizzle e Valibot, conforme as escolhas do projeto. A interface React de login e a integração dos comandos financeiros e de jogo ficam para as próximas specs.

## Histórias de usuário

### US-001: Criar minha conta

**Como** jogador, **quero** cadastrar nome, email e senha **para** obter uma identidade própria no operador.

**Critérios de aceitação:**

- [ ] Um cadastro válido cria uma conta com identificador estável e retorna apenas dados públicos da conta.
- [ ] Cadastro com email já utilizado não cria outra conta, inclusive sob solicitações concorrentes.
- [ ] Dados inválidos são rejeitados sem criar uma conta parcial.
- [ ] Reiniciar o operador não elimina a conta cadastrada.

### US-002: Entrar e consultar minha identidade

**Como** jogador, **quero** entrar com email e senha e consultar o usuário atual **para** realizar operações futuras em meu próprio nome.

**Critérios de aceitação:**

- [ ] Credenciais válidas permitem estabelecer uma sessão autenticada.
- [ ] Email desconhecido e senha incorreta produzem a mesma categoria de erro de autenticação.
- [ ] Uma sessão válida permite consultar somente o jogador associado a ela.
- [ ] Credencial ausente, inválida, expirada ou revogada não fornece uma identidade autenticada.
- [ ] Uma conta e uma sessão válida continuam utilizáveis após reiniciar o operador, respeitando a expiração.

### US-003: Encerrar minha sessão

**Como** jogador, **quero** sair da minha conta **para** impedir novos usos da sessão encerrada.

**Critérios de aceitação:**

- [ ] Depois de um logout confirmado, novas solicitações com a mesma credencial são rejeitadas.
- [ ] Repetir o logout não reativa a sessão nem causa erro interno.
- [ ] Encerrar uma sessão não encerra sessões independentes de outros jogadores.

### US-004: Preparar e evoluir o banco

**Como** mantenedor, **quero** preparar o banco por migrações versionadas **para** reproduzir a estrutura e preservar os dados entre entregas.

**Critérios de aceitação:**

- [ ] O procedimento documentado prepara um banco vazio para as operações de auth.
- [ ] Reexecutar o procedimento não duplica alterações já aplicadas nem apaga contas ou sessões.
- [ ] Uma falha de migração ou indisponibilidade do banco é reportada claramente, sem anunciar persistência pronta.
- [ ] As credenciais do banco e os segredos de autenticação não aparecem nas respostas ou logs.

### US-005: Usar a identidade autenticada em outras rotas e módulos

**Como** responsável por uma operação protegida, **quero** obter o jogador autenticado da solicitação **para** executar o fluxo em nome da conta correta.

**Critérios de aceitação:**

- [ ] Uma rota protegida consegue exigir autenticação e obter o ID estável do jogador usando o contrato público de auth.
- [ ] O fluxo chamado pela rota recebe a identidade validada sem acessar tabelas ou detalhes privados de auth.
- [ ] Solicitações simultâneas de jogadores diferentes mantêm seus contextos de identidade isolados.
- [ ] Um `playerId` informado pelo cliente não substitui o ID obtido da sessão autenticada.
- [ ] Uma verificação de integração demonstra o uso desse contrato por uma rota protegida, sem depender da implementação futura de bet/cashout.

## Requisitos funcionais

### FR-001: Cadastro de jogador — Must Have

QUANDO uma pessoa solicita cadastro com nome, email e senha válidos
O SISTEMA DEVE criar uma conta persistente com identificador estável
PARA QUE as próximas operações possam referenciar o mesmo jogador.

### FR-002: Unicidade do email — Must Have

QUANDO dois cadastros utilizam o mesmo email, inclusive com diferenças de caixa ou espaços externos
O SISTEMA DEVE tratar o email como a mesma identidade e permitir no máximo uma conta
PARA QUE solicitações repetidas ou concorrentes não criem identidades duplicadas.

### FR-003: Login — Must Have

QUANDO um jogador informa credenciais válidas
O SISTEMA DEVE estabelecer uma sessão autenticada associada à sua conta
PARA QUE operações protegidas obtenham a identidade pelo servidor.

QUANDO as credenciais não são válidas
O SISTEMA DEVE rejeitar o login sem informar se o email está cadastrado.

### FR-004: Usuário atual — Must Have

QUANDO uma solicitação apresenta uma sessão válida
O SISTEMA DEVE retornar somente os dados públicos da conta associada à sessão
PARA QUE o cliente reconheça o jogador autenticado.

### FR-005: Expiração e revogação — Must Have

QUANDO uma sessão expira ou seu logout é confirmado
O SISTEMA DEVE rejeitar novas solicitações autenticadas por essa sessão
PARA QUE uma credencial encerrada não continue autorizando operações.

A sessão deve ter duração finita. O valor inicial, a configuração e o mecanismo de validação serão definidos no design.

### FR-006: Identidade confiável para outros módulos — Must Have

QUANDO uma operação protegida precisa identificar o jogador
O SISTEMA DEVE fornecer o identificador obtido da sessão validada
PARA QUE dados enviados pelo cliente não substituam a identidade autenticada.

Rotas e módulos devem poder exigir autenticação e obter a identidade por um contrato público de auth. O contexto deve pertencer à solicitação em processamento, sem um usuário atual global compartilhado. Fluxos de aplicação recebem essa identidade validada como entrada.

O ID persistente da conta será também o `playerId` usado pelo operador ao criar sessões Crashsim e ao identificar a carteira nos webhooks futuros.

### FR-007: Persistência e migrações — Must Have

QUANDO o operador reinicia
O SISTEMA DEVE preservar contas e sessões ainda válidas.

QUANDO a estrutura de persistência evolui
O SISTEMA DEVE aplicar alterações por migrações Drizzle versionadas, sem recriar o banco ou apagar dados existentes.

### FR-008: Falhas de persistência — Must Have

QUANDO o banco está indisponível ou uma operação de persistência falha
O SISTEMA DEVE retornar uma falha controlada e não confirmar cadastro, login ou logout que não tenham sido efetivados
PARA QUE o cliente não interprete uma falha parcial como sucesso.

## Requisitos não funcionais

### NFR-001: Segurança e privacidade

- Senhas devem ser armazenadas somente por um mecanismo de derivação seguro; senha, hash e credenciais de sessão não devem aparecer em dados públicos ou logs.
- Todas as entradas de auth devem ser validadas, com limites de tamanho e uma política de senha explícita no design.
- Credenciais de sessão devem resistir a adivinhação e adulteração.
- Tentativas repetidas de login/cadastro devem ter proteção contra abuso com limites definidos no design; a proteção não deve revelar a existência da conta.
- Segredos devem ser fornecidos por configuração do servidor. Configuração necessária ausente ou inválida deve ser diagnosticada sem expor seu conteúdo.
- O ambiente desta entrega continua local. A exposição pública da stream e a interface autenticada do cliente serão tratadas na integração.

### NFR-002: Consistência

- Cadastros simultâneos para o mesmo email não podem violar a unicidade.
- Uma falha durante a criação da conta ou sessão não pode deixar registros parciais que aparentem uma operação concluída.
- Uma sessão revogada não pode voltar a ser aceita após reiniciar o operador.
- Erros ou indisponibilidade do banco não podem produzir uma identidade autenticada por fallback.

### NFR-003: Operação e observabilidade

- Documentar preparação do banco, aplicação de migrações, configuração e uso das operações de auth.
- Registrar resultados e falhas relevantes com identificadores seguros para diagnóstico, sem senhas, tokens ou credenciais do banco.
- Definir verificações para cadastro concorrente, persistência após reinício, credenciais inválidas, expiração, logout e indisponibilidade do banco.

## Fora do escopo

- Verificação de email, recuperação de senha e envio de emails.
- OAuth, login social, MFA, administração de contas e edição de perfil.
- Wallet, saldo inicial, ledger, débito/crédito e processamento de webhooks financeiros — F03.
- Sessão Crashsim, apostas, cashout e reconciliação de comandos — F04.
- Interface React de auth, integração do saldo e autenticação da stream existente — F05.
- Suporte a outras engines, Redis, múltiplas réplicas e arquitetura genérica de provedores.

## Contrato de identidade com as próximas entregas

Esta seção registra o vínculo exigido para F03/F04; implementar sessões Crashsim, comandos de jogo e liquidação permanece nas respectivas specs.

- **F02 / auth:** fornece o ID estável do jogador autenticado para rotas e fluxos protegidos.
- **F04 / game:** depois do login, quando o jogador abre a tela do jogo, o cliente solicita ao operador o início da sessão. O módulo `game` chama `POST /players/:id/session` usando esse ID como `playerId`. A engine retorna um `sessionId` e o associa ao jogador. A autenticação do operador e a sessão de jogo são independentes: login não depende da disponibilidade da engine.
- **F04 / aposta:** usa a sessão Crashsim associada ao jogador autenticado. O servidor controla essa associação e rejeita o uso da sessão de outro jogador.
- **F04 / cashout e consulta:** verifica que a aposta pertence ao jogador autenticado antes de executar a operação. Conhecer um `betId` não concede autorização para sacar ou consultar a aposta de outra conta.
- **F03 / financial:** recebe o mesmo `playerId` nos webhooks de débito/crédito e resolve a carteira correspondente. A requisição é autenticada pela assinatura da engine; não depende de uma sessão de navegador. Um logout do jogador não impede a liquidação de um crédito pendente válido.
- Sessões Crashsim podem desaparecer quando a engine reinicia. A F04 deve distinguir uma sessão inválida de uma aposta com resultado desconhecido e não repetir uma aposta ambígua apenas para recriar a sessão.

**Contrato conferido no código:** `engine/src/http.js` expõe a criação de sessão; `engine/src/bets.js` associa `sessionId` a `playerId`, recupera esse jogador ao apostar e o inclui nos webhooks de débito e crédito.

## Decisões

### D-001: Login por email e senha

**Decisão:** usar email e senha como credenciais do jogador.
**Motivo:** corresponde ao escopo do README e dispensa integração com um provedor externo.
**Fonte:** resposta do usuário à Q-001.
**Impacta:** US-001, US-002, FR-001 a FR-003 e NFR-001.

### D-002: Cadastro e auth básicos

**Decisão:** incluir cadastro pelo próprio jogador, login, logout e usuário atual; adiar verificação de email e recuperação de senha.
**Motivo:** entregar a identidade necessária às próximas specs com escopo adequado ao assessment.
**Fonte:** resposta do usuário à Q-002.
**Impacta:** US-001 a US-003, FR-001 a FR-005 e Fora do escopo.

### D-003: Persistência acompanha os módulos

**Decisão:** iniciar a base de banco e as entidades de auth nesta spec; introduzir carteira e ledger na F03.
**Motivo:** o roteiro aprovado atribui cada estrutura ao módulo responsável por seu comportamento.
**Fonte:** aprovação do `.ai/sdd/PLAN.md` pelo usuário.
**Impacta:** US-004, FR-007 e Fora do escopo.

### D-004: Identidade compartilhada entre auth, game e financial

**Decisão:** disponibilizar a identidade validada por solicitação a rotas e outros módulos; usar o ID persistente da conta como `playerId` na engine e nos webhooks financeiros.
**Motivo:** manter o vínculo entre conta, sessão de jogo, aposta e carteira, impedindo que dados enviados pelo cliente selecionem outro jogador.
**Fonte:** instrução do usuário para obter o usuário autenticado nos outros módulos e iniciar sessões da engine com seu `playerId`.
**Impacta:** US-005, FR-006 e Contrato de identidade com as próximas entregas.

### D-005: Criar a sessão Crashsim ao abrir o jogo

**Decisão:** criar a sessão da engine por uma operação autenticada do módulo `game`, solicitada ao abrir o jogo, depois do login. Reutilizar uma sessão conhecida enquanto válida; tratar perda de sessão e resultados ambíguos na F04.
**Motivo:** login permanece disponível independentemente da engine e o operador controla a associação entre jogador e sessão de jogo.
**Fonte:** aprovação explícita do usuário ao fluxo explicado de `POST /players/:id/session`.
**Impacta:** Contrato de identidade com as próximas entregas e F04; não amplia a implementação da F02.

## Perguntas

### Q-001: Qual método de login usar?

**Status:** answered
**Resposta:** email e senha.
**Decisão:** D-001.

### Q-002: O jogador pode criar a própria conta?

**Status:** answered
**Resposta:** cadastro e login básicos, incluindo logout e usuário atual; verificação de email e recuperação ficam para depois.
**Decisão:** D-002.

Não há perguntas críticas de produto em aberto. Política de senha, duração e formato da sessão, contrato de API e modelo das tabelas serão detalhados no design.

## Glossário

- **Jogador:** conta persistente do operador, identificada por um ID estável.
- **Sessão do operador:** autorização temporária e revogável para atuar como um jogador autenticado.
- **Sessão Crashsim:** credencial específica da engine, distinta da sessão do operador; será tratada na F04.
- **Contexto autenticado:** identidade validada e isolada da solicitação atual, disponível às rotas e fluxos protegidos.
- **Migração:** alteração versionada da estrutura do banco, aplicada sem descartar os dados existentes.
