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
          "Claude Code's /weave:start projection submits and enters plan work as a foreground command; it does not provide persisted idle-continuation state, an enforced continuation budget, pause/resume, or a status surface.",
      },
      {
        id: "provider-fast-activation",
        description:
          "Request provider acceleration and report bounded evidence",
        readiness: "unsupported",
        runtimeStatus: "unsupported",
        notes:
          "Claude Code static materialization has no owned request or response-evidence seam. Generated agent files must not claim that fast intent was requested or applied.",
        remediationHint:
          "Do not encode guessed frontmatter, environment, or provider controls. Supporting this requires a runtime Agent SDK integration plus per-attempt response proof.",
      },
    ],
  };
