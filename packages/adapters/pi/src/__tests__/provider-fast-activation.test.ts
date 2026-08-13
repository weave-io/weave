import { describe, expect, it } from "bun:test";
import {
  classifyProviderFastActivation,
  PROVIDER_FAST_ALLOWLIST_RULE_IDS,
  PROVIDER_FAST_INPUT_MAX_LENGTH,
  type ProviderFastActivationInput,
  type ProviderFastAllowlistRuleId,
  type ProviderFastApiFamily,
  type ProviderFastUnsupportedReason,
} from "../provider-fast-activation.js";

const SECRET_SHAPED_INPUT = "sk-proj-fast-secret-value-DO-NOT-ECHO-9f3c2a1b";

type SupportedCase = {
  readonly provider: "openai" | "anthropic";
  readonly apiFamily: ProviderFastApiFamily;
  readonly model: string;
  readonly allowlistRuleId: ProviderFastAllowlistRuleId;
};

const SUPPORTED_CASES: readonly SupportedCase[] = [
  {
    provider: "openai",
    apiFamily: "openai-responses",
    model: "gpt-5.6-sol",
    allowlistRuleId: "openai-gpt-5-6-sol",
  },
  {
    provider: "openai",
    apiFamily: "openai-completions",
    model: "gpt-5.6-sol",
    allowlistRuleId: "openai-gpt-5-6-sol",
  },
  {
    provider: "openai",
    apiFamily: "openai-responses",
    model: "gpt-5.6-terra",
    allowlistRuleId: "openai-gpt-5-6-terra",
  },
  {
    provider: "openai",
    apiFamily: "openai-completions",
    model: "gpt-5.6-terra",
    allowlistRuleId: "openai-gpt-5-6-terra",
  },
  {
    provider: "openai",
    apiFamily: "openai-responses",
    model: "gpt-5.6-luna",
    allowlistRuleId: "openai-gpt-5-6-luna",
  },
  {
    provider: "openai",
    apiFamily: "openai-completions",
    model: "gpt-5.6-luna",
    allowlistRuleId: "openai-gpt-5-6-luna",
  },
  {
    provider: "anthropic",
    apiFamily: "anthropic-messages",
    model: "claude-opus-5",
    allowlistRuleId: "anthropic-claude-opus-5",
  },
  {
    provider: "anthropic",
    apiFamily: "anthropic-messages",
    model: "claude-opus-4-8",
    allowlistRuleId: "anthropic-claude-opus-4-8",
  },
];

function intent(
  input: Omit<ProviderFastActivationInput, "fast">,
): ProviderFastActivationInput {
  return { fast: true, ...input };
}

function serializedClassification(input: ProviderFastActivationInput): string {
  return classifyProviderFastActivation(input).match(
    (value) => JSON.stringify(value),
    (error) => JSON.stringify(error),
  );
}

function expectUnsupported(
  input: ProviderFastActivationInput,
  reason: ProviderFastUnsupportedReason,
): void {
  const result = classifyProviderFastActivation(input);
  expect(result.isErr()).toBe(true);
  if (result.isOk()) {
    return;
  }
  expect(result.error).toEqual({ kind: "unsupported", reason });
}

