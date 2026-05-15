## Relevant Files

| File | Why It Is Relevant |
| --- | --- |
| `docs/specs/07-spec-adapter-capability-contract/07-spec-adapter-capability-contract.md` | Approved source spec for Adapter Capability Contract requirements and proof expectations. |
| `docs/specs/07-spec-adapter-capability-contract/07-tasks-adapter-capability-contract.md` | SDD task plan that maps the approved spec into implementation work and proof artifacts. |
| `docs/specs/07-spec-adapter-capability-contract/07-audit-adapter-capability-contract.md` | Planning audit report for gate results, standards evidence, and requirement coverage checks. |
| `docs/adapter-boundary.md` | Architecture boundary that must link to the capability contract and prohibit engine-owned harness discovery or mutation. |
| `docs/product-vision.md` | Product-level architecture source that must link to the capability contract and reinforce adapter-owned harness translation. |
| `CONTEXT.md` | Project context referenced by the spec; update only if the active implementation branch already owns context changes or if maintainers confirm it should summarize the new contract. |
| `README.md` | User-facing command and package overview; update only if readiness reporting becomes discoverable from the public README. |
| `packages/engine/src/capability-contract.ts` | Likely new pure engine module for capability types, readiness profile definitions, evaluation, health-report inputs, and renderer-ready report models. |
| `packages/engine/src/index.ts` | Public `@weave/engine` barrel that must export new capability contract types and helpers. |
| `packages/engine/src/adapter.ts` | Transitional adapter boundary; may receive documentation-only adapter-owned readiness interfaces, but new work must not treat deprecated `registerHook()`/`loadSkill()` as precedent. |
| `packages/engine/src/model-resolution.ts` | Existing pure-helper pattern to mirror: explicit adapter-supplied context in, normalized result out, no harness queries. |
| `packages/engine/src/__tests__/capability-contract.test.ts` | New engine tests for readiness values, capability entry shape, schemas, public model behavior, and sanitized fixtures. |
| `packages/engine/src/__tests__/capability-readiness.test.ts` | New engine tests for Core Readiness Profile required failures, emulated passes, optional warnings, token-usage applicability, and coverage guards. |
| `packages/engine/src/__tests__/adapter-health-report.test.ts` | New engine tests for adapter-supplied declarations/probe results, Safe Adapter Init inputs, `Result`/`ResultAsync` error modeling, and boundary-safe evaluation. |
| `packages/engine/src/__tests__/capability-reporting.test.ts` | New engine tests for renderer-ready report structures, deterministic ordering, JSON interchange data, and TOON-ready normalized output. |
| `packages/cli/src/readiness/render.ts` | Possible new CLI presentation helper for human/JSON/TOON fixtures that consumes engine report models without implementing full `doctor`, `status`, or `debug` commands. |
| `packages/cli/src/readiness/__tests__/render.test.ts` | Possible new CLI tests for human rows, parseable JSON output, deterministic TOON output, and sanitized fixture content. |
| `packages/cli/src/installers/index.ts` | Existing `HarnessInstaller.supported` binary signal that should be documented as complemented or eventually superseded by richer capability readiness. |
| `packages/core/src/schema.ts` | Source of `ToolPolicy`/`ToolPolicySchema`; capability entries that describe tool policy support should reference these concepts rather than duplicating enums. |
| `packages/engine/package.json` | Engine package scripts and dependencies; confirms `neverthrow` and `zod` are already available for capability contract work. |
| `packages/cli/package.json` | CLI package scripts and dependencies; confirms CLI helpers should use Bun tests and avoid adding full command scope unless required. |
| `AGENTS.md` | Repository standards for Bun-only runtime, `neverthrow`, pure engine helpers, mock-based tests, logging, and living documentation. |
| `package.json` | Root workspace scripts for `bun run lint`, `bun run typecheck`, `bun run build`, and `bun run test`. |
| `.github/workflows/ci.yml` | CI gate order and Bun version for final verification expectations. |
| `biome.json` | Formatting/lint rules, including no `console`, no explicit `any`, and no nested ternary. |
| `tsconfig.json` | Strict TypeScript and workspace path aliases that new exports must satisfy. |
| `bunfig.toml` | Bun test preload, timeout, and smol-mode configuration. |

