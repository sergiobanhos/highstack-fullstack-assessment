# Feature: Sessão Crashsim, aposta e cashout

> Status: Approved
> Source: .ai/sdd/PLAN.md — F04; ASSESSMENT.md; ORIGINAL_README.md; decisões anteriores do usuário e contrato atual em engine/src/http.js e engine/src/bets.js

## Visão geral

Estender o módulo game do operador para que um jogador autenticado abra uma sessão Crashsim, faça uma aposta e solicite cashout sem acessar a engine diretamente. O operador usa a identidade persistente do jogador e o módulo financial para que o débito e o crédito continuem sob as regras de carteira já aprovadas.

O fluxo precisa preservar a correção financeira quando a resposta de um comando se perde. O cashout pode ser consultado por betId na engine; uma aposta tem um limite adicional: a engine atual não aceita chave idempotente e só devolve o betId na resposta. O operador não pode repetir essa criação às cegas.

## Contexto de negócio

O operador é uma fronteira crítica e realtime. Um comando duplicado pode debitar uma segunda aposta; um cashout marcado como concluído sem confirmar o crédito pode mostrar um saldo incorreto. Um cliente também pode ficar com estado antigo durante uma queda do stream, quando aposta e cashout precisam ser bloqueados até a ressincronização.

A engine recebe um playerId ao criar sessão, usa essa sessão para associar a aposta ao jogador e envia o mesmo playerId nos webhooks financeiros. O navegador se autentica no operador; credenciais da engine e IDs de sessão Crashsim ficam no servidor.

## Histórias de usuário

### US-001: Abrir o jogo como jogador autenticado

**Como** jogador autenticado, **quero** abrir uma sessão de jogo vinculada à minha conta **para** apostar com minha identidade e minha carteira.

**Critérios de aceitação:**

- [ ] O operador obtém a identidade da sessão autenticada e usa seu ID persistente para criar a sessão Crashsim.
- [ ] O operador provisiona a carteira pelo contrato de financial antes de iniciar a sessão na engine.
- [ ] O cliente não escolhe o playerId associado à sessão e não recebe a chave de operador da engine.
- [ ] Falha ao provisionar carteira ou criar sessão não retorna sucesso de abertura do jogo.

### US-002: Fazer uma aposta na rodada atual

**Como** jogador autenticado, **quero** apostar enquanto a rodada aceita apostas **para** participar do jogo com saldo disponível.

**Critérios de aceitação:**

- [ ] A aposta só é aceita quando o operador está sincronizado com o estado atual e a rodada está em betting; a engine continua sendo a autoridade final.
- [ ] O valor respeita o contrato Crashsim: centavos inteiros positivos até 1.000.000.000; autoCashout, quando informado, respeita os limites e a precisão da engine.
- [ ] O resultado aceito só é apresentado depois que a engine conclui o débito síncrono via financial.
- [ ] Resposta de saldo insuficiente é explícita e não cria aposta aceita.

### US-003: Solicitar cashout de uma aposta própria

**Como** jogador autenticado, **quero** solicitar cashout de uma aposta minha enquanto a rodada está running **para** receber o payout calculado pela engine.

**Critérios de aceitação:**

- [ ] O jogador só consulta ou altera apostas cuja propriedade tenha sido confirmada no servidor.
- [ ] Cashout só é solicitado para aposta active e enquanto a rodada correspondente aceita cashout.
- [ ] O operador usa o resultado autoritativo do Crashsim para betId, estado, multiplicador e payout.
- [ ] Aposta inexistente, de outro jogador, já resolvida ou em rodada não executável retorna resultado controlado sem criar outro efeito.

### US-004: Recuperar o resultado de um comando sem resposta

**Como** jogador autenticado, **quero** que o operador determine o resultado real de uma aposta ou cashout após timeout **para** evitar duplicidade e não receber um falso resultado de falha.

**Critérios de aceitação:**

- [ ] Timeout ou desconexão após envio de comando é representado como unknown até haver evidência autoritativa.
- [ ] Cashout com resultado desconhecido é consultado por GET /bets/:id antes de ser declarado falho ou reenviado.
- [ ] Aposta com resultado desconhecido não é reenviada às cegas; o operador tenta associar o débito persistido ao betId e consultar a engine.
- [ ] Se o resultado da aposta não puder ser identificado com segurança, o estado permanece desconhecido e novas apostas do jogador ficam bloqueadas até resolução ou término da rodada.

