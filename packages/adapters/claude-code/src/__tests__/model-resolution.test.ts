import { describe, expect, it } from "bun:test";
import {
  type AgentDescriptor,
  readinessForProviderFastStatus,
  resolveAdapterModelIntent,
} from "@weaveio/weave-engine";
import { z } from "zod";
import {
  buildClaudeCodeModelInput,
  CLAUDE_CODE_AVAILABLE_MODELS,
  CLAUDE_CODE_FAST_UNSUPPORTED_REASON,
  describeClaudeCodeFastActivation,
} from "../model-resolution.js";

function makeDescriptor(
  overrides: Partial<AgentDescriptor> = {},
): AgentDescriptor {
  return {
    name: "test-agent",
    composedPrompt: "prompt",
    models: ["claude-sonnet-4-5"],
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

const fastIntentFixtureSchema = z.object({
  fast: z.literal(true).optional(),
});

type FastIntentFixture = z.infer<typeof fastIntentFixtureSchema>;

interface RawFastIntentFixture {
  readonly fast?: boolean | string;
}

function parseFastIntentFixture(
  input: RawFastIntentFixture,
): FastIntentFixture {
  const parsed = fastIntentFixtureSchema.safeParse(input);
  return parsed.success ? parsed.data : {};
}

describe("CLAUDE_CODE_AVAILABLE_MODELS", () => {
  it("contains claude-sonnet-4-5", () => {
    expect(CLAUDE_CODE_AVAILABLE_MODELS.has("claude-sonnet-4-5")).toBe(true);
  });

  it("contains claude-opus-4", () => {
    expect(CLAUDE_CODE_AVAILABLE_MODELS.has("claude-opus-4")).toBe(true);
  });

  it("does not contain unknown models", () => {
    expect(CLAUDE_CODE_AVAILABLE_MODELS.has("gpt-4o")).toBe(false);
  });
});

describe("buildClaudeCodeModelInput", () => {
  it("sets agentName from descriptor", () => {
    const input = buildClaudeCodeModelInput(makeDescriptor({ name: "loom" }));
    expect(input.agentName).toBe("loom");
  });

  it("sets agentMode from descriptor", () => {
    const input = buildClaudeCodeModelInput(
      makeDescriptor({ mode: "primary" }),
    );
    expect(input.agentMode).toBe("primary");
  });

  it("sets agentModels from descriptor when non-empty", () => {
    const input = buildClaudeCodeModelInput(
      makeDescriptor({ models: ["claude-opus-4"] }),
    );
    expect(input.agentModels).toEqual(["claude-opus-4"]);
  });

  it("strips thinking suffixes before static availability matching", () => {
    const input = buildClaudeCodeModelInput(
      makeDescriptor({
        models: ["claude-opus-4#high", "claude-sonnet-4-5#low"],
      }),
    );

    expect(input.agentModels).toEqual(["claude-opus-4", "claude-sonnet-4-5"]);
    const resolved = resolveAdapterModelIntent(input);
    expect(resolved).toMatchObject({
      model: "claude-opus-4",
      source: "agent-preference",
    });
    expect(resolved.thinkingLevel).toBeUndefined();
  });

  it("unescapes literal hashes without treating them as thinking suffixes", () => {
    const input = buildClaudeCodeModelInput(
      makeDescriptor({ models: ["weird\\#model"] }),
    );

    expect(input.agentModels).toEqual(["weird#model"]);
  });

  it("sets agentModels to undefined when empty", () => {
    const input = buildClaudeCodeModelInput(makeDescriptor({ models: [] }));
    expect(input.agentModels).toBeUndefined();
  });

  it("includes availableModels set", () => {
    const input = buildClaudeCodeModelInput(makeDescriptor());
    expect(input.availableModels).toBe(CLAUDE_CODE_AVAILABLE_MODELS);
  });

  it("ignores fast intent when building model resolution input", () => {
    const withoutFast = buildClaudeCodeModelInput(makeDescriptor());
    const withFast = buildClaudeCodeModelInput(makeDescriptor({ fast: true }));

    expect(withFast).toEqual(withoutFast);
  });
});

describe("describeClaudeCodeFastActivation", () => {
  it("emits no acceleration state without fast intent", () => {
    expect(describeClaudeCodeFastActivation(makeDescriptor())).toBeUndefined();
  });

  it("emits no acceleration state for a non-literal fast value", () => {
    const parsed = parseFastIntentFixture({ fast: "true" });
    expect(parsed).toEqual({});
    expect(describeClaudeCodeFastActivation(parsed)).toBeUndefined();
  });

  it("reports declared fast intent as unsupported with bounded evidence", () => {
    const diagnostic = describeClaudeCodeFastActivation(
      makeDescriptor({ fast: true }),
    );

    expect(diagnostic).toEqual({
      capabilityId: "provider-fast-activation",
      adapterId: "claude-code",
      state: "unsupported",
      evidenceKind: "none",
      evidenceOutcome: "inaccessible",
      reason: CLAUDE_CODE_FAST_UNSUPPORTED_REASON,
    });
    expect(CLAUDE_CODE_FAST_UNSUPPORTED_REASON).toBe(
      "harness-seam-unavailable",
    );
  });

  it("never reports requested or applied and maps to unsupported readiness", () => {
    const diagnostic = describeClaudeCodeFastActivation(
      makeDescriptor({ fast: true, models: ["claude-opus-5#high"] }),
    );

    expect(diagnostic?.state).not.toBe("requested");
    expect(diagnostic?.state).not.toBe("applied");
    expect(diagnostic).toBeDefined();
    const state = diagnostic?.state ?? "declared";
    expect(readinessForProviderFastStatus(state)).toBe("unsupported");
  });

  it("returns a frozen record that leaks no model or provider text", () => {
    const diagnostic = describeClaudeCodeFastActivation(
      makeDescriptor({ fast: true, models: ["claude-opus-5"] }),
    );

    expect(Object.isFrozen(diagnostic)).toBe(true);
    const serialized = JSON.stringify(diagnostic);
    expect(serialized).not.toContain("claude-opus-5");
    expect(serialized).not.toContain("anthropic");
    expect(serialized).not.toContain("speed");
  });
});