describe("classifyProviderFastActivation", () => {
  it("returns no-intent when fast is omitted", () => {
    const result = classifyProviderFastActivation({
      provider: "openai",
      apiFamily: "openai-responses",
      model: "gpt-5.6-sol",
    });
    expect(result.isOk()).toBe(true);
    if (result.isErr()) {
      return;
    }
    expect(result.value).toEqual({ kind: "no-intent" });
  });

  it("supports every exact allowlisted model and API pair", () => {
    expect(SUPPORTED_CASES.map((entry) => entry.model)).toEqual([
      "gpt-5.6-sol",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-5.6-luna",
      "claude-opus-5",
      "claude-opus-4-8",
    ]);
    expect(PROVIDER_FAST_ALLOWLIST_RULE_IDS).toEqual([
      "openai-gpt-5-6-sol",
      "openai-gpt-5-6-terra",
      "openai-gpt-5-6-luna",
      "anthropic-claude-opus-5",
      "anthropic-claude-opus-4-8",
    ]);

    for (const supported of SUPPORTED_CASES) {
      const result = classifyProviderFastActivation(intent(supported));
      expect(result.isOk()).toBe(true);
      if (result.isErr()) {
        return;
      }
      expect(result.value).toEqual({
        kind: "supported",
        providerFamily: supported.provider,
        allowlistRuleId: supported.allowlistRuleId,
      });
    }
  });

  it("rejects provider and API mismatches", () => {
    expectUnsupported(
      intent({
        provider: "openai",
        apiFamily: "anthropic-messages",
        model: "gpt-5.6-sol",
      }),
      "endpoint-not-allowed",
    );
    expectUnsupported(
      intent({
        provider: "anthropic",
        apiFamily: "openai-responses",
        model: "claude-opus-5",
      }),
      "endpoint-not-allowed",
    );
    expectUnsupported(
      intent({
        provider: "anthropic",
        apiFamily: "openai-completions",
        model: "claude-opus-4-8",
      }),
      "endpoint-not-allowed",
    );
  });

  it("rejects blank and oversized provider or model input", () => {
    expectUnsupported(
      intent({
        provider: "",
        apiFamily: "openai-responses",
        model: "gpt-5.6-sol",
      }),
      "input-blank",
    );
    expectUnsupported(
      intent({
        provider: "openai",
        apiFamily: "openai-responses",
        model: "",
      }),
      "input-blank",
    );
    expectUnsupported(
      intent({
        provider: "o".repeat(PROVIDER_FAST_INPUT_MAX_LENGTH + 1),
        apiFamily: "openai-responses",
        model: "gpt-5.6-sol",
      }),
      "input-oversized",
    );
    expectUnsupported(
      intent({
        provider: "openai",
        apiFamily: "openai-responses",
        model: "m".repeat(PROVIDER_FAST_INPUT_MAX_LENGTH + 1),
      }),
      "input-oversized",
    );
  });

  it("rejects aliases, snapshots, prefixes, suffixes, and proxies", () => {
    const rejectedModels = [
      "gpt-5.6",
      "gpt-5.6-sol-2026-03-01",
      "prefix-gpt-5.6-sol",
      "gpt-5.6-sol-suffix",
      "openai/gpt-5.6-sol",
      "claude-opus-4.8",
      "claude-opus-4-7",
      "claude-opus-5-20260301",
      "xclaude-opus-5",
      "claude-opus-5x",
    ] as const;

    for (const model of rejectedModels) {
      const apiFamily = model.includes("claude")
        ? "anthropic-messages"
        : "openai-responses";
      const provider = model.includes("claude") ? "anthropic" : "openai";
      expectUnsupported(
        intent({ provider, apiFamily, model }),
        "model-not-allowed",
      );
    }

    expectUnsupported(
      intent({
        provider: "azure",
        apiFamily: "openai-responses",
        model: "gpt-5.6-sol",
      }),
      "provider-not-allowed",
    );
    expectUnsupported(
      intent({
        provider: "openrouter",
        apiFamily: "openai-completions",
        model: "gpt-5.6-luna",
      }),
      "provider-not-allowed",
    );
    expectUnsupported(
      intent({
        provider: "bedrock",
        apiFamily: "anthropic-messages",
        model: "claude-opus-5",
      }),
      "provider-not-allowed",
    );
    expectUnsupported(
      intent({
        provider: "openai-compatible",
        apiFamily: "openai-responses",
        model: "gpt-5.6-sol",
      }),
      "provider-not-allowed",
    );
  });

  it("keeps secret-shaped input out of the serialized result", () => {
    const result = classifyProviderFastActivation(
      intent({
        provider: SECRET_SHAPED_INPUT,
        apiFamily: "openai-responses",
        model: SECRET_SHAPED_INPUT,
      }),
    );
    const serialized = JSON.stringify({
      result,
      classification: result.match(
        (value) => value,
        (error) => error,
      ),
    });

    expect(result.isErr()).toBe(true);
    expect(serialized).not.toContain(SECRET_SHAPED_INPUT);
    expect(serialized).not.toContain("sk-proj");
    expect(
      serializedClassification(
        intent({
          provider: SECRET_SHAPED_INPUT,
          apiFamily: "openai-responses",
          model: SECRET_SHAPED_INPUT,
        }),
      ),
    ).toBe('{"kind":"unsupported","reason":"provider-not-allowed"}');
  });

  it("returns deterministic outputs for the same input", () => {
    const input = intent({
      provider: "openai",
      apiFamily: "openai-responses",
      model: "gpt-5.6-terra",
    });
    const first = classifyProviderFastActivation(input);
    const second = classifyProviderFastActivation(input);
    expect(first).toEqual(second);
    expect(serializedClassification(input)).toBe(
      '{"kind":"supported","providerFamily":"openai","allowlistRuleId":"openai-gpt-5-6-terra"}',
    );
    expect(
      serializedClassification({
        provider: "anthropic",
        apiFamily: "anthropic-messages",
        model: "claude-opus-5",
      }),
    ).toBe('{"kind":"no-intent"}');
  });
});