### Notes

- Planning assumption: `token usage reporting when harness exposes usage` is a conditional required capability. The report model should include explicit applicability/status so harnesses that do not expose usage do not fail the Core Readiness Profile for that unavailable signal.
- Planning assumption: Safe Adapter Init should be encoded as adapter-owned declaration/probe input or a small adapter-facing readiness provider, not as a new precedent based on transitional `HarnessAdapter.registerHook()` or `HarnessAdapter.loadSkill()` methods.
- Planning assumption: `@weave/engine` owns normalized report/result structures and deterministic data contracts; `@weave/cli` may own presentation helpers/fixtures that consume those structures, but full `doctor`, `status`, or `debug` command implementation remains out of scope.
- Keep engine helpers pure and deterministic. Adapters supply static declarations, runtime probe results, harness usage applicability, and any feature-gap emulation notes as explicit inputs.
- Use `neverthrow` for fallible declaration/probe collection paths. Use Zod schemas only where runtime validation is needed for adapter-provided or external structured inputs.
- Tests must use synthetic adapter ids, synthetic remediation text, and mocked adapter/probe data. Do not read live harness directories, launch harness processes, register hooks, materialize agents, or commit local runtime details.
- Final implementation verification should include targeted Bun tests plus `bun run lint`, `bun run typecheck`, `bun run build`, and `bun run test`.

## Tasks

### [x] 1.0 Define the shared adapter capability model and public engine exports

#### 1.0 Scope

- Establish the harness-neutral vocabulary that engine, adapters, CLI, docs, and tests can all import.
- Cover exact readiness levels: `native`, `emulated`, `degraded`, and `unsupported`.
- Define shared capability entries with id, display name/description, readiness, implementation notes, runtime status when available, and blocking impact.
- Keep required-vs-optional semantics in a readiness profile instead of a binary `supported` flag.
- Export the public model from `@weave/engine` and reference existing `@weave/core` concepts such as `ToolPolicy` for tool-policy capability metadata rather than duplicating them.
- Likely implementation surface: `packages/engine/src/capability-contract.ts` or `packages/engine/src/capabilities.ts`, `packages/engine/src/index.ts`, and `packages/engine/src/__tests__/capability-contract.test.ts`.

#### 1.0 Proof Artifact(s)

- Test: `bun test packages/engine/src/__tests__/capability-contract.test.ts` demonstrates the shared model accepts the four approved readiness values and rejects or prevents unsupported states.
- Test: model fixtures demonstrate capability entries carry id, display/description, readiness, implementation notes, runtime status, and blocking impact without harness-specific data.
- Typecheck: `bun run typecheck` demonstrates public capability exports are usable across workspace packages.
- Code review artifact: `packages/engine/src/index.ts` exports the capability model from `@weave/engine`.
- Code review artifact: tool-policy capability metadata references `@weave/core` `ToolPolicy` concepts instead of duplicating policy enums.
- Sanitization proof: capability fixtures use synthetic adapter names and synthetic notes only; no credentials, local paths, or harness config contents are committed.

#### 1.0 Tasks

- [x] 1.1 Create the new engine capability contract module at `packages/engine/src/capability-contract.ts` with no harness-specific I/O, process spawning, or adapter runtime calls.
- [x] 1.2 Define `CapabilityReadiness` with exactly `native`, `emulated`, `degraded`, and `unsupported`; add a test that enumerates the allowed values and rejects or prevents any extra state.
- [x] 1.3 Define the shared capability id/display/description model, including stable ids for all required and optional capabilities named by the spec.
- [x] 1.4 Define capability entry fields for readiness, implementation notes, optional runtime status, blocking impact, source/supplier metadata, remediation hint, and sanitized detail text.
- [x] 1.5 Add Zod-backed runtime validation only for adapter-provided declaration objects if implementation accepts untrusted structured input; keep inferred TypeScript types as the source of truth.
- [x] 1.6 Reference `ToolPolicy`/`ToolPolicySchema` concepts from `@weave/core` for the tool-policy mapping/enforcement capability instead of duplicating allow/deny/ask enums.
- [x] 1.7 Add synthetic capability fixtures that prove entries can describe native, emulated, degraded, and unsupported readiness without using local paths, credentials, or real harness config.
- [x] 1.8 Export the new public types, schemas if any, constants, and helper signatures through `packages/engine/src/index.ts`.
- [x] 1.9 Add `packages/engine/src/__tests__/capability-contract.test.ts` covering readiness values, required fields, optional runtime-status fields, blocking-impact fields, tool-policy references, and export usability.
- [x] 1.10 Run `bun test packages/engine/src/__tests__/capability-contract.test.ts` and `bun run typecheck` as the proof commands for this parent task.

