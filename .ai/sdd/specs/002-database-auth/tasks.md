# Tasks: Base de persistência e autenticação de jogadores

> Requirements: @requirements.md
> Design: @design.md
> Status: Approved

## Cobertura dos requisitos

| Requisito | Tasks | Observações |
|-----------|-------|-------------|
| FR-001 / US-001 | T2, T3 | Cadastro persistente, validação e resposta pública |
| FR-002 | T1, T2, T3 | Constraint única no banco e tratamento de duplicidade na API |
| FR-003 / US-002 | T2, T3 | Login, criação de sessão e endpoint REST |
| FR-004 | T2, T3 | Resolução da sessão e `GET /auth/me` |
| FR-005 / US-003 | T2, T3 | Expiração, revogação persistente e logout idempotente |
| FR-006 / US-005 | T3 | Contrato `requireUser(request)` e rota protegida de teste |
| FR-007 / US-004 | T1, T4 | Migrações Drizzle, execução no Compose e persistência em restart |
| FR-008 | T1, T2, T3, T4 | Falhas de conexão, armazenamento e revogação sem falso sucesso |
| NFR-001 | T2, T3, T4 | Hash, tokens, limites, validação, redação de logs e configuração |
| NFR-002 | T1, T2 | Constraints, operações atômicas e persistência da revogação |
| NFR-003 | T4 | Instruções de operação, diagnóstico e evidências de verificação |

## Verificação de prontidão da implementação

| Verificação | Estado | Observações |
|-------------|--------|-------------|
| Todos os requisitos Must Have cobertos por tasks | Pass | FR-001–FR-008 têm ao menos uma task. |
| Requisitos cobertos pelo design aprovado | Pass | Modelo, API REST, segurança, falhas, migrações e ciclo de vida estão especificados. |
| Perguntas críticas respondidas | Pass | Email/senha, cadastro próprio e fluxo da sessão Crashsim foram decididos. |
| Tasks têm dependências, critérios, arquivos e verificação | Pass | Cada task abaixo informa esses campos. |
| Comandos de verificação conhecidos | Pass | `bun run typecheck`, `bun test`, `bun run db:migrate` e `docker compose config`; integração com PostgreSQL em banco exclusivo de teste. |
| Bloqueios de readiness | Nenhum | Compatibilidade Bun/dependências é verificada durante implementação conforme TD-002 e TD-004. |

## Fatias de implementação

### Fatia MVP: auth persistente disponível via REST

- **Objetivo:** permitir cadastro, login, consulta da própria identidade e logout confirmado após reinício do operador.
- **Histórias:** US-001 a US-005.
- **Tasks:** T1 → T2 → T3 → T4.
- **Validação independente:** executar migrações em PostgreSQL dedicado, usar os quatro endpoints, reiniciar o operador e conferir que a sessão ainda válida autentica e a revogada continua rejeitada.

## Task T1: Base PostgreSQL, schema de auth e migrações

**Prioridade:** P0
**Estimativa:** 4h
**Dependências:** nenhuma
**Cobre:** FR-002, FR-007, US-004, NFR-002, NFR-003

### Trabalho

- [ ] Adicionar `drizzle-orm`, `postgres` e ferramentas de desenvolvimento `drizzle-kit`; atualizar `package.json` e `bun.lock` com versões estáveis compatíveis com Bun.
- [ ] Criar `src/db.ts` com cliente Postgres, pool e fechamento explícitos, sem regra de negócio.
- [ ] Criar `drizzle.config.ts`, scripts `db:generate`/`db:migrate` e `src/migrate.ts`; executar migrations versionadas, sem schema push no startup.
- [ ] Criar `src/modules/auth/auth.schema.ts` com `players` e `auth_sessions`, índices e constraints descritos no design, incluindo unicidade nomeada para email.
- [ ] Gerar e revisar a migration inicial, garantindo que ela só crie a estrutura de auth e não remova ou recrie dados existentes.

### Critérios de aceite

- [ ] Uma base PostgreSQL de teste vazia recebe as tabelas e constraints esperadas.
- [ ] Rodar o migrador outra vez não apaga registros existentes nem reaplica migrations concluídas.
- [ ] Duas linhas com email canônico igual não podem coexistir; sessão não pode referenciar jogador inexistente.
- [ ] A conexão PostgreSQL fecha seus recursos quando solicitada e erros não imprimem a `DATABASE_URL`.

### Arquivos prováveis

