/** Weave delegates through OpenCode's native subagent action only. */
export const OPENCODE2_DELEGATION_ACTION = "subagent" as const;

export function isOpenCode2DelegationTarget(
  target: string,
  eligibleTargets: readonly string[],
): boolean {
  return eligibleTargets.includes(target);
}