### US-005: Continuar com segurança durante desconexão do stream

**Como** jogador, **quero** saber quando o estado da rodada está desatualizado **para** não enviar uma aposta ou cashout usando informação antiga.

**Critérios de aceitação:**

- [ ] Enquanto a conexão estiver reconnecting ou synchronizing, o último estado fica marcado como não atual e comandos financeiros são recusados.
- [ ] Após reconectar, os comandos só são liberados depois que o operador aplica um snapshot autoritativo atual.
- [ ] Evento atrasado ou fora de ordem não reabre uma rodada encerrada nem torna válido um comando que a rodada não aceita.

## Requisitos funcionais

### FR-001: Sessão Crashsim vinculada à identidade — Must Have

QUANDO um jogador autenticado abre o jogo
O SISTEMA DEVE provisionar sua carteira e criar uma sessão Crashsim usando o ID persistente retornado pela autenticação
PARA QUE as apostas e os webhooks financeiros se refiram ao jogador correto.

O cliente não pode enviar um playerId para substituir a identidade autenticada. Criar uma sessão para outro jogador ou expor credenciais do operador não é permitido.

### FR-002: Elegibilidade de comandos por rodada — Must Have

QUANDO o jogador solicita aposta ou cashout
O SISTEMA DEVE validar autenticação, propriedade, sincronização e fase corrente da rodada antes de enviar o comando
PARA QUE estados stale ou uma aposta pertencente a outra conta não produzam uma ação financeira.

A engine permanece a autoridade final sobre aceitação de aposta e cashout; uma mudança concorrente de fase é devolvida como resultado de conflito do jogo, sem ser convertida em sucesso.

### FR-003: Criar uma aposta — Must Have

QUANDO uma solicitação válida de aposta é enviada durante betting
O SISTEMA DEVE chamar a engine associando sessão, jogador, rodada e valor, e aguardar o resultado do débito financeiro
PARA QUE só uma aposta com débito confirmado seja tratada como aceita.

Valor em centavos deve ser inteiro positivo e respeitar o máximo atual de 1.000.000.000. O parâmetro opcional autoCashout respeita o contrato atual do Crashsim: de 1.01 até 1.000.000, com no máximo duas casas decimais. A engine pode recusar uma rodada que fechou entre a validação local e o comando.

### FR-004: Evitar apostas duplicadas por jogador e rodada — Must Have

QUANDO uma aposta aceita ou em resultado desconhecido já existe para o jogador na rodada atual
O SISTEMA DEVE impedir outra aposta aceita nessa rodada e retornar o resultado existente para repetição da mesma chave de comando
PARA QUE retries HTTP não criem dois bets nem dois débitos.

O MVP permite no máximo uma aposta aceita por jogador por rodada. Uma recusa definitiva 402 não ocupa essa vaga: depois de adicionar saldo, o jogador pode fazer uma nova tentativa enquanto a rodada ainda estiver em betting, usando uma nova chave de comando. Uma tentativa ainda desconhecida bloqueia nova tentativa nessa rodada.

### FR-005: Resultado desconhecido na criação de aposta — Must Have

QUANDO a chamada POST /bets não produz resposta conclusiva
O SISTEMA DEVE preservar o comando como desconhecido, tentar identificar o betId pela operação de débito persistida e consultar o bet quando o ID estiver disponível
PARA QUE uma resposta perdida não cause uma segunda aposta nem uma falha inventada.

O operador não deve reenviar POST /bets quando o resultado da chamada original for ambíguo. Se não puder obter um betId e validar o resultado com a fonte autoritativa, mantém unknown e bloqueia nova aposta do jogador naquela rodada até resolução ou término da rodada.

### FR-006: Cashout restrito ao dono da aposta — Must Have

QUANDO um jogador solicita cashout ou consulta uma aposta
O SISTEMA DEVE confirmar no servidor que o jogador autenticado é dono do betId
PARA QUE uma conta não possa consultar ou liquidar a aposta de outra conta.

A autorização não pode depender de um playerId no body/query nem de estado informado pelo navegador. BetId inválido, inexistente ou de outro jogador não causa alteração financeira.

### FR-007: Resultado do cashout e liquidação financeira — Must Have

