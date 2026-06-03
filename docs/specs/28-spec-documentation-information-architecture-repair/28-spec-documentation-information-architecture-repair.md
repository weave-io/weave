# 28-spec-documentation-information-architecture-repair.md

## Introduction/Overview

The documentation corpus contains strong content, but its structure has drifted: key specs are missing, links point to deleted files, documented conventions are not followed, and too many transient proof artifacts live alongside durable guidance. This spec defines a documentation information architecture repair that restores a navigable source of truth for future contributors and agents.

## Goals

- Restore a valid documentation navigation path from top-level entry points to canonical guides and specs.
- Re-establish one canonical home for the `.weave` DSL reference inside `docs/`.
- Reduce documentation clutter by separating durable guidance from transient proof artifacts.
- Make documented conventions match the repository's actual documentation structure.

## User Stories

- **As a maintainer**, I want a clear docs entry point so that I can navigate the architecture without chasing dead links.
- **As an AI agent**, I want one canonical DSL reference in `docs/` so that I am not forced to infer the product contract from onboarding instructions alone.
- **As a reviewer**, I want durable docs separated from transient proof artifacts so that conceptual guidance is easier to scan and keep current.
- **As a junior developer**, I want the docs structure and naming rules to match reality so I know which files are normative.

## Demoable Units of Work

### Unit 1: Restore Canonical Navigation

**Purpose:** Rebuild trustworthy entry points and eliminate dead-link traps.

**Functional Requirements:**
- The system shall add a top-level documentation index that explains where to find guides, ADRs, and specs.
- The system shall add a specs index that lists current specs, their purpose, and their canonical ordering.
- The system shall repair or replace links that currently point to deleted or missing specification files.
- The user shall be able to navigate from top-level docs into the DSL and workflow documentation without encountering known dead links.

**Proof Artifacts:**
- Diff: `docs/README.md` and `docs/specs/README.md` demonstrate restored entry points.
- Link check: documented dead links from the review are removed or redirected and demonstrate valid navigation paths.

### Unit 2: Restore a Canonical DSL Reference

**Purpose:** Put the `.weave` DSL contract back inside durable docs rather than relying on onboarding-only text.

**Functional Requirements:**
- The system shall create or restore one canonical DSL reference under `docs/`.
- The system shall reduce duplicate DSL contract material in onboarding files by turning those sections into summaries or pointers when appropriate.
- The system shall preserve any agent-specific onboarding guidance that belongs in `AGENTS.md` while moving normative DSL reference content to durable docs.

**Proof Artifacts:**
- Diff: canonical DSL reference appears under `docs/` and demonstrates restored ownership.
- Documentation: `AGENTS.md` links to the canonical DSL reference and demonstrates reduced contract duplication.

### Unit 3: Separate Durable Docs From Transient Artifacts

**Purpose:** Remove proof-artifact clutter from the permanent documentation surface.

**Functional Requirements:**
- The system shall define where audit, proof, validation, and checklist artifacts belong going forward.
- The system shall move or reclassify transient proof artifacts so `docs/` primarily contains durable reference material.
- The system shall document the required and optional documentation artifact types for future specs.
- The system shall preserve access to existing historical artifacts if they are still needed for auditability.

**Proof Artifacts:**
- File tree diff: demonstrates proof artifacts moved, reduced, or reclassified out of the main durable docs surface.
- Documentation: updated docs policy or spec index demonstrates the new artifact rules.

### Unit 4: Normalize Documentation Conventions

**Purpose:** Make repository guidance and actual docs layout match.

**Functional Requirements:**
- The system shall resolve mismatches between documented conventions and the actual spec directory structure.
- The system shall choose whether per-spec `index.md` files are required, then align repository guidance and docs structure with that choice.
- The system shall fix numbering collisions and ambiguous spec naming so one spec number maps to one canonical spec.

**Proof Artifacts:**
- Diff: AGENTS or docs policy updates demonstrate conventions now match reality.
- File tree or index: demonstrates unique spec numbering and unambiguous naming.

## Non-Goals (Out of Scope)

1. **Rewriting all documentation prose**: This spec does not rewrite every guide for style consistency.
2. **Changing product architecture by documentation alone**: This spec does not redefine engine or adapter boundaries except where canonical docs must accurately describe them.
3. **Deleting required historical evidence blindly**: This spec does not remove proof artifacts without first defining their new home or retention policy.

## Design Considerations

No specific design requirements identified.

## Repository Standards

- Documentation is a first-class deliverable and must be updated for non-trivial architectural or DSL changes.
- Prefer one canonical reference per concept, with other docs linking rather than duplicating normative content.
- Keep docs understandable by future agents and junior developers who do not have conversation history.
- Preserve relative linking and clear cross-references between guides, ADRs, and specs.

