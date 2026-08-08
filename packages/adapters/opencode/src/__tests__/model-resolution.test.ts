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
import { parseConfig, parseModelIntentEntry } from "@weaveio/weave-core";
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
      expect(result.value.model).toBe(DEFAULT_FALLBACK_MODEL);
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
      expect(result.value.model).toBe("claude-sonnet-4-5");
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
      expect(result.value.model).toBe("claude-sonnet-4-5");
    }
  });

  it("returns the declared model when availableModels is undefined (no filtering)", () => {
    const descriptor = makeDescriptor({ models: ["any-model"] });
    const context = makeContext({ availableModels: undefined });

    const result = resolveModelForAgent(descriptor, context);

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.model).toBe("any-model");
    }
  });

  it("maps Pi's openai-codex provider to OpenCode's openai provider", () => {
    const descriptor = makeDescriptor({
      models: ["openai-codex/gpt-5.3-codex"],
    });
    const context = makeContext({
      availableModels: new Set(["openai/gpt-5.3-codex"]),
    });

    const result = resolveModelForAgent(descriptor, context);

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.model).toBe("openai/gpt-5.3-codex");
    }
  });

  it("leaves OpenCode's openai provider unchanged", () => {
    const descriptor = makeDescriptor({
      models: ["openai/gpt-5.3-codex"],
    });
    const context = makeContext({
      availableModels: new Set(["openai/gpt-5.3-codex"]),
    });

    const result = resolveModelForAgent(descriptor, context);

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.model).toBe("openai/gpt-5.3-codex");
    }
  });

  it("strips the suffix before prefix normalization and availability matching", () => {
    const descriptor = makeDescriptor({
      models: ["openai-codex/gpt-5.3-codex#high"],
    });
    const context = makeContext({
      availableModels: new Set(["openai/gpt-5.3-codex"]),
    });

    const result = resolveModelForAgent(descriptor, context);

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value).toEqual({
        model: "openai/gpt-5.3-codex",
        thinkingLevel: "high",
      });
    }
  });

  it("preserves ordered fallback selection and the winning suffix", () => {
    const descriptor = makeDescriptor({
      models: [
        "openai-codex/unavailable-model#high",
        "openai-codex/gpt-5.3-codex#low",
      ],
      mode: "primary",
    });
    const context = makeContext({
      availableModels: new Set(["openai/gpt-5.3-codex"]),
    });

    const result = resolveModelForAgent(descriptor, context);

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value).toEqual({
        model: "openai/gpt-5.3-codex",
        thinkingLevel: "low",
      });
    }
  });

  it("preserves an escaped literal hash in the normalized base model", () => {
    const descriptor = makeDescriptor({
      models: ["provider/weird\\#model"],
      mode: "primary",
    });
    const context = makeContext({
      availableModels: new Set(["provider/weird#model"]),
    });

    const result = resolveModelForAgent(descriptor, context);

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value).toEqual({
        model: "provider/weird#model",
        thinkingLevel: undefined,
      });
    }
  });

  it("uses core grammar for zero through four source backslashes before #", () => {
    const cases = [
      {
        sourceSlashCount: 0,
        rawModel: "provider/#high",
        expected: { baseModel: "provider/", thinkingLevel: "high" },
      },
      {
        sourceSlashCount: 1,
        rawModel: "provider/\\#high",
        expected: { baseModel: "provider/#high" },
      },
      {
        sourceSlashCount: 2,
        rawModel: "provider/\\#high",
        expected: { baseModel: "provider/#high" },
      },
      {
        sourceSlashCount: 3,
        rawModel: "provider/\\\\#high",
        expected: { baseModel: "provider/\\\\", thinkingLevel: "high" },
      },
      {
        sourceSlashCount: 4,
        rawModel: "provider/\\\\#high",
        expected: { baseModel: "provider/\\\\", thinkingLevel: "high" },
      },
    ] as const;

    for (const testCase of cases) {
      const sourceModel =
        `provider/${"\\".repeat(testCase.sourceSlashCount)}#high`;
      const parsedConfig = parseConfig(
        `agent parity { models ["${sourceModel}"] }`,
      );

      expect(parsedConfig.isOk()).toBe(true);
      if (parsedConfig.isErr()) continue;

      const rawModel = parsedConfig.value.agents.parity?.models?.[0];
      expect(rawModel).toBe(testCase.rawModel);
      if (rawModel === undefined) continue;

      const parsedIntent = parseModelIntentEntry(rawModel);
      expect(parsedIntent.isOk()).toBe(true);
      if (parsedIntent.isOk()) {
        expect(parsedIntent.value).toEqual(testCase.expected);
      }
    }
  });

  it("proves core-parsed literal hashes have even backslash parity", () => {
    for (const baseSlashCount of [0, 1, 2, 3, 4]) {
      // The lexer consumes pairs of backslashes. An odd source run leaves the
      // final slash to escape the hash, so this is the source spelling that
      // attempts to produce `baseSlashCount` slashes before a literal hash.
      const sourceSlashCount = baseSlashCount * 2 + 1;
      const sourceModel =
        `provider/${"\\".repeat(sourceSlashCount)}#literal`;
      const parsedConfig = parseConfig(
        `agent parity { models ["${sourceModel}"] }`,
      );

      if (baseSlashCount % 2 === 1) {
        // An odd parsed run is not representable: the core parser leaves an
        // even run before #, making it a suffix delimiter, and the non-level
        // suffix is rejected by the schema.
        expect(parsedConfig.isErr()).toBe(true);
        if (parsedConfig.isErr()) {
          expect(parsedConfig.error).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                type: "ValidationError",
                path: "agents.parity.models.0",
              }),
            ]),
          );
        }
        continue;
      }

      expect(parsedConfig.isOk()).toBe(true);
      if (parsedConfig.isErr()) continue;

      const rawModel = parsedConfig.value.agents.parity?.models?.[0];
      expect(rawModel).toBeDefined();
      if (rawModel === undefined) continue;

      const parsedIntent = parseModelIntentEntry(rawModel);
      expect(parsedIntent.isOk()).toBe(true);
      if (parsedIntent.isErr()) continue;

      const expectedBaseModel =
        `provider/${"\\".repeat(baseSlashCount)}#literal`;
      expect(parsedIntent.value).toEqual({ baseModel: expectedBaseModel });

      const result = resolveModelForAgent(
        makeDescriptor({ models: [rawModel], mode: "primary" }),
        makeContext({ availableModels: new Set([expectedBaseModel]) }),
      );
      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value).toEqual({
          model: expectedBaseModel,
          thinkingLevel: undefined,
        });
      }
    }
  });

  it("keeps malformed descriptor bypasses defensive without changing result shape", () => {
    const malformedModel = "provider/model#not-a-thinking-level";
    expect(parseModelIntentEntry(malformedModel).isErr()).toBe(true);

    const result = resolveModelForAgent(
      makeDescriptor({ models: [malformedModel], mode: "primary" }),
      makeContext({ availableModels: new Set([malformedModel]) }),
    );

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value).toEqual({
        model: malformedModel,
        thinkingLevel: undefined,
      });
    }
  });

  it("keeps malformed escaped-hash suffixes as raw fallback models", () => {
    const malformedModel = String.raw`provider/model\#bogus#bad`;
    expect(parseModelIntentEntry(malformedModel).isErr()).toBe(true);

    const result = resolveModelForAgent(
      makeDescriptor({ models: [malformedModel], mode: "primary" }),
      makeContext({ availableModels: new Set([malformedModel]) }),
    );

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value).toEqual({
        model: malformedModel,
        thinkingLevel: undefined,
      });
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
      expect(result.value.model).toBe("system-default-model");
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
      expect(result.value.model).toBe("agent-preferred-model");
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
      expect(result.value.model).toBe("ui-selected-model");
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
      expect(result.value.model).toBe("system-default-model");
    }
  });

  it("returns UI-selected model for 'all' mode agents", () => {
    const descriptor = makeDescriptor({ models: [], mode: "all" });
    const context = makeContext({ uiSelectedModel: "ui-selected-model" });

    const result = resolveModelForAgent(descriptor, context);

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.model).toBe("ui-selected-model");
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

  it("checks the first suffixed subagent preference by normalized base model", () => {
    const descriptor = makeDescriptor({
      models: [
        "openai-codex/unavailable-model#high",
        "openai-codex/gpt-5.3-codex#low",
      ],
      mode: "subagent",
    });
    const context = makeContext({
      availableModels: new Set(["openai/gpt-5.3-codex"]),
    });

    const result = resolveModelForAgent(descriptor, context);

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe("ModelNotAvailableError");
      expect(result.error.message).toContain(
        "openai-codex/unavailable-model#high",
      );
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
      expect(result.value.model).toBe("any-model");
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
      expect(result.value.model).toBe("claude-sonnet-4-5");
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
      expect(result.value.model).toBe("claude-sonnet-4-5");
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
      expect(primaryResult.value.model).toBe("ui-model");
      expect(subagentResult.value.model).toBe(DEFAULT_FALLBACK_MODEL);
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
      expect(result.value.model).toBe("gpt-4o");
    }
  });
});