- `operator/package.json` — adicionar dependências e scripts.
- `operator/bun.lock` — atualizar lockfile.
- `operator/drizzle.config.ts` — criar configuração de schema/migrations.
- `operator/drizzle/` — criar migration SQL e metadados.
- `operator/src/db.ts` — criar conexão Drizzle/Postgres.
- `operator/src/migrate.ts` — criar comando de migração.
- `operator/src/modules/auth/auth.schema.ts` — criar tabelas e constraints.
- `operator/src/db.test.ts` e/ou testes de integração de migração — cobrir a base de persistência.

### Verificação

- [ ] `cd operator && bun run typecheck && bun test`.
- [ ] Com `TEST_DATABASE_URL` apontando para banco dedicado, executar `bun run db:migrate` duas vezes e confirmar que dados de uma execução de teste permanecem.
- [ ] Não apontar comandos de teste/migração destrutiva para o banco local de desenvolvimento.

## Task T2: Fluxos de autenticação e identidade persistida

**Prioridade:** P0
**Estimativa:** 4h
**Dependências:** T1
**Cobre:** FR-001–FR-005, FR-008, US-001–US-004, NFR-001, NFR-002

### Trabalho

- [ ] Criar em `auth.service.ts` os fluxos `register`, `login`, `logout` e `resolveSession`, usando Drizzle e retornando somente o DTO público.
- [ ] Normalizar email com trim/lowercase e mapear somente a violação da constraint `players_email_unique` para `EMAIL_IN_USE`.
- [ ] Implementar derivação/verificação Argon2id com `Bun.password`, token opaco aleatório de 32 bytes e persistência exclusiva do hash SHA-256.
- [ ] Validar duração finita e `AUTH_SESSION_TTL_SECONDS`; resolver sessões por hash, jogador associado, expiração e revogação persistida.
- [ ] Tornar logout uma atualização condicional idempotente; erro de banco deve impedir resposta de sucesso.
- [ ] Aplicar teto de duas operações de hash/verificação simultâneas e executar verificação dummy para email inexistente, liberando slots mesmo se houver exceção.
- [ ] Adicionar unit tests para normalização, hash/token, expiração, erro genérico de login, DTO público e falhas de storage; usar PostgreSQL dedicado para concorrência e persistência.

### Critérios de aceite

- [ ] Cadastros concorrentes com variações de caixa/espaços do mesmo email produzem exatamente um jogador.
- [ ] Email inexistente e senha incorreta retornam a mesma categoria `INVALID_CREDENTIALS`, sem sessão.
- [ ] Tokens não podem ser previstos, o valor original não é gravado e jogador/sessão continuam após recriar o serviço.
- [ ] Sessões expiradas ou revogadas não resolvem identidade após reiniciar o processo.
- [ ] Logout repetido ou de token desconhecido não reativa sessão; indisponibilidade durante revogação é erro, não sucesso.
- [ ] Falhas de persistência nunca autenticam por cache ou fallback.

### Arquivos prováveis

- `operator/src/modules/auth/auth.service.ts` — criar fluxos de auth.
- `operator/src/modules/auth/auth.service.test.ts` — unit/integration tests dos fluxos.
- `operator/src/modules/auth/auth.schema.ts` — consultar schema criado em T1, ajustar apenas conforme design.

### Verificação

- [ ] `cd operator && bun run typecheck && bun test`.
- [ ] Testes de integração executados contra PostgreSQL exclusivo e verificam concorrência, restart/revogação e indisponibilidade.
- [ ] Confirmar nos testes de logs e retornos que senha, hash e token não aparecem.

## Task T3: Endpoints REST e contrato público `requireUser`

**Prioridade:** P0
**Estimativa:** 3h
**Dependências:** T2
**Cobre:** FR-001–FR-006, FR-008, US-001–US-005, NFR-001, NFR-002

### Trabalho

- [ ] Criar `auth.controller.ts` com `POST /auth/register`, `POST /auth/login`, `GET /auth/me` e `POST /auth/logout`, seguindo corpos, status e códigos de erro do design.
- [ ] Validar inputs e header Bearer com Valibot; rejeitar campos/tamanhos inválidos sem refletir valores recebidos.
- [ ] Configurar `@fastify/rate-limit` compatível com Fastify 5 para limites independentes de login e cadastro antes de hashing.
- [ ] Criar `auth.module.ts` para compor controller/service e exportar `requireUser(request)` sem expor schema, hashes ou token interno.
- [ ] Isolar resolução da identidade no request atual; não usar variável global ou aceitar `playerId` enviado pelo cliente.
- [ ] Adicionar testes Fastify `inject` cobrindo rotas, códigos HTTP/headers, requests concorrentes com jogadores distintos e uma rota protegida de teste que consuma o contrato público.

