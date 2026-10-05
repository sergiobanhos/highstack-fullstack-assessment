# Feature: Reconciliação das apostas ao fim da rodada

> Status: Approved
> Source: `.ai/sdd/PLAN.md` — F07; comportamento atual de Crashsim; decisão explícita do usuário nesta conversa

## Visão geral

Manter o resultado das apostas persistidas pelo operador alinhado ao resultado final informado pela engine. Quando uma rodada crashar, ou quando o operador recuperar conexão depois que ela já terminou, jogadores devem ver suas apostas como perdidas ou cashed out, em vez de continuarem vendo uma aposta encerrada como “Em andamento”.

## Contexto de negócio

O endpoint de listagem devolve os estados persistidos pelo operador. Hoje, o evento de crash atualiza a rodada transmitida aos clientes, mas não atualiza as apostas salvas. A stream também não tem replay histórico: uma ressincronização pode encontrar a engine já em outra rodada. O operador precisa recuperar os resultados sem inventar um cashout, perder um cashout confirmado ou duplicar crédito financeiro.

## Histórias de usuário

### US-001: Ver o resultado da aposta depois do crash

**Como** jogador,  
**quero** ver o resultado final da minha aposta depois que a rodada crashar,  
**para que** uma aposta encerrada não continue parecendo estar em andamento.

**Critérios de aceitação:**

- [ ] Após a confirmação do resultado final pela engine, a aposta aparece como `lost` ou `cashed_out`, conforme o resultado autoritativo.
- [ ] A listagem e a consulta individual da aposta refletem o estado final persistido.
- [ ] Uma aposta cujo resultado ainda esteja sendo verificado é identificada como “Verificando resultado”, não como “Em andamento”.

### US-002: Recuperar resultados após uma desconexão

**Como** jogador,  
**quero** que minhas apostas sejam atualizadas quando o operador voltar a sincronizar com a engine,  
**para que** perder o evento de crash ao vivo não deixe apostas antigas abertas indefinidamente.

**Critérios de aceitação:**

- [ ] A recuperação inclui apostas ainda abertas de rodadas que já não são a rodada atual, mesmo quando o snapshot não contém o evento de crash perdido.
- [ ] A recuperação pode ser repetida sem regredir um resultado terminal nem criar efeitos financeiros duplicados.
- [ ] Se a engine não confirmar um resultado, o operador mantém a aposta sem resultado final confirmado e deixa claro que a verificação está pendente.

## Requisitos funcionais

### FR-001: Resolver apostas quando uma rodada crasha — Must Have

QUANDO a engine informar que uma rodada crashou  
O SISTEMA DEVE reconciliar as apostas aceitas daquela rodada com seus resultados finais  
PARA QUE nenhuma aposta encerrada permaneça indefinidamente como ativa.

### FR-002: Preservar cashouts confirmados e liquidação — Must Have

QUANDO uma aposta tiver sido cashoutada antes do crash  
O SISTEMA DEVE preservar o resultado, multiplicador, payout e estado de liquidação confirmados  
PARA QUE a reconciliação do crash não transforme um cashout em perda nem duplique crédito.

### FR-003: Recuperar resultados de eventos perdidos — Must Have

QUANDO a sincronização com a engine for restaurada e existirem apostas locais sem resultado final de rodadas encerradas  
O SISTEMA DEVE recuperar seus resultados mesmo que o evento histórico de crash não tenha sido entregue  
PARA QUE uma desconexão que atravesse o fim da rodada não deixe o estado persistido desatualizado.

### FR-004: Representar resultado ainda não confirmado — Must Have

QUANDO uma rodada já for conhecida como encerrada, mas a engine ainda não tiver confirmado o resultado de uma aposta  
O SISTEMA DEVE apresentar a aposta como em verificação  
PARA QUE o jogador não confunda um estado antigo com uma aposta que continua em andamento.

### FR-005: Repetir reconciliação com segurança — Must Have

QUANDO o mesmo crash ou processo de recuperação for observado mais de uma vez  
O SISTEMA DEVE manter resultados terminais e operações financeiras já confirmados sem duplicá-los  
PARA QUE retries, reconexões ou consultas repetidas não alterem incorretamente a aposta ou a carteira.

## Requisitos não funcionais

### NFR-001: Consistência

- A engine permanece autoridade para o resultado do jogo; o operador não declara perda ou cashout sem evidência suficiente.
- Estado do jogo e confirmação do crédito permanecem distinguíveis: `cashed_out` não significa, por si só, que o crédito já foi confirmado.
- Um resultado terminal já confirmado não pode regredir para ativo por evento atrasado, retry ou ressincronização.

### NFR-002: Recuperabilidade

- A recuperação deve funcionar tanto no evento de crash ao vivo quanto após a sincronização por snapshot.
- Indisponibilidade temporária da engine não deve ser convertida em perda, cashout ou sucesso financeiro inventado.

## Fora do escopo

- Alterar o protocolo ou a implementação do Crashsim.
- Adicionar replay histórico à stream da engine.
- Implementar worker genérico, painel administrativo ou reconciliação manual de toda a carteira.
- Mudar a política de crédito, webhooks ou ledger financeiro de F03; a reconciliação deve respeitar esses contratos.
- Implementar novas regras de aposta ou cashout.

## Decisões

### D-001: O crash inicia a reconciliação das apostas da rodada

**Decisão:** reconciliar as apostas da rodada quando o crash for recebido e também recuperar apostas de rodadas encerradas durante uma ressincronização. Preservar cashouts confirmados e não publicar um resultado final enquanto a engine não o confirmar.
**Motivo:** o evento de crash fecha a rodada, mas não carrega o resultado individual de cada aposta; a stream também não oferece replay histórico.
**Fonte:** recomendação apresentada pelo assistente e aprovada pelo usuário nesta conversa.
**Impacta:** US-001, US-002, FR-001–FR-005 e NFR-001–NFR-002.

## Perguntas

Nenhuma pergunta crítica aberta nesta etapa.

## Glossário

- **Resultado de jogo:** estado da aposta na engine, como `active`, `lost` ou `cashed_out`.
- **Liquidação:** confirmação independente do crédito do payout no ledger financeiro.
- **Reconciliação:** atualização do estado persistido do operador com base no resultado confirmado pela engine.