### [x] 2.0 Implement the Core Readiness Profile evaluator

#### 2.0 Scope

- Define the built-in Core Readiness Profile as the minimum readiness policy for core harness integrations.
- Classify required capabilities: config materialization, agent materialization, primary/default agent selection, delegated specialist execution/subagents, prompt composition/injection/run-agent support, tool policy mapping/enforcement, workflow persistence, workflow step dispatch, plan-file compatibility, command entrypoints, event logging/debug traces, and token usage reporting when the harness exposes usage.
- Classify optional capabilities: idle continuation, compaction recovery, context-window monitor, analytics dashboard, eval integration, static artifact generation, and multiple active workflows.
- Evaluate required capabilities as passing only when `native` or equivalent `emulated`; fail readiness for required `degraded` or `unsupported` entries.
- Evaluate optional `degraded` or `unsupported` entries as warnings only.
- Produce structured output with blocking failures and non-blocking warnings that downstream CLI renderers can consume.
- Planning assumption for the open token-usage question: do not add a fifth readiness level; model token usage as conditionally required when adapter-provided context says the harness exposes usage, otherwise include an explicit sanitized applicability/runtime-status explanation that does not block the profile.
- Likely implementation surface: same engine capability module as task 1.0 plus `packages/engine/src/__tests__/capability-readiness.test.ts` or equivalent split tests.

#### 2.0 Proof Artifact(s)

- Test: Core Readiness Profile rejects a required capability whose readiness is `degraded`.
- Test: Core Readiness Profile rejects a required capability whose readiness is `unsupported`.
- Test: Core Readiness Profile accepts a required capability whose readiness is `emulated` when the capability states equivalent behavior.
- Test: optional `unsupported` and optional `degraded` capabilities produce warning entries without failing readiness.
- Test: a coverage guard fixture asserts every required and optional capability named in the spec is present in the Core Readiness Profile exactly once.
- CLI JSON fixture: readiness evaluation output includes a deterministic profile id, overall status, blocking entries, warning entries, and per-capability readiness data.
- Sanitization proof: evaluation fixtures use synthetic implementation notes and remediation hints only; no local harness state or secrets are recorded.

#### 2.0 Tasks

- [x] 2.1 Define a `CORE_READINESS_PROFILE` constant with stable profile id, display metadata, required capability ids, optional capability ids, and deterministic ordering.
- [x] 2.2 Add every required capability from the spec to the profile: config materialization, agent materialization, primary/default agent selection, delegated specialist execution/subagents, prompt composition/injection/run-agent support, tool policy mapping/enforcement, workflow persistence, workflow step dispatch, plan-file compatibility, command entrypoints, event logging/debug traces, and conditional token usage reporting.
- [x] 2.3 Add every optional capability from the spec to the profile: idle continuation, compaction recovery, context-window monitor, analytics dashboard, eval integration, static artifact generation, and multiple active workflows.
- [x] 2.4 Define profile evaluation input that accepts adapter declarations plus an explicit adapter-provided token-usage applicability flag/status for harnesses that expose usage metrics.
- [x] 2.5 Implement pure readiness evaluation that marks required `native` and equivalent `emulated` entries as passing.
- [x] 2.6 Implement required-capability failure behavior so required `degraded` and `unsupported` entries produce blocking failures and fail the overall profile.
- [x] 2.7 Implement optional-capability warning behavior so optional `degraded` and `unsupported` entries produce non-blocking warnings and do not fail the overall profile.
- [x] 2.8 Implement missing-capability handling with deterministic blocking failures for missing required entries and deterministic warnings for missing optional entries.
- [x] 2.9 Include structured evaluation output fields for profile id, adapter id, overall status, per-capability results, blocking failures, non-blocking warnings, applicability details, and sanitized remediation hints.
- [x] 2.10 Add a coverage-guard test that compares the profile's required and optional ids against the full list from the approved spec so future edits cannot silently drop a capability.
- [x] 2.11 Add tests proving required `degraded` fails, required `unsupported` fails, required equivalent `emulated` passes, optional gaps warn only, missing required entries fail, and token usage is required only when the adapter says the harness exposes usage.
- [x] 2.12 Add a sanitized JSON fixture assertion showing blocking entries and warning entries in deterministic order for downstream CLI consumption.
- [x] 2.13 Run `bun test packages/engine/src/__tests__/capability-readiness.test.ts` and `bun run typecheck` as the proof commands for this parent task.

