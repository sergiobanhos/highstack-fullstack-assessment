# SDD Handoff Brief: Crashsim real-time operator proxy

> Status: Aprovado
> Readiness: Pronto para implementação
> Updated: 2026-10-03

## Metadata

- **Spec ID:** `001-crashsim-realtime-proxy`
- **Spec Path:** `.ai/sdd/specs/001-crashsim-realtime-proxy/`
- **Current `.status`:** `tasks:approved`
- **Source Inputs:** `.ai/sdd/PLAN.md`; upstream strategy handoff ausente
- **Requirements:** `.ai/sdd/specs/001-crashsim-realtime-proxy/requirements.md`
- **Design:** `.ai/sdd/specs/001-crashsim-realtime-proxy/design.md`
- **Tasks:** `.ai/sdd/specs/001-crashsim-realtime-proxy/tasks.md`
- **Status:** `.ai/sdd/specs/001-crashsim-realtime-proxy/.status`
- **Decisions:** `.ai/sdd/specs/001-crashsim-realtime-proxy/decisions.md`

## Resumo

- **Público:** desenvolvedores e clientes locais de diagnóstico do operador.
- **Problema:** encaminhar o estado realtime do Crashsim aos clientes sem expor credenciais nem abrir uma conexão com a engine por cliente.
- **Resultado esperado:** o operador mantém uma stream upstream, sincroniza o estado por snapshot e publica snapshot mais eventos ordenados por SSE.
- **Escopo:** serviço Bun/TypeScript com Fastify; módulo `game`; adaptador Crashsim; fan-out SSE; cliente diagnóstico local React 19/Vite; execução pelo Docker Compose root.
- **Fora de escopo:** autenticação de jogadores, apostas, cashout, liquidação financeira e UI completa do jogo.

## Requisitos

- **User stories:** `US-001` a `US-004`
- **Must Have:** `FR-001` a `FR-008`
- **NFRs relevantes:** `NFR-001` a `NFR-004`
- **Critérios críticos:** estado monotônico por `seq`; ignorar `tick` atrasado após crash; sincronizar via `GET /rounds/current`; não alegar replay de histórico; manter a chave da engine no servidor; congelar o último estado e exibir reconexão até sincronizar.

## Design

- **Abordagem:** monólito modular. Esta entrega implementa `modules/game`; `auth` e `financial` serão módulos irmãos em specs futuras.
- **Componentes:** composition root em `operator/src/server.ts`; adaptador Crashsim e hub realtime dentro do módulo `game`; controller SSE downstream; cliente React diagnóstico local.
- **Estado:** snapshot e fan-out em memória, sem persistência de ticks ou histórico durável nesta entrega.
- **Integrações:** WebSocket upstream da engine; `GET /rounds/current`; `GET /game/events` em SSE; proxy Vite para o operador.
- **Decisões técnicas:** `TD-001` a `TD-006`, incluindo porta de provider, SSE, snapshot sem replay, cliente mínimo, inscrição atômica snapshot/stream e limites modulares.
- **Riscos / limites:** hub em memória suporta uma instância do operador; eventos perdidos não podem ser reproduzidos pelo engine; a tela diagnóstica deve continuar local até existir autenticação.

## Plano de implementação

- **Ordem recomendada:** `T1` → `T2` → `T3` → `T4` → `T5`.
- **T1:** inicializar o serviço Bun/Fastify, configuração, Docker e Compose.
- **T2:** contratos provider-neutral, reducer monotônico e hub com inscrição atômica.
- **T3:** adaptador Crashsim, snapshot/resync e reconexão com backoff.
- **T4:** endpoint SSE com snapshot inicial, fila sem corrida e limpeza de inscrições.
- **T5:** cliente React de diagnóstico, proxy Vite, Docker Compose e instruções locais.
- **Arquivos principais:** `operator/`, `client/`, `docker-compose.yml`, `.ai/steering/tech-stack.md` e instruções locais em `README.md`.

## Verificação

```text
cd operator && bun run typecheck
cd operator && bun run test
cd client && bun run typecheck
cd client && bun test
cd client && bun run build
docker compose config
```

Verificações manuais incluem disponibilidade da engine durante startup, resync após `DROP_WS_EVERY=8`, ordenação com `REORDER=1`, snapshot antes dos eventos SSE e ausência da chave da engine no browser e nos logs.

## Prontidão

- **Pronto para implementação:** sim
- **Pronto para QA:** não; depende da implementação
- **Pronto para release:** não; depende da implementação e revisão
- **Bloqueios:** nenhum requisito crítico em aberto; implementação ainda não iniciada.
- **Próxima ação:** executar as tasks aprovadas em ordem.
