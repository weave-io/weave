import type { AdapterCapabilityContract } from "@weaveio/weave-engine";
import {
  PI_HOST_COMPATIBILITY_MATRIX,
  type PiHostSurfaceDeclaration,
  type PiHostSurfaceId,
} from "./host-compatibility-matrix.js";

export type { PiHostSurfaceDeclaration } from "./host-compatibility-matrix.js";

/** The host-surface contract is declared in the compatibility matrix. */
export const PI_HOST_SURFACE_DECLARATIONS: readonly PiHostSurfaceDeclaration[] =
  PI_HOST_COMPATIBILITY_MATRIX.surfaces;

/**
 * The four native-session capability contracts probed under Spec 33 §16:
 * persistent RPC session and restore, `appendEntry`, `get_entries`/`get_tree`,
 * and custom session directory support. The names are stable; other modules
 * and diagnostics refer to them by these IDs.
 */
export const PI_SESSION_CAPABILITY_SURFACE_IDS: readonly PiHostSurfaceId[] =
  Object.freeze([
    "rpc-persistent-session",
    "rpc-append-entry",
    "rpc-session-tree-read",
    "custom-session-directory",
  ] as const);

/** Session capability gaps that force health-only mode. */
export const PI_REQUIRED_FOR_DELEGATION_SURFACE_IDS: readonly PiHostSurfaceId[] =
  Object.freeze(
    PI_HOST_SURFACE_DECLARATIONS.filter(
      (surface) => surface.severity === "required-for-delegation",
    ).map((surface) => surface.id),
  );

/** Gaps that only degrade the overlay and select the custom-editor fallback. */
export const PI_OVERLAY_ONLY_SURFACE_IDS: readonly PiHostSurfaceId[] =
  Object.freeze(
    PI_HOST_SURFACE_DECLARATIONS.filter(
      (surface) => surface.severity === "overlay-only",
    ).map((surface) => surface.id),
  );

export const PI_ADAPTER_CAPABILITY_CONTRACT: AdapterCapabilityContract = {
  capabilities: [
    {
      id: "command-entrypoints",
      description: "Exclusive ownership of every /weave:* direct command",
      readiness: "native",
    },
    {
      id: "token-usage-reporting",
      description: "Per-message token usage as reported by Pi",
      readiness: "native",
    },
    {
      id: "config-materialization",
      description:
        "Loading and validating .weave config for the active project",
      readiness: "emulated",
    },
    {
      id: "agent-materialization",
      description: "Building descriptor candidates from materialized config",
      readiness: "emulated",
    },
    {
      id: "primary-agent-selection",
      description: "Selecting and atomically activating one primary descriptor",
      readiness: "emulated",
    },
    {
      id: "delegated-specialist-execution",
      description: "Running delegated agents as private RPC children",
      readiness: "emulated",
    },
    {
      id: "prompt-composition",
      description:
        "Appending composed descriptor prompts to Pi's system prompt",
      readiness: "emulated",
    },
    {
      id: "tool-policy-mapping",
      description:
        "Leaving tool authorization under Pi and each tool owner's native control",
      readiness: "native",
    },
    {
      id: "workflow-persistence",
      description: "Durable workflow state in the engine Runtime Store",
      readiness: "emulated",
    },
    {
      id: "workflow-step-dispatch",
      description: "Dispatching and completing workflow steps",
      readiness: "emulated",
    },
    {
      id: "plan-file-compatibility",
      description: "Reading and transitioning revisioned plan snapshots",
      readiness: "emulated",
    },
    {
      id: "event-logging",
      description: "Structured, rotating adapter diagnostics logging",
      readiness: "emulated",
    },
    {
      id: "context-window-monitor",
      description: "Native context-window usage reporting",
      readiness: "native",
    },
    {
      id: "model-thinking-activation",
      description:
        "Translating a descriptor's per-model thinking-level intent into pi.setThinkingLevel()",
      readiness: "emulated",
    },
    {
      id: "provider-fast-activation",
      description: "Request provider acceleration and report bounded evidence",
      // A ceiling, not a claim. Exactly one mapping can request acceleration,
      // and it cannot reach the top of the vocabulary on the pinned host, so
      // `native` would be a lie and `unsupported` now understates what the
      // wrapped provider really does. No static value can name the live
      // state, so this entry declares no `runtimeStatus`: the reportable
      // state comes from one correlated attempt and is read at runtime
      // through `providerFastActivationState` and
      // `effectiveProviderFastReadiness`, which may lower this ceiling and
      // can never raise it.
      readiness: "degraded",
      notes:
        "One mapping only: an agent that declares fast true and resolves to an allowlisted OpenAI Codex subscription model reached through the adapter's own wrapped codex provider on the first-party subscription transport. That wrapper owns the effective transport, the final request, and the same attempt's response, so it may request acceleration under the exact eligibility rules of the fast provider acceleration contract. The public OpenAI API and every other Pi provider stay unsupported: they send no acceleration control and their payloads and headers stay unchanged. The pinned host reports the same standard-speed response evidence for an accelerated request and for an untouched control, so a successful eligible request terminates at not-confirmed with a standard evidence outcome; applied needs same-attempt positive evidence that has never been observed here. Any eligibility failure is byte-identical passthrough with a bounded reason. This capability is optional: no state it reports changes readiness, health-only mode, or agent activation.",
      remediationHint:
        "Keep this ceiling at degraded while the subscription transport returns standard-speed evidence for accelerated and control requests alike. Raise it only on correlated same-attempt positive evidence, and return it to unsupported if a recheck of the mapping fails.",
    },
    {
      id: "idle-continuation",
      description: "Resuming idle work within one live generation",
      readiness: "emulated",
    },
    {
      id: "compaction-recovery",
      description: "Recovering correlation across a compaction event",
      readiness: "emulated",
    },
    {
      id: "analytics-dashboard",
      description: "Usage analytics dashboard",
      readiness: "degraded",
    },
    {
      id: "static-artifact-generation",
      description: "Static artifact generation helpers",
      readiness: "degraded",
    },
    {
      id: "eval-integration",
      description:
        "Evaluation harness integration (explicitly out of scope under the Pi adapter contract)",
      readiness: "unsupported",
    },
    {
      id: "multiple-active-workflows",
      description:
        "Running more than one active workflow concurrently (explicitly out of scope under the Pi adapter contract)",
      readiness: "unsupported",
    },
  ],
};
