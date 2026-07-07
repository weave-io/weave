# Spec 16 Validation — Stable Adapter Descriptor Contract

Validation Completed: 2026-05-22 16:03:01 EDT  
Validation Performed By: gpt-5.5

## 1. Executive Summary

| Field | Result |
| --- | --- |
| Overall Verdict | PASS |
| Implementation Ready | Yes |
| Required Gate Failures | 0 |
| Blocking Issues | 0 |
| Proof Files Expected | 4 |
| Proof Files Verified Accessible | 4 |
| Expected Implementation Commits Verified | 4 / 4 |
| Targeted Commands Rerun | 5 / 5 |
| Final Quality Gate | PASS, exit 0 |

Spec 16 is implemented, tested, documented, and ready for the next workflow step. The stable adapter-facing `AgentDescriptor` contract is exported from `@weaveio/weave-engine`, includes `displayName` presentation metadata and optional normalized `category` metadata, preserves harness-neutral field semantics, omits disabled descriptors rather than emitting disabled records, and keeps concrete materialization responsibilities adapter-owned.

No blocking validation issues were found. The final `bun run lint && bun run typecheck && bun test packages/engine/src` gate exits `0`; lint prints pre-existing warning diagnostics in `packages/engine/src/__tests__/skill-resolution.test.ts`, but those diagnostics do not fail the configured gate and are outside the Spec 16 changed source set.

## 2. Coverage Matrix

### Functional Requirements

| Unit | Requirement Area | Evidence | Status |
| --- | --- | --- | --- |
| 1.0 | Export and document stable `AgentDescriptor` from `@weaveio/weave-engine` | `packages/engine/src/index.ts` exports `AgentDescriptor`; `docs/adapter-boundary.md` and `docs/prompt-composition.md` document the descriptor contract | PASS |
| 1.0 | Keep `name` as stable internal id | `AgentDescriptor.name: string`; compose tests assert stable builtin/custom names | PASS |
| 1.0 | Add optional `displayName` presentation metadata | `AgentDescriptor.displayName?: string`; `composeAgentDescriptor()` maps `agentConfig.display_name` without replacing `name` | PASS |
| 1.0 | Avoid harness-specific id fields | Source and docs expose harness-neutral `name`/`displayName`; no OpenCode/Claude/Pi-specific descriptor ids introduced | PASS |
| 2.0 | Expose final `composedPrompt`, not raw prompt sources | Compose tests assert `prompt`, `prompt_file`, and `prompt_append` are absent from descriptors | PASS |
| 2.0 | Preserve ordered `models` as abstract model intent | `models: agentConfig.models ?? []`; docs assign concrete model lookup/formatting to adapters | PASS |
| 2.0 | Expose abstract `rawToolPolicy` and `effectiveToolPolicy` only | Descriptor fields use `ToolPolicy` and `EffectiveToolPolicy`; docs assign concrete tool-name mapping/enforcement to adapters | PASS |
| 2.0 | Expose harness-neutral delegation metadata | `delegationTargets: DelegationTarget[]` covered in custom-agent descriptor tests | PASS |
| 2.0 | Keep skill data to requested skill names only | `skills: agentConfig.skills ?? []`; runner effect uses resolved skill names only, no adapter metadata | PASS |
| 3.0 | Include category metadata for generated shuttles | `AgentDescriptor.category` includes category `name`, optional `description`, and declared `patterns`; tests cover `shuttle-frontend` | PASS |
| 3.0 | Preserve category patterns without expansion or scanning | Tests assert declared patterns are preserved; source copies `category.patterns ?? []` and performs no glob expansion | PASS |
| 3.0 | Omit category metadata for regular agents | Compose tests assert regular descriptor `category` is `undefined` | PASS |
| 3.0 | Omit disabled declared agents and suppressed generated shuttles | Runner/materialization tests cover omission; `WeaveRunner` skips disabled agents | PASS |
| 3.0 | Keep workflows and commands out of descriptor scope | Spec and adapter boundary docs state workflow/command materialization is outside `AgentDescriptor` | PASS |
| 4.0 | Link Spec 16 from `docs/adapter-boundary.md` | `docs/adapter-boundary.md` links `specs/16-spec-stable-adapter-descriptor-contract/...` | PASS |
| 4.0 | Distinguish Spec 16 from Spec 14 and Spec 15 | Spec 16 cross-links category metadata and materialization API specs and states boundaries | PASS |
| 4.0 | Preserve runner compatibility | `bun test packages/engine/src/__tests__/runner.test.ts` rerun passes: 52 pass, 0 fail | PASS |
| 4.0 | Use isolated engine tests/mock fixtures | Changed tests are Bun engine tests; no real harness launches or harness resource writes observed | PASS |
| 4.0 | Document adapter-owned concrete output responsibilities | `docs/adapter-boundary.md` documents adapters own files, plugin entries, commands, hooks, concrete model fields, permissions, and feature-gap emulation | PASS |

### Repository Standards

