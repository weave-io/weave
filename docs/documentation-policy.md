# Documentation Policy

This document classifies the types of documentation artifacts in the Weave repository and defines where each type belongs. It governs what is durable reference material and what is non-normative historical evidence.

**Related:** [docs/README.md](README.md) · [docs/artifacts/README.md](artifacts/README.md) · [ADR 0005 — Decisions 9 and 10](adr/0005-five-spec-remediation-decisions.md)

---

## Artifact Classification

### Durable (normative)

Durable artifacts are the canonical source of truth. They are updated when the system changes and must remain accurate for future contributors and agents.

| Type | Location | Examples |
| --- | --- | --- |
| Conceptual guides | `docs/*.md` | `adapter-boundary.md`, `config-loading.md`, `workflow-schema.md` |
| DSL reference | `docs/dsl-reference.md` | Canonical `.weave` syntax reference |
| Architecture Decision Records | `docs/adr/` | `0001-prompt-composition-templates.md` |
| Formal specs | `docs/specs/<N>-spec-*/` | `07-spec-adapter-capability-contract.md` |
| Spec indexes | `docs/specs/README.md` | This file's sibling |
| Top-level navigation | `docs/README.md` | Entry point for the corpus |

**Rules for durable artifacts:**

- Must be updated when the system they describe changes.
- Must not contain transient proof output, terminal captures, or task-specific checklists.
- Must use relative Markdown links to cross-reference other durable artifacts.
- Must be understandable by a future agent or developer without conversation history.

### Non-normative (historical / validation)

Non-normative artifacts are evidence that a spec was implemented correctly. They are useful for audit and regression context but are not maintained as the system evolves.

| Type | Location | Examples |
| --- | --- | --- |
| Proof artifacts | `docs/artifacts/` or `docs/specs/<N>-spec-*/<N>-proofs/` | Terminal captures, diff outputs, test run summaries |
| Audit checklists | `docs/artifacts/` or `docs/specs/<N>-spec-*/<N>-audit*.md` | Per-spec audit files |
| Task tracking | `docs/specs/<N>-spec-*/<N>-tasks*.md` | Implementation task lists |
| Validation reports | `docs/specs/<N>-spec-*/<N>-validation*.md` | One-time validation outputs |

**Rules for non-normative artifacts:**

- Must not be updated to reflect system changes — they are historical snapshots.
- Must not contain secrets, API keys, tokens, real user paths, or private prompt content.
- May remain in their original spec directory when they are tightly coupled to that spec's proof record.
- New specs should place proof artifacts in `docs/artifacts/` rather than mixing them with durable spec content.

---

## Spec Directory Layout

Each spec directory may contain:

```
docs/specs/<N>-spec-<name>/
├── <N>-spec-<name>.md          # Durable: formal spec (normative)
├── <N>-tasks-<name>.md         # Non-normative: implementation task list
├── <N>-audit-<name>.md         # Non-normative: audit checklist
├── <N>-validation-<name>.md    # Non-normative: validation report
└── <N>-proofs/                 # Non-normative: proof artifacts directory
    └── *.md                    # Terminal captures, diff outputs, etc.
```

Only `<N>-spec-<name>.md` is durable. All other files in a spec directory are non-normative.

---

## Artifact Retention Policy

**Retain, do not prune.** Non-normative artifacts provide audit history. Moving them to `docs/artifacts/` or leaving them in their spec directory is acceptable; deleting them is not.

**New specs** shall not produce proof artifacts that land directly in `docs/` alongside durable guides. New proof artifacts go in `docs/artifacts/` or in the spec's own `<N>-proofs/` subdirectory.

**Existing artifacts** in spec directories are grandfathered. They do not need to be moved unless a spec directory is being reorganized for another reason.

---

## DSL Reference Ownership

The canonical `.weave` DSL reference lives at `docs/dsl-reference.md`. It is a durable guide, not a numbered spec.

`AGENTS.md` contains a DSL syntax summary for onboarding purposes. That summary is a pointer and overview — the normative contract lives in `docs/dsl-reference.md`. When the two diverge, `docs/dsl-reference.md` is authoritative.

See [ADR 0005 — Decision 10](adr/0005-five-spec-remediation-decisions.md) for the rationale behind this placement.
