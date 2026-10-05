# Feature: Carteira, ledger e webhooks financeiros

> Status: Approved
> Source: `.ai/sdd/PLAN.md` — F03; `ASSESSMENT.md`; `ORIGINAL_README.md`; contrato em `engine/src/wallet.js`, `engine/src/bets.js` e `engine/src/http.js`

## Visão geral

Implementar o módulo `financial` do operador para manter a carteira de cada jogador e processar os débitos de apostas e créditos de cashout enviados pela engine Crashsim. O saldo persistente é a autoridade para permitir apostas e apresentar o valor disponível nos fluxos futuros do cliente.

A engine envia `txId`, `playerId`, `amount`, `betId` e `roundId` nos webhooks `POST /wallet/debit` e `POST /wallet/credit`. Espera `200 { balance }` quando a operação é concluída e `402` quando um débito não pode ser pago. Reenvios podem ocorrer, inclusive por timeout após o operador ter aplicado a transação.

## Contexto de negócio

Duplicar um débito permite apostar acima do saldo; duplicar um crédito paga duas vezes. Duas apostas simultâneas não podem consumir mais do que o saldo disponível. O operador precisa vincular o `playerId` persistente do webhook à carteira correta sem depender de uma sessão de navegador.

Valores financeiros são inteiros em unidades menores. O módulo mantém operações idempotentes e deixa um contrato para outros módulos consultarem o saldo. A recuperação operacional de liquidações que excedam as tentativas da engine está planejada para F06.

## Histórias de usuário

### US-001: Consultar meu saldo

**Como** jogador, **quero** consultar o saldo disponível da minha conta **para** saber se posso fazer uma aposta.

**Critérios de aceitação:**

- [ ] O saldo pertence ao jogador identificado pelo operador e não pode ser escolhido por `playerId` enviado pelo navegador.
- [ ] O saldo retornado representa o estado persistido após as operações financeiras confirmadas.
- [ ] A API não expõe transações ou saldos de outro jogador.

### US-002: Debitar uma aposta com segurança

**Como** operador, **quero** descontar uma aposta uma única vez **para** que a engine só aceite apostas cobertas pelo saldo.

**Critérios de aceitação:**

- [ ] Um débito válido diminui saldo e registra a operação financeira de forma indivisível.
- [ ] Saldo insuficiente é recusado e não pode tornar a carteira negativa.
- [ ] Débitos simultâneos respeitam o saldo disponível; não há leitura seguida de escrita que permita overspend.
- [ ] Reenviar a mesma operação não aplica outro débito e devolve o resultado original.

### US-003: Creditar um cashout com segurança

**Como** jogador, **quero** receber no saldo o valor do cashout confirmado pela engine **para** que o operador reflita o resultado financeiro da aposta.

**Critérios de aceitação:**

- [ ] Um crédito válido aumenta saldo e registra a operação financeira de forma indivisível.
- [ ] Reenvios da mesma operação não duplicam o crédito e retornam o mesmo resultado confirmado.
- [ ] Indisponibilidade ou falha de persistência não é confirmada como crédito concluído.
- [ ] Webhook com `amount` não seguro é rejeitado sem mutação e gera incidente; o payout aproximado não é recuperado automaticamente pelo F06.

### US-004: Confiar na origem da operação

**Como** operador, **quero** aceitar somente webhooks autênticos e recentes **para** que terceiros não alterem saldos.

**Critérios de aceitação:**

- [ ] Assinatura ausente, incorreta, corpo alterado ou timestamp fora da janela é rejeitado sem mutar carteira.
- [ ] A validação usa exatamente o corpo recebido da engine antes de qualquer parse/normalização.
- [ ] A autenticação do webhook não depende da sessão de navegador do jogador.

### US-005: Manter o histórico financeiro consistente

**Como** operador, **quero** consultar o histórico de operações confirmado **para** explicar a formação do saldo e investigar divergências.