| Standard | Evidence | Status |
| --- | --- | --- |
| Work in requested worktree only | `git rev-parse --show-toplevel` returned `/Users/jose/projects/weave.worktrees/spec-16-stable-descriptor`; branch `feat/spec-16-stable-descriptor` | PASS |
| Bun-only workflows | All validation commands used `bun`; no Node runtime commands used | PASS |
| Engine/adapter boundary | Engine constructs normalized descriptors; docs state adapters own discovery, concrete model/tool mapping, harness files, commands, hooks, and feature-gap emulation | PASS |
| Public exports from engine barrel | `packages/engine/src/index.ts` exports `AgentDescriptor` and `AgentDescriptorCategory` types | PASS |
| `neverthrow` expected-failure style | `composeAgentDescriptor()` continues returning `ResultAsync<AgentDescriptor, ComposeError>` | PASS |
| Isolated tests | Engine tests use in-memory fixtures/mock adapter patterns; no live harness process required | PASS |
| Living documentation | `docs/adapter-boundary.md`, `docs/prompt-composition.md`, and Spec 16 docs updated | PASS |
| Security hygiene for proof artifacts | Secret scan found no matches in Spec 16 docs/proofs; manual review found no credentials/tokens/passwords/API keys | PASS |
| D1 scope gate | Core/source changes map to Spec 16; supporting docs/tests/proofs/codesight metadata are acceptable and linked | PASS |

### Proof Artifacts

| Proof Artifact | Accessibility | Reviewer Context | Independent Verification | Status |
| --- | --- | --- | --- | --- |
| `16-proofs/16-task-01-proofs.md` | Read successfully | Front-loads task summary, what it proves, evidence, conclusion | Reran compose test and engine typecheck; inspected export/docs | PASS |
| `16-proofs/16-task-02-proofs.md` | Read successfully | Front-loads task summary, non-category field claims, evidence, conclusion | Reran compose test; inspected descriptor shape and prompt-source omission tests | PASS |
| `16-proofs/16-task-03-proofs.md` | Read successfully | Front-loads task summary, category/disabled claims, evidence, conclusion | Reran descriptors/compose/runner tests; inspected category metadata source path | PASS |
| `16-proofs/16-task-04-proofs.md` | Read successfully | Front-loads task summary, docs/compatibility claims, evidence, conclusion | Reran runner and final quality gates; inspected docs links | PASS |

## 3. Validation Issues

No blocking validation issues were found.

| Severity | Issue | Evidence | Disposition |
| --- | --- | --- | --- |
| Info | Final lint gate prints existing warnings in `packages/engine/src/__tests__/skill-resolution.test.ts` | `bun run lint && bun run typecheck && bun test packages/engine/src` exited `0` while reporting 37 warnings and 19 infos | Non-blocking; outside Spec 16 changed source files and not a gate failure |

## 4. Gate and Rubric Results

### Gates A-F

| Gate | Result | Evidence |
| --- | --- | --- |
| Gate A — Spec/task discovery | PASS | Spec, task, audit, and proof directories discovered and readable |
| Gate B — Commit/file analysis | PASS | Expected commits `a67d2b6`, `e41abed`, `2d666c2`, `b6a0d62` present with relevant stats |
| Gate C — Requirement coverage | PASS | Functional matrix maps all Spec 16 units to code, tests, docs, and rerun commands |
| Gate D — Scope/repository standards | PASS | No unmapped out-of-scope core/source changes found; supporting docs/tests/proofs/codesight metadata acceptable |
| Gate E — Proof verification/security hygiene | PASS | All four proof files accessible; grep/manual review found no secrets or credential-like content |
| Gate F — Independent execution | PASS | All requested targeted/final gates rerun successfully; final quality gate exit `0` |

### Rubric R1-R6

| Rubric | Result | Evidence |
| --- | --- | --- |
| R1 — Requirement-to-implementation traceability | PASS | Each functional requirement maps to changed source, tests, or docs |
| R2 — Test sufficiency | PASS | Builtin, custom, category, disabled-entry, prompt-source, and runner compatibility tests pass |
| R3 — Boundary correctness | PASS | Descriptor remains harness-neutral; docs keep concrete materialization adapter-owned |
| R4 — Proof quality | PASS | Proof docs front-load reviewer context and include command evidence/conclusions |
| R5 — Regression readiness | PASS | Targeted tests plus full engine test suite pass |
| R6 — Security/privacy hygiene | PASS | No real secrets/tokens/passwords/API keys detected in proof/spec docs; descriptor skills remain names only |

## 5. Evidence Appendix

### Worktree and Branch Confirmation

```text
$ git rev-parse --show-toplevel
/Users/jose/projects/weave.worktrees/spec-16-stable-descriptor

$ git rev-parse --is-bare-repository
false

$ git status --short --branch
## feat/spec-16-stable-descriptor
```

### Recent Commit Analysis

Expected implementation commits were present at the tip of `feat/spec-16-stable-descriptor`:

```text
b6a0d62 docs(engine): document stable descriptor contract
2d666c2 feat(engine): include category descriptor metadata
e41abed test(engine): cover stable descriptor fields
a67d2b6 feat(engine): add descriptor display name
```

Relevant `git log --stat -4` observations:

