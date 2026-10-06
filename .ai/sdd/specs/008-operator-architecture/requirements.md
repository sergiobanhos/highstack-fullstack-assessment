# Feature: Organização arquitetural do Operator

> Status: Approved
> Source: conversa de arquitetura do Operator; `.ai/steering/conventions.md`

## Overview

Reorganizar o código do Operator para que os fluxos de negócio, a integração com Crashsim e a distribuição realtime sejam fáceis de localizar e explicar. A mudança cobre os módulos `auth`, `financial` e `game` e mantém os contratos e as garantias críticas do MVP.

## Business Context

O Operator já atende autenticação, carteira, apostas, cashout e estado realtime. Conforme essas responsabilidades cresceram, casos de uso passaram a dividir arquivos extensos, detalhes do protocolo Crashsim ficaram distribuídos entre módulos, e o caminho entre stream, estado, event hub e SSE ficou difícil de entender. Isso aumenta o custo de manutenção e de revisão de mudanças que podem afetar saldo ou estado de jogo.

O resultado esperado é que uma pessoa consiga localizar a implementação de cada fluxo, identificar onde termina o protocolo externo e entender como os eventos chegam aos clientes sem precisar conhecer detalhes incidentais de composição.

## User Stories

### US-001: Encontrar a implementação de um fluxo de negócio

**As a** pessoa mantenedora do Operator  
**I want to** localizar os casos de uso por módulo e fluxo  
**So that** mudanças em auth, financial ou game tenham escopo claro e sejam mais simples de revisar.

**Acceptance Criteria:**
- [ ] Cada módulo de negócio existente (`auth`, `financial`, `game`) apresenta uma organização consistente para seus casos de uso.
- [ ] A interface pública de cada módulo pode ser entendida sem importar arquivos privados de outro módulo.
- [ ] Controllers permanecem focados em HTTP e delegam o fluxo de negócio à interface do módulo.

### US-002: Entender a integração Crashsim

**As a** pessoa mantenedora do Operator  
**I want to** encontrar em um lugar os detalhes de comunicação e protocolo do Crashsim  
**So that** os fluxos de negócio não precisem conhecer parsing, autenticação ou transporte específicos da Engine.

**Acceptance Criteria:**
- [ ] Os detalhes de transporte e formato de payload Crashsim têm um ponto de localização explícito e documentado.
- [ ] `game` continua dono dos fluxos de sessão, aposta, cashout, consulta e reconciliação.
- [ ] `financial` continua dono da carteira, ledger e processamento financeiro dos webhooks.

### US-003: Rastrear o fluxo realtime até o client

**As a** pessoa mantenedora do Operator  
**I want to** entender o caminho Engine → Operator → client e a responsabilidade de cada etapa  
**So that** eu consiga revisar e diagnosticar desconexões, ressincronização e entrega de eventos.

**Acceptance Criteria:**
- [ ] O fluxo possui uma interface clara entre ingestão da Engine, estado da rodada, fan-out e transporte SSE.
- [ ] A implementação suporta uma única conexão upstream da Engine por processo do Operator e múltiplos clients SSE.
- [ ] Um novo subscriber recebe snapshot e estado de conexão antes dos eventos concorrentes posteriores ao snapshot.
- [ ] A documentação explica o papel de cada etapa sem exigir que o leitor conheça detalhes privados da implementação.

## Functional Requirements

### FR-001: Organização consistente dos módulos — Must Have

WHEN uma pessoa mantenedora procura uma operação de negócio  
THE SYSTEM SHALL organizar os casos de uso de `auth`, `financial` e `game` em uma localização previsível dentro de cada módulo  
SO THAT fluxos relacionados possam ser encontrados e revisados sem atravessar responsabilidades não relacionadas.

### FR-002: Interface de serviço por módulo — Must Have

WHEN um controller ou outro módulo chama uma capacidade de negócio  
THE SYSTEM SHALL expor os casos de uso públicos pelo service do módulo, que funciona como sua interface estável  
SO THAT consumidores não dependam da organização interna dos casos de uso.

### FR-003: Casos de uso representam fluxos de negócio — Must Have

WHEN uma operação envolver validação de negócio, persistência e/ou comunicação externa  
THE SYSTEM SHALL manter essas decisões num caso de uso coeso  
SO THAT o fluxo possa ser lido, testado e alterado como uma unidade.

Casos de uso não devem servir apenas como arquivos de helpers ou encaminhadores sem responsabilidade própria.

### FR-004: Integração Crashsim localizada — Must Have

WHEN um fluxo precisar comunicar-se com Crashsim  
THE SYSTEM SHALL concentrar os detalhes de transporte, autenticação técnica, validação e formato de payload Crashsim numa integração concreta e identificável  
SO THAT os módulos de negócio não implementem esses detalhes de forma duplicada ou dispersa.

### FR-005: Responsabilidades de negócio preservadas — Must Have

WHEN a organização interna do Operator mudar  
THE SYSTEM SHALL manter `auth` responsável por identidade e sessão do jogador, `financial` por wallet/ledger/payout e `game` por sessão Crashsim, comandos, estado de rodada e reconciliação  
SO THAT a refatoração preserve os limites de negócio entre módulos.

### FR-006: Fluxo realtime com responsabilidade compreensível — Must Have

WHEN eventos chegarem da Engine ou um client abrir SSE  
THE SYSTEM SHALL permitir rastrear a ingestão, validação, redução do estado, fan-out e entrega realtime por interfaces de módulo claras  
SO THAT componentes privados possam ser alterados sem espalhar conhecimento do protocolo ou do transporte pelos consumidores.

### FR-007: Contratos externos preservados — Must Have

