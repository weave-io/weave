/**
 * Unit tests for `model-resolution.ts`.
 *
 * Verifies:
 * - `resolveModelForAgent()` calls `resolveAdapterModelIntent()` with the
 *   correct OpenCode model context.
 * - Supported model resolution paths: agent preference, system default,
 *   constant fallback, UI-selected (non-subagent).
 * - Fail-fast rule: explicit subagent model intent fails when the declared
 *   model is not in the available set.
 * - When `availableModels` is undefined, any declared model is accepted.
 * - Non-subagent agents do not trigger the fail-fast rule.
 *
 * All tests are pure — no filesystem access, no SDK calls.
 */

import { describe, expect, it } from "bun:test";
import type { AgentDescriptor, EffectiveToolPolicy } from "@weaveio/weave-engine";
import { DEFAULT_FALLBACK_MODEL } from "@weaveio/weave-engine";
import {
  type OpenCodeModelContext,
  resolveModelForAgent,
} from "../model-resolution.js";

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
    models: [],
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

function makeContext(
  overrides: Partial<OpenCodeModelContext> = {},
): OpenCodeModelContext {
  return { ...overrides };
}

// ---------------------------------------------------------------------------
// Tests: constant fallback (no models declared, no context)
// ---------------------------------------------------------------------------

describe("resolveModelForAgent — constant fallback", () => {
  it("returns the constant fallback model when no models are declared and no context", () => {
    const descriptor = makeDescriptor({ models: [] });
    const context = makeContext();

    const result = resolveModelForAgent(descriptor, context);

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value).toBe(DEFAULT_FALLBACK_MODEL);
    }
  });

  it("returns ok() not err() for the fallback path", () => {
    const descriptor = makeDescriptor({ models: [] });
    const result = resolveModelForAgent(descriptor, {});
    expect(result.isOk()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tests: agent preference resolution
// ---------------------------------------------------------------------------

describe("resolveModelForAgent — agent preference", () => {
  it("returns the first declared model when it is available", () => {
    const descriptor = makeDescriptor({ models: ["claude-sonnet-4-5"] });
    const context = makeContext({
      availableModels: new Set(["claude-sonnet-4-5", "gpt-4o"]),
    });

    const result = resolveModelForAgent(descriptor, context);

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value).toBe("claude-sonnet-4-5");
    }
  });

  it("returns the second declared model when the first is not available", () => {
    // For non-subagent mode, the engine falls through to the next available model
    const descriptor = makeDescriptor({
      models: ["unavailable-model", "claude-sonnet-4-5"],
      mode: "primary",
    });
    const context = makeContext({
      availableModels: new Set(["claude-sonnet-4-5"]),
    });

    const result = resolveModelForAgent(descriptor, context);

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value).toBe("claude-sonnet-4-5");
    }
  });

  it("returns the declared model when availableModels is undefined (no filtering)", () => {
    const descriptor = makeDescriptor({ models: ["any-model"] });
    const context = makeContext({ availableModels: undefined });

    const result = resolveModelForAgent(descriptor, context);

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value).toBe("any-model");
    }
  });
});

// ---------------------------------------------------------------------------
// Tests: system default resolution
// ---------------------------------------------------------------------------

describe("resolveModelForAgent — system default", () => {
  it("returns the system default when no models are declared", () => {
    const descriptor = makeDescriptor({ models: [] });
    const context = makeContext({ systemDefault: "system-default-model" });

    const result = resolveModelForAgent(descriptor, context);

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value).toBe("system-default-model");
    }
  });

  it("prefers agent preference over system default", () => {
    const descriptor = makeDescriptor({ models: ["agent-preferred-model"] });
    const context = makeContext({
      systemDefault: "system-default-model",
      availableModels: new Set([
        "agent-preferred-model",
        "system-default-model",
      ]),
    });

    const result = resolveModelForAgent(descriptor, context);

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value).toBe("agent-preferred-model");
    }
  });
});

// ---------------------------------------------------------------------------
// Tests: UI-selected model (non-subagent)
// ---------------------------------------------------------------------------

