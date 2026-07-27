import type {
  AcceptanceManifestRequirement,
  TestEvidence,
} from "./acceptance-manifest.js";

/**
 * Source-controlled requirement rows for the Pi adapter acceptance manifest
 * (Pi adapter contract). Every mandatory `PI-*` ID is traced here to real, existing
 * named tests and packed-proof evidence IDs (see `PACKED_PROOF_REGISTRY`
 * below). Every row is `"pass"` because all 23 digest-bound live TUI smoke
 * checks passed against the artifact recorded in
 * `docs/specs/33-spec-pi-adapter/33-smoke-checklist.md`. Automated and packed
 * evidence remains mandatory and is verified by
 * `scripts/release/__tests__/acceptance-manifest.test.ts`.
 */
export const PACKED_PROOF_REGISTRY: Readonly<Record<string, TestEvidence>> = {
  P001: {
    file: "scripts/release/__tests__/pi-adapter-packed.test.ts",
    name: "packs @weaveio/weave-adapter-pi with an inventory-clean, policy-valid tarball",
  },
  P002: {
    file: "scripts/release/__tests__/pi-adapter-fake-host-consumer.test.ts",
    name: "installs the packed tarball against a local fake ${HOST_PACKAGE_NAME}@${EXACT_TESTED_HOST_VERSION} host, without network or starting Pi",
  },
};