QUANDO a engine confirma cashout
O SISTEMA DEVE registrar o resultado de jogo e acompanhar separadamente a confirmação do crédito no ledger financeiro
PARA QUE cashed_out não seja apresentado como saldo creditado antes de o crédito persistir.

O Crashsim pode responder ao comando antes de concluir a chamada assíncrona do webhook de crédito. O operador só declara a liquidação concluída quando o módulo financial confirma o crédito correspondente ao mesmo betId; os retries e a regra de crédito único continuam sob F03.

### FR-008: Reconciliar timeout de cashout — Must Have

QUANDO o comando de cashout termina sem resposta conclusiva
O SISTEMA DEVE consultar GET /bets/:id antes de reportar falha ou tentar novamente
PARA QUE o cliente receba o estado verdadeiro sem disparar um segundo cashout.

Se o GET confirmar cashed_out, o operador apresenta o resultado da engine e o estado de liquidação financeira. Se confirmar que a aposta continua active, uma nova tentativa só pode ocorrer após validar novamente rodada e propriedade. Se engine e consulta não responderem, o resultado permanece desconhecido.

### FR-009: Recriar sessão inválida com segurança — Must Have

QUANDO a engine informar que a sessão Crashsim não existe mais
O SISTEMA DEVE criar uma sessão para o jogador autenticado antes de aceitar um comando futuro
PARA QUE reinícios da engine não permitam reutilizar uma sessão inválida ou atribuir um bet a outro jogador.

Uma resposta definitiva session_not_found indica que aquele comando não foi aceito com aquela sessão. Timeout ou erro de rede não deve ser interpretado como session_not_found.

### FR-010: Erros e falhas do comando — Must Have

QUANDO validação, engine, stream, autenticação ou persistência impedirem a conclusão do comando
O SISTEMA DEVE retornar um resultado estável que distinga recusa definitiva, conflito, indisponibilidade e estado desconhecido
PARA QUE o cliente possa reagir sem reenviar uma operação financeira incerta.

As falhas não devem expor stack, chave do operador, segredo de webhook ou credenciais. A perda de conexão não pode virar sucesso nem uma falha definitiva quando o resultado financeiro ainda for desconhecido.

## Requisitos não funcionais

### NFR-001: Exatidão financeira

- Valores de aposta são centavos inteiros e respeitam limites do contrato da engine; nenhuma validação monetária depende de arredondamento.
- O resultado de cashout/payout tem a precisão que o contrato atual e F03 permitem. Payout inseguro continua sujeito ao incidente e à limitação definidos por D-009 da F03.
- A confirmação de aposta depende do resultado do débito persistido por F03.

### NFR-002: Idempotência e concorrência

- Solicitações repetidas com a mesma chave de comando não criam um segundo bet ou cashout.
- Somente uma aposta aceita ou desconhecida por jogador e rodada fica aberta no MVP; recusa definitiva permite uma nova tentativa com nova chave.
- A mesma aposta não pode ser cashoutada ou creditada duas vezes, mesmo com retry, timeout ou webhook atrasado.
- Uma queda do operador após comando enviado não perde um resultado já persistido enquanto o estado correspondente ainda estiver disponível no Crashsim.

### NFR-003: Segurança e privacidade

- Todas as rotas de comando exigem sessão autenticada do operador e obtêm o jogador por auth.requireUser.
- Valide conteúdo do browser e respostas relevantes da engine; nunca confie em sessionId, playerId, status de aposta ou payout escolhidos pelo cliente.
- Chaves e sessões Crashsim permanecem no lado servidor e não aparecem em payloads/logs de browser.
- Respostas de propriedade negada não revelam dados de outros jogadores.

### NFR-004: Consistência realtime

- Aposta e cashout são bloqueados até a conexão estar sincronizada com o snapshot atual da engine.
- O último estado fica congelado e identificado como desatualizado durante desconexão.
- Rodada, seq e status monotônicos do F01 permanecem válidos; um tick atrasado não reabre uma rodada crashed.

### NFR-005: Diagnóstico e operação

- Logs distinguem comando enviado, aceito, recusado, desconhecido e reconciliado, com correlação segura.
- Um estado desconhecido é observável e não desaparece por timeout local.
- Erros da engine são registrados sem credenciais ou payload financeiro integral.

## Fora do escopo