**Critérios de aceitação:**

- [ ] Cada débito/crédito confirmado é associado ao jogador, `txId`, tipo, valor e referência da aposta/rodada quando presentes.
- [ ] Uma operação já aplicada não é apagada nem reescrita para acomodar um reenvio.
- [ ] Uma falha de crédito que esgote as tentativas da engine continua elegível ao fluxo de reconciliação previsto para F06.
- [ ] Webhook e recuperação identificam o mesmo cashout por `betId`; crédito já confirmado não pode ser aplicado outra vez por webhook atrasado ou reconciliação.

### US-006: Adicionar saldo de teste local

**Como** jogador autenticado no ambiente local, **quero** adicionar saldo de teste à minha carteira **para** experimentar apostas sem integrar um meio de pagamento.

**Critérios de aceitação:**

- [ ] A carteira começa em zero e o jogador pode solicitar um crédito de teste em USD.
- [ ] A operação credita somente a carteira da identidade autenticada, mesmo se o pedido contiver outro `playerId`.
- [ ] A recarga aparece no saldo e no histórico como crédito de teste, distinta de crédito enviado pela engine.
- [ ] O recurso não fica disponível em ambiente de produção.

## Requisitos funcionais

### FR-001: Carteira por jogador — Must Have

QUANDO um jogador persistente passa a usar operações financeiras
O SISTEMA DEVE disponibilizar uma carteira associada ao ID estável da conta
PARA QUE as operações da engine atinjam a identidade correta.

Para este MVP, a moeda é USD e carteiras começam com saldo zero; jogadores podem adicionar saldo de teste somente no ambiente local, conforme D-004 e D-005.

### FR-002: Webhook de débito — Must Have

QUANDO a engine envia um débito assinado para `/wallet/debit`
O SISTEMA DEVE validar o evento e aplicar a operação uma única vez ao jogador indicado pelo `playerId`
PARA QUE uma aposta só consuma saldo disponível.

Se o saldo não for suficiente, o sistema deve persistir o resultado de recusa associado ao `txId` e retornar `402`, sem lançamento financeiro ou alteração do saldo. Reenvios idênticos devem devolver a mesma recusa; após adicionar saldo, uma nova tentativa exige outro `txId`. Se o débito for confirmado, deve retornar `200 { balance }` com o saldo resultante confirmado.

O `amount` recebido deve ser um inteiro positivo seguro para o contrato JSON numérico do operador (`Number.isSafeInteger`). Valor fora dessa faixa deve ser rejeitado como inválido antes de qualquer mutação.

### FR-003: Webhook de crédito — Must Have

QUANDO a engine envia um crédito assinado para `/wallet/credit`
O SISTEMA DEVE aplicar o crédito uma única vez ao jogador indicado pelo `playerId`
PARA QUE o cashout confirmado pela engine aumente o saldo sem pagamento duplicado.

O operador só pode responder `200 { balance }` depois de confirmar a persistência do crédito e do novo saldo. Falha que impeça essa confirmação deve resultar em resposta não-success para permitir o retry da engine com o mesmo `txId`.

Cada cashout pode gerar no máximo um crédito confirmado. O `txId` protege retries do webhook; `betId` também identifica o cashout entre a entrega normal e a reconciliação posterior.

O operador rejeita com `422` um `amount` que não seja um inteiro seguro para JSON, sem alterar saldo, operação financeira aplicada ou ledger. Como a engine não repete respostas 4xx e sua consulta de aposta fornece o payout pelo mesmo contrato numérico, F06 não deve creditar esse valor aproximado; deve registrar o cashout como incidente de precisão sem recuperação automática.

### FR-004: Idempotência por `txId` — Must Have

QUANDO a engine repete um webhook com o mesmo `txId` e mesmo conteúdo financeiro
O SISTEMA DEVE preservar o efeito financeiro original e devolver a resposta original
PARA QUE retries após timeout não dupliquem nem reinterpretem uma operação já processada.