### [x] 3.0 Define adapter-owned declarations, runtime health reports, and Safe Adapter Init inputs

#### 3.0 Scope

- Provide the adapter declaration API for static baseline capabilities and adapter-supplied runtime probe results.
- Define Adapter Health Report data that explains whether an adapter is currently usable in its environment.
- Define a Safe Adapter Init path for read-only readiness verification without materializing agents, registering hooks, launching workflows, or mutating harness state.
- Keep harness-owned checks inside adapters; engine helpers must accept declarations and probe results as explicit inputs and must not scan harness directories, query harness APIs, or register concrete hooks.
- Model fallible health-check logic with `neverthrow` `Result` or `ResultAsync` error types.
- Include enough health report detail for CLI output to explain what failed, why it blocks or warns, and which component supplied the information.
- Planning assumption for the Safe Adapter Init open question: expose safe readiness checks through adapter-owned capability declaration/probe inputs or a future adapter-facing readiness provider, not by expanding the transitional `HarnessAdapter.registerHook()`/`loadSkill()` precedent.
- Likely implementation surface: engine capability module, new or updated adapter-facing types near `packages/engine/src/adapter.ts` only if needed, and mock-based tests under `packages/engine/src/__tests__/`.

#### 3.0 Proof Artifact(s)

- Test: a mock adapter or adapter fixture supplies static declarations and runtime probe results; engine evaluation uses only those explicit inputs.
- Test: runtime probe failures are represented with `Result`/`ResultAsync` error types and become structured health report entries instead of thrown expected failures.
- Test: health reports identify supplier component, capability id, blocking impact, runtime status, and remediation hint where available.
- Code review artifact: engine helpers do not use harness-specific file I/O, do not scan harness-owned directories, do not launch harness processes, and do not register concrete hooks.
- Code review artifact: Safe Adapter Init is documented as read-only and separate from agent materialization/workflow launch paths.
- Sanitization proof: health report fixtures redact or synthesize file paths, command output, credentials, tokens, and harness configuration contents.

#### 3.0 Tasks

- [x] 3.1 Define adapter-owned static declaration input types that let adapters provide baseline capability entries and implementation notes without the engine discovering harness resources.
- [x] 3.2 Define adapter-owned runtime probe result types for current environment status, including supplier component, runtime status, blocking impact, sanitized details, and remediation hints.
- [x] 3.3 Define `AdapterHealthReport` output that combines declaration and runtime probe data into a CLI-ready health summary without exposing secrets or local harness config contents.
- [x] 3.4 Define the Safe Adapter Init shape as an adapter-owned readiness provider/input that performs read-only checks and returns declarations/probes; do not require full agent materialization or workflow startup.
- [x] 3.5 Add documentation comments that Safe Adapter Init must not materialize agents, register hooks, launch workflows, mutate harness config, write files, or start harness runtimes.
- [x] 3.6 Model fallible runtime probe collection with `Result` or `ResultAsync` error unions so expected missing/unavailable harness state does not throw.
- [x] 3.7 Implement pure engine helper behavior that accepts adapter-provided declaration/probe values and returns normalized health/evaluation output without calling `Bun.file`, launching processes, scanning directories, or calling harness APIs.
- [x] 3.8 Add mock adapter/readiness-provider fixtures that supply successful probes, blocking probe failures, warning-only probe gaps, and sanitized remediation hints.
- [x] 3.9 Add `packages/engine/src/__tests__/adapter-health-report.test.ts` covering explicit adapter input, `Result`/`ResultAsync` failure mapping, supplier attribution, blocking/warning health details, and sanitized output.
- [x] 3.10 Review `packages/engine/src/adapter.ts` changes, if any, to ensure transitional `registerHook()` and `loadSkill()` remain documented as non-precedent and are not used by the new evaluator.
- [x] 3.11 Run `bun test packages/engine/src/__tests__/adapter-health-report.test.ts` and `bun run typecheck` as the proof commands for this parent task.