export const ACCEPTANCE_MANIFEST_REQUIREMENTS: readonly AcceptanceManifestRequirement[] =
  [
    {
      id: "PI-ACT",
      contractReferences: ["docs/adapters/pi.md#activation"],
      tests: {
        T001: {
          file: "packages/adapters/pi/src/__tests__/safe-initializer.test.ts",
          name: "reaches a ready (non-health-only) state when every probe is ok, mode is tui, host is compatible",
        },
        T002: {
          file: "packages/adapters/pi/src/__tests__/safe-initializer.test.ts",
          name: "reports trust as withheld but forces health-only mode fail-closed, even when every probe (including project-path ones) reports ok",
        },
        T003: {
          file: "packages/adapters/pi/src/__tests__/controller.test.ts",
          name: "creates a fresh generation with a distinct ID on each activation",
        },
        T004: {
          file: "packages/adapters/pi/src/__tests__/controller.test.ts",
          name: "rejects an operation handle captured before a replacement as ControllerGenerationStale",
        },
        T005: {
          file: "packages/adapters/pi/src/__tests__/extension.test.ts",
          name: "performs no work before session_start: no notify/status/widget calls happen at factory time",
        },
      },
      packedProof: { required: true, evidenceIds: ["P002"] },
      liveSmoke: {
        required: true,
        checklistIds: ["S001", "S002", "S003", "S022"],
      },
      result: "pass",
    },
    {
      id: "PI-MAT",
      contractReferences: ["docs/adapters/pi.md#workflow-projection", "docs/architecture/adapter-boundary.md#materialization"],
      tests: {
        T001: {
          file: "packages/adapters/pi/src/__tests__/config-activator.test.ts",
          name: "loads config and materializes it into a descriptor catalog",
        },
        T002: {
          file: "packages/adapters/pi/src/__tests__/config-activator.test.ts",
          name: "maps a config load failure into an ActivationFailed PiAdapterFailure",
        },
        T003: {
          file: "packages/adapters/pi/src/__tests__/primary-session.test.ts",
          name: "atomically activates a primary-mode descriptor: identity, prompt, applied model, skills",
        },
        T004: {
          file: "packages/adapters/pi/src/__tests__/primary-session.test.ts",
          name: "rejects mode: subagent descriptors and leaves prior state untouched",
        },
      },
      packedProof: { required: true, evidenceIds: ["P001"] },
      liveSmoke: { required: true, checklistIds: ["S005"] },
      result: "pass",
    },
    {
      id: "PI-PRM",
      contractReferences: ["docs/adapters/pi.md#user-surface"],
      tests: {
        T001: {
          file: "packages/adapters/pi/src/__tests__/primary-session.test.ts",
          name: "renders one delimited block with the descriptor's stable identity and final composedPrompt",
        },
        T002: {
          file: "packages/adapters/pi/src/__tests__/primary-session.test.ts",
          name: "appends to a non-empty system prompt without dropping existing content",
        },
        T003: {
          file: "packages/adapters/pi/src/__tests__/primary-session.test.ts",
          name: "does not append twice for the same descriptor identity",
        },
      },
      packedProof: { required: true, evidenceIds: ["P001"] },
      liveSmoke: { required: true, checklistIds: ["S008"] },
      result: "pass",
    },
    {
      id: "PI-SKL",
      contractReferences: ["docs/architecture/adapter-boundary.md#skills"],
      tests: {
        T001: {
          file: "packages/adapters/pi/src/__tests__/skill-catalog.test.ts",
          name: "resolves exact, case-sensitive requested skills present in the Pi-owned snapshot",
        },
        T002: {
          file: "packages/adapters/pi/src/__tests__/skill-catalog.test.ts",
          name: "isolates a missing skill to this agent's result only (no global failure shape)",
        },
        T003: {
          file: "packages/adapters/pi/src/__tests__/skill-catalog.test.ts",
          name: "refresh() replaces the discovery snapshot used by subsequent resolutions",
        },
      },
      packedProof: { required: true, evidenceIds: ["P001"] },
      liveSmoke: { required: true, checklistIds: ["S006"] },
      result: "pass",
    },
    {
      id: "PI-MDL",
      contractReferences: ["docs/architecture/adapter-boundary.md#models"],
      tests: {
        T001: {
          file: "packages/adapters/pi/src/__tests__/model-resolution.test.ts",
          name: "resolves an exact canonical provider/id match (tier 1)",
        },
        T002: {
          file: "packages/adapters/pi/src/__tests__/model-resolution.test.ts",
          name: "skips an ambiguous bare id and never fuzzy-picks between providers",
        },
        T003: {
          file: "packages/adapters/pi/src/__tests__/model-resolution.test.ts",
          name: "tries later entries in order when an earlier entry is unavailable",
        },
      },
      packedProof: { required: true, evidenceIds: ["P001"] },
      liveSmoke: { required: true, checklistIds: ["S007", "S009"] },
      result: "pass",
    },
    {
      id: "PI-POL",
      contractReferences: ["docs/reference/permissions.md#adapter-support"],
      tests: {
        T001: {
          file: "packages/adapters/pi/src/__tests__/permission-bridge.test.ts",
          name: "classifies discovered tools, seals a registry, and proves complete coverage for native + weave-owned tools",
        },
        T002: {
          file: "packages/adapters/pi/src/__tests__/permission-bridge.test.ts",
          name: "fails closed when the name is not free, and never calls registerTool",
        },
        T003: {
          file: "packages/adapters/pi/src/__tests__/extension-tool-governance.test.ts",
          name: "allows a governed native call under an allow policy and writes back only the consumed snapshot",
        },
        T004: {
          file: "packages/adapters/pi/src/__tests__/extension-tool-governance.test.ts",
          name: "blocks a governed native call under a deny policy",
        },
        T005: {
          file: "packages/adapters/pi/src/__tests__/extension-tool-governance.test.ts",
          name: "prompts for approval under an ask policy and allows once approved",
        },
        T006: {
          file: "packages/adapters/pi/src/__tests__/tool-governance.test.ts",
          name: "reports an unrelated third-party tool as unmanaged, never as native or weave-owned",
        },
      },
      packedProof: { required: true, evidenceIds: ["P001"] },
      liveSmoke: {
        required: true,
        checklistIds: ["S010", "S011", "S012", "S013"],
      },
      result: "pass",
      notes:
        "Closed-set check verifies all 3 permission-gate outcome kinds (allow-unmanaged, allow, block) appear across the referenced tests. The `block` variant's free-form `reason: string` is not a closed literal union in code today, so per-reason exhaustiveness is not separately automated.",
    },
    {
      id: "PI-DEL",
      contractReferences: ["docs/adapters/pi.md#private-children", "docs/reference/execution-lifecycle.md#effects"],
      tests: {
        T001: {
          file: "packages/adapters/pi/src/__tests__/delegation-controller.test.ts",
          name: "authorizes and spawns immediately when under budget, resolving on settlement",
        },
        T002: {
          file: "packages/adapters/pi/src/__tests__/delegation-controller.test.ts",
          name: "denies (never queues) once max_children is reached for that parent",
        },
        T003: {
          file: "packages/adapters/pi/src/__tests__/delegation-tool.test.ts",
          name: "resolver: hard-rejects (never asks) an agent outside the eligible target set",
        },
        T004: {
          file: "packages/adapters/pi/src/__tests__/rpc-child.test.ts",
          name: "passes the secret only via environment, never argv/prompt, and completes the handshake before returning",
        },
        T005: {
          file: "packages/adapters/pi/src/__tests__/rpc-child.test.ts",
          name: "relays the child's own approval-request to the caller-supplied callback, and delivers the caller's approval-response back to it",
        },
        T006: {
          file: "packages/adapters/pi/src/__tests__/child-mode.test.ts",
          name: "reports settlement exactly once via an authenticated envelope on agent_settled",
        },
      },
      packedProof: { required: true, evidenceIds: ["P001"] },
      liveSmoke: { required: true, checklistIds: ["S014", "S015"] },
      result: "pass",
      notes:
        "Closed-set check verifies all 11 PI_CONTROL_KINDS private control envelope/reply kinds appear across the referenced tests.",
    },
    {
      id: "PI-CMD",
      contractReferences: ["docs/adapters/pi.md#user-surface"],
      tests: {
        T001: {
          file: "packages/adapters/pi/src/__tests__/extension.test.ts",
          name: "registers exactly the nine /weave:* command shells, the bare native palette command, and four lifecycle delegates, nothing else",
        },
        T002: {
          file: "packages/adapters/pi/src/__tests__/workflow-commands.test.ts",
          name: "never authorizes start without an explicit user confirmation",
        },
        T003: {
          file: "packages/adapters/pi/src/__tests__/workflow-commands.test.ts",
          name: "is read-only and reports the tracked instance's status",
        },
        T004: {
          file: "packages/adapters/pi/src/__tests__/controller.test.ts",
          name: "blocks mutating commands but allows read-only and idempotent-cleanup commands in health-only mode",
        },
      },
      packedProof: { required: true, evidenceIds: ["P001"] },
      liveSmoke: { required: true, checklistIds: ["S016"] },
      result: "pass",
      notes:
        "Closed-set check verifies all 9 WEAVE_COMMAND_NAMES and all 3 WEAVE_COMMAND_CLASSIFICATIONS (mutating, read-only, idempotent-cleanup — the invalid-state gating dimension in health-only mode) appear across the referenced tests.",
    },
    {
      id: "PI-LIF",
      contractReferences: ["docs/reference/execution-lifecycle.md#explicit-execution-operations"],
      tests: {
        T001: {
          file: "packages/adapters/pi/src/__tests__/workflow-controller.test.ts",
          name: "dispatches every step through the direct-dispatch port and completes the workflow",
        },
        T002: {
          file: "packages/adapters/pi/src/__tests__/workflow-controller.test.ts",
          name: "carries workflow instance/lease/step correlation on every direct-dispatch call",
        },
        T003: {
          file: "packages/adapters/pi/src/__tests__/extension-tool-governance.test.ts",
          name: "allows a governed native call under an allow policy and writes back only the consumed snapshot",
        },
        T004: {
          file: "packages/engine/src/__tests__/permissions-before-tool.test.ts",
          name: "uses the registered session policy and registry",
        },
      },
      packedProof: { required: true, evidenceIds: ["P001"] },
      liveSmoke: { required: true, checklistIds: ["S016"] },
      result: "pass",
      notes:
        "Closed-set check verifies all 10 lifecycle operations (observeSession, startExecution, resumeExecution, handleUserInterrupt, dispatchStep, completeStep, beforeTool, inspectExecution, approveArtifact, reconcileExecution) appear across the referenced tests.",
    },
    {
      id: "PI-CMP",
      contractReferences: ["docs/reference/execution-lifecycle.md#completion"],
      tests: {
        T001: {
          file: "packages/adapters/pi/src/__tests__/structured-completion.test.ts",
          name: "accepts a valid success candidate",
        },
        T002: {
          file: "packages/adapters/pi/src/__tests__/structured-completion.test.ts",
          name: "maps a missing candidate to CompletionSignalMissing",
        },
        T003: {
          file: "packages/adapters/pi/src/__tests__/structured-completion.test.ts",
          name: "rejects an unclosed completion method",
        },
      },
      packedProof: { required: true, evidenceIds: ["P001"] },
      liveSmoke: { required: true, checklistIds: ["S016"] },
      result: "pass",
    },
    {
      id: "PI-REC",
      contractReferences: ["docs/reference/execution-lifecycle.md#leases-and-recovery"],
      tests: {
        T001: {
          file: "packages/adapters/pi/src/__tests__/recovery-pointer.test.ts",
          name: "accepts a well-formed pointer",
        },
        T002: {
          file: "packages/adapters/pi/src/__tests__/recovery-pointer.test.ts",
          name: "returns true only when generations match",
        },
        T003: {
          file: "packages/adapters/pi/src/__tests__/workflow-controller.test.ts",
          name: "appends a bounded recovery pointer after each successful step completion",
        },
      },
      packedProof: { required: true, evidenceIds: ["P001"] },
      liveSmoke: { required: true, checklistIds: ["S019", "S020"] },
      result: "pass",
    },
    {
      id: "PI-PLN",
      contractReferences: ["docs/adapters/pi.md#workflow-projection"],
      tests: {
        T001: {
          file: "packages/adapters/pi/src/__tests__/plan-catalog.test.ts",
          name: "filters to safe .md basenames and sorts them deterministically",
        },
        T002: {
          file: "packages/adapters/pi/src/__tests__/plan-catalog.test.ts",
          name: "reports a degraded, typed failure for a real containment failure (e.g. a symlinked plans directory)",
        },
        T003: {
          file: "packages/adapters/pi/src/__tests__/workflow-commands.test.ts",
          name: "reads and renders the named plan's full nested task tree",
        },
        T004: {
          file: "packages/adapters/pi/src/__tests__/plan-render.test.ts",
          name: "falls back to the first pending parent when none is in_progress",
        },
      },
      packedProof: { required: true, evidenceIds: ["P001"] },
      liveSmoke: { required: true, checklistIds: ["S017"] },
      result: "pass",
      notes:
        "Closed-set check verifies all 3 PLAN_TASK_STATES (pending, in_progress, completed) appear across the referenced tests.",
    },
    {
      id: "PI-ART",
      contractReferences: ["docs/reference/execution-lifecycle.md#artifacts"],
      tests: {
        T001: {
          file: "packages/adapters/pi/src/__tests__/artifact-provider.test.ts",
          name: "computes a stable sha256 digest for known file bytes",
        },
        T002: {
          file: "packages/adapters/pi/src/__tests__/artifact-provider.test.ts",
          name: "rejects a path that escapes the project root via ..",
        },
        T003: {
          file: "packages/adapters/pi/src/__tests__/workflow-controller.test.ts",
          name: "never pins an artifact whose prior approval was invalidated by a newer, unapproved revision",
        },
        T004: {
          file: "packages/adapters/pi/src/__tests__/workflow-commands.test.ts",
          name: "binds a user actor and the artifact's own path for digest recomputation on approve",
        },
      },
      packedProof: { required: true, evidenceIds: ["P001"] },
      liveSmoke: { required: true, checklistIds: ["S018"] },
      result: "pass",
      notes:
        "Closed-set check verifies both ArtifactApprovalActor kinds (user, agent) and all 4 RECONCILIATION_AUTHORIZATION_SOURCES (user, runtime, review-gate, security-gate) appear across the referenced tests.",
    },
    {
      id: "PI-PER",
      contractReferences: ["docs/reference/runtime.md#runtime-store", "docs/reference/permissions.md#runtime-store-migration-v3-and-data-ban"],
      tests: {
        T001: {
          file: "packages/adapters/pi/src/__tests__/runtime-store-port.test.ts",
          name: "opens and migrates a fresh Runtime Store in a scratch directory",
        },
        T002: {
          file: "packages/adapters/pi/src/__tests__/runtime-store-port.test.ts",
          name: "maps a scripted open failure onto RuntimeStoreOpenFailed",
        },
        T003: {
          file: "packages/adapters/pi/src/__tests__/permission-bridge.test.ts",
          name: "never mutates Pi - registerTool is not called during planning",
        },
      },
      packedProof: { required: true, evidenceIds: ["P001"] },
      liveSmoke: { required: true, checklistIds: ["S010", "S011", "S012"] },
      result: "pass",
    },
    {
      id: "PI-DIA",
      contractReferences: ["docs/reference/runtime.md#journal-and-snapshots"],
      tests: {
        T001: {
          file: "packages/adapters/pi/src/__tests__/telemetry.test.ts",
          name: "declares every normalized journal family required by Pi adapter contract",
        },
        T002: {
          file: "packages/adapters/pi/src/__tests__/telemetry.test.ts",
          name: "notifies exactly once per unique code+scope+correlation identity",
        },
        T003: {
          file: "packages/adapters/pi/src/__tests__/telemetry.test.ts",
          name: "extractAssistantUsageFromMessage never surfaces message text/content",
        },
      },
      packedProof: { required: true, evidenceIds: ["P001"] },
      liveSmoke: { required: true, checklistIds: ["S021"] },
      result: "pass",
    },
    {
      id: "PI-USG",
      contractReferences: ["docs/reference/runtime.md#retention-and-usage"],
      tests: {
        T001: {
          file: "packages/adapters/pi/src/__tests__/telemetry.test.ts",
          name: "rejects negative/non-finite token and cost values rather than passing them through",
        },
        T002: {
          file: "packages/adapters/pi/src/__tests__/telemetry.test.ts",
          name: "maps a genuine store write failure to the closed UsageWriteFailed code",
        },
        T003: {
          file: "packages/adapters/pi/src/__tests__/rpc-child.test.ts",
          name: "projects exact-host usage once and deduplicates by responseId",
        },
      },
      packedProof: { required: true, evidenceIds: ["P001"] },
      liveSmoke: { required: true, checklistIds: ["S021"] },
      result: "pass",
    },
    {
      id: "PI-CAP",
      contractReferences: ["docs/reference/adapter-capabilities.md#capability-contract"],
      tests: {
        T001: {
          file: "packages/adapters/pi/src/__tests__/capability-prober.test.ts",
          name: "returns exactly one unavailable probe for all 19 capability IDs",
        },
        T002: {
          file: "packages/adapters/pi/src/__tests__/capability-prober.test.ts",
          name: "returns exactly one probe per capability ID, in the trusted case",
        },
        T003: {
          file: "packages/adapters/pi/src/__tests__/capability-prober.test.ts",
          name: "handles every anomaly kind at once and still returns exactly 19 fail-closed rows",
        },
      },
      packedProof: { required: true, evidenceIds: ["P001"] },
      liveSmoke: { required: true, checklistIds: ["S004"] },
      result: "pass",
      notes:
        "Closed-set check verifies all 19 ALL_CAPABILITY_IDS appear across the referenced tests.",
    },
    {
      id: "PI-ERR",
      contractReferences: ["docs/reference/adapter-capabilities.md#readiness-levels"],
      tests: {
        T001: {
          file: "packages/adapters/pi/src/__tests__/safe-initializer.test.ts",
          name: "enters health-only mode when the host identity is unknown",
        },
        T002: {
          file: "packages/adapters/pi/src/__tests__/controller.test.ts",
          name: "rejects an operation handle captured before a replacement as ControllerGenerationStale",
        },
        T003: {
          file: "packages/adapters/pi/src/__tests__/child-runtime.test.ts",
          name: "rejects a replayed nonce (fail closed) rather than logging and continuing",
        },
        T004: {
          file: "packages/adapters/pi/src/__tests__/workflow-controller.test.ts",
          name: "fails closed and reconciles as execution-mismatch",
        },
        T005: {
          file: "packages/adapters/pi/src/__tests__/telemetry.test.ts",
          name: "maps a genuine store write failure to the closed UsageWriteFailed code",
        },
        T006: {
          file: "packages/adapters/pi/src/__tests__/plan-catalog.test.ts",
          name: "reports a degraded, typed failure for a real containment failure (e.g. a symlinked plans directory)",
        },
        T007: {
          file: "packages/adapters/pi/src/__tests__/failure-taxonomy.test.ts",
          name: "matches the frozen failure-code list exactly, in both directions",
        },
      },
      packedProof: { required: true, evidenceIds: ["P001"] },
      liveSmoke: { required: true, checklistIds: ["S002"] },
      result: "pass",
      notes:
        "PiAdapterFailureCodeSchema closes the full failure-code taxonomy at the type level (errors.ts). Each code family has at least one named fail-closed test above. failure-taxonomy.test.ts additionally locks every one of the ~47 codes plus every impact/recovery value — a schema-drift lock, not a per-code behavioral guarantee.",
    },
    {
      id: "PI-PKG",
      contractReferences: ["docs/adapters/pi.md#verification", "docs/architecture/adapter-boundary.md#materialization"],
      tests: {
        T001: {
          file: "packages/adapters/pi/src/__tests__/package-consumption.test.ts",
          name: "exposes the controller/initializer/host-compatibility surface from the root entry",
        },
        T002: {
          file: "packages/adapters/pi/src/__tests__/package-consumption.test.ts",
          name: "exposes exactly one default extension factory from the /extension subpath",
        },
        T003: {
          file: "packages/adapters/pi/src/__tests__/host-compatibility.test.ts",
          name: "rejects a prerelease at the floor (no force/ignore override)",
        },
        T004: {
          file: "packages/adapters/pi/src/__tests__/host-compatibility-matrix.test.ts",
          name: "names the exact host package, range, floor, and tested version (Pi adapter contract)",
        },
      },
      packedProof: { required: true, evidenceIds: ["P001", "P002"] },
      liveSmoke: { required: true, checklistIds: ["S001", "S023"] },
      result: "pass",
      notes:
        "Closed-set check verifies the minimum-only host boundary tokens (HOST_PACKAGE_NAME, HOST_VERSION_FLOOR) appear across the referenced tests.",
    },
    {
      id: "PI-MODE",
      contractReferences: ["docs/adapters/pi.md#activation", "docs/adapters/pi.md#health-only-mode", "docs/adapters/pi.md#private-children"],
      tests: {
        T001: {
          file: "packages/adapters/pi/src/__tests__/extension.test.ts",
          name: "blocks activation into a wrong mode as health-only",
        },
        T002: {
          file: "packages/adapters/pi/src/__tests__/child-runtime.test.ts",
          name: "returns not-a-child and never deletes anything when no bootstrap secret is present in the environment",
        },
        T003: {
          file: "packages/adapters/pi/src/__tests__/delegation-controller.test.ts",
          name: "fails closed (never spawns a process) when the request's own task exceeds the same bound enforced at tool parsing and RPC send",
        },
      },
      packedProof: { required: true, evidenceIds: ["P002"] },
      liveSmoke: { required: true, checklistIds: ["S001", "S002"] },
      result: "pass",
    },
  ];