QUANDO o mesmo `txId` chega com jogador, tipo ou valor diferentes
O SISTEMA DEVE rejeitar a reutilização conflitante sem alterar a carteira ou o histórico
PARA QUE uma chave idempotente não possa ser usada para mudar a operação original.

Para créditos de cashout, o operador também deve tratar `betId` como chave de correlação única do pagamento. Se o webhook chegar depois de a reconciliação já ter creditado o mesmo jogador e valor, deve devolver o resultado existente sem novo crédito. `betId` repetido com jogador ou valor divergente deve ser rejeitado e sinalizado para investigação.

### FR-005: Concorrência e limite de saldo — Must Have

QUANDO múltiplos débitos concorrentes atuam sobre a mesma carteira
O SISTEMA DEVE serializar ou condicionar as mutações ao saldo atual na persistência
PARA QUE o saldo nunca fique negativo e não haja gasto acima do disponível.

A atualização de saldo, a operação correspondente e sua chave de idempotência devem ter resultado consistente mesmo se o processo ou a conexão cair durante a confirmação.

### FR-006: Assinatura e frescor do webhook — Must Have

QUANDO um webhook financeiro chega
O SISTEMA DEVE validar a assinatura HMAC da engine sobre o timestamp e os bytes exatos do corpo, além de rejeitar timestamps fora da janela permitida
PARA QUE payloads adulterados ou replayados fora da janela não alterem o saldo.

O formato atual usa os headers `x-timestamp` e `x-signature`, assinatura HMAC-SHA256 sobre `${timestamp}.${rawBody}`. Segredo só existe no servidor; assinatura inválida, antiga ou futura não cria operação financeira.

### FR-007: Saldo para módulos do operador — Must Have

QUANDO outro fluxo confiável do operador consulta o saldo de um jogador
O SISTEMA DEVE fornecer saldo e moeda pelo contrato público do módulo `financial`
PARA QUE game e a futura API do cliente usem o valor persistido sem acessar tabelas privadas.

A rota de consulta para o jogador deve exigir identidade de auth e será definida no desenho desta spec; operações do webhook continuam independentes de sessão de navegador.

O contrato interno também deve permitir que F06 consulte se o cashout de um `betId` já foi creditado, sem acessar tabelas privadas, e acione a recuperação pela mesma regra idempotente.

### FR-008: Falhas e retries — Must Have

QUANDO banco, validação ou persistência impedem concluir um webhook
O SISTEMA DEVE evitar confirmar uma mutação não persistida e retornar resultado compatível com o contrato de retry da engine
PARA QUE uma tentativa repetida possa completar sem duplicidade.

O sistema deve registrar falhas suficientes para diagnóstico sem incluir segredo, assinatura, credencial, payload financeiro integral ou dados sensíveis do jogador nos logs. F03 não manterá inbox nem worker para callbacks. Se o crédito não chegar após os retries da engine, F04 mantém o resultado conhecido do cashout e F06 compara o estado da aposta obtido da engine com o ledger; somente o crédito ausente é recuperado, pela mesma regra idempotente e sem ajuste manual no banco.

Exceção: se o payout retornado pela engine não for um inteiro seguro, F06 registra um incidente não reconciliável pelo contrato atual e não converte nem credita o número aproximado.


### FR-009: Crédito de teste local — Must Have

QUANDO um jogador autenticado solicita saldo de teste em ambiente local
O SISTEMA DEVE creditar o valor solicitado à carteira associada à sessão autenticada e registrar o crédito como operação de teste
PARA QUE o jogador possa exercitar o fluxo de apostas sem integração de pagamento.

A carteira inicia em zero. O valor deve ser positivo e inteiro em centavos de USD. A operação deve ser identificável e protegida contra repetição acidental da mesma solicitação. O endpoint não pode aceitar `playerId` do cliente como identidade. O recurso deve falhar fechado e não ser registrado em ambiente de produção.

