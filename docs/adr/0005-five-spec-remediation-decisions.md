# ADR 0005: Remediation Decisions for a Completed Refactor

**Status**: Deprecated
**Date**: 2026-06-03
**Deprecated**: 2026-07-27
**Superseded by**: [Documentation Policy](../contributing/documentation.md), [Execution Lifecycle](../reference/execution-lifecycle.md), [CLI](../reference/cli.md), [OpenCode Adapter](../adapters/opencode.md), and [DSL Reference](../reference/dsl.md)

---

## Context

This ADR resolved open implementation questions for a one-time decomposition of the execution lifecycle, CLI migration code, OpenCode adapter, core DSL types, and documentation layout. It also recorded transient baseline failures and commit sequencing for that refactor.

Those work packages are complete. Their numbered implementation documents, task lists, and proof artifacts became stale after the code evolved and no longer belong in the maintained documentation set.

## Decision

The original implementation choices remain part of Git history but this ADR no longer governs current behavior.

Current contracts live in named architecture and reference pages:

- [Execution Lifecycle](../reference/execution-lifecycle.md)
- [CLI](../reference/cli.md)
- [OpenCode Adapter](../adapters/opencode.md)
- [DSL Reference](../reference/dsl.md)
- [Documentation Policy](../contributing/documentation.md)

The documentation policy supersedes the original artifact-retention and numbered-spec decisions. Plans and proof remain in issues, pull requests, CI, and Git history rather than under `docs/`.

## Consequences

- Do not use this ADR as implementation guidance.
- Do not restore the retired numbered-spec hierarchy.
- Follow the current named reference pages and their linked source/tests.
- Write a new ADR when a current architectural decision changes.
