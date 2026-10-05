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
| Next Feature ID | 003 | Recompute from filesystem before creating a new spec |
| Numbering Issues | none | duplicate prefix / invalid status / non-canonical directory |

## Specs

| ID | Feature | Status | Requirements | Design | Tasks | Review |
|----|---------|--------|--------------|--------|-------|--------|
| 001 | Crashsim real-time operator proxy | implementation:done | `.ai/sdd/specs/001-crashsim-realtime-proxy/requirements.md` (approved: single Crashsim scope) | `.ai/sdd/specs/001-crashsim-realtime-proxy/design.md` (approved: direct Crashsim integration) | `.ai/sdd/specs/001-crashsim-realtime-proxy/tasks.md` (approved; implementation complete) | pending |
| 002 | Base de persistência e autenticação de jogadores | tasks:approved | `.ai/sdd/specs/002-database-auth/requirements.md` (approved) | `.ai/sdd/specs/002-database-auth/design.md` (approved: REST) | `.ai/sdd/specs/002-database-auth/tasks.md` (approved) | — |

## Handoff

- `.ai/sdd/handoff/sdd-brief.md`: available (spec 002, tasks approved; implementation not started)

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
- [ ] F02 implementation deferred; proceed with F03 requirements
