/**
 * Unit tests for `translate-agent.ts`.
 *
 * Verifies:
 * - `translateAgent()` maps `AgentDescriptor` fields to the expected
 *   `OpenCodeAgentConfig` shape.
 * - The `resolvedModel` parameter is used instead of `descriptor.models[0]`.
 * - When `resolvedModel` is undefined, the model field is omitted.
 * - Presentation fields (description, temperature) are passed through.
 * - Tool policy mapping is applied correctly.
 * - The function returns `ok(config)` for valid descriptors.
 *
 * All tests are pure — no filesystem access, no SDK calls.
 */

import { describe, expect, it } from "bun:test";
import type { AgentDescriptor, EffectiveToolPolicy } from "@weaveio/weave-engine";
import { translateAgent } from "../translate-agent.js";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const DEFAULT_TOOL_POLICY: EffectiveToolPolicy = {
  read: "allow",
  write: "allow",
  execute: "allow",
  delegate: "deny",
  network: "ask",
};

function makeDescriptor(
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

// ---------------------------------------------------------------------------
// Tests: basic translation
// ---------------------------------------------------------------------------

describe("translateAgent — basic translation", () => {
  it("returns ok(config) for a valid descriptor", () => {
    const descriptor = makeDescriptor();
    const result = translateAgent(descriptor);
    expect(result.isOk()).toBe(true);
  });

  it("maps composedPrompt to prompt", () => {
    const descriptor = makeDescriptor({ composedPrompt: "Custom prompt text" });
    const result = translateAgent(descriptor);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.prompt).toBe("Custom prompt text");
    }
  });

  it("maps mode to mode", () => {
    const descriptor = makeDescriptor({ mode: "primary" });
    const result = translateAgent(descriptor);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.mode).toBe("primary");
    }
  });

  it("maps subagent mode correctly", () => {
    const descriptor = makeDescriptor({ mode: "subagent" });
    const result = translateAgent(descriptor);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.mode).toBe("subagent");
    }
  });

  it("passes through temperature when defined", () => {
    const descriptor = makeDescriptor({ temperature: 0.7 });
    const result = translateAgent(descriptor);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.temperature).toBe(0.7);
    }
  });

  it("omits temperature when undefined", () => {
    const descriptor = makeDescriptor({ temperature: undefined });
    const result = translateAgent(descriptor);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.temperature).toBeUndefined();
    }
  });

  it("passes through description when defined", () => {
    const descriptor = makeDescriptor({ description: "My agent description" });
    const result = translateAgent(descriptor);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.description).toBe("My agent description");
    }
  });

  it("omits description when undefined", () => {
    const descriptor = makeDescriptor({ description: undefined });
    const result = translateAgent(descriptor);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.description).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// Tests: resolved model parameter
// ---------------------------------------------------------------------------

describe("translateAgent — resolvedModel parameter", () => {
  it("uses resolvedModel when provided", () => {
    const descriptor = makeDescriptor({ models: ["claude-sonnet-4-5"] });
    const result = translateAgent(descriptor, "gpt-4o");
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.model).toBe("gpt-4o");
    }
  });

  it("omits model field when resolvedModel is undefined", () => {
    const descriptor = makeDescriptor({ models: ["claude-sonnet-4-5"] });
    const result = translateAgent(descriptor, undefined);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.model).toBeUndefined();
    }
  });

  it("does NOT use descriptor.models[0] as a fallback", () => {
    // The old behavior was to use descriptor.models[0] when no resolved model
    // was provided. The new behavior is to omit the model field entirely.
    const descriptor = makeDescriptor({ models: ["claude-sonnet-4-5"] });
    const result = translateAgent(descriptor); // no resolvedModel argument
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      // model should be undefined, not "claude-sonnet-4-5"
      expect(result.value.model).toBeUndefined();
    }
  });

  it("uses the exact resolvedModel string (no transformation)", () => {
    const descriptor = makeDescriptor();
    const result = translateAgent(descriptor, "anthropic/claude-sonnet-4-5");
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.model).toBe("anthropic/claude-sonnet-4-5");
    }
  });

  it("resolvedModel overrides any models in descriptor.models", () => {
    // Even if descriptor.models has entries, resolvedModel takes precedence
    const descriptor = makeDescriptor({ models: ["model-a", "model-b"] });
    const result = translateAgent(descriptor, "resolved-model");
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.model).toBe("resolved-model");
    }
  });
});

// ---------------------------------------------------------------------------
// Tests: tool policy mapping
// ---------------------------------------------------------------------------

describe("translateAgent — tool policy mapping", () => {
  it("includes permission field from tool policy mapping", () => {
    const descriptor = makeDescriptor();
    const result = translateAgent(descriptor);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.permission).toBeDefined();
    }
  });

  it("omits tools field when read policy is allow", () => {
    const descriptor = makeDescriptor({
      effectiveToolPolicy: {
        read: "allow",
        write: "allow",
        execute: "allow",
        delegate: "deny",
        network: "ask",
      },
    });
    const result = translateAgent(descriptor);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      // tools patch is only added when read is denied
      expect(result.value.tools).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// Tests: full descriptor round-trip
// ---------------------------------------------------------------------------

describe("translateAgent — full descriptor round-trip", () => {
  it("produces a complete config from a fully-specified descriptor", () => {
    const descriptor = makeDescriptor({
      composedPrompt: "You are a specialized agent.",
      mode: "subagent",
      temperature: 0.3,
      description: "Specialized agent",
      models: ["claude-sonnet-4-5"],
    });

    const result = translateAgent(descriptor, "claude-sonnet-4-5");

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      const config = result.value;
      expect(config.prompt).toBe("You are a specialized agent.");
      expect(config.mode).toBe("subagent");
      expect(config.temperature).toBe(0.3);
      expect(config.description).toBe("Specialized agent");
      expect(config.model).toBe("claude-sonnet-4-5");
      expect(config.permission).toBeDefined();
    }
  });

  it("produces a minimal config from a minimal descriptor", () => {
    const descriptor = makeDescriptor({
      composedPrompt: "Minimal prompt.",
      mode: "primary",
      temperature: undefined,
      description: undefined,
      models: [],
    });

    const result = translateAgent(descriptor);

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      const config = result.value;
      expect(config.prompt).toBe("Minimal prompt.");
      expect(config.mode).toBe("primary");
      expect(config.temperature).toBeUndefined();
      expect(config.description).toBeUndefined();
      expect(config.model).toBeUndefined();
    }
  });
});
