/**
 * Shared fixtures for this adapter's tests.
 *
 * `makeDescriptor` was defined identically in several test files here. It
 * stays package-local: the adapters deliberately share no code with one
 * another, so this is not hoisted into a common test package.
 */

import type {
  AgentDescriptor,
  EffectiveToolPolicy,
} from "@weaveio/weave-engine";

/** The policy every descriptor fixture in this package starts from. */
export const DEFAULT_TOOL_POLICY: EffectiveToolPolicy = {
  read: "allow",
  write: "allow",
  execute: "allow",
  delegate: "deny",
  network: "ask",
};

export function makeDescriptor(
  overrides: Partial<AgentDescriptor> = {},
): AgentDescriptor {
  return {
    name: "test-agent",
    composedPrompt: "You are a test agent.",
    models: ["claude-sonnet-4-5"],
    mode: "subagent",
    temperature: 0.2,
    description: "A test agent",
    effectiveToolPolicy: DEFAULT_TOOL_POLICY,
    rawToolPolicy: undefined,
    delegationTargets: [],
    skills: [],
    ...overrides,
  };
}