### [ ] 4.0 Provide renderer-ready readiness report structures and deterministic CLI fixtures

#### 4.0 Scope

- Define renderer-ready structures for human-readable, JSON, and TOON readiness output without hard-coding harness-specific assumptions in the engine.
- Preserve JSON as the machine-readable interchange format.
- Preserve TOON as a compact deterministic representation for LLM-oriented consumption.
- Keep data production separate from presentation so downstream `doctor`, `status`, or `debug` commands can render profile results consistently.
- Avoid committing sensitive runtime data, credentials, local file contents, or harness secrets in proof artifacts.
- Planning assumption for the renderer-location open question: engine owns normalized report/result structures and deterministic data contracts; CLI owns concrete terminal presentation when full commands are implemented downstream.
- Likely implementation surface: engine report DTOs/normalizers plus fixture-oriented CLI tests or fixtures under `packages/cli/src/**` only if needed for proof.

#### 4.0 Proof Artifact(s)

- CLI fixture: human renderer-ready output lists pass/fail/warning capability rows with capability names, readiness, blocking impact, and remediation hints.
- CLI fixture: JSON renderer-ready output is parseable and includes profile id, adapter id, overall readiness, blocking failures, warnings, runtime health details, and capability entries.
- CLI fixture: TOON renderer-ready output is deterministic across repeated test runs and preserves stable ordering for LLM-oriented comparison.
- Test: renderer-ready structures can be produced from the same evaluation result without re-running adapter probes or mutating harness state.
- Test: JSON remains the authoritative machine-readable interchange fixture; human and TOON outputs are derived from the same sanitized report model.
- Sanitization proof: report fixtures contain only synthetic adapter ids, synthetic remediation hints, and redacted runtime-status examples.

#### 4.0 Tasks

- [ ] 4.1 Define a normalized readiness report model in the engine that includes adapter id, profile id, overall readiness status, capability rows, blocking failures, warnings, health details, and generated-at/ordering rules that remain deterministic in tests.
- [ ] 4.2 Add a pure engine helper that converts profile evaluation plus health report data into the normalized report model without re-running probes or mutating harness state.
- [ ] 4.3 Define JSON interchange output as the canonical machine-readable representation of the normalized report model.
- [ ] 4.4 Define a stable human-row DTO with status, capability name, readiness, blocking impact, runtime status, and remediation hint so CLI presentation can render readable rows later.
- [ ] 4.5 Define TOON-ready output rules or a serializer with stable key order, stable row order, and compact deterministic formatting for LLM-oriented consumption.
- [ ] 4.6 Add sanitized fixture data that includes at least one pass, one blocking failure, one optional warning, one runtime health detail, and one token-usage applicability example.
- [ ] 4.7 Add `packages/engine/src/__tests__/capability-reporting.test.ts` covering normalized report generation, deterministic ordering, parseable JSON data, TOON-ready deterministic data, and no probe re-execution.
- [ ] 4.8 If CLI presentation helpers are added, create `packages/cli/src/readiness/render.ts` to render human, JSON, and TOON fixture output from engine report models without adding full `doctor`, `status`, or `debug` commands.
- [ ] 4.9 If CLI presentation helpers are added, create `packages/cli/src/readiness/__tests__/render.test.ts` covering human rows, JSON parseability, repeated TOON output equality, and no `console.*` usage outside the terminal boundary.
- [ ] 4.10 Verify every renderer fixture is sanitized: synthetic adapter ids, synthetic paths such as `<redacted>`, no credentials, no real command output, and no local harness configuration contents.
- [ ] 4.11 Run `bun test packages/engine/src/__tests__/capability-reporting.test.ts`, any CLI readiness render tests, and `bun run typecheck` as the proof commands for this parent task.

