/** Composition and portable quality gates for all eight builtin prompts. */

import { beforeAll, describe, expect, it } from "bun:test";
import { resolve } from "node:path";
import type { WeaveConfig } from "@weaveio/weave-core";
import type { AgentDescriptor } from "@weaveio/weave-engine";
import { composeAgentDescriptor } from "@weaveio/weave-engine";
import { getBuiltinConfig, resolvePromptPaths } from "../index.js";

const AGENTS = [
  "loom",
  "tapestry",
  "pattern",
  "shuttle",
  "thread",
  "spindle",
  "weft",
  "warp",
] as const;
const COMPOSED_LIMITS = { bytes: 23_200, words: 3_400 };
const PORTABLE_DENIALS = [
  /\b(?:claude|gpt|openai|anthropic|gemini)\b/i,
  /\b(?:temperature|top[- ]?p|verbosity|effort|reasoning|thinking|cache)\b/i,
  /\b(?:chain[- ]of[- ]thought|hidden deliberation|private scratch|internal reasoning)\b/i,
  /(?:^|\s)\/[-\w]+|\bweave\s+(?:start|run|delegate)\b|\bweave\s+prompt(?!\s+self-modify(?=$|[^\w\s]))/i,
  /\b(?:parallel(?:ism)?|concurren(?:cy|t)|worker count|queue size)\b\s*[:=]?\s*\d+/i,
  /\b(?:retry|retries|sidebar|status panel|progress ritual|sleep|wait)\b/i,
  /\{\{\{delegation\.section\}\}\}/,
] as const;

let config: WeaveConfig;
const descriptors = new Map<string, AgentDescriptor>();

beforeAll(async () => {
  const parsed = getBuiltinConfig();
  if (parsed.isErr()) throw new Error(JSON.stringify(parsed.error));
  config = resolvePromptPaths(parsed.value, {
    kind: "builtin",
    rootDir: resolve(import.meta.dir, "../.."),
  });
  for (const [name, agent] of Object.entries(config.agents)) {
    const result = await composeAgentDescriptor(
      name,
      agent,
      config,
      config.agents,
    );
    if (result.isErr()) throw new Error(JSON.stringify(result.error));
    descriptors.set(name, result.value);
  }
});

function descriptor(name: string): AgentDescriptor {
  const value = descriptors.get(name);
  if (value === undefined) throw new Error(`Missing descriptor: ${name}`);
  return value;
}

function wordCount(text: string): number {
  return text.trim() === "" ? 0 : text.trim().split(/\s+/u).length;
}

describe("builtin compose contract", () => {
  it("composes all eight builtins with valid, fully rendered prompts", () => {
    expect(Object.keys(config.agents).sort()).toEqual([...AGENTS].sort());
    for (const name of AGENTS) {
      const prompt = descriptor(name).composedPrompt;
      expect(prompt.trim().length).toBeGreaterThan(0);
      expect(prompt).not.toMatch(/\{\{[#^/!>&]?[\w.-][\w.-]*\}\}/);
      expect(prompt).not.toMatch(/\{\{\{[^}]+\}\}\}/);
    }
  });

  it("keeps plan artifacts under .weave/plans", () => {
    const pattern = descriptor("pattern").composedPrompt;
    const tapestry = descriptor("tapestry").composedPrompt;
    expect(pattern).toContain(".weave/plans/{slug}.md");
    expect(tapestry).toContain(".weave/plans/{plan_name}.md");
    expect(tapestry).toContain(".weave/learnings/{plan_name}.md");
  });

  it("keeps the aggregate composed prompt within the portable budget", () => {
    const prompts = AGENTS.map((name) => descriptor(name).composedPrompt);
    const aggregate = prompts.join("\n");
    expect(new TextEncoder().encode(aggregate).byteLength).toBeLessThanOrEqual(
      COMPOSED_LIMITS.bytes,
    );
    expect(wordCount(aggregate)).toBeLessThanOrEqual(COMPOSED_LIMITS.words);
  });

  it("rejects provider settings, hidden deliberation, adapter commands, fixed concurrency, and choreography", () => {
    for (const name of AGENTS) {
      const prompt = descriptor(name).composedPrompt;
      for (const denial of PORTABLE_DENIALS) expect(prompt).not.toMatch(denial);
    }
  });

  it("renders delegation targets dynamically for every delegating agent", () => {
    const delegators = AGENTS.filter(
      (name) => config.agents[name]?.tool_policy?.delegate === "allow",
    );
    const specialists = AGENTS.filter(
      (name) => config.agents[name]?.tool_policy?.delegate !== "allow",
    );
    expect(delegators.length).toBeGreaterThan(0);
    for (const name of delegators) {
      const value = descriptor(name);
      expect(value.delegationTargets.length).toBeGreaterThan(0);
      for (const target of value.delegationTargets) {
        expect(target.triggers.length).toBeGreaterThan(0);
        expect(value.composedPrompt).toContain(target.name);
      }
      for (const specialist of specialists)
        expect(value.composedPrompt).toContain(specialist);
    }
  });

  it("preserves review routing and gate role semantics", () => {
    const weft = descriptor("weft").composedPrompt;
    const warp = descriptor("warp").composedPrompt;
    expect(weft).toMatch(/review/i);
    expect(weft).toMatch(/approve|reject/i);
    expect(warp).toMatch(/security|audit/i);
    expect(warp).toMatch(/approve|block/i);
  });

  it("keeps non-delegating agents free of generated delegation sections", () => {
    for (const name of AGENTS) {
      if (config.agents[name]?.tool_policy?.delegate === "allow") continue;
      expect(descriptor(name).delegationTargets).toEqual([]);
      expect(descriptor(name).composedPrompt).not.toContain("## Delegation");
    }
  });
});