- Implementar PostgreSQL/auth ou ledger/webhooks financeiros, pertencentes a F02 e F03.
- Interface completa de jogador, saldo e controles React, pertencente a F05.
- Worker ou painel de reconciliação operacional para callbacks de cashout não entregues, pertencente a F06.
- Persistir estado interno do próprio Crashsim, oferecer replay histórico da engine ou garantir recuperação depois de reinício dela.
- Adicionar outro jogo, provider, adapter genérico ou registry.
- Alterar o protocolo/implementação da engine para adicionar idempotência nesta feature; F04 mantém o contrato atual e aplica proteção no operador.

## Decisões

### D-001: Limitar uma aposta aceita por jogador e rodada sem alterar a engine

**Decisão:** não alterar o protocolo Crashsim. O operador mantém no máximo uma aposta aceita ou desconhecida por jogador/rodada, não repete às cegas uma criação com resultado ambíguo, tenta recuperar o betId pela operação de débito persistida e consulta a aposta. Se não conseguir confirmar o resultado, conserva unknown e bloqueia nova aposta para aquele jogador na rodada.
**Motivo:** a engine não aceita chave idempotente em POST /bets e o betId só aparece na resposta ou no webhook de débito; repetir um pedido ambíguo pode criar nova aposta e novo débito.
**Fonte:** Q-001, resposta explícita do usuário.
**Impacta:** US-002, US-004, FR-004, FR-005, NFR-002 e Fora do escopo.

### D-002: Permitir nova tentativa após recusa definitiva de saldo

**Decisão:** 402 confirmado é uma recusa final daquela tentativa; o jogador pode adicionar saldo e tentar de novo na mesma rodada, se ela ainda estiver em betting, com uma nova chave de comando. Uma tentativa desconhecida continua bloqueando a rodada.
**Motivo:** diferenciar uma recusa financeira certa de uma criação cujo resultado não foi recebido preserva retry útil sem abrir duplicidade.
**Fonte:** Q-002, resposta explícita do usuário.
**Impacta:** US-002, FR-003–FR-005 e NFR-002.

### D-003: Abrir sessão de jogo pela identidade autenticada

**Decisão:** ao abrir o jogo, o operador provisiona carteira e solicita sessão Crashsim com o ID persistente retornado por auth; identidade e chaves nunca são escolhidas pelo browser.
**Motivo:** a engine precisa do mesmo playerId que chega no webhook para associar a carteira.
**Fonte:** decisão explícita anterior do usuário e design F03.
**Impacta:** US-001, FR-001, FR-006 e NFR-003.

### D-004: Consultar aposta após resultado desconhecido do cashout

**Decisão:** consultar GET /bets/:id antes de declarar falha ou repetir cashout; acompanhar o estado de jogo separado do estado do crédito em F03.
**Motivo:** a engine pode ter aceitado o cashout antes de a conexão expirar, e o GET fornece o estado verdadeiro enquanto a aposta ainda estiver disponível.
**Fonte:** comportamento esperado no ASSESSMENT.md, convenções críticas do operador e decisão prévia do usuário.
**Impacta:** US-003, US-004, FR-007, FR-008 e NFR-002.

## Perguntas

### Q-001: Como evitar duplicidade se a resposta de POST /bets se perder?

**Status:** answered
**Resposta:** não alterar a engine; limitar a uma aposta aceita ou desconhecida por jogador/rodada, não reenviar às cegas, recuperar pelo débito persistido quando possível e manter desconhecido/bloqueado quando não houver confirmação segura.
**Decisão:** D-001.

### Q-002: O que fazer depois de um débito recusado com 402?

**Status:** answered
**Resposta:** permitir nova tentativa enquanto a rodada ainda estiver aberta, depois de saldo suficiente, com nova chave de comando; resultado desconhecido bloqueia nova tentativa.
**Decisão:** D-002.

## Glossário

- **Bet / aposta:** aposta identificada pela engine por betId, vinculada a jogador, rodada e valor.
- **Resultado desconhecido:** comando enviado sem resposta suficiente para determinar se a engine o aceitou.
- **Sessão Crashsim:** credencial de curta duração criada pela engine e associada ao playerId; não é a sessão de login do operador.
- **Liquidação:** crédito persistido no ledger financeiro correspondente a um cashout já aceito pela engine.
- **Chave de comando:** identificador estável do pedido do cliente ao operador usado para deduplicar retries HTTP.
