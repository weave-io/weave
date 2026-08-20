import type { AdapterCapabilityContract } from "@weaveio/weave-engine";

/**
 * OpenCode resolves valid thinking intent but does not yet confirm SDK
 * forwarding for per-request reasoning control.
 */
export const OPENCODE_ADAPTER_CAPABILITY_CONTRACT: AdapterCapabilityContract = {
  capabilities: [
    {
      id: "agent-materialization",
      description: "Materialize Weave agents into OpenCode",
      readiness: "degraded",
      notes:
        "New agents can be created through the SDK, but same-name resources are never updated automatically because user-editable description and options metadata cannot prove Weave ownership.",
      remediationHint:
        "Remove a conflicting OpenCode agent manually, or add a durable Weave-owned database record and unforgeable host identity before enabling updates.",
    },
    {
      id: "delegated-specialist-execution",
      description: "Delegate work to specialist OpenCode agents",
      readiness: "degraded",
      notes:
        "Delegation creates new specialist agents, while same-name materialization fails closed when ownership cannot be proven.",
      remediationHint:
        "Use unique agent names or provide an unforgeable Weave ownership authority before enabling automatic updates.",
    },
    {
      id: "tool-policy-mapping",
      description: "Map Weave tool policies to OpenCode permissions",
      readiness: "native",
      notes:
        "Delegation maps to OpenCode's task permission with allow, deny, and ask semantics; doom_loop is not a delegation control. Read ask remains default-enabled because OpenCode has no per-read approval permission.",
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
