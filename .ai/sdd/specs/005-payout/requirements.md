# Feature: Payout local de carteira

> Status: Approved
> Source: pedido do usuário; `.ai/sdd/specs/003-financial-wallet-ledger/requirements.md` e `.ai/steering/conventions.md`

## Visão geral

Permitir que um jogador autenticado solicite um saque simulado do saldo da própria carteira, acompanhe o status e consulte seu histórico. No ambiente local, o pedido passa por `processing` e depois por `done`, sem integração com um provedor de pagamentos.

O valor continua sujeito às regras financeiras existentes: deve ser representado em unidades menores inteiras, não pode exceder o saldo disponível e só pode ser debitado uma vez. A capacidade pertence ao módulo `financial`; conforme pedido do usuário, o desenho deve reutilizar o serviço de débito existente.

A API autenticada do operador deve permitir solicitar um payout, consultar o status por referência e listar o histórico próprio. Os caminhos e formatos concretos ficam para o desenho.

## Contexto de negócio

Um payout pendente não pode deixar o mesmo saldo disponível para apostas ou outros pedidos de payout. A solicitação precisa ter identidade e status consultáveis para que retry, atualização de página ou atraso no processamento não causem um segundo débito nem ocultem o resultado.

O termo payout nesta feature significa saque da carteira. O cashout de uma aposta Crashsim e o crédito correspondente permanecem no fluxo F04/F03. O payout local simula o ciclo operacional; `done` não representa envio de dinheiro real.

## Histórias de usuário

### US-001: Solicitar um payout

**Como** jogador autenticado, **quero** solicitar um saque do saldo disponível **para** acompanhar um payout simulado no ambiente local.

**Critérios de aceitação:**

- [ ] A solicitação é associada ao jogador autenticado; o cliente não pode escolher o proprietário por `playerId`.
- [ ] Uma solicitação válida cria um payout identificável em `processing` e reduz o saldo disponível pelo valor solicitado uma única vez.
- [ ] Valor inválido ou maior que o saldo disponível não cria payout nem altera o saldo.
- [ ] Repetir uma solicitação aceita após timeout ou resposta perdida não cria outro payout nem repete o débito.
- [ ] O jogador recebe uma referência que pode usar para consultar o estado da solicitação.

### US-002: Consultar o status de um payout

**Como** jogador autenticado, **quero** consultar o status de um payout meu **para** saber se ainda está sendo processado ou se a simulação terminou.

**Critérios de aceitação:**

- [ ] O status observável começa como `processing` e passa para `done` depois do atraso simulado.
- [ ] O status nunca retrocede de `done` para `processing`.
- [ ] Uma referência inexistente ou pertencente a outro jogador não revela os dados do payout.
- [ ] Consultar o status não altera saldo nem cria outro débito.

### US-003: Consultar meu histórico de payouts

**Como** jogador autenticado, **quero** consultar meus payouts anteriores **para** revisar valores e resultados.

**Critérios de aceitação:**

- [ ] O histórico contém somente payouts associados ao jogador autenticado.
- [ ] Cada item informa uma referência, valor, moeda, status e datas de solicitação e conclusão quando disponíveis.
- [ ] Payouts novos aparecem como `processing`; a conclusão atualiza o mesmo item para `done`, sem duplicar o histórico.
- [ ] O histórico permanece disponível após reiniciar o operador.

## Requisitos funcionais

### FR-001: Solicitação autenticada — Must Have

QUANDO um jogador autenticado solicita um payout
O SISTEMA DEVE associar a solicitação à identidade persistente obtida da sessão autenticada
PARA QUE nenhum cliente solicite ou consulte payout em nome de outro jogador.

O cliente não escolhe o jogador por campo de rota, query ou body.

### FR-002: Validar valor e debitar uma vez — Must Have

QUANDO um jogador solicita um payout com valor válido e coberto pelo saldo disponível
O SISTEMA DEVE aceitar a solicitação, debitar esse valor uma única vez e registrar o payout
PARA QUE o saldo reservado para processamento não possa ser gasto de novo.

Valor deve ser positivo, inteiro em unidades menores e compatível com os limites monetários existentes. Quando o valor não for válido ou exceder o saldo, a solicitação deve ser recusada sem alteração de saldo ou criação de payout. Falha parcial não pode deixar payout aceito sem o débito correspondente, nem débito sem um payout recuperável.

### FR-003: Repetição segura da solicitação — Must Have

QUANDO uma solicitação aceita for repetida por retry ou timeout
O SISTEMA DEVE devolver ou permitir recuperar o mesmo payout sem aplicar outro débito
PARA QUE a perda de uma resposta não cause saque duplicado.

Uma chave reutilizada com dados conflitantes deve ser recusada sem outra mutação financeira.

### FR-004: Processamento local simulado — Must Have

QUANDO um payout local é aceito
O SISTEMA DEVE mantê-lo em `processing` durante o intervalo simulado e depois marcá-lo `done`
PARA QUE o cliente consiga observar o ciclo de processamento solicitado.

Esta transição é monotônica e ocorre uma única vez para o payout. A duração concreta do atraso fica para o desenho. `done` descreve apenas o fim da simulação local; não confirma uma transferência real.

### FR-005: Consultar status com autorização — Must Have

QUANDO um jogador autenticado consulta um payout por sua referência
O SISTEMA DEVE retornar o estado mais recente somente se o payout pertencer ao jogador
PARA QUE o resultado seja consultável sem expor solicitações de terceiros.

### FR-006: Consultar histórico próprio — Must Have

QUANDO um jogador autenticado consulta o histórico de payouts
O SISTEMA DEVE retornar seus pedidos, incluindo os ainda `processing` e os `done`
PARA QUE o cliente possa acompanhar solicitações em andamento e anteriores.

