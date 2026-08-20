import type { AdapterCapabilityContract } from "@weaveio/weave-engine";

/**
 * OpenCode accepts valid thinking intent but does not confirm SDK forwarding
 * for per-request reasoning control.
 */
export const OPENCODE_ADAPTER_CAPABILITY_CONTRACT: AdapterCapabilityContract = {
  capabilities: [
    {
      id: "agent-materialization",
      description: "Materialize Weave agents into OpenCode",
      readiness: "degraded",
      notes:
        "The config hook injects translated agents in declaration order and skips existing same-name resources without changing them; the plugin does not persist agent configuration through an SDK.",
      remediationHint:
        "Rename a Weave agent or remove the conflicting OpenCode entry before startup.",
    },
    {
      id: "delegated-specialist-execution",
      description: "Delegate work to specialist OpenCode agents",
      readiness: "degraded",
      notes:
        "Specialist agents are available when the config hook injects them, but same-name materialization is skipped when an OpenCode entry already exists.",
      remediationHint:
        "Use unique agent names or remove a conflicting OpenCode entry before startup.",
    },
    {
      id: "tool-policy-mapping",
      description: "Map Weave tool policies to OpenCode permissions",
      readiness: "native",
      notes:
        "Read, glob, grep, and list use explicit OpenCode permission rules for allow, deny, and ask; delegation uses the task permission with the same three values. No read policy is omitted or routed through the boolean tools map.",
    },
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
    {
      id: "provider-fast-activation",
      description: "Request provider acceleration and report bounded evidence",
      readiness: "unsupported",
      runtimeStatus: "unsupported",
      notes:
        "OpenCode's plugin surface can mutate a provider request but exposes no correlated official response-body proof, so the adapter sends no acceleration control and cannot claim applied or native. Materialized agent config alone is not evidence of acceleration; declared intent is reported as unsupported and agents still materialize.",
      remediationHint:
        "Keep reporting unsupported until the plugin contract exposes correlated official response-body evidence for the same attempt; only then implement the allowlisted request mutation.",
    },
  ],
};
