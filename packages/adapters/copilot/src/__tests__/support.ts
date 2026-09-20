/**
 * Shared fixtures for this adapter's tests.
 *
 * `makeDescriptor` was defined identically in several test files here. It
 * stays package-local: the adapters deliberately share no code with one
 * another, so this is not hoisted into a common test package.
 */

import type { AgentDescriptor } from "@weaveio/weave-engine";

export function makeDescriptor(
  overrides: Partial<AgentDescriptor> = {},
): AgentDescriptor {
  return {
    name: "test-agent",
    composedPrompt: "You are a test agent.",
    models: ["claude-sonnet-5"],
    mode: "subagent",
    effectiveToolPolicy: {
      read: "allow",
      write: "allow",
      execute: "allow",
      delegate: "deny",
      network: "ask",
    },
    rawToolPolicy: undefined,
    delegationTargets: [],
    skills: [],
    ...overrides,
  };
}
