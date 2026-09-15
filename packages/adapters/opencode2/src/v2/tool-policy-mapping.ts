import type { ToolPermission } from "@weaveio/weave-core";
import type {
  AgentDescriptor,
  EffectiveToolPolicy,
} from "@weaveio/weave-engine";
import {
  isOpenCode2DelegationTarget,
  OPENCODE2_DELEGATION_ACTION,
} from "./delegation.js";

export interface NativePermissionRule {
  readonly action: string;
  readonly resource: string;
  readonly effect: ToolPermission;
}

const ACTIONS = {
  read: ["read", "glob", "grep"],
  write: ["edit"],
  execute: ["shell"],
  network: ["webfetch", "websearch"],
} as const;

function capabilityRules(
  actions: readonly string[],
  effect: ToolPermission,
): NativePermissionRule[] {
  return actions.map((action) => ({ action, resource: "*", effect }));
}

/** Map abstract policy without replacing host safeguards for unrelated actions. */
export function mapOpenCode2ToolPolicy(
  policy: EffectiveToolPolicy,
  delegationTargets: readonly string[],
): NativePermissionRule[] {
  const rules = [
    ...capabilityRules(ACTIONS.read, policy.read),
    ...capabilityRules(ACTIONS.write, policy.write),
    ...capabilityRules(ACTIONS.execute, policy.execute),
    ...capabilityRules(ACTIONS.network, policy.network),
  ];

  rules.push({
    action: OPENCODE2_DELEGATION_ACTION,
    resource: "*",
    effect: "deny",
  });
  if (policy.delegate === "deny") return rules;
  for (const target of [...new Set(delegationTargets)]) {
    if (!isOpenCode2DelegationTarget(target, delegationTargets)) continue;
    rules.push({
      action: OPENCODE2_DELEGATION_ACTION,
      resource: target,
      effect: policy.delegate,
    });
  }
  return rules;
}

const QUESTION_ACTION = "question";

/**
 * Explicit `question` rule from the agent's mode. The question tool pauses
 * the session until the user answers, so a subagent asking one stalls the
 * delegating run. The host gives only its own agents a `question` rule; left
 * implicit, a Weave agent falls through to the host's `ask` fallback or to a
 * global `*` allow. Primary and `all` agents can be selected by the user, so
 * they keep the tool.
 */
export function mapOpenCode2QuestionRule(
  mode: AgentDescriptor["mode"],
): NativePermissionRule {
  return {
    action: QUESTION_ACTION,
    resource: "*",
    effect: mode === "subagent" ? "deny" : "allow",
  };
}

export const OPENCODE2_MANAGED_PERMISSION_ACTIONS: ReadonlySet<string> =
  new Set([
    ...ACTIONS.read,
    ...ACTIONS.write,
    ...ACTIONS.execute,
    ...ACTIONS.network,
    OPENCODE2_DELEGATION_ACTION,
    QUESTION_ACTION,
  ]);
