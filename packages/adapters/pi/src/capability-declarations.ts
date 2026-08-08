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
      description: "Exclusive ownership of the twelve /weave:* direct commands",
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
      id: "descriptor-relative-native-session-io",
      description:
        "Host-owned native session reads and writes addressed by an opaque session descriptor rather than a caller-supplied filesystem path",
      readiness: "native",
      notes:
        "Owned by the Pi host, not by the adapter. The adapter never declares this capability from static knowledge alone: the host surface probe `descriptor-relative-native-session-io` is authoritative and can only lower it. The exact tested host (0.83.0) reports `path-only-session-api`, so the capability is unavailable and the adapter enters health-only mode.",
      supplier: "host",
      remediationHint:
        "Upgrade the Pi host to one whose native session API is descriptor-relative, or run Weave in health-only mode.",
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
