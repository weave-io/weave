import type {
  AcceptanceManifestRequirement,
  TestEvidence,
} from "./acceptance-manifest.js";

/**
 * Source-controlled requirement rows for the Pi adapter acceptance manifest
 * (Pi adapter contract). Every mandatory `PI-*` ID is traced here to real, existing
 * named tests and packed-proof evidence IDs (see `PACKED_PROOF_REGISTRY`
 * below). Permission-specific live evidence belongs to the historical
 * permission-enabled artifact, so `PI-POL` remains pending until a new
 * digest-bound native-control smoke run completes.
 *
 * Pi `0.83.0` lacks the required capability
 * `descriptor-relative-native-session-io` (probe reason
 * `path-only-session-api`), so every generation enters health-only mode and
 * fails closed for all persistent session mutation and child spawn. Every
 * requirement whose live evidence needed a spawned child or a session
 * mutation is therefore `pending`, and the Task 20 proofs for those rows are
 * historical records of pre-`c24182f` behaviour. Only read-only,
 * reporting, and automated evidence supports a `pass` on this host.
 *
 * Automated and packed
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
  P003: {
    file: "packages/adapters/pi/src/__tests__/child-inspection-render.test.ts",
    name: "composes fallback transcript into inspection view",
  },
  P004: {
    file: "packages/adapters/pi/src/__tests__/child-inspection-integration.test.ts",
    name: "real RPC lifecycle supports steer, queued follow-up, UI response, interruption, and restart",
  },
  P005: {
    file: "packages/adapters/pi/src/__tests__/child-inspection-privacy.test.ts",
    name: "private canaries stay out of every parent-facing projection",
  },
  P006: {
    file: "packages/adapters/pi/src/__tests__/child-inspection-privacy.test.ts",
    name: "parent result is the bounded terminal projection plus numeric metadata",
  },
  P007: {
    file: "packages/adapters/pi/src/__tests__/child-inspection-integration.test.ts",
    name: "the real RPC child accepts a >1 MiB assistant record and settles without poison",
  },
  P008: {
    file: "packages/adapters/pi/src/__tests__/child-native-sessions.test.ts",
    name: "deletes with the confirmation token and appends a tombstone",
  },
  P009: {
    file: "packages/adapters/pi/src/__tests__/child-inspection-settings.test.ts",
    name: "aggregates unknown, type, and range issues",
  },
  P010: {
    file: "packages/adapters/pi/src/__tests__/child-inspection-integration.test.ts",
    name: "real ordinary recovery resumes through the controller and preserves bounded result",
  },
  P011: {
    file: "packages/adapters/pi/src/__tests__/child-native-session-paging.test.ts",
    name: "pages newest/older/newer across >10k entries without duplicates",
  },
  P012: {
    file: "packages/adapters/pi/src/__tests__/adapter-cli-commands.test.ts",
    name: "pages >10k entries through readSessionEntryPage only with opaque cursors",
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
      contractReferences: [
        "docs/adapters/pi.md#workflow-projection",
        "docs/architecture/adapter-boundary.md#materialization",
      ],
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
          name: "returns available skills and warns for missing skills without failing the agent",
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
          file: "packages/adapters/pi/src/__tests__/capability-prober.test.ts",
          name: "reports Pi native tool control without permission interception",
        },
        T002: {
          file: "packages/adapters/pi/src/__tests__/extension.test.ts",
          name: "registers commands, the palette shortcut, and six lifecycle delegates without a tool-call interceptor",
        },
      },
      packedProof: { required: true, evidenceIds: ["P001"] },
      liveSmoke: {
        required: true,
        checklistIds: ["S010", "S011", "S012", "S013"],
      },
      result: "pending",
      notes:
        "Pi leaves tool authorization to Pi and each tool owner. The cited live smoke row belongs to the superseded permission implementation; a new native-control smoke run is pending.",
    },
    {
      id: "PI-DEL",
      contractReferences: [
        "docs/adapters/pi.md#private-children",
        "docs/reference/execution-lifecycle.md#effects",
      ],
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
          name: "execute: rejects an ineligible agent with a structured (not thrown) error, never touching the controller",
        },
        T004: {
          file: "packages/adapters/pi/src/__tests__/rpc-child.test.ts",
          name: "passes the secret only via environment, never argv/prompt, and completes the handshake before returning",
        },
        T005: {
          file: "packages/adapters/pi/src/__tests__/child-mode.test.ts",
          name: "reports settlement exactly once via an authenticated envelope on agent_settled",
        },
        T006: {
          file: "packages/adapters/pi/src/__tests__/child-runtime.test.ts",
          name: "sends and resolves a nested task larger than one control envelope",
        },
      },
      packedProof: { required: true, evidenceIds: ["P001"] },
      liveSmoke: {
        required: true,
        checklistIds: ["S014", "S015", "S056"],
      },
      result: "pending",
      notes:
        "Closed-set check verifies all 9 PI_CONTROL_KINDS private control envelope kinds across the referenced tests. The earlier Pi 0.83 descriptor-only gate is superseded. Pi 0.84.1 Task 14 proves Pi-native persistent spawn; S014, S015, and S056 remain the acceptance blockers.",
    },
    {
      id: "PI-CMD",
      contractReferences: [
        "docs/adapters/pi.md#user-surface",
        "docs/adapters/pi.md#child-session-commands",
        "docs/reference/cli.md#weave-adapter",
      ],
      tests: {
        T001: {
          file: "packages/adapters/pi/src/__tests__/extension.test.ts",
          name: "registers commands, the palette shortcut, and six lifecycle delegates without a tool-call interceptor",
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
        T005: {
          file: "packages/adapters/pi/src/__tests__/adapter-cli-commands.test.ts",
          name: "pages >10k entries through readSessionEntryPage only with opaque cursors",
        },
        T006: {
          file: "packages/adapters/pi/src/__tests__/adapter-cli-production.test.ts",
          name: "opens XDG-rooted ports and lists an empty workspace page",
        },
        T007: {
          file: "packages/cli/src/commands/__tests__/adapter.test.ts",
          name: "resolves a unique origin parent via children.resolve",
        },
        T008: {
          file: "packages/cli/src/commands/__tests__/adapter.test.ts",
          name: "rejects a forged parent session scope",
        },
      },
      packedProof: { required: true, evidenceIds: ["P001", "P012"] },
      liveSmoke: { required: true, checklistIds: ["S016"] },
      result: "pass",
      notes:
        "Closed-set check verifies all 9 WEAVE_COMMAND_NAMES and all 3 WEAVE_COMMAND_CLASSIFICATIONS (mutating, read-only, idempotent-cleanup — the invalid-state gating dimension in health-only mode) appear across the referenced tests. CLI children show pages through readSessionEntryPage only (max 100 + opaque cursor); delete resolves immutable origin parent scope without a synthetic current parent and without a published CLI→Pi runtime dependency.",
    },
    {
      id: "PI-LIF",
      contractReferences: [
        "docs/reference/execution-lifecycle.md#explicit-execution-operations",
      ],
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
          file: "packages/engine/src/__tests__/permissions-before-tool.test.ts",
          name: "uses the registered session policy and registry",
        },
      },
      packedProof: { required: true, evidenceIds: ["P001"] },
      liveSmoke: { required: true, checklistIds: ["S016", "S058"] },
      result: "pending",
      notes:
        "Closed-set check verifies all 10 lifecycle operations (observeSession, startExecution, resumeExecution, handleUserInterrupt, dispatchStep, completeStep, beforeTool, inspectExecution, approveArtifact, reconcileExecution) appear across the referenced tests. Direct workflow dispatch and session transition both mutate persistent session state, so Pi 0.83.0 fails them closed; the Task 20 S058 proof is historical pre-c24182f evidence and this row stays pending.",
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
      contractReferences: [
        "docs/reference/execution-lifecycle.md#leases-and-recovery",
      ],
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
      contractReferences: [
        "docs/reference/runtime.md#runtime-store",
        "docs/reference/permissions.md#runtime-store-migration-v3-and-data-ban",
      ],
      tests: {
        T001: {
          file: "packages/adapters/pi/src/__tests__/runtime-store-port.test.ts",
          name: "opens and migrates a fresh Runtime Store in a scratch directory",
        },
        T002: {
          file: "packages/adapters/pi/src/__tests__/runtime-store-port.test.ts",
          name: "maps a scripted open failure onto RuntimeStoreOpenFailed",
        },
      },
      packedProof: { required: true, evidenceIds: ["P001"] },
      liveSmoke: { required: true, checklistIds: ["S019", "S020"] },
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
      liveSmoke: { required: true, checklistIds: ["S021", "S063", "S064"] },
      result: "pass",
      notes:
        "S063 and S064 were re-run live on the final fail-closed head 9a8c6468 and are recorded by docs/specs/33-spec-pi-adapter/33-proofs/33-task21-final-head-fail-closed-proof.md: /weave:history and /weave:doctor returned bounded sanitized output with no paths, and children show returned newest 100 plus an older cursor page of 100 with no overlap, exact under forced short reads and fail-closed on premature-zero, mutation, and oversize reads. Supersedes its 43ebc137 and b0997dec bindings.",
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
      contractReferences: [
        "docs/reference/adapter-capabilities.md#capability-contract",
      ],
      tests: {
        T001: {
          file: "packages/adapters/pi/src/__tests__/capability-prober.test.ts",
          name: "returns exactly one unavailable probe for all 20 capability IDs",
        },
        T002: {
          file: "packages/adapters/pi/src/__tests__/capability-prober.test.ts",
          name: "returns exactly one probe per capability ID, in the trusted case",
        },
        T003: {
          file: "packages/adapters/pi/src/__tests__/capability-prober.test.ts",
          name: "handles every anomaly kind at once and still returns exactly 20 fail-closed rows",
        },
      },
      packedProof: { required: true, evidenceIds: ["P001"] },
      liveSmoke: { required: true, checklistIds: ["S004"] },
      result: "pass",
      notes:
        "Closed-set check verifies all 20 ALL_CAPABILITY_IDS appear across the referenced tests. Pi 0.84.1 Task 14 live evidence proves Pi-native readiness on the exact artifact and the closed path-free failure reasons.",
    },
    {
      id: "PI-ERR",
      contractReferences: [
        "docs/reference/adapter-capabilities.md#readiness-levels",
      ],
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
      contractReferences: [
        "docs/adapters/pi.md#verification",
        "docs/architecture/adapter-boundary.md#materialization",
      ],
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
      contractReferences: [
        "docs/adapters/pi.md#activation",
        "docs/adapters/pi.md#health-only-mode",
        "docs/adapters/pi.md#private-children",
      ],
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
          file: "packages/adapters/pi/src/__tests__/child-runtime.test.ts",
          name: "sends and resolves a nested task larger than one control envelope",
        },
      },
      packedProof: { required: true, evidenceIds: ["P002"] },
      liveSmoke: {
        required: true,
        checklistIds: ["S001", "S002", "S057", "S067"],
      },
      result: "pass",
      notes:
        "The earlier Pi 0.83 descriptor-only readiness result is historical. Pi 0.84.1 Task 14 proves SessionManager create/open, the private root, native process launch, exact parent/thread identity, and live overlay inspection. Closed readiness reports only pi-session-api-unavailable, pi-session-root-unavailable, pi-session-root-unsafe, or pi-process-unavailable.",
    },
    {
      id: "PI-INS",
      contractReferences: [
        "docs/adapters/pi.md#private-child-inspection",
        "docs/adapters/pi.md#native-child-sessions",
      ],
      tests: {
        T001: {
          file: "packages/adapters/pi/src/__tests__/child-inspection-render.test.ts",
          name: "composes fallback transcript into inspection view",
        },
        T002: {
          file: "packages/adapters/pi/src/__tests__/child-inspection-render.test.ts",
          name: "renders at every width including width=1",
        },
        T003: {
          file: "packages/adapters/pi/src/__tests__/child-native-session-paging.test.ts",
          name: "pages newest/older/newer across >10k entries without duplicates",
        },
        T004: {
          file: "packages/adapters/pi/src/__tests__/child-native-session-paging.test.ts",
          name: "eight-entry newest page stays chronological under forced 7-byte chunks",
        },
      },
      packedProof: { required: true, evidenceIds: ["P003", "P011"] },
      liveSmoke: {
        required: true,
        checklistIds: [
          "S040",
          "S041",
          "S042",
          "S043",
          "S045",
          "S046",
          "S047",
          "S048",
          "S070",
          "S071",
          "S075",
          "S076",
        ],
      },
      result: "pending",
      notes:
        "Automated native child paging proves bounded bidirectional reads without full materialization and preserves chronological multi-chunk assembly. Pi 0.84.1 Task 14 proves the live overlay and fallback paths; S042 remains pending.",
    },
    {
      id: "PI-INT",
      contractReferences: [
        "docs/adapters/pi.md#full-screen-child-overlay",
        "docs/adapters/pi.md#overlay-keys",
      ],
      tests: {
        T001: {
          file: "packages/adapters/pi/src/__tests__/child-inspection-integration.test.ts",
          name: "real RPC lifecycle supports steer, queued follow-up, UI response, interruption, and restart",
        },
      },
      packedProof: { required: true, evidenceIds: ["P004"] },
      liveSmoke: {
        required: true,
        checklistIds: [
          "S044",
          "S049",
          "S050",
          "S051",
          "S052",
          "S053",
          "S055",
          "S072",
          "S073",
          "S074",
          "S077",
        ],
      },
      result: "pending",
      notes:
        "Automated coverage exercises overlay steering, follow-up, retry, continue, settlement, key ownership, compact mode, and cancellation. Pi 0.84.1 Task 14 proves the live overlay interaction matrix, including exact-subject q-modal Escape dismissal; the other listed live rows remain acceptance requirements.",
    },
    {
      id: "PI-PRI",
      contractReferences: [
        "docs/adapters/pi.md#private-children",
        "docs/adapters/pi.md#no-migration-from-the-jsonl-store",
        "docs/adr/0014-pi-native-child-sessions.md",
      ],
      tests: {
        T001: {
          file: "packages/adapters/pi/src/__tests__/child-inspection-privacy.test.ts",
          name: "private canaries stay out of every parent-facing projection",
        },
        T002: {
          file: "packages/adapters/pi/src/__tests__/child-native-sessions.test.ts",
          name: "the Weave root is disjoint from Pi's default session directory",
        },
        T003: {
          file: "packages/adapters/pi/src/__tests__/child-session-refs.test.ts",
          name: "serialized envelopes contain no transcript-like fields",
        },
      },
      packedProof: { required: true, evidenceIds: ["P005"] },
      liveSmoke: { required: true, checklistIds: ["S059", "S061", "S062"] },
      result: "pending",
      notes:
        "ADR 0014 replaces JSONL private-history migration with native Pi child sessions and an explicit no-migration decision. Pi 0.84.1 Task 14 proves native session isolation, exact parent/thread identity, reopen, and 0600/0700 permissions; S062 remains pending.",
    },
    {
      id: "PI-BND",
      contractReferences: ["docs/adapters/pi.md#settlement-and-output"],
      tests: {
        T001: {
          file: "packages/adapters/pi/src/__tests__/child-inspection-privacy.test.ts",
          name: "parent result is the bounded terminal projection plus numeric metadata",
        },
      },
      packedProof: { required: true, evidenceIds: ["P006"] },
      liveSmoke: { required: true, checklistIds: ["S068"] },
      result: "pending",
      notes:
        "Automated tests prove the bounded terminal projection plus numeric metadata. Task 20 recorded no live run that inspected parent projections for child content, so S068 and this requirement stay pending.",
    },
    {
      id: "PI-OVR",
      contractReferences: ["docs/adapters/pi.md#settlement-and-output"],
      tests: {
        T001: {
          file: "packages/adapters/pi/src/__tests__/child-inspection-integration.test.ts",
          name: "the real RPC child accepts a >1 MiB assistant record and settles without poison",
        },
        T002: {
          file: "packages/adapters/pi/src/__tests__/repeated-settlement-validator.test.ts",
          name: "requires ten sequential runs plus one maximum-parallelism batch and every unique sentinel",
        },
      },
      packedProof: { required: true, evidenceIds: ["P007"] },
      liveSmoke: { required: true, checklistIds: ["S069"] },
      result: "pending",
      notes:
        "Oversized native output is proved by the >1 MiB RPC test and the repeated-settlement validator. Task 20 ran no live oversized sequential and maximum-parallelism sweep, so S069 and this requirement stay pending.",
    },
    {
      id: "PI-QUO",
      contractReferences: [
        "docs/adapters/pi.md#cleanup-tombstones-and-orphans",
        "docs/adr/0014-pi-native-child-sessions.md",
      ],
      tests: {
        T001: {
          file: "packages/adapters/pi/src/__tests__/child-native-sessions.test.ts",
          name: "deletes with the confirmation token and appends a tombstone",
        },
        T002: {
          file: "packages/adapters/pi/src/__tests__/child-native-sessions.test.ts",
          name: "refuses deletion without the confirmation token",
        },
        T003: {
          file: "packages/adapters/pi/src/__tests__/child-inspection-settings.test.ts",
          name: "rejects removed quota and retention keys as unknown",
        },
      },
      packedProof: { required: true, evidenceIds: ["P008"] },
      liveSmoke: { required: true, checklistIds: ["S065", "S066"] },
      result: "pending",
      notes:
        "ADR 0014 removes byte quotas, trimming, and automatic pruning. Pi 0.84.1 Task 14 proves terminal-only production children.delete with durable tombstones; S066 orphan evidence remains pending.",
    },
    {
      id: "PI-SET",
      contractReferences: [
        "docs/adapters/pi.md#private-child-inspection",
        "docs/reference/configuration.md#harness-adapter-settings",
      ],
      tests: {
        T001: {
          file: "packages/adapters/pi/src/__tests__/child-inspection-settings.test.ts",
          name: "aggregates unknown, type, and range issues",
        },
        T002: {
          file: "packages/adapters/pi/src/__tests__/child-inspection-settings.test.ts",
          name: "requires an explicit policy for invalid settings",
        },
      },
      packedProof: { required: true, evidenceIds: ["P009"] },
      liveSmoke: { required: true, checklistIds: ["S050"] },
      result: "pending",
      notes:
        "Task 20 proved only the keybinding half of adapter settings (S050: conflicts reported, user bindings preserved). No live run rejected invalid adapter settings with structured issues, so this stays pending.",
    },
    {
      id: "PI-RCV",
      contractReferences: [
        "docs/adapters/pi.md#private-child-inspection",
        "docs/reference/execution-lifecycle.md#leases-and-recovery",
      ],
      tests: {
        T001: {
          file: "packages/adapters/pi/src/__tests__/child-inspection-integration.test.ts",
          name: "real ordinary recovery resumes through the controller and preserves bounded result",
        },
        T002: {
          file: "packages/adapters/pi/src/__tests__/child-inspection-integration.test.ts",
          name: "the actual workflow resume controller completes the persisted step",
        },
      },
      packedProof: { required: true, evidenceIds: ["P010"] },
      liveSmoke: { required: true, checklistIds: ["S054", "S057", "S060"] },
      result: "pending",
      notes:
        "S057 was re-run live on the final fail-closed head 9a8c6468 and is recorded by docs/specs/33-spec-pi-adapter/33-proofs/33-task21-final-head-fail-closed-proof.md: history, doctor, list, and show stay readable in health-only mode without mutation support. Thread capacity release (S054) and the quit-and-reload cancel then force-stop path (S060) were never run live, and both need a spawned child that Pi 0.83.0 fails closed, so this stays pending.",
    },
  ];