## Requisitos não funcionais

### NFR-001: Exatidão monetária

- Valores de saldo, débito e crédito são inteiros em unidades menores; nenhuma operação usa ponto flutuante para armazenar ou comparar dinheiro.
- Webhook `amount` e saldo numérico retornado à engine devem ser inteiros seguros (`Number.isSafeInteger`). Um `amount` fora da faixa é rejeitado antes do banco; se o saldo resultante ultrapassaria a faixa, registrar a recusa idempotente sem alterar carteira/ledger. O operador não arredonda nem tenta inferir o payout original.
- Somente valores inteiros positivos dentro da faixa segura do contrato JSON podem produzir mutação.
- Não há conversão cambial implícita.

### NFR-002: Consistência e idempotência

- A unicidade de `txId`, o resultado idempotente e a alteração de saldo são confirmados como uma única unidade de persistência.
- Duas requisições com o mesmo `txId` em paralelo produzem no máximo um efeito financeiro.
- Um timeout com resultado de commit desconhecido é resolvido pelo mesmo `txId`, não por uma nova transação.
- Créditos e débitos distintos concorrentes sobre a mesma carteira não perdem atualizações.
- Uma recuperação de cashout e um webhook atrasado do mesmo `betId` produzem no máximo um crédito, mesmo que a recuperação precise de uma chave técnica própria.

### NFR-003: Segurança e privacidade

- Validar método, rota, headers, tamanho e estrutura dos webhooks antes de processar valores.
- Comparar assinatura sem diferença temporal que permita comparação insegura; manter segredo apenas na configuração do servidor.
- Nunca logar segredo, assinatura, `rawBody`, Authorization ou credenciais de banco.
- Um `playerId` desconhecido não recebe crédito nem débito e não cria uma carteira órfã.

### NFR-004: Operação

- Documentar segredo e endpoint configurados para a engine, respostas esperadas, retries, consulta de saldo e recuperação após falha.
- O caminho de débito permanece síncrono do ponto de vista da engine: a engine só decide se aceita a aposta após a resposta do operador.
- Débito e crédito são processados de forma síncrona: só responder `200` depois de confirmar a transação financeira persistida. Não confirmar callbacks apenas por enfileirá-los em memória.

### NFR-005: Limite do crédito de teste

- O crédito manual é exclusivo para desenvolvimento/teste local; não simula pagamento, saque, bônus comercial ou dinheiro resgatável.
- Configuração de produção não pode habilitar o crédito manual por valor padrão nem por erro de configuração.
- O crédito de teste é registrado com origem distinta dos webhooks Crashsim e não altera o contrato de assinatura da engine.

## Fora do escopo

- Cadastro/login de jogadores — F02.
- Sessões Crashsim, criação de aposta, cashout e reconciliação por estado da aposta — F04.
- UI React do saldo e autenticação da SSE — F05.
- Integração com pagamentos, depósitos/saques em dinheiro real, bônus comerciais, tarifas, câmbio ou backoffice de ajustes; o crédito de teste local é a única exceção de funding deste MVP.
- Recuperação operacional completa após a engine esgotar os retries — F06.
- Outros provedores, Redis ou múltiplas réplicas nesta fase.

## Decisões

### D-001: Valores monetários em unidades menores inteiras

**Decisão:** saldo, débito e crédito são armazenados e transmitidos como inteiros em centavos/unidade menor, conforme o contrato Crashsim.
**Motivo:** evita arredondamento e corresponde ao valor `amount` inteiro enviado pela engine.
**Fonte:** `ASSESSMENT.md`, `ORIGINAL_README.md` e steering de convenções.
**Impacta:** US-001–US-005, FR-002–FR-008 e NFR-001.

### D-002: Webhooks financeiros são independentes do login web