describe("resolveModelForAgent — UI-selected model", () => {
  it("returns the UI-selected model for primary mode agents", () => {
    const descriptor = makeDescriptor({ models: [], mode: "primary" });
    const context = makeContext({ uiSelectedModel: "ui-selected-model" });

    const result = resolveModelForAgent(descriptor, context);

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value).toBe("ui-selected-model");
    }
  });

  it("ignores UI-selected model for subagent mode agents", () => {
    // Engine rule: uiSelectedModel is ignored for subagent mode
    const descriptor = makeDescriptor({ models: [], mode: "subagent" });
    const context = makeContext({
      uiSelectedModel: "ui-selected-model",
      systemDefault: "system-default-model",
    });

    const result = resolveModelForAgent(descriptor, context);

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      // Should fall through to system default, not UI-selected
      expect(result.value).toBe("system-default-model");
    }
  });

  it("returns UI-selected model for 'all' mode agents", () => {
    const descriptor = makeDescriptor({ models: [], mode: "all" });
    const context = makeContext({ uiSelectedModel: "ui-selected-model" });

    const result = resolveModelForAgent(descriptor, context);

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value).toBe("ui-selected-model");
    }
  });
});

// ---------------------------------------------------------------------------
// Tests: fail-fast rule for explicit subagent model intent
// ---------------------------------------------------------------------------

describe("resolveModelForAgent — fail-fast for unsupported subagent model", () => {
  it("returns ModelNotAvailableError when subagent declares unavailable model", () => {
    const descriptor = makeDescriptor({
      models: ["unsupported-model"],
      mode: "subagent",
    });
    const context = makeContext({
      availableModels: new Set(["claude-sonnet-4-5", "gpt-4o"]),
    });

    const result = resolveModelForAgent(descriptor, context);

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe("ModelNotAvailableError");
    }
  });

  it("ModelNotAvailableError includes the agent name", () => {
    const descriptor = makeDescriptor({
      name: "my-subagent",
      models: ["unsupported-model"],
      mode: "subagent",
    });
    const context = makeContext({
      availableModels: new Set(["claude-sonnet-4-5"]),
    });

    const result = resolveModelForAgent(descriptor, context);

    expect(result.isErr()).toBe(true);
    if (result.isErr() && result.error.type === "ModelNotAvailableError") {
      expect(result.error.agentName).toBe("my-subagent");
    }
  });

  it("ModelNotAvailableError includes the requested models", () => {
    const descriptor = makeDescriptor({
      models: ["unsupported-model", "also-unsupported"],
      mode: "subagent",
    });
    const context = makeContext({
      availableModels: new Set(["claude-sonnet-4-5"]),
    });

    const result = resolveModelForAgent(descriptor, context);

    expect(result.isErr()).toBe(true);
    if (result.isErr() && result.error.type === "ModelNotAvailableError") {
      expect(result.error.requestedModels).toContain("unsupported-model");
    }
  });

  it("ModelNotAvailableError includes the available models list", () => {
    const descriptor = makeDescriptor({
      models: ["unsupported-model"],
      mode: "subagent",
    });
    const context = makeContext({
      availableModels: new Set(["claude-sonnet-4-5", "gpt-4o"]),
    });

    const result = resolveModelForAgent(descriptor, context);

    expect(result.isErr()).toBe(true);
    if (result.isErr() && result.error.type === "ModelNotAvailableError") {
      expect(result.error.availableModels).toContain("claude-sonnet-4-5");
      expect(result.error.availableModels).toContain("gpt-4o");
    }
  });

  it("ModelNotAvailableError has a human-readable message", () => {
    const descriptor = makeDescriptor({
      name: "my-subagent",
      models: ["unsupported-model"],
      mode: "subagent",
    });
    const context = makeContext({
      availableModels: new Set(["claude-sonnet-4-5"]),
    });

    const result = resolveModelForAgent(descriptor, context);

    expect(result.isErr()).toBe(true);
    if (result.isErr() && result.error.type === "ModelNotAvailableError") {
      expect(result.error.message).toContain("my-subagent");
      expect(result.error.message).toContain("unsupported-model");
    }
  });

  it("does NOT fail-fast when availableModels is undefined (no filtering)", () => {
    // When the adapter cannot determine available models, any declared model
    // is accepted without fail-fast behavior.
    const descriptor = makeDescriptor({
      models: ["any-model"],
      mode: "subagent",
    });
    const context = makeContext({ availableModels: undefined });

    const result = resolveModelForAgent(descriptor, context);

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value).toBe("any-model");
    }
  });

  it("does NOT fail-fast for primary mode agents with unavailable model", () => {
    // Fail-fast only applies to subagent mode.
    // Primary mode falls through to the next available model or fallback.
    const descriptor = makeDescriptor({
      models: ["unavailable-model"],
      mode: "primary",
    });
    const context = makeContext({
      availableModels: new Set(["claude-sonnet-4-5"]),
    });

    const result = resolveModelForAgent(descriptor, context);

    // Should succeed (falls through to constant fallback)
    expect(result.isOk()).toBe(true);
  });

  it("does NOT fail-fast for 'all' mode agents with unavailable model", () => {
    const descriptor = makeDescriptor({
      models: ["unavailable-model"],
      mode: "all",
    });
    const context = makeContext({
      availableModels: new Set(["claude-sonnet-4-5"]),
    });

    const result = resolveModelForAgent(descriptor, context);

    expect(result.isOk()).toBe(true);
  });

  it("does NOT fail-fast when subagent has no declared models", () => {
    // Fail-fast only applies when models are explicitly declared.
    const descriptor = makeDescriptor({ models: [], mode: "subagent" });
    const context = makeContext({
      availableModels: new Set(["claude-sonnet-4-5"]),
    });

    const result = resolveModelForAgent(descriptor, context);

    expect(result.isOk()).toBe(true);
  });

  it("succeeds when subagent declares a model that IS available", () => {
    const descriptor = makeDescriptor({
      models: ["claude-sonnet-4-5"],
      mode: "subagent",
    });
    const context = makeContext({
      availableModels: new Set(["claude-sonnet-4-5", "gpt-4o"]),
    });

    const result = resolveModelForAgent(descriptor, context);

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value).toBe("claude-sonnet-4-5");
    }
  });
});