WHEN a refatoração for concluída  
THE SYSTEM SHALL preservar as rotas REST, os envelopes SSE, os payloads de webhook e os contratos atuais com Crashsim  
SO THAT clients, Engine e fluxos financeiros existentes continuem funcionando sem migração de contrato.

### FR-008: Garantias de stream preservadas — Must Have

WHEN a Engine desconectar, eventos chegarem atrasados ou um client SSE reconectar  
THE SYSTEM SHALL preservar congelamento do último estado conhecido, health de conexão, reconexão com backoff, ressincronização por snapshot, ausência de replay histórico, filtragem por `seq` e proteção contra tick posterior ao crash  
SO THAT estado antigo ou incompleto não seja apresentado como live nem faça uma rodada regredir.

### FR-009: Garantias financeiras preservadas — Must Have

WHEN webhooks duplicados, operações concorrentes, timeouts ou falhas de banco ocorrerem  
THE SYSTEM SHALL preservar idempotência por `txId`, atualização de saldo e ledger na mesma transação, proteção contra saldo negativo e semântica atual de retry/resposta  
SO THAT reorganizar arquivos não altere a correção do dinheiro.

### FR-010: Segurança dos limites de integração — Must Have

WHEN o Operator comunicar-se com o browser ou Crashsim  
THE SYSTEM SHALL manter credenciais técnicas somente no servidor, validar payloads externos nos pontos de entrada e verificar HMAC/frescor nos webhooks  
SO THAT a refatoração não enfraqueça autenticação nem exposição de segredos.

### FR-011: Composição explícita da aplicação — Must Have

WHEN o Operator for construído  
THE SYSTEM SHALL manter um ponto de composição explícito que conecte os módulos por contratos exportados  
SO THAT dependências entre módulos permaneçam visíveis e testáveis.

### FR-012: Documentação arquitetural atualizada — Should Have

WHEN a arquitetura alvo for aprovada e implementada  
THE SYSTEM SHALL atualizar o steering e os diagramas do README para refletir os módulos, contratos e caminho realtime atuais  
SO THAT documentação persistente não continue ensinando a organização anterior.

## Non-Functional Requirements

### NFR-001: Corretude e confiabilidade

- A refatoração não pode reduzir a cobertura existente dos casos de falha realtime ou financeiros.
- A suíte automatizada relevante deve continuar verificando desconexão, ressincronização, eventos fora de ordem, duplicidade de webhook, concorrência de débito e resultados desconhecidos.

### NFR-002: Manutenibilidade

- A organização deve permitir localizar o caso de uso, sua interface pública e suas dependências sem seguir cadeias de arquivos redundantes.
- Uma mudança em detalhe Crashsim deve ficar concentrada na integração concreta e nos testes do contrato correspondente.

### NFR-003: Compatibilidade

- Não haverá mudança observável nos contratos REST, SSE ou webhook nesta entrega.
- Não haverá alteração na API ou na implementação da Engine Crashsim.

## Out of Scope

- Adicionar outro jogo ou provider, registry, plugin system, catálogo ou interface genérica de engine.
- Alterar comportamento de aposta, cashout, wallet, payout ou autenticação.
- Alterar schemas do banco, dados persistidos ou migrations.
- Substituir SSE por WebSocket ou introduzir Redis, filas, workers, Outbox ou replay histórico.
- Refatorar a UI React além dos ajustes necessários para manter o contrato existente.
- Adicionar um framework genérico de use cases, repositories ou dependency injection.

## Decisions

### D-001: Aplicar o padrão de casos de uso aos três módulos

**Decision:** `auth`, `financial` e `game` terão uma organização previsível para casos de uso, acessados por uma interface de serviço do módulo.  
**Reason:** a convenção será consistente entre módulos, enquanto cada arquivo continuará representando um fluxo real e coeso.  
**Source:** instrução direta do usuário nesta conversa.  
**Impacts:** FR-001, FR-002, FR-003.

### D-002: Centralizar o protocolo concreto Crashsim

**Decision:** a spec de design deve avaliar a localização dos clientes HTTP/WebSocket e da validação de autenticação de webhook numa integração Crashsim identificável, mantendo as rotas e efeitos financeiros dentro de `financial`.  
**Reason:** HTTP, WebSocket e HMAC são detalhes do protocolo externo; wallet e ledger são responsabilidades financeiras.  
**Source:** proposta do usuário para `lib/crashsim` e escopo desta spec.  
**Impacts:** FR-004, FR-005, FR-010.

### D-003: Refatoração sem mudança de contrato

**Decision:** esta entrega reorganiza módulos e interfaces internas; contratos externos e garantias atuais permanecem.  
**Reason:** reduz o risco de combinar mudanças arquiteturais com mudanças de comportamento num sistema realtime que movimenta dinheiro.  
**Source:** escopo inferido da solicitação de melhorar organização e clareza.  
**Impacts:** FR-007–FR-011, NFR-001, NFR-003, Out of Scope.

## Questions

Nenhuma questão de requisito bloqueia este draft. A decisão técnica sobre como encapsular fan-out/event hub sob o fluxo realtime será feita no design, preservando os critérios de FR-006 e FR-008.

## Glossary

- **Caso de uso:** fluxo de negócio completo, como registrar um jogador, processar um débito, fazer uma aposta ou reconciliar uma rodada.
- **Interface do módulo:** operações públicas que controllers e outros módulos podem usar, sem conhecer os arquivos privados.
- **Integração Crashsim:** código concreto responsável pelo protocolo HTTP, WebSocket e autenticação de webhook do Crashsim.
- **Fan-out:** distribuição do mesmo estado/evento do Operator para múltiplos subscribers SSE.
