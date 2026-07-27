/** Semantic and portable quality gates for the eight shipped builtin prompts. */

import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { getBuiltinConfig } from "../builtins.js";

const PROMPTS_DIR = join(import.meta.dir, "..", "..", "prompts");
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

type AgentName = (typeof AGENTS)[number];

const SOURCE_LIMITS: Record<AgentName, { bytes: number; words: number }> = {
  loom: { bytes: 4_500, words: 650 },
  tapestry: { bytes: 4_000, words: 600 },
  pattern: { bytes: 2_800, words: 420 },
  shuttle: { bytes: 1_900, words: 280 },
  thread: { bytes: 1_200, words: 180 },
  spindle: { bytes: 1_600, words: 230 },
  weft: { bytes: 2_300, words: 350 },
  warp: { bytes: 3_000, words: 450 },
};

const PORTABLE_DENIALS = [
  /\b(?:claude|gpt|openai|anthropic|gemini)\b/i,
  /\b(?:model|temperature|top[- ]?p|verbosity|effort|reasoning|thinking|cache)\s*(?:setting|budget|level|parameter|control|mode)?\b/i,
  /\b(?:chain[- ]of[- ]thought|hidden deliberation|private scratch|internal reasoning|show your reasoning)\b/i,
  /(?:^|\s)\/[-\w]+|\bweave\s+(?:start|run|prompt|delegate)\b/i,
  /\b(?:parallel(?:ism)?|concurren(?:cy|t)|worker count|queue size)\b\s*[:=]?\s*\d+/i,
  /\b(?:retry|retries|retrying|sidebar|status panel|progress ritual|sleep|wait)\b/i,
  /\{\{\{delegation\.section\}\}\}/,
] as const;

const ROLE_CONTRACTS: Record<AgentName, RegExp[]> = {
  loom: [
    /direct|directly|bounded/i,
    /delegat|route/i,
    /pattern|plan/i,
    /review|security/i,
  ],
  tapestry: [
    /coordinator|coordinate|sequence|schedule/i,
    /delegat/i,
    /not implement|does not implement|never implement/i,
  ],
  pattern: [
    /plan|planner/i,
    /planning only|never implement|does not implement/i,
    /scope/i,
    /acceptance/i,
  ],
  shuttle: [
    /implement|implementation/i,
    /authori[sz]|authorized/i,
    /evidence|verify/i,
    /not delegate|does not delegate|leaf/i,
  ],
  thread: [
    /read[- ]only/i,
    /explor|inspect|search/i,
    /path|symbol|evidence/i,
    /never modify|does not modify/i,
  ],
  spindle: [
    /research|external|documentation|source/i,
    /read[- ]only/i,
    /cit|source facts|grounded/i,
    /interpret/i,
  ],
  weft: [
    /review/i,
    /approve|reject/i,
    /evidence|finding|file/i,
    /read[- ]only|does not implement|never implement/i,
  ],
  warp: [
    /security|audit/i,
    /approve|block/i,
    /vulnerab|critical|risk/i,
    /read[- ]only|does not implement|never implement/i,
  ],
};

function wordCount(text: string): number {
  return text.trim() === "" ? 0 : text.trim().split(/\s+/u).length;
}

function requireContract(text: string, contract: RegExp[]): void {
  for (const term of contract) expect(text).toMatch(term);
}

const builtinNames = Object.keys(
  getBuiltinConfig()._unsafeUnwrap().agents,
).sort();

describe("builtin prompt source contract", () => {
  it("covers exactly all eight builtin sources", () => {
    expect(builtinNames).toEqual([...AGENTS].sort());
  });

  for (const agentName of AGENTS) {
    it(`${agentName} stays within its portable source budget`, async () => {
      const text = await Bun.file(join(PROMPTS_DIR, `${agentName}.md`)).text();
      const limit = SOURCE_LIMITS[agentName];
      expect(new TextEncoder().encode(text).byteLength).toBeLessThanOrEqual(
        limit.bytes,
      );
      expect(wordCount(text)).toBeLessThanOrEqual(limit.words);
    });

    it(`${agentName} preserves its role, boundary, evidence, and output semantics`, async () => {
      const text = await Bun.file(join(PROMPTS_DIR, `${agentName}.md`)).text();
      requireContract(text, ROLE_CONTRACTS[agentName]);
    });

    it(`${agentName} contains only portable prompt policy`, async () => {
      const text = await Bun.file(join(PROMPTS_DIR, `${agentName}.md`)).text();
      for (const denial of PORTABLE_DENIALS) expect(text).not.toMatch(denial);
      expect(text).toMatch(/^#+ /m);
      expect(text).not.toContain("Placeholder");
    });
  }

  it("keeps delegation inventory in composition rather than source prose", async () => {
    for (const agentName of AGENTS) {
      const text = await Bun.file(join(PROMPTS_DIR, `${agentName}.md`)).text();
      expect(text).not.toMatch(
        /^\s*[-*]\s+\*\*(?:loom|tapestry|shuttle|pattern|thread|spindle|weft|warp)\*\*\s*[-—:]/im,
      );
    }
  });
});