### Critérios de aceite

- [ ] Os quatro endpoints retornam os status e formatos definidos; respostas auth incluem `Cache-Control: no-store`.
- [ ] `GET /auth/me` e rota protegida de teste só recebem identidade da sessão Bearer validada.
- [ ] Logout com token sintaticamente correto é idempotente inclusive após revogação; falha real do banco retorna erro controlado.
- [ ] Campos privados, tokens e erros do banco não são expostos; tentativas inválidas também consomem rate limit.
- [ ] A rota de teste protegida só existe na suite e não fica registrada no servidor real.

### Arquivos prováveis

- `operator/package.json`, `operator/bun.lock` — dependência de rate limit, se não incluída antes.
- `operator/src/modules/auth/auth.controller.ts` — criar endpoints REST.
- `operator/src/modules/auth/auth.module.ts` — criar composição e exports públicos.
- `operator/src/modules/auth/auth.controller.test.ts` — testar contrato HTTP e isolamento.
- `operator/src/modules/auth/auth.module.test.ts` — testar contrato de identidade entre módulos.

### Verificação

- [ ] `cd operator && bun run typecheck && bun test`.
- [ ] Cobrir 400/401/409/429/503 conforme aplicável e 201/200/204 nos sucessos.
- [ ] Confirmar que um `playerId` falso no body não muda o jogador retornado por `requireUser`.

## Task T4: Inicialização, Compose, logs e instruções operacionais

**Prioridade:** P0
**Estimativa:** 3h
**Dependências:** T1, T2, T3
**Cobre:** FR-007, FR-008, US-004, NFR-001–NFR-003

### Trabalho

- [ ] Adicionar `DATABASE_URL` e `AUTH_SESSION_TTL_SECONDS` à validação de config, sem incluir valores sensíveis em erros.
- [ ] Integrar banco e auth em `server.ts`; verificar banco/schema antes de listen, adicionar `/ready` separado do liveness `/health`, e fechar game/banco em shutdown ou erro de inicialização.
- [ ] Atualizar Dockerfile para carregar migrations e entry point do migrador sem instalar `drizzle-kit` na imagem de produção.
- [ ] Atualizar Compose com `operator-migrate` one-shot após Postgres saudável e fazer operator esperar conclusão bem-sucedida; preservar o volume Postgres atual e expor portas somente em loopback.
- [ ] Ampliar proteção dos logs/config para `DATABASE_URL`, Authorization e campos de auth; não repassar erros brutos do driver.
- [ ] Documentar configuração, migrations, endpoints REST, exemplos fictícios, status, readiness e procedimento seguro de operação no README.
- [ ] Executar revisão integrada: suite/tipos existentes, fluxo Docker, indisponibilidade de banco, restart, SSE existente e carga limitada de hashing sem regressão visível de eventos.

### Critérios de aceite

- [ ] Banco ausente, migration incompleta ou falha de inicialização impede a API de anunciar prontidão.
- [ ] `/health` mede liveness e `/ready` retorna 503 quando schema/banco não está disponível.
- [ ] `docker compose up --build` aplica migration antes de iniciar operator; reiniciar mantém contas e sessões válidas/revogadas.
- [ ] Logs e respostas não contêm credenciais, `DATABASE_URL`, senha, hash ou token; rotas existentes de SSE continuam com o comportamento anterior.
- [ ] README permite a outra pessoa preparar banco, aplicar migrations e chamar auth sem consultar código.

### Arquivos prováveis

- `operator/src/config.ts`, `operator/src/config.test.ts` — configuração de DB/sessão.
- `operator/src/server.ts` — composição, readiness e ciclo de vida.
- `operator/Dockerfile` — incluir migration runtime.
- `docker-compose.yml` — serviço de migration e dependências de health.
- `README.md` — operação e exemplos de REST.
- `operator/src/server.test.ts` — readiness e fechamento de recursos.

### Verificação

- [ ] `cd operator && bun run typecheck && bun test`.
- [ ] `docker compose config`.
- [ ] Teste manual com banco de teste: inicialização/migração, login, restart, `me`, logout e rejeição posterior.
- [ ] Parar o banco durante execução e confirmar readiness 503, erro de auth seguro e recuperação quando ele volta.
- [ ] Confirmar funcionamento do SSE existente durante casos normais e carga de autenticação limitada.
