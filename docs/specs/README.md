# Weave Specs Index

Formal specs define subsystem requirements with acceptance criteria and proof artifacts. Each spec lives in its own directory under `docs/specs/`.

Specs are numbered sequentially. Numbers 01–06 were retired or superseded; the active corpus begins at 07. See [Documentation Policy](../documentation-policy.md) for the artifact classification rules that govern spec directories.

---

## Active Specs

| # | Spec | Summary |
| --- | --- | --- |
| 07 | [Adapter Capability Contract](07-spec-adapter-capability-contract/07-spec-adapter-capability-contract.md) | Structured readiness vocabulary (`native`/`emulated`/`degraded`/`unsupported`) and Core Readiness Profile evaluation |
| 08 | [Abstract Tool Policy Evaluation](08-spec-abstract-tool-policy-evaluation/08-spec-abstract-tool-policy-evaluation.md) | Engine-owned `evaluateEffectiveToolPolicy`; adapter-owned concrete tool-name mapping |
| 09 | [Adapter-Provided Skill Resolution](09-spec-adapter-provided-skill-resolution/09-spec-adapter-provided-skill-resolution.md) | `loadAvailableSkills()` adapter surface; `resolveSkillsForConfig()` pure engine helper |
| 10a | [Builtin Prompt Defaults](10-spec-builtin-prompt-defaults/10-spec-builtin-prompt-defaults.md) | Builtin agent prompt embedding and bundle-safe resolution |
| 10b | [Workflow Engine](10-spec-workflow-engine/10-spec-workflow-engine.md) | Workflow execution engine design (superseded by Spec 22 for execution contract) |
| 11 | [Prompt Composition Templates](11-spec-prompt-composition-templates/11-spec-prompt-composition-templates.md) | Mustache template rendering, delegation section injection, template context fields |
| 12 | [Runtime Persistence](12-spec-runtime-persistence/12-spec-runtime-persistence.md) | SQLite-backed Runtime Store schema and ownership rules |
| 13 | [Minimal Execution Lifecycle Surface](13-spec-minimal-execution-lifecycle-surface/13-spec-minimal-execution-lifecycle-surface.md) | The 8 typed lifecycle methods; replaces `registerHook()` designs |
| 14 | [Preserve Category Metadata](14-spec-preserve-category-metadata/14-spec-preserve-category-metadata.md) | `CategoryMetadata` on generated shuttle descriptors |
| 15 | [Adapter-Facing Materialization API](15-spec-adapter-facing-materialization-api/15-spec-adapter-facing-materialization-api.md) | `materializeAgents()` pure API; `MaterializationPlan` contract |
| 16 | [Stable Adapter Descriptor Contract](16-spec-stable-adapter-descriptor-contract/16-spec-stable-adapter-descriptor-contract.md) | `AgentDescriptor` stable field table; disabled-entry rules |
| 17 | [Workflow Extension DSL](17-spec-workflow-extension/17-spec-workflow-extension.md) | `extends`, `insert_before`, `insert_after` step-aware merge |
| 18 | [Delegation Exclusion](18-spec-delegation-exclusion/18-spec-delegation-exclusion.md) | Excluding agents from delegation topology |
| 19 | [Plan State Provider](19-spec-plan-state-provider/19-spec-plan-state-provider.md) | Abstract `PlanStateProvider` interface; removes direct `Bun.file()` from engine |
| 20 | [OpenCode Adapter Materialization](20-spec-opencode-adapter-materialization/20-spec-opencode-adapter-materialization.md) | OpenCode-specific adapter materialization shape |
| 21a | [CLI Legacy Config Migration](21-spec-cli-legacy-config-migration/21-spec-cli-legacy-config-migration.md) | `weave init migrate` JSONC-to-DSL conversion |
| 21b | Workflow-First Execution (draft) | Earlier draft; superseded by Spec 22. No spec file — directory is empty. |
| 22 | [Workflow-First Execution](22-spec-workflow-first-execution/22-spec-workflow-first-execution.md) | `startExecution` as sole authorized entry point; `before-plan` extension surface; artifact integrity |
| 23 | Thermonuclear Quality Remediation | Planning artifact only; no formal spec file. Remediation work was decomposed into Specs 24–28. |
| 24 | [Execution Lifecycle Decomposition](24-spec-execution-lifecycle-decomposition/24-spec-execution-lifecycle-decomposition.md) | Concern-based split of `execution-lifecycle.ts` into four focused modules |
| 25 | [CLI Init and Migration Decomposition](25-spec-cli-init-and-migration-decomposition/25-spec-cli-init-and-migration-decomposition.md) | Split `init.ts`; move conversion logic to `packages/cli/src/migrate/` |
| 26 | [OpenCode Adapter Boundary Cleanup](26-spec-opencode-adapter-boundary-cleanup/26-spec-opencode-adapter-boundary-cleanup.md) | Typed spawn seam; canonical redaction helper import |
| 27 | [DSL Model and Schema Cleanup](27-spec-dsl-model-and-schema-cleanup/27-spec-dsl-model-and-schema-cleanup.md) | Remove phantom `extend_before_plan` per-workflow targeting; shared prompt-schema helpers |
| 28 | [Documentation Information Architecture Repair](28-spec-documentation-information-architecture-repair/28-spec-documentation-information-architecture-repair.md) | Restore navigation, canonical DSL reference, artifact policy, convention alignment |
| 29 | [Default Usage Is Not Workflow-Driven](29-spec-default-usage-not-workflow-driven/29-spec-default-usage-not-workflow-driven.md) | Ordinary Weave usage is Loom-led; workflows are explicit, user-invoked constructs; supersedes the "add default_workflow" interpretation from ADR 0006 and the implicit-default-workflow reading of Spec 22 |

---

## Retired / Superseded Specs (01–06)

Specs 01–06 were produced during the alpha phase and are no longer maintained as normative references. Their subject matter is covered by the active guides and specs above:

| Retired # | Subject | Current canonical reference |
| --- | --- | --- |
| 01 | Core DSL | [DSL Reference](../dsl-reference.md) |
| 02 | Workflow Schema | [Workflow Schema guide](../workflow-schema.md) |
| 03 | Config Discovery | [Config Loading guide](../config-loading.md) |
| 04 | Agent Model Resolution | [Model Resolution guide](../model-resolution.md) |
| 05 | Skill Loader | [Spec 09 — Adapter-Provided Skill Resolution](09-spec-adapter-provided-skill-resolution/09-spec-adapter-provided-skill-resolution.md) |
| 06 | CLI | [CLI guide](../cli.md) |

---

## Numbering Notes

- **10a / 10b**: Two specs share the `10-` prefix due to a historical naming collision. Both directories are preserved; `10-spec-workflow-engine` is the earlier design document and `10-spec-builtin-prompt-defaults` is the implementation spec.
- **21a / 21b**: Two specs share the `21-` prefix. `21-spec-cli-legacy-config-migration` is the active CLI migration spec; `21-spec-workflow-first-execution` is an earlier draft superseded by Spec 22.
- New specs should use the next available integer after 29.
