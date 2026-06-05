# 30-spec-minimal-runtime-command-lifecycle.md

**Related**: [Issue #17](https://github.com/weave-io/weave/issues/17) · [Product Vision](../../product-vision.md) · [Adapter Boundary](../../adapter-boundary.md) · [Adapter Readiness Status](../../adapter-readiness-status.md) · [ADR 0004 — Workflow-First Execution Contract](../../adr/0004-workflow-first-execution-contract.md) · [ADR 0006 — End-to-End Orchestration Flow](../../adr/0006-end-to-end-orchestration-flow.md) · [Spec 13 — Minimal Execution Lifecycle Surface](../13-spec-minimal-execution-lifecycle-surface/13-spec-minimal-execution-lifecycle-surface.md) · [Spec 19 — Plan State Provider](../19-spec-plan-state-provider/19-spec-plan-state-provider.md) · [Spec 22 — Workflow-First Execution](../22-spec-workflow-first-execution/22-spec-workflow-first-execution.md) · [Spec 29 — Default Usage Is Not Workflow-Driven](../29-spec-default-usage-not-workflow-driven/29-spec-default-usage-not-workflow-driven.md) · [Command-Operation Contract](./30-command-operation-contract.md)

## Introduction/Overview

This feature defines the minimal OpenCode runtime command lifecycle needed for the first dogfood release while keeping command semantics reusable by other harness adapters. The goal is to expose explicit user-invoked runtime operations for starting plan execution, running named workflows, inspecting status, aborting or advancing blocked executions, and reporting adapter/runtime health without moving command logic into OpenCode-specific parsing code.

## Goals

- Define a harness-agnostic command-operation layer for the minimal runtime lifecycle operations required by issue #17.
- Keep OpenCode command delivery adapter-owned while ensuring the operation semantics can be reused by a second harness adapter.
- Preserve the separation between ordinary plan execution and explicit named workflow execution.
- Provide user-facing or explicitly documented OpenCode affordances for start, named workflow run, status, abort/cancel, blocked-step advancement, and health summary.
- Produce reusable tests, OpenCode projection tests, and dogfood evidence that prove commands invoke shared engine lifecycle semantics.

## User Stories

- **As a Weave user dogfooding OpenCode**, I want explicit commands for runtime execution so that I can start, inspect, and control work without relying on hidden hooks.
- **As a Weave maintainer**, I want command semantics to live outside OpenCode-specific command registration so that behavior remains testable and reproducible across harnesses.
- **As a harness adapter author**, I want a reusable command-operation contract so that I can expose the same lifecycle operations through my harness-native command shape without copying OpenCode logic.
- **As a workflow user**, I want named workflow execution to remain separate from ordinary plan execution so that I can intentionally choose which execution mode I am invoking.
- **As a runtime debugger**, I want concise status, health, and event evidence so that I can diagnose active or blocked executions during dogfood.

## Demoable Units of Work

### Unit 1: Reusable runtime command operations

**Purpose:** Define the shared command semantics once so OpenCode and future adapters can expose the same lifecycle behavior through harness-native triggers.

**Functional Requirements:**
- The system shall define reusable command operations for start plan execution, run named workflow, inspect status, abort or cancel execution, advance or complete a blocked step, and runtime health summary.
- The system shall keep command-operation logic outside OpenCode-specific command parsing, registration, slash-command naming, and plugin wiring code.
- The system shall map command operations to existing engine lifecycle concepts where possible, including `startExecution`, `runWorkflow`, `inspectExecution`, `handleUserInterrupt`, `completeStep`, lifecycle reconciliation, and adapter health reporting.
- The system shall represent unsupported or degraded operations explicitly instead of silently pretending the operation succeeded.
- The system shall expose enough typed result data for adapters to render user-facing success, failure, status, and diagnostic messages.

**Proof Artifacts:**
- Test: reusable command-operation tests demonstrate each operation invokes shared lifecycle semantics without importing OpenCode command-registration code.
- Test: a mock second-adapter fixture demonstrates the same command operations can be projected by a non-OpenCode adapter without copying OpenCode-specific logic.
- Documentation: command-operation contract notes demonstrate which lifecycle method or degradation path each operation uses.

### Unit 2: OpenCode explicit execution entrypoints

**Purpose:** Make the OpenCode dogfood path user-invoked and observable while preserving the split between plan execution and named workflow execution.

**Functional Requirements:**
- The system shall expose or document an explicit OpenCode delivery path for starting existing plan execution, using the Weave-owned command surface where feasible, such as `/weave:start`.
- The system shall expose or document named workflow execution separately from ordinary plan execution.
- The system shall not implement or require `/start-work` for this issue.
- The system shall not revive the superseded hidden/default workflow model from issue #58.
- The system shall ensure OpenCode session hooks such as `session.created` do not implicitly start durable execution.

**Proof Artifacts:**
- Test: OpenCode adapter projection tests demonstrate the plan-start entrypoint delegates to the reusable start-plan operation.
- Test: OpenCode adapter projection tests demonstrate named workflow execution delegates to the reusable named-workflow operation and remains separate from plan start.
- Test: plugin tests demonstrate session materialization hooks do not call `runWorkflow`, `startPlanExecution`, or the shared command start operation.
- Dogfood evidence: OpenCode command or documented equivalent output demonstrates a user can explicitly start plan execution and invoke or intentionally decline named workflow exposure.

### Unit 3: Runtime control, inspection, and health affordances

**Purpose:** Give dogfood users and maintainers the minimum controls and diagnostics needed to operate active executions safely.

**Functional Requirements:**
- The system shall provide a user-facing or documented equivalent path to inspect active execution status from OpenCode.
- The system shall provide a user-facing or documented equivalent path to abort or cancel an active execution from OpenCode.
- The system shall provide a user-facing or documented equivalent path to advance or complete a blocked step when no automatic completion signal is available.
- The system shall provide a concise health summary for adapter/runtime readiness, including command-entrypoint support and any degraded or unsupported lifecycle operation.
- The system shall surface event or journal evidence sufficient to diagnose active, blocked, completed, and aborted executions.

**Proof Artifacts:**
- Test: reusable command-operation tests demonstrate status, abort/cancel, blocked-step advancement, and health operations return typed success or degradation results.
- Test: OpenCode adapter projection tests demonstrate OpenCode-facing affordances render those operation results without duplicating lifecycle logic.
- Dogfood evidence: terminal capture, command output, or proof note demonstrates status, abort/cancel, blocked-step advancement, and health summary behavior against a real or documented OpenCode dogfood scenario.

### Unit 4: Lifecycle integration, policy enforcement, and dogfood evidence

**Purpose:** Prove the command surface integrates with the existing execution lifecycle, abstract tool policy, completion signals, and runtime evidence model.

**Functional Requirements:**
- The system shall observe available OpenCode session context such as session ID, foreground agent, model metadata, and context metadata where OpenCode exposes it.
- The system shall detect structured completion signals needed for `agent_signal` and `review_verdict` completion methods, or explicitly document the degraded fallback path.
- The system shall enforce abstract tool policy after the OpenCode adapter maps concrete OpenCode tools to abstract capabilities.
- The system shall apply abstract engine effects such as `RunAgent` through adapter-owned projection behavior.
- The system shall emit enough runtime evidence for maintainers to connect a user-invoked OpenCode command to the shared lifecycle state transition it caused.

**Proof Artifacts:**
- Test: lifecycle or integration tests demonstrate command-triggered execution applies `RunAgent` or equivalent dispatch effects through a mock adapter.
- Test: before-tool or policy tests demonstrate abstract tool policy is evaluated after concrete OpenCode tool-name mapping.
- Test: completion tests demonstrate `agent_signal` and `review_verdict` handling or the documented degraded fallback for OpenCode.
- Proof document: dogfood evidence links OpenCode command invocation, lifecycle state transition, event or journal output, and final status/health result.

## Non-Goals (Out of Scope)

1. **No `/start-work` requirement**: This feature does not implement, require, or rename the OpenCode entrypoint to `/start-work`.
2. **No full legacy hook system**: This feature does not port idle continuation, context-window monitoring, compaction recovery, todo continuation enforcement, or broad legacy governance hooks.
3. **No hidden default workflow model**: This feature does not revive issue #58's hidden/default workflow interpretation or make named workflows the ordinary execution path.
4. **No complete runtime rewrite**: This feature does not redesign durable lifecycle storage, workflow schema, or all execution-lifecycle methods beyond what the minimal command surface needs.
5. **No all-adapter implementation mandate**: This feature defines reusable semantics for future adapters but only requires OpenCode projection and a mock second-adapter proof.

## Design Considerations

No specific visual design requirements identified. The user experience requirement is command clarity: OpenCode users should see distinct affordances or documentation for plan start, named workflow run, status, abort/cancel, blocked-step advancement, and health summary. Messages should be concise, action-oriented, and safe for terminal display.

## Repository Standards

- Follow the harness-agnostic engine/adapter boundary in [docs/adapter-boundary.md](../../adapter-boundary.md): engine owns normalized lifecycle semantics; adapters own concrete command registration, hook wiring, UI actions, and harness-specific delivery.
- Preserve the product vision in [docs/product-vision.md](../../product-vision.md): Weave provides normalized primitives and adapters translate them into harness-specific experiences.
- Keep execution start explicit and user-authorized, consistent with [ADR 0004](../../adr/0004-workflow-first-execution-contract.md) and [Spec 22](../22-spec-workflow-first-execution/22-spec-workflow-first-execution.md).
- Preserve [Spec 29](../29-spec-default-usage-not-workflow-driven/29-spec-default-usage-not-workflow-driven.md): ordinary usage is not workflow-driven, and named workflow execution must remain explicit.
- Use `PlanStateProvider` boundaries from [Spec 19](../19-spec-plan-state-provider/19-spec-plan-state-provider.md) for plan existence and plan completion behavior.
- Keep tests isolated with mock adapters, in-memory lifecycle stores, and fixture context instead of starting a real harness in unit tests.
- Use Bun-only project conventions and repository-standard `neverthrow` result types for fallible TypeScript APIs unless a framework boundary requires a different shape.
- Update durable docs and proof artifacts under `docs/` or spec-local proof directories when implementation changes command or lifecycle behavior.

## Technical Considerations

- Current OpenCode documentation was reviewed through Context7 using official OpenCode sources (`/anomalyco/opencode`, living docs). Relevant guidance: OpenCode plugins are TypeScript modules that return hooks such as `config` and `tool.execute.before`; plugins can add custom tools through the plugin `tool` surface; OpenCode custom slash-style commands may be configured in `opencode.jsonc`; the TUI discovers slash commands from registered palette commands with a `slashName` property. This supports keeping concrete command delivery adapter-owned rather than embedding OpenCode command mechanics in engine code.
- Existing OpenCode adapter helpers already provide partial surfaces: `packages/adapters/opencode/src/start-plan-execution.ts` exposes `/weave:start`-oriented plan execution; `packages/adapters/opencode/src/run-workflow.ts` exposes explicit named workflow execution; `packages/adapters/opencode/src/plugin.ts` materializes agents on `session.created` and should not become an implicit execution-start hook.
- Existing engine lifecycle modules already cover many required operations: start/resume, dispatch, completion, interrupts, inspection, before-tool policy evaluation, and reconciliation. Follow-up implementation should compose these before adding new lifecycle primitives.
- Status, abort/cancel, blocked-step advancement, and health summary can likely map to existing lifecycle or readiness helpers, but the spec allows explicit degraded or unsupported results when OpenCode cannot expose a native affordance yet.
- The command-operation layer should return normalized results that are easy for adapters to render in a slash command, plugin command, tool response, UI action, or script entrypoint.
- Event and journal evidence should be structured enough to prove command invocation, lifecycle state transition, and final execution state without exposing secrets or local-only sensitive data.
- There is a known documentation/surface mismatch around the exact lifecycle method count across older specs and code. This feature should avoid re-litigating the entire lifecycle surface and should document only the operations needed for issue #17.

## Security Considerations

- Command operations shall preserve explicit user invocation and shall not allow OpenCode hooks or hidden defaults to start durable execution without a visible user action.
- Abort/cancel and blocked-step advancement operations shall only affect the intended active execution and shall return clear errors when the target execution is missing, already terminal, or ambiguous.
- Tool-policy enforcement shall occur after the adapter maps concrete OpenCode tools to abstract capabilities, preventing policy bypass through harness-specific tool names.
- Runtime evidence and proof artifacts shall not include secrets, API keys, credentials, private prompts, sensitive local paths beyond necessary repository-relative paths, or private user data.
- Health summaries shall report readiness and degradation without exposing sensitive environment details.

## Success Metrics

1. **Reusable semantics**: command-operation tests prove start, named workflow, status, abort/cancel, blocked-step advancement, and health behavior without importing OpenCode command-registration code.
2. **OpenCode dogfood usability**: a user can explicitly start plan execution, inspect status, abort/cancel, advance a blocked step, and view health from OpenCode or a documented equivalent.
3. **Adapter portability**: a mock second-adapter proof demonstrates the same operation layer can be exposed without copying OpenCode-specific command logic.
4. **Execution boundary clarity**: tests and docs prove named workflow execution remains separate from ordinary plan execution and no hook silently starts execution.
5. **Diagnostic evidence**: dogfood proof artifacts connect command invocations to lifecycle state transitions, event or journal output, and final status/health results.

## Open Questions

1. Which concrete OpenCode delivery mechanism should be preferred for status, abort/cancel, blocked-step advancement, and health: slash commands, plugin commands/tools, documentation-only equivalents, or a staged combination?
2. Should the reusable command-operation layer be introduced as a new engine module or as a thin composition API over existing execution-lifecycle modules?
3. What level of real OpenCode dogfood evidence is required before issue #17 is closed: terminal captures from the TUI, plugin command output, scripted invocation output, or all of these?