### [ ] 5.0 Document readiness gates and the installer-support migration boundary

#### 5.0 Scope

- Document readiness gate semantics and link the capability contract from existing architecture documentation.
- Explain how `native`, `emulated`, `degraded`, and `unsupported` affect Core Readiness Profile pass/fail/warn outcomes.
- Document that adapter runtime health and Safe Adapter Init are adapter-owned/read-only and that engine helpers consume explicit adapter-provided inputs.
- Identify how existing binary installer support such as `HarnessInstaller.supported` relates to, complements, or is eventually superseded by capability readiness.
- Ensure proof artifacts and docs include redaction guidance and do not expose secrets.
- Likely implementation surface: `docs/specs/07-spec-adapter-capability-contract/07-spec-adapter-capability-contract.md`, `docs/adapter-boundary.md`, `docs/product-vision.md`, `CONTEXT.md` if already part of the active SDD branch, and possibly CLI installer docs/comments where `HarnessInstaller.supported` is discussed.

#### 5.0 Proof Artifact(s)

- Docs: `docs/adapter-boundary.md` or `docs/product-vision.md` links to the Adapter Capability Contract spec and summarizes the readiness contract’s boundary implications.
- Docs: the spec or companion docs describe required-vs-optional Core Readiness Profile semantics, including required `degraded`/`unsupported` failure and optional-gap warning behavior.
- Docs: Safe Adapter Init is documented as read-only and adapter-owned, with no materialization, hook registration, workflow launch, or harness-state mutation.
- Docs/code review artifact: `HarnessInstaller.supported` is explicitly described as a legacy/binary installer signal that capability readiness complements now and can supersede for richer status reporting later.
- Security review artifact: documentation and fixtures include proof-artifact redaction guidance for runtime health details, JSON output, and TOON output.
- Verification: `bun run lint`, `bun run typecheck`, `bun run build`, and `bun run test` remain the planned final checks for the completed implementation phase.

#### 5.0 Tasks

- [ ] 5.1 Update `docs/adapter-boundary.md` to link to the Adapter Capability Contract spec and explain that capability declarations/probes are adapter-owned inputs consumed by pure engine evaluators.
- [ ] 5.2 Update `docs/product-vision.md` to link to the Adapter Capability Contract spec and summarize how readiness levels make partial harness support explicit.
- [ ] 5.3 Update the capability contract spec or a linked companion section to document Core Readiness Profile semantics: required `native`/equivalent `emulated` passes, required `degraded`/`unsupported` fails, and optional gaps warn only.
- [ ] 5.4 Document the conditional token-usage assumption: token reporting is required only when adapter-provided context says the harness exposes usage data, and the report must carry explicit applicability/status.
- [ ] 5.5 Document Safe Adapter Init as read-only and adapter-owned: no agent materialization, hook registration, workflow launch, harness-state mutation, generated config writes, or harness runtime startup.
- [ ] 5.6 Add a migration note near `HarnessInstaller.supported` documentation or comments explaining that it is a legacy binary installer-support signal that capability readiness complements now and may supersede for richer status reporting later.
- [ ] 5.7 Add proof-artifact redaction guidance covering runtime health details, JSON output, TOON output, local paths, command output, credentials, API keys, tokens, `.env` values, and harness config contents.
- [ ] 5.8 Update `CONTEXT.md` only if the active branch already owns context documentation updates or maintainers confirm it should summarize the new capability contract.
- [ ] 5.9 Verify documentation links resolve and that docs do not reference deleted historical spec paths as new required reading.
- [ ] 5.10 Run targeted documentation review plus `bun run lint`, `bun run typecheck`, `bun run build`, and `bun run test` as the final planned verification set for the implementation phase.
