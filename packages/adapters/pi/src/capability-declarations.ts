import type { AdapterCapabilityContract } from "@weaveio/weave-engine";
import {
  PI_HOST_COMPATIBILITY_MATRIX,
  type PiHostSurfaceDeclaration,
} from "./host-compatibility-matrix.js";

export type { PiHostSurfaceDeclaration } from "./host-compatibility-matrix.js";

/** The host-surface contract is declared in the compatibility matrix. */
export const PI_HOST_SURFACE_DECLARATIONS: readonly PiHostSurfaceDeclaration[] =
  PI_HOST_COMPATIBILITY_MATRIX.surfaces;

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