**Decisão:** autenticar callbacks pela assinatura da engine e mapear seu `playerId` para a conta/carteira persistente, sem exigir sessão de navegador.
**Motivo:** a engine liquida uma aposta mesmo se o jogador sair ou sua sessão expirar.
**Fonte:** roadmap F03 aprovado e instrução anterior do usuário sobre liquidação independente do logout.
**Impacta:** US-002–US-004, FR-002–FR-008.

### D-003: Um único efeito por `txId`

**Decisão:** cada chave idempotente identifica um efeito financeiro; conteúdo conflitante com chave já usada não pode alterar o saldo.
**Motivo:** engine repete callbacks após timeout e pode duplicar créditos.
**Fonte:** instrução de falhas críticas, `.ai/sdd/PLAN.md` e seção Wallet de `ASSESSMENT.md`.
**Impacta:** US-002, US-003, FR-004, FR-005 e NFR-002.

### D-004: USD como moeda única do MVP

**Decisão:** todos os saldos e operações financeiras deste MVP são em USD, representados em centavos; não haverá conversão nem carteiras multi-moeda.
**Motivo:** o contrato Crashsim envia valores inteiros sem moeda; o operador precisa atribuir uma interpretação única.
**Fonte:** resposta explícita do usuário.
**Impacta:** US-001–US-006, FR-001–FR-009 e NFR-001.

### D-005: Recarga de teste local pelo jogador

**Decisão:** a carteira começa em zero e o jogador autenticado pode solicitar créditos de teste em ambiente local. Não há integração com pagamentos; o crédito é registrado como operação distinta da liquidação Crashsim e não pode ser habilitado em produção.
**Motivo:** permitir testar apostas neste MVP local sem conceder fundos a contas em produção nem depender de pagamentos externos.
**Fonte:** resposta explícita do usuário.
**Impacta:** US-001, US-006, FR-001, FR-007, FR-009, NFR-005 e Fora do escopo.

### D-006: Recusa de débito idempotente

**Decisão:** quando o saldo for insuficiente, persistir a recusa `402` associada ao `txId`, sem criar lançamento financeiro nem alterar o saldo. Repetições do mesmo débito retornam a mesma recusa; uma nova tentativa depois de adicionar saldo precisa de outro `txId`.
**Motivo:** o mesmo identificador deve conservar um resultado estável, inclusive quando a resposta original se perde e a engine repete a chamada.
**Fonte:** recomendação aceita pelo usuário; retries da engine reutilizam o corpo e o `txId` originais.
**Impacta:** US-002, FR-002, FR-004, NFR-002.

### D-007: Confirmar webhook após persistir a operação

**Decisão:** aplicar débito/crédito e confirmar sua persistência antes de responder `200` à engine. Se a persistência falhar, responder com erro para permitir retry com o mesmo `txId`.
**Motivo:** a engine só deve tratar o débito como aceito ou o crédito como entregue depois que o operador tiver confirmado o estado financeiro; a idempotência resolve retries após timeout.
**Fonte:** recomendação aceita pelo usuário; contrato síncrono de débito e retries documentados na engine.
**Impacta:** US-002, US-003, FR-002, FR-003, FR-008, NFR-002 e NFR-004.

### D-008: Recuperar cashouts em F04/F06

**Decisão:** F03 processa webhooks de forma síncrona e não cria inbox/worker. F04 persiste o resultado conhecido do cashout e seu estado de liquidação; F06 identifica cashouts sem crédito correspondente ao comparar a aposta na engine com o ledger. A recuperação usa o módulo `financial`, respeita `txId` e garante um único crédito por `betId`, mesmo se o webhook original chegar atrasado.
**Motivo:** retries cobrem falhas transitórias; a reconciliação cobre falhas persistentes sem expandir F03 com uma fila de comandos. A recuperação e o uso de `GET /bets/:id` também são cenários explícitos do assessment.
**Limite conhecido:** no engine atual, apostas são mantidas em memória. A consulta não garante recuperação depois de reinício da engine; recuperação durável após esse reinício exige suporte durável do engine.
**Fonte:** recomendação aceita pelo usuário; `ASSESSMENT.md` (timeout de cashout e incidente de créditos não entregues).
**Impacta:** US-003, US-005, FR-003, FR-004, FR-007, FR-008 e NFR-002.

