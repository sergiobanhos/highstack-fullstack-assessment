# SDD Workflow

Pipeline: `IDEA → PLAN → REQUIREMENTS → DESIGN → TASKS → IMPLEMENTATION → REVIEW`

## Gates

1. **IDEA** → exploração divergente (`.ai/sdd/ideas/`)
2. **PLAN** → roadmap e fronteiras (`.ai/sdd/PLAN.md`, opcional)
3. **REQUIREMENTS** → contrato de produto (`.ai/sdd/specs/NNN-feature/requirements.md`)
4. **DESIGN** → contrato técnico (`.ai/sdd/specs/NNN-feature/design.md`)
5. **TASKS** → plano de implementação (`.ai/sdd/specs/NNN-feature/tasks.md`)
6. **IMPLEMENTATION** → código + testes
7. **REVIEW** → verificação contra spec (`.ai/sdd/specs/NNN-feature/review.md`)

## Skills por etapa

| Etapa | Comando |
|-------|---------|
| Ideação | `/sdd-idea` |
| Planejamento | `/sdd-plan` |
| Requisitos | `/sdd-prd` |
| Design | `/sdd-spec` |
| Tasks | `/sdd-tasks` |
| Implementação | Execução manual ou `/sdd-exec` |
| Review | `/sdd-review` |

## Handoff

Após `tasks:approved`, rodar `/sdd-ai-integration-phase` para gerar sdd-brief.md.
