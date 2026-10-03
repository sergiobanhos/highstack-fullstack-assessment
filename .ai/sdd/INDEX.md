# SDD Index

## Upstream Handoffs

- `.ai/strategy/handoff/strategy-brief.md`: missing

## Plan

- `.ai/sdd/PLAN.md`: available (draft)

## Ideas

| ID | Name | Status | Path |
|----|------|--------|------|

## Feature Workspace

> Numbering source: actual directories under `.ai/sdd/specs/`, not this index.

| Field | Value | Notes |
|-------|-------|-------|
| Next Feature ID | 002 | Recompute from filesystem before creating a new spec |
| Numbering Issues | none | duplicate prefix / invalid status / non-canonical directory |

## Specs

| ID | Feature | Status | Requirements | Design | Tasks | Review |
|----|---------|--------|--------------|--------|-------|--------|
| 001 | Crashsim real-time operator proxy | implementation:done | `.ai/sdd/specs/001-crashsim-realtime-proxy/requirements.md` (approved: single Crashsim scope) | `.ai/sdd/specs/001-crashsim-realtime-proxy/design.md` (approved: direct Crashsim integration) | `.ai/sdd/specs/001-crashsim-realtime-proxy/tasks.md` (approved; implementation complete) | pending |

## Handoff

- `.ai/sdd/handoff/sdd-brief.md`: available (spec 001, implementation complete; ready for review)

## Next Actions

- [x] Approve narrowed requirements and outage behavior in spec 001
- [x] Approve initial design for spec 001
- [x] Approve initial tasks for spec 001
- [x] Approve the simplified Crashsim-only design and tasks
- [x] Implement feature 001: align T2, then continue T3–T5
- [ ] Review implementation and decide whether to commit
