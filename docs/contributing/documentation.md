# Documentation Policy

Weave documentation describes the system that exists now. It does not store implementation plans, task lists, proof captures, audit logs, dated findings, or completed specifications.

**Related:** [Documentation Index](../README.md) · [Testing](testing.md) · [Public Docs Package](../../packages/docs/README.md)

---

## Two documentation surfaces

| Surface | Audience | Owns |
| --- | --- | --- |
| [`docs/`](../README.md) | Contributors and coding agents | Internal architecture, exact implementation contracts, adapter internals, contributor guides, ADRs |
| [`packages/docs/`](../../packages/docs/) | Weave users | Tutorials, user how-to guides, product explanation, public command and DSL reference |

Do not copy whole pages between the two. Link to the other surface when the audience changes. A public behavior change may require updates in both places, but each page should answer a different reader's question.

## Information architecture

```text
docs/
├── README.md
├── architecture/     # why the system is shaped this way
├── reference/        # exact current contracts and vocabularies
├── adapters/         # harness-specific implementation notes
├── guides/           # contributor procedures
├── contributing/     # code, test, docs, and release conventions
└── adr/              # durable decisions and their status
```

Every concept has one maintained home. Other pages summarize and link; they do not restate the full contract.

## What does not belong in `docs/`

Never add:

- numbered implementation specifications;
- task breakdowns or checklists tied to one issue;
- proof, audit, validation, or terminal-capture files;
- dated scorecards, delivery status, checkpoints, or phase findings;
- generated manifests, schemas, release inputs, or test fixtures;
- copies of source-level field lists that can be linked instead;
- historical architecture kept only as migration context.

Put plans and acceptance criteria in the issue or pull request. Keep run evidence in CI artifacts. Put executable fixtures beside the owning script or package. Git history is the archive for deleted documentation.

## Page types

### Architecture

Architecture pages explain ownership, boundaries, and stable system shape. They describe *why* and link to reference pages for exact APIs.

### Reference

Reference pages state current behavior precisely. They use source and tests as executable backing, avoid roadmap language, and link directly to the owning modules.

### Adapter notes

Adapter pages explain one harness's ownership, lifecycle mapping, capability gaps, and internal verification. Public setup instructions stay in `packages/docs/` or the package README.

### Guides

Guides help contributors complete a recurring task. They do not preserve the result of one past run.

### ADRs

ADRs preserve decisions with meaningful trade-offs. Each ADR declares one status:

- `Proposed`
- `Accepted`
- `Superseded by ADR NNNN`
- `Deprecated`

An accepted ADR is immutable except for status and link repairs. When the decision changes, write a new ADR and mark the old one superseded. ADRs may describe historical context; current behavior still belongs in architecture or reference pages.

## Writing rules

- Lead with the reader's goal and scope.
- Use one canonical term for each concept; [`CONTEXT.md`](../../CONTEXT.md) owns the glossary.
- Prefer stable domain language over file inventories and line numbers.
- Link directly to source for closed vocabularies and detailed types instead of copying lists likely to drift.
- Use relative Markdown links.
- Explain *why* a boundary exists, not only *what* the code does.
- State current behavior in the present tense. Keep future work in issues.
- Remove stale text rather than adding layers of correction notes.
- Keep one concept per page.

## When code changes

Update documentation in the same change when you:

- add, remove, or rename a DSL field or syntax form;
- change parser, validator, config-loading, or merge behavior;
- change an engine/adapter ownership boundary;
- add or change a public engine contract or lifecycle operation;
- alter an adapter's capabilities, commands, or support boundary;
- change security, persistence, release, or failure semantics;
- add a package or major subsystem;
- fix a non-obvious invariant whose reason is not clear from code.

A refactor that preserves documented behavior does not need a documentation diff merely to prove work happened.

## Canonical DSL reference

The internal DSL contract is [`docs/reference/dsl.md`](../reference/dsl.md). Public syntax reference lives under [`packages/docs/src/content/docs/docs/reference/dsl/`](../../packages/docs/src/content/docs/docs/reference/dsl/). A DSL change updates both audiences where applicable and carries the four-layer tests in [Testing](testing.md).

## Review checklist

Before a documentation change is done:

- [ ] The page has one clear audience and purpose.
- [ ] No active contract has two authoritative homes.
- [ ] Plans, proof, dates, and implementation status are absent.
- [ ] Links point to current named pages, not deleted spec numbers or task artifacts.
- [ ] New pages appear in [`docs/README.md`](../README.md).
- [ ] Public behavior changes update `packages/docs/` where needed.
- [ ] `bun run docs:check-links` passes.

Review the corpus as code evolves. If a page no longer guides a recurring task or defines current behavior, merge its useful content elsewhere and delete it.
