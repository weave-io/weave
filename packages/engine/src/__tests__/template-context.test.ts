/**
 * template-context.test.ts
 *
 * What the context holds is asserted where a user can see it: a composed
 * prompt either renders a path or is refused for naming one, and
 * `tests/dsl/prompt-templates.scenario.test.ts` covers both halves — every
 * allowed path, and the raw config fields (`models`, `temperature`,
 * `prompt_file`, the raw tool policy) a prompt may not reach.
 *
 * What is left here is the defensive copy: the builder is handed arrays its
 * caller still owns, and nothing a user writes can show whether they were
 * copied.
 */

import { describe, expect, it } from "bun:test";

import type { DelegationTarget } from "../compose.js";
import {
  type AgentPromptTemplateContext,
  buildTemplateContext,
  type TemplateContextInput,
} from "../template-context.js";
import type { EffectiveToolPolicy } from "../tool-policy.js";

const defaultPolicy: EffectiveToolPolicy = {
  read: "allow",
  write: "deny",
  execute: "ask",
  delegate: "allow",
  network: "deny",
};

function build(
  overrides: Partial<TemplateContextInput> = {},
): AgentPromptTemplateContext {
  const result = buildTemplateContext({
    agentName: "test-agent",
    mode: "subagent",
    skills: [],
    effectiveToolPolicy: defaultPolicy,
    delegationTargets: [],
    ...overrides,
  });
  if (result.isErr()) throw new Error(JSON.stringify(result.error));
  return result.value;
}

function makeTarget(
  name: string,
  description?: string,
  triggers: string[] = [],
  isCategory = false,
): DelegationTarget {
  return { name, description, triggers, isCategory };
}

describe("buildTemplateContext — delegation with targets", () => {
  it("copies trigger arrays so later mutation cannot change the context", () => {
    const triggers = ["review code", "fix tests"];
    const ctx = build({
      delegationTargets: [makeTarget("shuttle", undefined, triggers)],
    });
    triggers.push("do not leak");
    expect(ctx.delegation.targets[0]?.triggers).toEqual([
      "review code",
      "fix tests",
    ]);
    expect(ctx.delegation.targets[0]?.triggers).not.toBe(triggers);
  });
});