- `a67d2b6` added Spec 16 docs/proofs/tasks, adjacent Spec 14/15 docs, adapter-boundary docs, compose tests, and `displayName` in `compose.ts`.
- `e41abed` added stable non-category descriptor tests and supporting docs/proofs.
- `2d666c2` added category descriptor metadata in engine source, compose/descriptors/runner tests, and task 3 proof evidence.
- `b6a0d62` documented the stable descriptor contract in adapter-boundary/prompt-composition docs and added task 4 proof evidence.

### Changed File Classification

Core/source implementation changes mapped to Spec 16:

- `packages/engine/src/compose.ts`
- `packages/engine/src/index.ts`
- `packages/engine/src/runner.ts`
- `packages/engine/src/template-context.ts`

Core/source tests mapped to Spec 16:

- `packages/engine/src/__tests__/compose.test.ts`
- `packages/engine/src/__tests__/descriptors.test.ts`
- `packages/engine/src/__tests__/runner.test.ts`

Supporting documentation/proof changes:

- `docs/adapter-boundary.md`
- `docs/prompt-composition.md`
- `docs/specs/16-spec-stable-adapter-descriptor-contract/**`
- Adjacent linked Spec 14/15 documentation files
- `.codesight/**` metadata

D1 scope conclusion: PASS. No unmapped out-of-scope core/source changes were found.

### Source Inspection Highlights

`packages/engine/src/compose.ts`:

```ts
export interface AgentDescriptor {
  name: string;
  displayName?: string;
  description?: string;
  category?: AgentDescriptorCategory;
  composedPrompt: string;
  models: string[];
  mode: AgentMode;
  temperature?: number;
  effectiveToolPolicy: EffectiveToolPolicy;
  rawToolPolicy: ToolPolicy | undefined;
  delegationTargets: DelegationTarget[];
  skills: string[];
}
```

`composeAgentDescriptor()` returns `name: agentName`, `displayName: agentConfig.display_name`, optional normalized `category`, `composedPrompt`, ordered `models`, abstract policy fields, delegation targets, and requested skill names.

`packages/engine/src/index.ts` exports:

```ts
export type {
  AgentDescriptor,
  AgentDescriptorCategory,
  ComposeError,
  DelegationTarget,
  PromptTemplateReason,
} from "./compose.js";
```

### Proof File Checks

All required proof files exist and were read:

```text
docs/specs/16-spec-stable-adapter-descriptor-contract/16-proofs/16-task-01-proofs.md
docs/specs/16-spec-stable-adapter-descriptor-contract/16-proofs/16-task-02-proofs.md
docs/specs/16-spec-stable-adapter-descriptor-contract/16-proofs/16-task-03-proofs.md
docs/specs/16-spec-stable-adapter-descriptor-contract/16-proofs/16-task-04-proofs.md
```

Secret scan command:

```text
$ grep -RInE '(AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|ghp_[0-9A-Za-z]{36}|github_pat_[0-9A-Za-z_]{20,}|sk-[A-Za-z0-9]{20,}|xox[baprs]-[0-9A-Za-z-]{10,}|-----BEGIN (RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----|password\s*[:=]|api[_-]?key\s*[:=]|secret\s*[:=]|token\s*[:=])' docs/specs/16-spec-stable-adapter-descriptor-contract || true
```

Result: no matches.

### Commands Rerun

```text
$ bun test packages/engine/src/__tests__/compose.test.ts
bun test v1.3.13 (bf2e2cec)
39 pass
0 fail
91 expect() calls
Ran 39 tests across 1 file. [42.00ms]
```

```text
$ bun run --filter '@weaveio/weave-engine' typecheck
@weaveio/weave-engine typecheck: Exited with code 0
```

```text
$ bun test packages/engine/src/__tests__/descriptors.test.ts packages/engine/src/__tests__/compose.test.ts packages/engine/src/__tests__/runner.test.ts
bun test v1.3.13 (bf2e2cec)
113 pass
0 fail
270 expect() calls
Ran 113 tests across 3 files. [51.00ms]
```

```text
$ bun test packages/engine/src/__tests__/runner.test.ts
bun test v1.3.13 (bf2e2cec)
52 pass
0 fail
147 expect() calls
Ran 52 tests across 1 file. [41.00ms]
```

```text
$ bun run lint && bun run typecheck && bun test packages/engine/src
FINAL_EXIT:0
Checked 108 files in 36ms. No fixes applied.
Found 37 warnings.
Found 19 infos.
$ tsc --noEmit -p tsconfig.json && bun run --filter '*' typecheck
@weaveio/weave-core typecheck: Exited with code 0
@weaveio/weave-engine typecheck: Exited with code 0
@weaveio/weave-adapter-opencode typecheck: Exited with code 0
@weaveio/weave-config typecheck: Exited with code 0
@weaveio/weave-cli typecheck: Exited with code 0
bun test v1.3.13 (bf2e2cec)
974 pass
0 fail
2859 expect() calls
Ran 974 tests across 19 files. [553.00ms]
```

### Final Status Before Report Write

```text
$ git status --short --branch
## feat/spec-16-stable-descriptor
```

After writing this validation report, the only expected uncommitted change is this report file.