O histórico não pode aceitar um `playerId` de cliente para trocar o escopo da consulta. Ordenação e paginação serão definidas no desenho.

### FR-007: Disponibilidade somente local — Must Have

QUANDO o operador inicia fora do ambiente local de desenvolvimento
O SISTEMA DEVE manter desabilitada a criação de payouts simulados
PARA QUE o fluxo de teste não seja confundido com saque real nem oferecido em produção.

### FR-008: Falhas controladas — Must Have

QUANDO autenticação, validação, saldo ou persistência impedirem a solicitação ou consulta
O SISTEMA DEVE retornar um resultado controlado sem declarar um payout aceito quando o débito e o registro não estiverem confirmados
PARA QUE o cliente não interprete falha parcial como sucesso financeiro.

Erros não podem expor segredos, credenciais, dados financeiros de outro jogador ou detalhes internos do banco.

## Requisitos não funcionais

### NFR-001: Exatidão financeira

- Valores de payout e saldo usam unidades menores inteiras, conforme as regras do módulo `financial`.
- Débitos concorrentes de apostas e payouts não podem consumir mais que o saldo disponível nem torná-lo negativo.
- Um pedido repetido não produz mais de um débito, inclusive se a resposta original se perder.

### NFR-002: Consistência e recuperação

- O débito e o registro recuperável do payout não podem divergir diante de falha ou reinício.
- A transição `processing` → `done` não cria uma operação financeira adicional.
- Histórico e status sobrevivem a reinícios do operador.

### NFR-003: Segurança e privacidade

- Solicitação, consulta individual e histórico exigem autenticação.
- A identidade e o escopo dos dados vêm da sessão validada; referências conhecidas não concedem acesso a payouts de outros jogadores.
- Logs não incluem credenciais, tokens de sessão ou dados financeiros sensíveis desnecessários.

### NFR-004: Limite do mock

- O fluxo simulado só pode ser usado no ambiente local de desenvolvimento e não inicia transferência externa.
- O status deixa claro que o resultado pertence a uma simulação local.

## Fora do escopo

- Integração com banco, PIX, cartão, carteira externa ou qualquer provedor de pagamentos.
- Saque ou transferência de dinheiro real, taxas, validação de destino, KYC ou conversão cambial.
- Cashout de uma aposta Crashsim ou crédito de payout de aposta, já cobertos pelas specs financeiras e de jogo existentes.
- Cancelamento, falha ou revisão manual do payout nesta primeira simulação; o caminho solicitado termina em `done`.
- Interface completa do jogador; esta spec define capacidades do operador para consumo por cliente.
- Alterar as regras gerais de saldo, ledger, débito de apostas, crédito de cashout ou autenticação definidos nas specs anteriores.

## Decisões

### D-001: Payout significa saque de carteira

**Decisão:** esta feature trata o pedido do jogador para retirar saldo da própria carteira; não trata o cashout de uma aposta.
**Motivo:** mantém o ciclo de saque separado do resultado do jogo e do crédito de cashout.
**Fonte:** resposta do usuário à pergunta sobre o significado de payout.
**Impacta:** US-001–US-003, FR-001–FR-006 e Fora do escopo.

### D-002: Simular somente no ambiente local

**Decisão:** o payout segue `processing` → `done` após um atraso simulado e não se conecta a um provedor nem representa transferência real.
**Motivo:** o pedido especifica explicitamente um fluxo mock para local/dev.
**Fonte:** pedido inicial do usuário.
**Impacta:** US-001–US-003, FR-004, FR-007, NFR-004 e Fora do escopo.

### D-003: Criar a capacidade no módulo financeiro e reutilizar o débito

**Decisão:** a nova capacidade pertence ao módulo `financial` e reutiliza o serviço de débito já existente.
**Motivo:** conserva as regras de carteira existentes para operações que reduzem o saldo.
**Fonte:** pedido inicial do usuário.
**Impacta:** FR-002, FR-003 e NFR-001–NFR-002.

### D-004: Debitar o valor quando o pedido é aceito

**Decisão:** reduzir o saldo disponível pelo valor pedido assim que o payout é aceito, antes de mantê-lo em `processing`.
**Motivo:** o valor não pode continuar disponível para aposta ou para outro payout durante a simulação; o fluxo reutiliza o débito financeiro existente.
**Fonte:** recomendação deste PRD baseada no pedido do usuário para reutilizar o serviço de débito e nas regras de consistência financeira do projeto; destacada para revisão junto com o draft.
**Impacta:** US-001–US-002, FR-002–FR-004 e NFR-001–NFR-002.

### D-005: Permitir valor parcial até o saldo disponível

**Decisão:** o jogador escolhe o valor do payout; o operador aceita um valor positivo que não exceda o saldo disponível.
**Motivo:** saques parciais permitem ao jogador controlar quanto da carteira solicitar, mantendo a proteção contra saldo insuficiente.
**Fonte:** resposta do usuário à Q-001.
**Impacta:** US-001, FR-002 e NFR-001.

## Perguntas

### Q-001: O payout aceita saque parcial ou sempre solicita todo o saldo?

**Status:** answered
**Resposta:** o jogador escolhe um valor até o saldo disponível; saques parciais são permitidos.
**Decisão:** D-005.
**Por que importa:** determina se o jogador controla o valor do pedido ou se cada payout consome todo o saldo disponível.
**Impacta:** US-001, FR-002 e validações associadas.

## Glossário

- **Payout:** pedido simulado de saque de saldo da carteira, nesta feature.
- **Processing:** pedido aceito cuja simulação ainda não terminou.
- **Done:** estado terminal da simulação local; não significa transferência real.
