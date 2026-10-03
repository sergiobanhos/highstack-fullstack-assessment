---
name: sdd-adopt
description: 'Explicit command-style skill for adopting SDD into a project that already has code: retroactively analyzes the codebase, pre-fills steering docs with detected facts, and backfills the SDD index with implemented features. Use when the user explicitly asks to adopt, retrofit, backfill, or document an existing project with SDD. Do not auto-load for fresh init (use sdd-init), feature specs, or status checks.'
---

# AI / SDD Adopt (existing project)

Adopt SDD in a project that already has code. Unlike `$sdd-init` (which scaffolds empty skeletons), ADOPT is retroactive: it reads the codebase, extracts what already exists, and pre-fills the SDD workspace so the docs describe reality instead of placeholders.

## Purpose

ADOPT answers: "we already built software — make SDD reflect it." It produces steering docs pre-filled with detected stack/conventions, registers shipped features in `INDEX.md` as `implemented`, and leaves open questions for the user to confirm. It never invents rules and never overwrites existing `.ai/` content without approval.

## Workflow

1. Load references.
   - Read `../_shared/references/sdd-practical.md`.
   - Apply the Language Policy: respond and write artifacts in the user's initial chat language while keeping skill instructions and templates in EN-US.
   - Read `../_shared/references/templates.md` when creating files.

2. Verify prerequisites.
   - If `.ai/sdd/INDEX.md` does not exist, tell the user to run `$sdd-init` first (or offer to run it now) before adopting.
   - Read existing `.ai/steering/*.md`, `.ai/sdd/INDEX.md`, and `.ai/sdd/PLAN.md` if present. Adopting must update them, not replace them.

3. Inventory the codebase.
   - Stack: package manifests (`package.json`, lockfiles, `Cargo.toml`, `pyproject.toml`, etc.), monorepo layout, framework signals.
   - Modules/features: source tree (e.g. `src/modules/`, `apps/`, `packages/`), route definitions, schema files (Prisma/SQL), job processors.
   - Conventions: lint/format configs, test runner and test file patterns, folder structure rules, naming patterns, git commit style.
   - Product context: README, docs, marketing copy if present.
   - Recent activity: `git log --oneline -30` for shipped features.
   - Do not read more than needed to draft the artifacts; prefer breadth over depth.

4. Clarify scope with the user.
   - Ask one question at a time:
     - Which features/domains should be registered in `INDEX.md` (all known, or a subset)?
     - Should shipped features get full spec directories (`requirements.md`/`design.md`/`tasks.md`) later via `$sdd-prd`, or only index rows for now?
     - Any rule the analysis cannot see (e.g. tribal knowledge, deploy policy)?

5. Draft retroactive artifacts.
   - Update `.ai/steering/product.md`: purpose, target users, current state derived from evidence.
   - Update `.ai/steering/tech-stack.md`: detected runtime, frameworks, infrastructure, commands.
   - Update `.ai/steering/conventions.md`: detected architecture patterns, testing conventions, git conventions.
   - Update `.ai/sdd/INDEX.md`: add one row per existing feature with status `implemented`, next free feature ID recomputed from `specs/` directories.
   - Mark every inferred fact with `[inferred — review]` so the user can spot unverified claims.
   - Put unknowns in Open Questions, never as invented rules.
   - Keep each doc short; steering docs are persistent context, not documentation dumps.

6. Review with the user.
   - Show a diff-style summary: what will be created vs updated, per file.
   - Ask for explicit approval before writing anything.

7. Save and hand off.
   - Write only approved files.
   - List created/updated files and remaining `[inferred — review]` items for the user to confirm or correct.
   - Recommend next commands:
     - `$sdd-prd` to retroactively spec a critical feature that will keep evolving
     - `$sdd-steering` to refine any steering doc the user flagged
     - `$sdd-idea` or `$sdd-plan` for the next new feature

## Output

- Updated `.ai/steering/product.md`, `.ai/steering/tech-stack.md`, `.ai/steering/conventions.md`
- Updated `.ai/sdd/INDEX.md` with `implemented` rows for existing features
- Optional: minimal spec directories only if the user explicitly asked (status `implemented`, artifacts marked as retroactive)
- A summary of unverified `[inferred — review]` items

## Quality Bar

- Adoption must be safe and idempotent; re-running never duplicates rows or discards edits.
- Existing `.ai/` content is preserved unless the user approves the change.
- Every claim in generated docs traces to a file, config, or git history — otherwise it is an Open Question.
- The final response lists created/updated files, unverified inferences, and the recommended next step.

## Critical Rules

- Do not create full spec artifacts (`requirements.md`, `design.md`, `tasks.md`) for existing features without explicit user approval.
- Do not mark any retroactive draft as approved automatically.
- Do not overwrite user-edited `.ai/` files; propose updates and wait for approval.
- Do not invent conventions, commands, or product facts that the codebase does not evidence.
- Do not ask many questions at once; adopt progressively.
