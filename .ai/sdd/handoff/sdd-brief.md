# SDD Handoff Brief: Crashsim real-time operator proxy

> Status: Approved — implementação concluída
> Readiness: Pronto para revisão
> Updated: 2026-10-03

## Metadata

- **Spec ID:** `001-crashsim-realtime-proxy`
- **Spec Path:** `.ai/sdd/specs/001-crashsim-realtime-proxy/`
- **Current `.status`:** `implementation:done`
- **Requirements:** `.ai/sdd/specs/001-crashsim-realtime-proxy/requirements.md`
- **Design:** `.ai/sdd/specs/001-crashsim-realtime-proxy/design.md`
- **Tasks:** `.ai/sdd/specs/001-crashsim-realtime-proxy/tasks.md`
- **Source Inputs:** `.ai/sdd/PLAN.md`; upstream strategy handoff ausente

## Resumo

- **Problema:** encaminhar o estado realtime do Crashsim aos clientes sem expor credenciais ou abrir uma conexão com a engine por cliente.
- **Resultado esperado:** o operador mantém uma stream upstream, sincroniza o estado via snapshot e publica snapshot mais eventos ordenados por SSE.
- **Escopo:** Bun/TypeScript com Fastify; um módulo `game` direto e específico do Crashsim; clientes HTTP/WebSocket, serviço de stream, reducer, hub SSE e cliente diagnóstico local React 19/Vite no Docker Compose root.
- **Fora de escopo:** segundo jogo/engine ou abstrações para suportá-los, autenticação de jogadores, apostas, cashout, liquidação financeira e UI completa.
- **Invariantes:** estado monotônico por `seq`; ignorar `tick` atrasado após crash; ressincronizar por `GET /rounds/current`; não alegar replay; manter credencial da engine no servidor; congelar último estado durante reconexão.

## Design

- `game.module.ts` instancia e conecta as peças concretas do fluxo Crashsim.
- `crashsim-http.client.ts` busca o snapshot; `crashsim-stream.client.ts` mantém uma única WebSocket upstream.
- `game-stream.service.ts` orquestra conexão, sincronização, reconexão, redução e publicação.
- `round-state.ts` implementa tipos internos e reducer puro; `game-event-hub.ts` faz fan-out e captura snapshot/inscrição atomicamente.
- `game-events.controller.ts` é um controller SSE fino em `GET /game/events`.
- O cliente React local mostra status, snapshot e eventos recebidos.
- Não há porta genérica, `GameTypeModule`, catálogo, registry, plugin ou pastas por jogo. Um segundo jogo exige uma decisão arquitetural futura baseada nas necessidades reais.

## Implementação concluída

- T1 bootstrap Bun/Fastify, configuração, Docker e Compose concluído.
- T2 reducer e hub consolidados em `modules/game/`; scaffolding genérico de game types removido.
- T3 integração direta Crashsim, snapshot, reconexão, ressincronização e proteção contra eventos fora de ordem concluídos.
- T4 rota `GET /game/events` em SSE e limpeza independente de assinantes concluídas.
- T5 cliente React diagnóstico, Compose e instruções locais concluídos.
- README inclui diagrama da comunicação entre browser, operador e engine.

## Verificação planejada

```text
cd operator && bun run typecheck
cd operator && bun run test
cd client && bun run typecheck
cd client && bun test
cd client && bun run build
docker compose config
```

Verificações executadas: os comandos acima passaram. Também foi validado o fluxo SSE através do proxy Vite em execução, o cliente no browser, assinantes independentes com limpeza, e o cenário `DROP_WS_EVERY=8 REORDER=1` com estados `reconnecting → synchronizing → connected` e snapshot ressincronizado. Os testes cobrem tick tardio após crash, sequência duplicada/antiga e ausência de credenciais nos logs/payloads.

## Prontidão

- **Pronto para implementação:** sim; implementação concluída.
- **Pronto para QA/release:** pendente de revisão.
- **Próxima ação:** revisar as alterações e então decidir sobre o commit.
