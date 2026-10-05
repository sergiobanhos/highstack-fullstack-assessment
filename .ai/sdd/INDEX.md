# SDD Index

## Upstream Handoffs

- `.ai/strategy/handoff/strategy-brief.md`: missing

## Plan

- `.ai/sdd/PLAN.md`: available (approved)

## Ideas

| ID | Name | Status | Path |
|----|------|--------|------|

## Feature Workspace

> Numbering source: actual directories under `.ai/sdd/specs/`, not this index.

| Field | Value | Notes |
|-------|-------|-------|
| Next Feature ID | 006 | Recompute from filesystem before creating a new spec |
| Numbering Issues | none | duplicate prefix / invalid status / non-canonical directory |

## Specs

| ID | Feature | Status | Requirements | Design | Tasks | Review |
|----|---------|--------|--------------|--------|-------|--------|
| 001 | Crashsim real-time operator proxy | implementation:done | `.ai/sdd/specs/001-crashsim-realtime-proxy/requirements.md` (approved: single Crashsim scope) | `.ai/sdd/specs/001-crashsim-realtime-proxy/design.md` (approved: direct Crashsim integration) | `.ai/sdd/specs/001-crashsim-realtime-proxy/tasks.md` (approved; implementation complete) | pending |
| 002 | Base de persistência e autenticação de jogadores | implementation:done | `.ai/sdd/specs/002-database-auth/requirements.md` (approved) | `.ai/sdd/specs/002-database-auth/design.md` (approved: REST) | `.ai/sdd/specs/002-database-auth/tasks.md` (approved; T1–T4 complete) | — |
| 003 | Carteira, ledger e webhooks financeiros | implementation:done | `.ai/sdd/specs/003-financial-wallet-ledger/requirements.md` (approved; Q-001–Q-005 respondidos; D-009 definido) | `.ai/sdd/specs/003-financial-wallet-ledger/design.md` (approved) | `.ai/sdd/specs/003-financial-wallet-ledger/tasks.md` (T1–T5 concluídas e verificadas) | — |
| 004 | Sessão Crashsim, aposta e cashout | implementation:in-progress | `.ai/sdd/specs/004-crashsim-bet-cashout/requirements.md` (approved; Q-001–Q-002 respondidos) | `.ai/sdd/specs/004-crashsim-bet-cashout/design.md` (approved; risco residual de débito sem estorno no MVP) | `.ai/sdd/specs/004-crashsim-bet-cashout/tasks.md` (T1–T7 implementadas e verificadas; smoke test manual com Crashsim real pendente) | — |
| 005 | F05 — Payout local de carteira | implementation:in-progress | `.ai/sdd/specs/005-payout/requirements.md` (approved; Q-001 respondido; D-005 definido) | `.ai/sdd/specs/005-payout/design.md` (approved) | `.ai/sdd/specs/005-payout/tasks.md` (approved; execução T1–T5) | — |

## Handoff

- `.ai/sdd/handoff/sdd-brief.md`: available (F02 and F03 done; F04 tasks approved and ready to implement)

## Next Actions

- [x] Approve narrowed requirements and outage behavior in spec 001
- [x] Approve initial design for spec 001
- [x] Approve initial tasks for spec 001
- [x] Approve the simplified Crashsim-only design and tasks
- [x] Implement feature 001: align T2, then continue T3–T5
- [x] Commit feature 001 (`ebb9f95`)
- [x] Approve the revised roadmap for database, auth, financial, game commands, and client integration
- [x] Create requirements for F02: database foundation and player authentication
- [x] Approve requirements for spec 002
- [x] Create the design for spec 002
- [x] Approve the REST design for spec 002
- [x] Create tasks for spec 002
- [x] Approve tasks for spec 002
- [x] Defer F02 implementation at user request
- [x] Implement F02 T1–T4
- [x] Implement F03 T1–T5
- [x] Implement F04 T1–T7 after F03 verification (real Crashsim smoke test remains in `.ai/sdd/specs/004-crashsim-bet-cashout/tasks.md`)
- [x] Create F03 requirements draft
- [x] Resolve F03 questions
- [x] Approve F03 requirements
- [x] Create F03 design draft
- [x] Approve F03 design
- [x] Create F03 tasks
- [x] Approve F03 tasks
- [x] Create F04 requirements draft: Crashsim bet and cashout commands
- [x] Resolve F04 questions about ambiguous bet creation and definitive 402
- [x] Approve F04 requirements
- [x] Create F04 design draft
- [x] Approve F04 design
- [x] Create F04 tasks draft
- [x] Approve F04 tasks
- [x] Implement F02 and F03 in dependency order
- [ ] Implement F04 after F03 verification (T1–T5 complete)
- [x] Review and approve payout requirements in `.ai/sdd/specs/005-payout/`
- [x] Register F05 local payout in `.ai/sdd/PLAN.md`
- [x] Review and approve F05 design in `.ai/sdd/specs/005-payout/`
- [x] Review and approve F05 tasks in `.ai/sdd/specs/005-payout/`