### D-009: Rejeitar valores fora da faixa inteira segura no operador

**Decisão:** não alterar a engine. O operador aceita somente `amount` e saldo resultante representáveis como inteiros JSON seguros. `amount` inseguro recebe `422` antes de tocar o banco e gera incidente de precisão; crédito/top-up seguro que ultrapassaria o teto persiste apenas a recusa idempotente, sem alterar carteira/ledger. Como a engine trata 4xx como terminal e `GET /bets/:id` expõe o payout pelo mesmo contrato numérico, F06 não credita o valor aproximado nem declara a liquidação recuperada automaticamente.
**Motivo:** acima de `Number.MAX_SAFE_INTEGER`, o Crashsim pode perder precisão ao converter o payout de `BigInt` para `number`; o operador não tem informação suficiente para reconstruir o valor matemático original.
**Fonte:** decisão explícita do usuário; contrato observado em `engine/src/bets.js`, `engine/src/wallet.js` e `ORIGINAL_README.md`.
**Impacta:** US-003, FR-003, FR-008, NFR-001 e D-008.

## Perguntas

### Q-001: Qual escopo de moeda deve ter o MVP?

**Status:** answered

**Resposta:** USD único, valores em centavos; sem câmbio nem multi-moeda neste MVP.
**Decisão:** D-004.

### Q-002: Como carteiras recebem saldo inicial?

**Status:** answered

**Resposta:** carteira inicia em zero. Jogador autenticado pode adicionar saldo de teste somente no ambiente local; não há integração de pagamento, e essa ação é desabilitada em produção.
**Decisão:** D-005.

### Q-003: O que deve ocorrer ao repetir um débito originalmente recusado?

**Status:** answered
**Resposta:** seguir a recomendação: preservar a recusa `402` para o mesmo `txId`; depois de adicionar saldo, uma nova tentativa usa outro `txId`.
**Decisão:** D-006.
**Por que importa:** uma chave `txId` deve identificar um resultado estável; reavaliar depois que o jogador recebeu saldo pode transformar o mesmo callback em um novo débito.
**Recomendação:** repetir exatamente a recusa `402` original, mesmo se o saldo mudou depois. **Aceita.**

| Opção | Resposta | Escolha quando... | Impacto |
|--------|----------|-------------------|---------|
| A | Replay mantém o `402` original (recomendado) | `txId` representa uma única tentativa financeira imutável | Registrar o resultado recusado para idempotência; novo intento precisa de outro `txId`. |
| B | Reavaliar o saldo em cada repetição | A engine reutiliza o mesmo `txId` como consulta até o débito ser aceito | O mesmo `txId` pode primeiro falhar e depois debitar; idempotência cobre só operações aceitas. |
| C | Não persistir recusas | Só operações bem-sucedidas entram no registro idempotente | Reenvios recusados são reavaliados pelo saldo atual e não há resposta original persistida. |
| Custom | Outra regra | O contrato da engine usa chave de forma diferente | Atualizar critérios e cenário de retry. |

### Q-004: Em que momento a engine deve receber confirmação de um webhook?

**Status:** answered
**Resposta:** seguir a recomendação: aplicar e persistir débito/crédito antes de retornar `200`; em falha, responder erro para retry com o mesmo `txId`.
**Decisão:** D-007.
**Por que importa:** responder antes de processar o débito pode permitir uma aposta sem a reserva do saldo; o README inicial também menciona fila assíncrona, que precisa ter comportamento recuperável.
**Recomendação:** esperar a transação persistente terminar e então responder; débito e crédito seguem o mesmo contrato simples no MVP. **Aceita.**

