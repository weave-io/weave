import type { AdapterCapabilityContract } from "@weaveio/weave-engine";

/** Claude Code cannot activate per-request thinking levels in this adapter. */
export const CLAUDE_CODE_ADAPTER_CAPABILITY_CONTRACT: AdapterCapabilityContract =
  {
    capabilities: [
      {
        id: "model-thinking-activation",
        description:
          "Apply per-model thinking-level intent to Claude Code invocations",
        readiness: "unsupported",
        notes:
          "Claude Code's current static-list adapter has no host-controlled per-invocation thinking-level setting; validated levels are ignored after base-model matching.",
      },
      {
        id: "idle-continuation",
        description: "Continue working toward a goal while the session is idle",
        readiness: "degraded",
        notes:
          "Claude Code's goal command has no persisted goal state, no enforced continuation budget, no pause/resume, and no status surface.",
      },
    ],
  };
