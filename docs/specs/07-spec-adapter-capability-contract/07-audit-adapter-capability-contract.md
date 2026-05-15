# SDD2 Planning Audit — Adapter Capability Contract

## Scope

- Spec: `docs/specs/07-spec-adapter-capability-contract/07-spec-adapter-capability-contract.md`
- Task plan: `docs/specs/07-spec-adapter-capability-contract/07-tasks-adapter-capability-contract.md`
- Issue: <https://github.com/weave-io/weave/issues/49>
- Audit mode: SDD2 Phase 4, planning-only, exception-focused.

## Standards Evidence

| Source path | Read status | Extracted standards | Conflicts |
| --- | --- | --- | --- |
| `AGENTS.md` | yes | Bun-only runtime; `neverthrow` for fallible APIs; pure engine helpers; mock-based tests; living docs required. | none |
| `README.md` | yes | Weave uses pure composition APIs; package layout includes engine/CLI/adapters; common commands use `bun run build`, `bun run typecheck`, `bun run test`. | none |
| `package.json` | yes | Root scripts: `bun run lint`, `bun run typecheck`, `bun run build`, `bun run test`; Biome/lint-staged workspace setup. | none |
| `.github/workflows/ci.yml` | yes | CI uses Bun 1.3.10, frozen install, lint, typecheck, build, test. | none |
| `biome.json` | yes | 2-space formatting; no `console`; no explicit `any`; no nested ternary; kebab/snake-case filenames. | none |
| `tsconfig.json` | yes | Strict TypeScript, `bun-types`, workspace aliases for `@weave/*`. | none |
| `bunfig.toml` | yes | Bun tests use preload, 5s timeout, smol mode. | none |
| `docs/adapter-boundary.md` | yes | Adapters own discovery/probes/concrete tools; engine accepts explicit context and stays harness-neutral. | none |
| `docs/product-vision.md` | yes | Weave owns normalized intent; adapters translate into harness behavior and fill feature gaps. | none |

## Gate Overview

| Gate | Required | Result | Evidence |
| --- | --- | --- | --- |
| Approved spec read | yes | PASS | Spec lines 1-150 reviewed. |
| Existing parent task file read | yes | PASS | Parent task file read before edit. |
| Required task file sections | yes | PASS | Task file includes `## Relevant Files`, `### Notes`, and `## Tasks`. |
| Parent-task structure preserved | yes | PASS | 5 parent tasks remain, each with `#### N.0 Proof Artifact(s)` and `#### N.0 Tasks`. |
| TBD replacement | yes | PASS | `TBD` search returned zero matches. |
| Subtasks actionable and junior-friendly | yes | PASS | 55 subtasks added across tasks 1.0-5.0 with concrete files, checks, and proof commands. |
| Functional requirement coverage | yes | PASS | Coverage table below maps every spec functional requirement to subtasks and proof artifacts. |
| Proof artifact quality | yes | PASS | Proofs are observable commands/fixtures/reviews, reproducible, scope-linked, and sanitized. |
| Open questions handled | yes | PASS | Token usage, Safe Adapter Init shape, and renderer location are explicit planning assumptions. |
| Repository standards reflected | yes | PASS | Bun, `neverthrow`, Zod-if-needed, pure engine helpers, mock tests, docs, and CI commands are planned. |
| Scope/non-goals protected | yes | PASS | Full adapter implementation, full CLI commands, workflow runtime, and permission internals remain out of scope. |
| Planning-only constraint | yes | PASS | Only SDD markdown artifacts were written; no source code changes were made. |

## Functional Requirement Coverage

| Spec requirement | Planned subtask(s) | Planned proof/test artifact(s) |
| --- | --- | --- |
| `CapabilityReadiness` has exactly `native`, `emulated`, `degraded`, `unsupported`. | 1.2 | `capability-contract.test.ts`; typecheck. |
| Capability entries record id, display/description, readiness, implementation notes, runtime status, blocking impact. | 1.3, 1.4, 1.7 | Model fixture tests; sanitized fixture review. |
| Required vs optional capabilities use readiness profile, not boolean support. | 2.1-2.3, 2.6-2.8 | Readiness tests; coverage guard. |
| Public capability types exported from `@weave/engine`. | 1.8, 1.10 | `packages/engine/src/index.ts` review; `bun run typecheck`. |
| Tool-policy capability avoids duplicating `ToolPolicy`. | 1.6, 1.9 | Tool-policy reference test/review. |
| Core Readiness Profile exists. | 2.1 | `capability-readiness.test.ts`. |
| Required capability list is complete. | 2.2, 2.10 | Coverage-guard test. |
| Optional capability list is complete. | 2.3, 2.10 | Coverage-guard test. |
| Required `native`/equivalent `emulated` passes. | 2.5, 2.11 | Emulated-pass test. |
| Required `degraded`/`unsupported` fails. | 2.6, 2.11 | Required degraded/unsupported failure tests. |
| Optional `degraded`/`unsupported` warns only. | 2.7, 2.11 | Optional warning-only tests. |
| Structured output identifies blocking failures and warnings. | 2.9, 2.12 | JSON fixture with blocking and warning entries. |
| Adapter Health Report exists. | 3.2, 3.3 | `adapter-health-report.test.ts`. |
| Safe Adapter Init is read-only and avoids materialization/hooks/workflows/mutation. | 3.4, 3.5 | Safe-init tests and code review artifact. |
| Harness checks stay inside adapters; engine consumes explicit inputs. | 3.1, 3.7, 3.10 | Mock adapter/probe tests; boundary review. |
| Fallible health checks use `Result`/`ResultAsync`. | 3.6, 3.9 | Health failure mapping tests. |
| Health report explains failure, blocking/warning impact, and supplier. | 3.2, 3.3, 3.9 | Health report detail tests. |
| Renderer-ready human/JSON/TOON structures exist. | 4.1-4.5, 4.8-4.9 | Reporting/render tests. |
| JSON is machine-readable; TOON is deterministic for LLM consumption. | 4.3, 4.5, 4.7, 4.9 | JSON parseability and repeated TOON equality tests. |
| Readiness semantics are documented and architecture docs link to the contract. | 5.1-5.5 | Docs review artifacts. |
| `HarnessInstaller.supported` relationship is identified. | 5.6 | Installer-support migration note review. |
| Sensitive runtime data is excluded from artifacts. | 4.6, 4.10, 5.7 | Sanitization reviews for fixtures and docs. |

## Open Question Handling

| Open question | Planning resolution | Blocking? |
| --- | --- | --- |
| Token usage reporting when harness exposes usage | Planned as conditional required capability with explicit applicability/status in the report model. | no |
| Safe Adapter Init shape | Planned as adapter-owned declaration/probe input or readiness provider with tests; not based on transitional adapter methods. | no |
| Renderer location | Planned as engine-owned normalized report structures plus optional CLI presentation helpers/fixtures; full commands stay out of scope. | no |

## Chain-of-Verification

- Spec requirements were traced from the approved spec into parent tasks, subtasks, and proof artifacts.
- Parent tasks remain demoable units of work; subtasks are implementation steps nested under those units.
- Every parent task has observable proof artifacts before its subtask list.
- `TBD` placeholders were removed.
- All proof artifacts are planned as commands, fixtures, or code/doc review artifacts with sanitization constraints.
- Unrelated working-tree changes under historical specs, `CONTEXT.md`, and `.weave/runtime/` were not modified by this SDD2 phase.

## Exceptions

None. All REQUIRED gates pass.
