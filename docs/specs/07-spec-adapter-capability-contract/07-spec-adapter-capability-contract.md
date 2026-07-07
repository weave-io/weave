# 07-spec-adapter-capability-contract.md

## Introduction/Overview

Define the **Adapter Capability Contract** for Weave so the engine, adapters, CLI doctor/status/debug commands, and documentation can describe adapter readiness consistently. The primary goal is to replace vague binary support checks with a harness-neutral contract that distinguishes `native`, `emulated`, `degraded`, and `unsupported` capabilities, then evaluates those declarations through readiness profiles and runtime health reports.

This spec is based on GitHub issue [#49](https://github.com/weave-io/weave/issues/49) and uses the terminology defined in [`CONTEXT.md`](../../../CONTEXT.md), [`docs/product-vision.md`](../../product-vision.md), and [`docs/adapter-boundary.md`](../../adapter-boundary.md).

## Goals

- Define shared adapter capability types that can be imported by engine, adapters, CLI, and tests.
- Provide an adapter declaration API for static baseline capabilities and runtime health-check results.
- Implement a **Core Readiness Profile** that fails required capabilities when they are `degraded` or `unsupported`, while treating optional capability gaps as warnings.
- Provide CLI-ready renderer models for human-readable, JSON, and TOON output without hard-coding harness-specific assumptions in the engine.
- Document readiness gates so future adapter work for OpenCode, Pi, Claude Code, and other harnesses can implement the same contract.

## User Stories

- **As a Weave adapter maintainer**, I want to declare which Weave behaviors my adapter supports so that readiness is visible before users try to run workflows.
- **As a CLI user**, I want `doctor`, `status`, or `debug` output to explain whether an adapter is ready so that I can fix missing capabilities without reading adapter source code.
- **As an engine developer**, I want capability evaluation to be pure and harness-neutral so that readiness logic remains testable and does not violate the engine/adapter boundary.
- **As a documentation reader**, I want required and optional capabilities to be defined in one place so that adapter expectations are clear and stable across harnesses.

## Demoable Units of Work

### Unit 1: Shared Capability Model

**Purpose:** Establish the vocabulary and typed contract that all packages can share.

**Functional Requirements:**
- The system shall define a `CapabilityReadiness` model with exactly these support levels: `native`, `emulated`, `degraded`, and `unsupported`.
- The system shall define capability entries that record the capability id, display name or description, readiness level, implementation notes, runtime status when available, and blocking impact.
- The system shall distinguish required capabilities from optional capabilities using a readiness profile rather than a single boolean `supported` flag.
- The system shall export the public capability types from `@weaveio/weave-engine` so adapters and CLI code can consume the same definitions.
- The system shall avoid duplicating existing core types such as `ToolPolicy`; capability entries that describe tool policy support shall reference existing `@weaveio/weave-core` concepts where relevant.

**Proof Artifacts:**
- `Test: packages/engine/src/__tests__/capability*.test.ts passes` demonstrates the shared model accepts valid readiness values and rejects or prevents unsupported states.
- `Typecheck: bun run typecheck` demonstrates the public exports are usable across workspace packages.
- `Code review artifact: packages/engine/src/index.ts exports capability model` demonstrates consumers can import the contract from the engine package.

### Unit 2: Readiness Profile Evaluation

**Purpose:** Make adapter readiness decisions deterministic and explainable.

**Functional Requirements:**
- The system shall define the **Core Readiness Profile** as the built-in minimum readiness policy for core harness integrations.
- The system shall classify these capabilities as required for the Core Readiness Profile: config materialization, agent materialization, primary/default agent selection, delegated specialist execution/subagents, prompt composition/injection/run-agent support, tool policy mapping/enforcement, workflow persistence, workflow step dispatch, plan-file compatibility, command entrypoints, event logging/debug traces, and token usage reporting when the harness exposes usage.
- The system shall classify these capabilities as optional: idle continuation, compaction recovery, context-window monitor, analytics dashboard, eval integration, static artifact generation, and multiple active workflows.
- The system shall pass required capabilities only when they are `native` or equivalent `emulated`.
- The system shall fail readiness when any required capability is `degraded` or `unsupported`.
- The system shall report optional `degraded` or `unsupported` capabilities as warnings, not readiness failures.
- The system shall produce structured evaluation output that identifies blocking failures and non-blocking warnings.

**Proof Artifacts:**
- `Test: Core Readiness Profile rejects degraded required capability` demonstrates readiness gating blocks unsafe adapter states.
- `Test: Core Readiness Profile accepts emulated required capability` demonstrates emulation can satisfy required behavior.
- `Test: optional unsupported capability reports warning only` demonstrates optional gaps do not block readiness.
- `CLI JSON fixture: readiness result includes blocking and warning entries` demonstrates downstream commands can render profile decisions consistently.

### Unit 3: Runtime Health Report and Safe Adapter Init

**Purpose:** Combine static declarations with current environment checks without making the engine perform harness-specific I/O.

**Functional Requirements:**
- The system shall define an **Adapter Health Report** as the runtime account of whether an adapter is currently usable in its environment.
- The system shall support a **Safe Adapter Init** path that lets an adapter perform read-only readiness verification without materializing agents, registering hooks, launching full workflows, or mutating harness state.
- The system shall keep harness-owned checks inside adapters; engine helpers shall accept adapter-provided declarations and probe results as explicit inputs.
- The system shall model health-check failures with `neverthrow` `Result` or `ResultAsync` error types when fallible logic is introduced.
- The system shall include enough health report detail for CLI output to explain what failed, why it blocks or warns, and what component supplied the information.

**Proof Artifacts:**
- `Test: mock adapter supplies runtime probe results` demonstrates engine readiness evaluation does not query harness APIs directly.
- `Test: health report uses Result/ResultAsync for fallible checks` demonstrates expected failures are typed rather than thrown.
- `Code review artifact: no engine helper scans harness directories or registers concrete hooks` demonstrates compliance with the adapter boundary.

### Unit 4: CLI and Documentation Integration Contract

**Purpose:** Ensure readiness information is usable by humans, machines, and LLM-oriented workflows.

**Functional Requirements:**
- The system shall define renderer-ready structures for human-readable, JSON, and TOON output.
- The system shall preserve JSON as the machine-readable interchange format and TOON as a compact deterministic representation for LLM-oriented consumption.
- The system shall document the readiness gate semantics in this spec and link related architecture docs to the capability contract.
- The system shall identify how existing binary installer support, such as `HarnessInstaller.supported`, relates to or should eventually be superseded by capability readiness.
- The system shall avoid committing sensitive runtime data, credentials, local file contents, or harness secrets in proof artifacts.

**Proof Artifacts:**
- `CLI fixture: human renderer output lists pass/fail/warning capability rows` demonstrates users can understand readiness state.
- `CLI fixture: JSON renderer output is parseable and includes readiness profile results` demonstrates automation can consume the report.
- `CLI fixture: TOON renderer output is deterministic` demonstrates LLM-oriented status output can be compared in tests.
- `Docs: links from adapter-boundary or product-vision to this spec` demonstrates future readers can discover the contract.

## Non-Goals (Out of Scope)

1. **Full adapter implementation**: This spec does not require implementing OpenCode, Pi, Claude Code, or other adapter behavior beyond the shared contract and test fixtures needed to prove it.
2. **Replacing all transitional adapter APIs**: This spec may identify how `registerHook()` and `loadSkill()` are superseded conceptually, but complete lifecycle and skill API replacement remains separate work.
3. **Complete CLI command implementation**: This spec defines renderer-ready models and proof fixtures; full `doctor`, `status`, or `debug` command behavior may be completed in downstream CLI issues.
4. **Workflow execution semantics**: This spec records workflow persistence and dispatch as capabilities, but it does not design the full workflow runtime.
5. **Security or permission enforcement internals**: This spec identifies tool policy mapping/enforcement as a capability, but it does not implement every harness-specific permission mechanism.

## Design Considerations

No specific UI design requirements identified. Human-readable CLI output should be clear enough for a user to see pass/fail/warning status, capability names, blocking impact, and remediation hints when available. JSON and TOON output should prioritize deterministic structure over visual formatting.

## Repository Standards

- Follow the engine/adapter boundary in [`docs/adapter-boundary.md`](../../adapter-boundary.md): engine code may evaluate harness-neutral declarations, but adapters own harness resource discovery, runtime probes, concrete tool names, and feature-gap emulation.
- Follow the product vision in [`docs/product-vision.md`](../../product-vision.md): Weave defines primitives and normalized intent; adapters translate that intent into concrete harness behavior.
- Use Bun-only tooling and commands: `bun run typecheck`, `bun test`, and package-specific Bun scripts where appropriate.
- Use `neverthrow` for functions that can fail. Prefer `Result<T, E>` for synchronous fallible helpers and `ResultAsync<T, E>` for async health checks.
- Use Zod-backed schemas when structured external or adapter-provided inputs require runtime validation; keep inferred types as the source of truth.
- Keep engine helpers pure where possible, following the pattern in `packages/engine/src/model-resolution.ts`.
- Add isolated tests with mocks rather than starting real harnesses or reading real harness state.
- Export new public engine APIs through `packages/engine/src/index.ts`.
- Update docs for non-trivial architecture changes and link the new spec from existing architecture documentation.
- Use Conventional Commits when the later SDD task workflow creates the planning commit.

## Technical Considerations

- The likely implementation home is a new engine module such as `packages/engine/src/capabilities.ts` or `packages/engine/src/capability-contract.ts`, with exports from `packages/engine/src/index.ts`.
- The current `HarnessAdapter` in `packages/engine/src/adapter.ts` is explicitly transitional. New contract design should avoid treating deprecated `registerHook()` and `loadSkill()` as precedent.
- The model-resolution helper is the preferred pattern: accept explicit adapter-supplied context, return normalized output, and do not query harness runtime state inside the engine.
- The existing CLI installer interface includes `HarnessInstaller.supported: boolean`; capability readiness should provide a richer future replacement or complement for that binary signal.
- Required capability declarations should include enough metadata to explain whether support is `native` or `emulated`; emulated support must be treated as satisfying a required capability when behavior is equivalent for the readiness profile.
- Runtime health checks should combine static capability declarations with adapter-supplied probe results, but the engine should not perform harness-specific I/O.
- Renderer-ready output should separate data production from presentation so human, JSON, and TOON renderers can be tested with fixtures.
- Latest-standards research summary: no external technology-specific standards research was needed because this feature defines internal Weave architecture and readiness vocabulary. The relevant standards are repository-local architecture rules: harness-neutral engine APIs, adapter-owned discovery, Bun-only runtime, `neverthrow` error modeling, and mock-based tests.

## Security Considerations

- Health reports and proof artifacts must not include API keys, tokens, credentials, local secrets, `.env` values, or sensitive harness configuration contents.
- Runtime probe details should report capability status and remediation hints without dumping private file paths or secret-bearing command output unless explicitly sanitized.
- Tool policy mapping/enforcement is a required capability because incorrect translation could grant broader permissions than intended.
- Safe Adapter Init must be read-only and must not register hooks, launch agents, mutate user harness state, or write generated config as part of readiness checking.
- JSON and TOON output should be safe to attach to issues after redaction guidance is followed.

## Success Metrics

1. **Contract coverage**: All required and optional capabilities listed in issue #49 are represented in the shared model and readiness profile.
2. **Readiness correctness**: Tests prove required `degraded`/`unsupported` capabilities fail readiness, required `native`/`emulated` capabilities pass, and optional gaps produce warnings only.
3. **Boundary compliance**: Engine readiness evaluation operates on explicit adapter-provided inputs and does not perform harness-specific discovery or runtime mutation.
4. **CLI readiness**: Renderer-ready outputs can support human, JSON, and TOON formats without changing the core evaluation model.
5. **Documentation discoverability**: Existing architecture docs link to the completed capability contract spec.

## Open Questions

1. Should `token usage reporting when harness exposes usage` be represented as a conditional required capability with a `not-applicable` style status, or as a required capability whose readiness can be `emulated` only when equivalent usage data is available?
2. Should the first implementation expose a standalone `SafeAdapterInit` interface, or should safe readiness checks be modeled as an optional method on adapter capability declarations?
3. Should renderer implementations live in `@weaveio/weave-engine` as normalized format helpers or in `@weaveio/weave-cli` as presentation-specific code that consumes engine evaluation results?
