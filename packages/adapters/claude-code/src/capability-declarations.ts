import type { AdapterCapabilityContract } from "@weaveio/weave-engine";

/** Claude Code cannot activate per-request thinking levels in this adapter. */
export const CLAUDE_CODE_ADAPTER_CAPABILITY_CONTRACT: AdapterCapabilityContract = {
  capabilities: [
    {
      id: "model-thinking-activation",
      description:
        "Apply per-model thinking-level intent to Claude Code invocations",
      readiness: "unsupported",
      notes:
        "Claude Code's current static-list adapter has no host-controlled per-invocation thinking-level setting; validated levels are ignored after base-model matching.",
    },
  ],
};
