import type { AdapterCapabilityContract } from "@weaveio/weave-engine";

/**
 * OpenCode resolves valid thinking intent but does not yet confirm SDK
 * forwarding for per-request reasoning control.
 */
export const OPENCODE_ADAPTER_CAPABILITY_CONTRACT: AdapterCapabilityContract = {
  capabilities: [
    {
      id: "model-thinking-activation",
      description: "Activate a descriptor's requested model thinking level",
      readiness: "degraded",
      notes:
        "The adapter strips and resolves the suffix, but the OpenCode SDK's exact per-request reasoning-effort forwarding surface is unconfirmed; the winning level is therefore not guaranteed to reach the harness.",
    },
    {
      id: "idle-continuation",
      description: "Continue plan execution while the agent is idle",
      readiness: "degraded",
      notes:
        "Missing behaviors: no persisted goal state, no enforced continuation budget, no pause/resume, and no status surface.",
    },
  ],
};
