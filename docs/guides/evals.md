# Agent Eval Guide

Use `weave eval run` to test builtin agent prompts and routing against committed text fixtures. Evals are regression tests for agent behavior, not a substitute for engine or adapter integration tests.

**Related:** [Eval Reporting](../reference/eval-reporting.md) · [CLI](../reference/cli.md) · [Builtin Prompts](../contributing/builtin-prompts.md) · [Testing](../contributing/testing.md)

---

## What an eval covers

Each registered suite binds:

- one agent behavior;
- committed case fixtures;
- one runner implementation;
- allowed model IDs;
- a scoring rubric;
- sanitized report output.

The registry in [`packages/cli/src/evals/types.ts`](../../packages/cli/src/evals/types.ts) is the source of truth for suite IDs, short aliases, display names, fixture directories, and default models. Do not maintain another list in prose.

Evals are text-only. A case may describe tool or delegation intent, but the eval harness does not execute real tools, commands, workflows, harnesses, or external processes.

## Commands

```bash
weave eval run
weave eval run --agent <name>
weave eval run --model <id>
weave eval run --case <id>
weave eval run --dry-run
weave eval run --raw-artifacts
```

`--dry-run` validates the registry, fixtures, filters, model allowlist, prompt loading, and report assembly without calling a model. Run it before every live eval change.

A live run requires the configured model-provider key. Raw artifacts are local-only, explicit opt-in, and never publishable.

## Adding a case

1. Choose the existing suite that owns the behavior. Add a suite only when the behavior, runner, and rubric are genuinely distinct.
2. Add one focused fixture in that suite's fixture directory.
3. Give it a stable case ID and concise input.
4. Express assertions as observable output constraints, not implementation trivia.
5. Update the suite's rubric only when the expected behavior changed.
6. Run the filtered dry run.
7. Run the suite tests and prompt snapshots.
8. If the prompt changed, run a live comparison against the relevant model set before accepting a new baseline.

Case and rubric schemas are defined beside the runner types. Let schema tests document the exact field vocabulary.

## Assertion style

Prefer assertions that survive wording changes:

- required or forbidden concepts;
- routing target and trigger match;
- plan structure or review verdict;
- security constraints;
- explicit tool/delegation intent.

Do not assert an entire answer verbatim. Do not award a pass for merely repeating the prompt. A rubric should measure the behavior the agent owns.

## Prompt provenance

Every run records a bounded provenance manifest with the agent, prompt source, and SHA-256 hash. It does not contain the prompt body. Prompt snapshots under the CLI tests catch drift between builtins, registry wiring, and the evaluated prompt.

## Local workflow

```bash
bun test packages/cli/src/evals
bun packages/cli/src/main.ts eval run --agent <name> --dry-run
bun packages/cli/src/main.ts eval run --agent <name> --case <id>
```

Use the repo command when testing unpublished source. Use an installed `weave` binary only when validating the packed CLI.

## Results

A run writes an immutable, schema-versioned bundle plus derived dashboard indexes. All publishable output passes through the central allowlist sanitizer. See [Eval Reporting](../reference/eval-reporting.md) for the security and publication contract.

Do not record dated score tables, checkpoints, or model recommendations in this guide. Put temporary comparison output in the issue or pull request that motivated the run. Git and CI retain the evidence; this page describes only the current procedure.