// ---------------------------------------------------------------------------
// Tests: resolveAdapterModelIntent() integration
// ---------------------------------------------------------------------------

describe("resolveModelForAgent — resolveAdapterModelIntent() integration", () => {
  it("passes agentName to the resolution input", () => {
    // Verify the resolved model is returned (not just any model)
    const descriptor = makeDescriptor({
      name: "named-agent",
      models: ["claude-sonnet-4-5"],
      mode: "primary",
    });
    const context = makeContext({
      availableModels: new Set(["claude-sonnet-4-5"]),
    });

    const result = resolveModelForAgent(descriptor, context);

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value).toBe("claude-sonnet-4-5");
    }
  });

  it("passes agentMode to the resolution input (affects UI-selected behavior)", () => {
    // subagent mode: UI-selected is ignored
    const subagentDescriptor = makeDescriptor({ mode: "subagent", models: [] });
    const primaryDescriptor = makeDescriptor({ mode: "primary", models: [] });
    const context = makeContext({ uiSelectedModel: "ui-model" });

    const subagentResult = resolveModelForAgent(subagentDescriptor, context);
    const primaryResult = resolveModelForAgent(primaryDescriptor, context);

    expect(subagentResult.isOk()).toBe(true);
    expect(primaryResult.isOk()).toBe(true);

    if (subagentResult.isOk() && primaryResult.isOk()) {
      // Primary gets UI-selected; subagent falls through to fallback
      expect(primaryResult.value).toBe("ui-model");
      expect(subagentResult.value).toBe(DEFAULT_FALLBACK_MODEL);
    }
  });

  it("passes availableModels to the resolution input for filtering", () => {
    // Only "gpt-4o" is available; "claude-sonnet-4-5" is not
    const descriptor = makeDescriptor({
      models: ["claude-sonnet-4-5", "gpt-4o"],
      mode: "primary",
    });
    const context = makeContext({
      availableModels: new Set(["gpt-4o"]),
    });

    const result = resolveModelForAgent(descriptor, context);

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      // First available model in the declared list
      expect(result.value).toBe("gpt-4o");
    }
  });
});
