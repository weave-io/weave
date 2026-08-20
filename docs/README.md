# Weave Contributor Documentation

This directory is the current internal reference for contributors and coding agents. It contains architecture, implementation contracts, adapter internals, contributor guides, and decision records. It deliberately excludes plans, completed specs, task logs, and proof artifacts.

User-facing tutorials and product reference live in the [public docs package](../packages/docs/). See the [documentation policy](contributing/documentation.md) for the boundary.

## Architecture

| Page | Purpose |
| --- | --- |
| [Product Vision](architecture/product-vision.md) | Harness-agnostic product model and design principles |
| [System Overview](architecture/system-overview.md) | How configuration becomes harness behavior |
| [Adapter Boundary](architecture/adapter-boundary.md) | Engine/adapter ownership and prohibited dependencies |
| [Agent Surfaces](architecture/agent-surfaces.md) | Patterns for materializing agents in different harnesses |

## Reference

| Page | Contract |
| --- | --- |
| [DSL](reference/dsl.md) | Internal canonical `.weave` syntax |
| [Configuration](reference/configuration.md) | Discovery, layering, merge, trust, and prompt paths |
| [Prompts](reference/prompts.md) | Template context, delegation rendering, and composition |
| [Models](reference/models.md) | Model intent, resolution, thinking suffixes, and reviewers |
| [Workflows](reference/workflows.md) | Workflow schema, extensions, steps, artifacts, and completion |
| [Delegation](reference/delegation.md) | Portable child and concurrency budgets |
| [Tool Policy](reference/tool-policy.md) | Abstract capability decisions and concrete mapping boundary |
| [Permissions](reference/permissions.md) | Grants, challenges, permits, coverage, and authorization |
| [Adapter Capabilities](reference/adapter-capabilities.md) | Static ceilings, runtime probes, health, and readiness |
| [Execution Lifecycle](reference/execution-lifecycle.md) | Normalized operations, effects, completion, and recovery |
| [Runtime Store](reference/runtime.md) | Durable state, leases, journal, privacy, and retention |
| [CLI](reference/cli.md) | Internal command behavior, runtime commands, and adapter dispatch |
| [Eval Reporting](reference/eval-reporting.md) | Sanitized bundles, indexes, raw artifacts, and publication |

## Adapters

| Page | Harness |
| --- | --- |
| [OpenCode](adapters/opencode.md) | Runtime plugin, materialization, commands, and logging |
| [Claude Code](adapters/claude-code.md) | File materialization and capability boundary |
| [Pi](adapters/pi.md) | Extension lifecycle, private children, readiness, and recovery |

## Guides

| Page | Task |
| --- | --- |
| [Develop an Adapter](guides/adapter-development.md) | Bootstrap, materialize, project commands, and lifecycle mapping |
| [Author Agent Evals](guides/evals.md) | Add cases, run dry checks, and interpret results |
| [Troubleshoot Pi Child Sessions](guides/pi-child-troubleshooting.md) | Read doctor checks, diagnostic codes, and child session commands |
| [Verify an Adapter](testing/adapter-verification.md) | Prove a packaged adapter loads, becomes ready, and works in its real harness |
| [Pi Config Hot-Reload Live Proof](testing/pi-adapter-config-hot-reload-live-proof.md) | Recorded real-harness evidence for the Pi delegation-boundary config refresh |

## Contributing

| Page | Conventions |
| --- | --- |
| [TypeScript](contributing/typescript.md) | Bun runtime, `neverthrow`, control flow, and logging |
| [Testing](contributing/testing.md) | Schema coverage and boundary mocks |
| [Builtin Prompts](contributing/builtin-prompts.md) | Portable prompt behavior and regression rules |
| [Releases](contributing/releases.md) | Artifact identity, channels, publication, and trust boundaries |
| [Documentation](contributing/documentation.md) | Audience split, page types, update rules, and pruning policy |

## Specifications

| Spec | Status |
| --- | --- |
| [33 — Pi private child sessions](specs/33-spec-pi-adapter/33-spec-pi-adapter.md) | Active; amended for private child inspection |
| [33 — Weave UI design record](specs/33-spec-pi-adapter/33-weave-ui-design.md) | Active; delegation card, child inspector, and Plan Rail |

## Architecture Decision Records

ADRs preserve the reason for decisions. Current behavior belongs in the pages above.

| ADR | Status | Decision |
| --- | --- | --- |
| [0001](adr/0001-prompt-composition-templates.md) | Accepted | Mustache prompt templates |
| [0002](adr/0002-runtime-persistence-store.md) | Accepted | SQLite-backed Runtime Store |
| [0003](adr/0003-opencode-adapter-materialization-shape.md) | Accepted | OpenCode materialization shape |
| [0004](adr/0004-workflow-first-execution-contract.md) | Accepted | Explicit execution authorization boundary |
| [0005](adr/0005-five-spec-remediation-decisions.md) | Deprecated | One-time remediation choices for a completed refactor |
| [0006](adr/0006-end-to-end-orchestration-flow.md) | Accepted with superseded section | End-to-end orchestration flow |
| [0007](adr/0007-artifact-first-oidc-releases.md) | Accepted | Artifact-first OIDC releases |
| [0008](adr/0008-portable-delegation-budgets.md) | Accepted | Portable delegation budgets |
| [0009](adr/0009-input-aware-tool-permission-authorization.md) | Accepted | Input-aware authorization |
| [0010](adr/0010-plan-state-and-artifact-approval-authority.md) | Accepted | Plan and artifact approval authority |
| [0011](adr/0011-effective-adapter-readiness-and-runtime-observability.md) | Accepted | Effective readiness and observability |
| [0013](adr/0013-pi-private-child-sessions.md) | Accepted | Private Pi child sessions are adapter-owned and outside Runtime Store |
| [0014](adr/0014-pi-native-child-sessions.md) | Accepted | Pi children use native Pi sessions with no JSONL migration |

## Validation

```bash
bun run docs:check-links
```

The documentation checker validates local links in both this corpus and the public docs package.