## Technical Considerations

- Context assessment found strong conceptual guides but a broken docs architecture caused by missing specs, dead links, duplicated contract material, and clutter from proof artifacts.
- No latest-standards research was needed because this is a repository documentation-structure remediation rather than an external technology selection problem.
- Link-repair work should prefer stable canonical destinations rather than temporary redirect text scattered across many files.
- If historical proof files must stay versioned, move them behind a clearly non-normative artifact boundary instead of leaving them mixed with reference docs.

## Security Considerations

- Proof artifacts moved or retained under the new structure shall continue to avoid exposing secrets, tokens, or sensitive local environment details.
- Documentation examples shall avoid including sensitive file paths, credentials, or internal-only runtime outputs.

## Success Metrics

1. **Navigation health**: known dead links from the review are resolved and canonical docs entry points exist.
2. **Canonical ownership**: one durable DSL reference exists under `docs/`, with onboarding files linking to it instead of duplicating it as the primary source.
3. **Corpus clarity**: durable reference docs are easier to scan because transient proof artifacts are moved, reclassified, or governed by clear retention rules.

## Open Questions

~~1. Should historical proof artifacts remain versioned in a non-normative directory, or should some be pruned after policy creation?~~
~~2. Should the canonical DSL reference be restored as `01-spec-core-dsl` or introduced as a new guide with updated cross-links?~~

## Implementation Notes (Task 8)

### Decisions made

**Open Question 1 — Artifact retention**: Historical proof artifacts are retained in their existing spec directories. The `docs/artifacts/` directory and `docs/documentation-policy.md` define the retention policy going forward. No pruning was performed.

**Open Question 2 — DSL reference placement**: The canonical DSL reference was introduced as a new guide at `docs/dsl-reference.md` (not as a numbered spec). This keeps it alongside other conceptual guides (`adapter-boundary.md`, `config-loading.md`, etc.) and avoids the retired-spec numbering confusion.

### Changes made

**`docs/dsl-reference.md`** — Removed the stale "Status note" that said Specs 22 and 24 were "being formalised." Both specs are now complete. Replaced with a current-state note linking to the finalized specs and `workflow-schema.md`.

**`docs/adapter-boundary.md`** — Updated three references to `execution-lifecycle.ts` to reflect the Spec 24 decomposition outcome: the implementation now lives in `packages/engine/src/execution-lifecycle/` (17 focused modules); `execution-lifecycle.ts` is a compatibility barrel. Added Spec 24 to the Execution Lifecycle Surface section header.

**`AGENTS.md`** — Three changes:
1. Added a canonical-reference callout at the top of the DSL section pointing to `docs/dsl-reference.md` as the normative contract. The AGENTS.md DSL section is now explicitly an onboarding summary, not the primary source.
2. Fixed the `shuttle` agent example from `mode all` to `mode subagent`, aligning with the canonical builtin declaration (the migration note in `docs/config-loading.md` documents this change).
3. Added `Entry point: docs/README.md` to the Guides bullet in the "Where docs live" section.

### Link review result

Manual link review of all files listed in the task spec found **no dead links**. All relative Markdown links in the following files resolve to existing files:
- `docs/README.md`
- `docs/specs/README.md`
- `docs/dsl-reference.md`
- `docs/documentation-policy.md`
- `docs/artifacts/README.md`
- `AGENTS.md`
- `docs/adapter-boundary.md`
- `docs/product-vision.md`
- `docs/cli.md`
- `docs/config-loading.md`
- `docs/model-resolution.md`
- `docs/workflow-schema.md`
- `docs/prompt-composition.md`
- `docs/specs/24-spec-execution-lifecycle-decomposition/24-spec-execution-lifecycle-decomposition.md`
- `docs/specs/25-spec-cli-init-and-migration-decomposition/25-spec-cli-init-and-migration-decomposition.md`
- `docs/specs/26-spec-opencode-adapter-boundary-cleanup/26-spec-opencode-adapter-boundary-cleanup.md`
- `docs/specs/27-spec-dsl-model-and-schema-cleanup/27-spec-dsl-model-and-schema-cleanup.md`

### Navigation path verification

A contributor can reach all canonical references from `docs/README.md`:
- **DSL** → [DSL Reference](../dsl-reference.md) in the Conceptual Guides table
- **CLI** → [CLI](../cli.md) in the Conceptual Guides table
- **Adapter boundary** → [Adapter Boundary](../adapter-boundary.md) in the Conceptual Guides table
- **Workflow lifecycle** → [Workflow Schema](../workflow-schema.md) + [Spec 22](../specs/22-spec-workflow-first-execution/22-spec-workflow-first-execution.md) via the Formal Specs section
- **Spec index** → [docs/specs/README.md](../specs/README.md) via the Formal Specs section
