import type { ToolPermission } from "@weaveio/weave-core";
import type { EffectiveToolPolicy } from "@weaveio/weave-engine";
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

export const OPENCODE2_MANAGED_PERMISSION_ACTIONS: ReadonlySet<string> =
  new Set([
    ...ACTIONS.read,
    ...ACTIONS.write,
    ...ACTIONS.execute,
    ...ACTIONS.network,
    OPENCODE2_DELEGATION_ACTION,
  ]);