| Opção | Resposta | Escolha quando... | Impacto |
|--------|----------|-------------------|---------|
| A | Aplicar e persistir antes do `200` (recomendado) | Correção imediata do saldo e simplicidade são prioridade | Webhook espera a transação; em falha responde erro e engine tenta novamente com o mesmo `txId`. |
| B | Gravar em inbox durável e responder após essa gravação | É necessário desacoplar processamento sem perder callbacks | Saldo pode ainda não refletir o crédito quando chega `200`; consumidor durável e estado pendente fazem parte do escopo. |
| C | Enfileirar em memória e responder imediatamente | Apenas protótipo descartável, sem garantia de recuperação após restart | Uma queda pode perder callbacks já reconhecidos; incompatível com dinheiro real. |
| Custom | Outra regra | Existe contrato de fila/latência específico | Atualizar critérios, respostas e escopo. |

### Q-005: Onde fica a recuperação de créditos de cashout após esgotar retries?

**Status:** answered
**Resposta:** seguir a recomendação: F04 registra o cashout confirmado; F06 reconcilia o resultado da engine com o ledger e recupera apenas o crédito ausente, de forma idempotente por cashout. F03 não terá inbox/worker.
**Decisão:** D-008.
**Por que importa:** a engine tenta entregar o crédito e pode esgotar retries sem notificar o operador; o saldo confirmado pode ficar abaixo do resultado do cashout.
**Recomendação:** manter F03 síncrona e sem inbox/worker. F04 persiste o cashout confirmado e o estado de liquidação pendente; F06 compara `payout`/`betId` com o ledger e credita o que faltar usando uma chave de negócio estável por cashout. O webhook original e a reconciliação devem convergir para o mesmo efeito: um webhook atrasado após a reconciliação não pode creditar de novo. **Aceita.**

Se a resposta do cashout for desconhecida, F04/F06 pode consultar `GET /bets/:id` enquanto a engine ainda retém a aposta. No engine atual, as apostas vivem em um `Map` em memória (`engine/src/bets.js`); portanto, a consulta não sobrevive a um reinício da engine. Recuperação que sobreviva a esse reinício exige estado durável ou uma garantia equivalente do engine e não pode ser prometida apenas pelo operador.

| Opção | Resposta | Escolha quando... | Impacto |
|--------|----------|-------------------|---------|
| A | Deixar detecção e reconciliação para F04/F06 (recomendado) | Queremos o escopo direto de F03 e uma recuperação baseada no resultado do cashout | F04 persiste o cashout confirmado; F06 compara a aposta com o ledger e credita uma vez por `betId`; webhook e recuperação deduplicam pelo mesmo cashout. Sobrevive a falhas do operador, desde que a fonte do estado do cashout ainda esteja disponível. |
| B | Incluir inbox durável e processamento recuperável em F03 | O operador precisa assumir e exibir créditos pendentes já nesta feature | Registra webhooks recebidos para processamento posterior, mas não recupera um callback que nunca chegou; adiciona estado pendente, worker/retry e muda o momento da confirmação à engine. |
| Custom | Outra regra | A responsabilidade deve ficar em outra fase ou seguir outro fluxo | Atualizar limites de F03/F04/F06 e critérios de recuperação. |

## Glossário

- **Carteira:** saldo disponível persistente associado a um jogador e a uma moeda.
- **Ledger:** histórico de operações financeiras confirmadas, usado para explicar a formação do saldo.
- **Webhook:** chamada servidor-a-servidor enviada pela engine para solicitar débito ou crédito.
- **`txId`:** identificador que a engine mantém igual ao repetir a mesma operação financeira.
- **Unidade menor:** inteiro que representa centavos ou a menor unidade da moeda escolhida.
- **Saldo disponível:** valor que ainda pode cobrir novas apostas após débitos e créditos persistidos.
