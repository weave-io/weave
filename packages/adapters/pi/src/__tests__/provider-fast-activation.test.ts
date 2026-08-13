import { describe, expect, it } from "bun:test";
import {
  applyAnthropicProviderFastHeaders,
  applyAnthropicProviderFastPayload,
  applyOpenAiProviderFastPayload,
  classifyProviderFastActivation,
  PROVIDER_FAST_ALLOWLIST_RULE_IDS,
  PROVIDER_FAST_ANTHROPIC_BETA_TOKEN,
  PROVIDER_FAST_HEADER_MAX_COUNT,
  PROVIDER_FAST_INPUT_MAX_LENGTH,
  PROVIDER_FAST_PAYLOAD_MAX_ARRAY_LENGTH,
  PROVIDER_FAST_PAYLOAD_MAX_DEPTH,
  PROVIDER_FAST_PAYLOAD_MAX_NODES,
  PROVIDER_FAST_PAYLOAD_MAX_PROPERTIES_PER_OBJECT,
  PROVIDER_FAST_PAYLOAD_MAX_STRING_LENGTH,
  type ProviderFastActivationClassification,
  type ProviderFastActivationInput,
  type ProviderFastAllowlistRuleId,
  type ProviderFastApiFamily,
  type ProviderFastMutationReason,
  type ProviderFastUnsupportedReason,
  planAnthropicProviderFastHeaders,
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

const OPENAI_SUPPORTED: ProviderFastActivationClassification = {
  kind: "supported",
  providerFamily: "openai",
  allowlistRuleId: "openai-gpt-5-6-sol",
};

const ANTHROPIC_SUPPORTED: ProviderFastActivationClassification = {
  kind: "supported",
  providerFamily: "anthropic",
  allowlistRuleId: "anthropic-claude-opus-5",
};

const NO_INTENT: ProviderFastActivationClassification = { kind: "no-intent" };

const UNSUPPORTED: ProviderFastActivationClassification = {
  kind: "unsupported",
  reason: "model-not-allowed",
};

const SECRET_AUTHORIZATION = `Bearer ${SECRET_SHAPED_INPUT}`;

function expectMutationUnsupported(
  result: {
    isOk(): boolean;
    isErr(): boolean;
    error?: { kind: "unsupported"; reason: ProviderFastMutationReason };
  },
  reason: ProviderFastMutationReason,
): void {
  expect(result.isErr()).toBe(true);
  if (result.isOk()) {
    return;
  }
  expect(result.error).toEqual({ kind: "unsupported", reason });
}

function serializedMutation(result: {
  isOk(): boolean;
  match(
    onOk: (value: unknown) => unknown,
    onErr: (error: unknown) => unknown,
  ): unknown;
}): string {
  return JSON.stringify({
    ok: result.isOk(),
    classification: result.match(
      () => ({ kind: "ok" }),
      (error) => error,
    ),
  });
}

function clonePlain<T>(value: T): T {
  return structuredClone(value);
}

describe("applyOpenAiProviderFastPayload", () => {
  it("returns the exact original reference for no-intent and unsupported", () => {
    const payload = { model: "gpt-5.6-sol", messages: [] };
    const noIntent = applyOpenAiProviderFastPayload(NO_INTENT, payload);
    const unsupported = applyOpenAiProviderFastPayload(UNSUPPORTED, payload);
    expect(noIntent.isOk()).toBe(true);
    expect(unsupported.isOk()).toBe(true);
    if (noIntent.isErr() || unsupported.isErr()) {
      return;
    }
    expect(noIntent.value).toBe(payload);
    expect(unsupported.value).toBe(payload);
    expect(noIntent.value).toEqual(payload);
    expect(unsupported.value).toEqual(payload);
  });

  it("adds only service_tier fast and preserves unrelated fields", () => {
    const payload = {
      model: "gpt-5.6-sol",
      messages: [{ role: "user", content: "hi" }],
      temperature: 0,
    };
    const original = clonePlain(payload);
    const result = applyOpenAiProviderFastPayload(OPENAI_SUPPORTED, payload);
    expect(result.isOk()).toBe(true);
    if (result.isErr()) {
      return;
    }
    expect(result.value).not.toBe(payload);
    expect(payload).toEqual(original);
    expect(result.value).toEqual({
      ...original,
      service_tier: "fast",
    });
  });

  it("preserves a compatible existing service_tier without rewriting it", () => {
    const payload = {
      model: "gpt-5.6-sol",
      service_tier: "fast",
      stream: true,
    };
    const original = clonePlain(payload);
    const result = applyOpenAiProviderFastPayload(OPENAI_SUPPORTED, payload);
    expect(result.isOk()).toBe(true);
    if (result.isErr()) {
      return;
    }
    expect(result.value).not.toBe(payload);
    expect(payload).toEqual(original);
    expect(result.value).toEqual(original);
  });

  it("rejects an incompatible existing service_tier", () => {
    const payload = { service_tier: "priority" };
    const original = clonePlain(payload);
    const result = applyOpenAiProviderFastPayload(OPENAI_SUPPORTED, payload);
    expectMutationUnsupported(result, "request-collision");
    expect(payload).toEqual(original);
  });

  it("rejects a malformed existing service_tier", () => {
    const payload = { service_tier: 1 };
    const original = clonePlain(payload);
    const result = applyOpenAiProviderFastPayload(OPENAI_SUPPORTED, payload);
    expectMutationUnsupported(result, "payload-malformed");
    expect(payload).toEqual(original);
  });

  it("accepts a frozen original because the output is a validated copy", () => {
    const payload = Object.freeze({ model: "gpt-5.6-sol" });
    const result = applyOpenAiProviderFastPayload(OPENAI_SUPPORTED, payload);
    expect(result.isOk()).toBe(true);
    if (result.isErr()) {
      return;
    }
    expect(result.value).not.toBe(payload);
    expect(payload).toEqual({ model: "gpt-5.6-sol" });
    expect(result.value).toEqual({
      model: "gpt-5.6-sol",
      service_tier: "fast",
    });
  });

  it("accepts a nonextensible original because the output is a copy", () => {
    const payload = Object.preventExtensions({ model: "gpt-5.6-sol" });
    const result = applyOpenAiProviderFastPayload(OPENAI_SUPPORTED, payload);
    expect(result.isOk()).toBe(true);
    if (result.isErr()) {
      return;
    }
    expect(result.value).not.toBe(payload);
    expect(payload).toEqual({ model: "gpt-5.6-sol" });
  });

  it("rejects accessors, inherited fields, symbols, callables, and cycles without executing getters", () => {
    let getterExecutions = 0;
    const accessor: Record<string, unknown> = { model: "gpt-5.6-sol" };
    Object.defineProperty(accessor, "service_tier", {
      enumerable: true,
      configurable: true,
      get() {
        getterExecutions += 1;
        return SECRET_SHAPED_INPUT;
      },
    });

    const inherited = Object.create({
      service_tier: "fast",
    }) as Record<string, unknown>;
    inherited.model = "gpt-5.6-sol";

    const withSymbol: Record<string, unknown> = { model: "gpt-5.6-sol" };
    Object.defineProperty(withSymbol, Symbol("hidden"), {
      value: SECRET_SHAPED_INPUT,
      enumerable: true,
    });

    const callable = () => SECRET_SHAPED_INPUT;
    callable.model = "gpt-5.6-sol";

    const cyclic: Record<string, unknown> = { model: "gpt-5.6-sol" };
    cyclic.self = cyclic;

    const sparse = { items: [] as unknown[] };
    sparse.items.length = 2;

    const datePayload = { when: new Date(0) };
    const mapPayload = { extra: new Map() };

    const cases: readonly unknown[] = [
      accessor,
      inherited,
      withSymbol,
      callable,
      cyclic,
      sparse,
      datePayload,
      mapPayload,
    ];
    for (const candidate of cases) {
      const result = applyOpenAiProviderFastPayload(
        OPENAI_SUPPORTED,
        candidate,
      );
      expectMutationUnsupported(result, "payload-unsafe");
      expect(serializedMutation(result)).not.toContain(SECRET_SHAPED_INPUT);
      expect(serializedMutation(result)).not.toContain("sk-proj");
    }
    expect(getterExecutions).toBe(0);
  });

  it("rejects oversized and malformed payload graphs", () => {
    const oversizedKeys: Record<string, unknown> = {};
    for (
      let index = 0;
      index < PROVIDER_FAST_PAYLOAD_MAX_PROPERTIES_PER_OBJECT + 1;
      index += 1
    ) {
      oversizedKeys[`k${index}`] = index;
    }
    expectMutationUnsupported(
      applyOpenAiProviderFastPayload(OPENAI_SUPPORTED, oversizedKeys),
      "payload-oversized",
    );

    const oversizedArray = {
      items: Array.from(
        { length: PROVIDER_FAST_PAYLOAD_MAX_ARRAY_LENGTH + 1 },
        (_, index) => index,
      ),
    };
    expectMutationUnsupported(
      applyOpenAiProviderFastPayload(OPENAI_SUPPORTED, oversizedArray),
      "payload-oversized",
    );

    const oversizedString = {
      note: "x".repeat(PROVIDER_FAST_PAYLOAD_MAX_STRING_LENGTH + 1),
    };
    expectMutationUnsupported(
      applyOpenAiProviderFastPayload(OPENAI_SUPPORTED, oversizedString),
      "payload-oversized",
    );

    let deep: unknown = { leaf: true };
    for (
      let depth = 0;
      depth < PROVIDER_FAST_PAYLOAD_MAX_DEPTH + 1;
      depth += 1
    ) {
      deep = { nested: deep };
    }
    expectMutationUnsupported(
      applyOpenAiProviderFastPayload(OPENAI_SUPPORTED, deep),
      "payload-oversized",
    );

    const tooManyNodes: Record<string, unknown> = {};
    for (let index = 0; index < PROVIDER_FAST_PAYLOAD_MAX_NODES; index += 1) {
      tooManyNodes[`n${index}`] = { v: index };
    }
    expectMutationUnsupported(
      applyOpenAiProviderFastPayload(OPENAI_SUPPORTED, tooManyNodes),
      "payload-oversized",
    );

    expectMutationUnsupported(
      applyOpenAiProviderFastPayload(OPENAI_SUPPORTED, null),
      "payload-malformed",
    );
    expectMutationUnsupported(
      applyOpenAiProviderFastPayload(OPENAI_SUPPORTED, ["not-an-object"]),
      "payload-malformed",
    );
    expectMutationUnsupported(
      applyOpenAiProviderFastPayload(OPENAI_SUPPORTED, { n: Number.NaN }),
      "payload-malformed",
    );
  });
});

describe("applyAnthropicProviderFastPayload", () => {
  it("returns the exact original reference for no-intent and unsupported", () => {
    const payload = { model: "claude-opus-5", messages: [] };
    const noIntent = applyAnthropicProviderFastPayload(NO_INTENT, payload);
    const unsupported = applyAnthropicProviderFastPayload(UNSUPPORTED, payload);
    expect(noIntent.isOk()).toBe(true);
    expect(unsupported.isOk()).toBe(true);
    if (noIntent.isErr() || unsupported.isErr()) {
      return;
    }
    expect(noIntent.value).toBe(payload);
    expect(unsupported.value).toBe(payload);
    expect(noIntent.value).toEqual(payload);
  });

  it("adds only speed fast and preserves unrelated fields", () => {
    const payload = {
      model: "claude-opus-5",
      max_tokens: 32,
      messages: [{ role: "user", content: "hi" }],
    };
    const original = clonePlain(payload);
    const result = applyAnthropicProviderFastPayload(
      ANTHROPIC_SUPPORTED,
      payload,
    );
    expect(result.isOk()).toBe(true);
    if (result.isErr()) {
      return;
    }
    expect(result.value).not.toBe(payload);
    expect(payload).toEqual(original);
    expect(result.value).toEqual({
      ...original,
      speed: "fast",
    });
  });

  it("preserves a compatible existing speed value", () => {
    const payload = { model: "claude-opus-5", speed: "fast" };
    const original = clonePlain(payload);
    const result = applyAnthropicProviderFastPayload(
      ANTHROPIC_SUPPORTED,
      payload,
    );
    expect(result.isOk()).toBe(true);
    if (result.isErr()) {
      return;
    }
    expect(result.value).not.toBe(payload);
    expect(payload).toEqual(original);
    expect(result.value).toEqual(original);
  });

  it("rejects an incompatible or malformed existing speed", () => {
    const conflict = { speed: "standard" };
    const originalConflict = clonePlain(conflict);
    expectMutationUnsupported(
      applyAnthropicProviderFastPayload(ANTHROPIC_SUPPORTED, conflict),
      "request-collision",
    );
    expect(conflict).toEqual(originalConflict);

    const malformed = { speed: false };
    const originalMalformed = clonePlain(malformed);
    expectMutationUnsupported(
      applyAnthropicProviderFastPayload(ANTHROPIC_SUPPORTED, malformed),
      "payload-malformed",
    );
    expect(malformed).toEqual(originalMalformed);
  });
});

describe("Anthropic provider-fast headers", () => {
  it("plans no change and leaves the original map for no-intent, unsupported, and OpenAI", () => {
    const headers = { Authorization: SECRET_AUTHORIZATION };
    const noIntent = planAnthropicProviderFastHeaders(NO_INTENT, headers);
    const unsupported = planAnthropicProviderFastHeaders(UNSUPPORTED, headers);
    const openai = planAnthropicProviderFastHeaders(OPENAI_SUPPORTED, headers);
    expect(noIntent.isOk()).toBe(true);
    expect(unsupported.isOk()).toBe(true);
    expect(openai.isOk()).toBe(true);
    if (noIntent.isErr() || unsupported.isErr() || openai.isErr()) {
      return;
    }
    expect(noIntent.value).toEqual({ action: "none" });
    expect(unsupported.value).toEqual({ action: "none" });
    expect(openai.value).toEqual({ action: "none" });

    const applied = applyAnthropicProviderFastHeaders(NO_INTENT, headers);
    expect(applied.isOk()).toBe(true);
    if (applied.isErr()) {
      return;
    }
    expect(applied.value).toBe(headers);
    expect(headers).toEqual({ Authorization: SECRET_AUTHORIZATION });
  });

  it("adds the exact beta token once and preserves unrelated headers", () => {
    const headers: Record<string, string> = {
      Authorization: SECRET_AUTHORIZATION,
      "x-request-id": "req-1",
    };
    const plan = planAnthropicProviderFastHeaders(ANTHROPIC_SUPPORTED, headers);
    expect(plan.isOk()).toBe(true);
    if (plan.isErr()) {
      return;
    }
    expect(plan.value).toEqual({ action: "write" });
    const result = applyAnthropicProviderFastHeaders(
      ANTHROPIC_SUPPORTED,
      headers,
    );
    expect(result.isOk()).toBe(true);
    if (result.isErr()) {
      return;
    }
    expect(result.value).toBe(headers);
    expect(headers).toEqual({
      Authorization: SECRET_AUTHORIZATION,
      "x-request-id": "req-1",
      "anthropic-beta": PROVIDER_FAST_ANTHROPIC_BETA_TOKEN,
    });
  });

  it("merges the token into an existing beta header without duplicating it", () => {
    const headers = {
      "anthropic-beta": "prompt-caching-2024-07-31",
      Authorization: SECRET_AUTHORIZATION,
    };
    const result = applyAnthropicProviderFastHeaders(
      ANTHROPIC_SUPPORTED,
      headers,
    );
    expect(result.isOk()).toBe(true);
    if (result.isErr()) {
      return;
    }
    expect(headers["anthropic-beta"]).toBe(
      `prompt-caching-2024-07-31, ${PROVIDER_FAST_ANTHROPIC_BETA_TOKEN}`,
    );
    expect(headers.Authorization).toBe(SECRET_AUTHORIZATION);

    const alreadyPresent = {
      "anthropic-beta": `prompt-caching-2024-07-31, ${PROVIDER_FAST_ANTHROPIC_BETA_TOKEN}`,
    };
    const preservePlan = planAnthropicProviderFastHeaders(
      ANTHROPIC_SUPPORTED,
      alreadyPresent,
    );
    expect(preservePlan.isOk()).toBe(true);
    if (preservePlan.isErr()) {
      return;
    }
    expect(preservePlan.value).toEqual({ action: "preserve" });
    const preserved = applyAnthropicProviderFastHeaders(
      ANTHROPIC_SUPPORTED,
      alreadyPresent,
    );
    expect(preserved.isOk()).toBe(true);
    expect(alreadyPresent["anthropic-beta"]).toBe(
      `prompt-caching-2024-07-31, ${PROVIDER_FAST_ANTHROPIC_BETA_TOKEN}`,
    );
  });

  it("rejects case-insensitive duplicate beta headers with no mutation", () => {
    const headers = {
      "anthropic-beta": "prompt-caching-2024-07-31",
      "Anthropic-Beta": "tools-2024-04-04",
    };
    const original = clonePlain(headers);
    expectMutationUnsupported(
      planAnthropicProviderFastHeaders(ANTHROPIC_SUPPORTED, headers),
      "header-duplicate",
    );
    expectMutationUnsupported(
      applyAnthropicProviderFastHeaders(ANTHROPIC_SUPPORTED, headers),
      "header-duplicate",
    );
    expect(headers).toEqual(original);
  });

  it("rejects frozen or nonextensible header maps without mutation", () => {
    const frozen = Object.freeze({
      Authorization: SECRET_AUTHORIZATION,
    });
    expectMutationUnsupported(
      applyAnthropicProviderFastHeaders(ANTHROPIC_SUPPORTED, frozen),
      "header-unsafe",
    );
    expect(frozen).toEqual({ Authorization: SECRET_AUTHORIZATION });

    const sealed = Object.preventExtensions({
      Authorization: SECRET_AUTHORIZATION,
    });
    expectMutationUnsupported(
      applyAnthropicProviderFastHeaders(ANTHROPIC_SUPPORTED, sealed),
      "header-unsafe",
    );
    expect(sealed).toEqual({ Authorization: SECRET_AUTHORIZATION });
  });

  it("rejects malformed, unsafe, and colliding header maps with no partial write", () => {
    let getterExecutions = 0;
    const accessor: Record<string, unknown> = {
      Authorization: SECRET_AUTHORIZATION,
    };
    Object.defineProperty(accessor, "anthropic-beta", {
      enumerable: true,
      configurable: true,
      get() {
        getterExecutions += 1;
        return SECRET_SHAPED_INPUT;
      },
    });
    expectMutationUnsupported(
      applyAnthropicProviderFastHeaders(ANTHROPIC_SUPPORTED, accessor),
      "header-unsafe",
    );
    expect(getterExecutions).toBe(0);
    expect(accessor.Authorization).toBe(SECRET_AUTHORIZATION);
    expect("anthropic-beta" in accessor).toBe(true);

    const nonstring = { "anthropic-beta": ["fast-mode-2026-02-01"] };
    const originalNonstring = clonePlain(nonstring);
    expectMutationUnsupported(
      applyAnthropicProviderFastHeaders(ANTHROPIC_SUPPORTED, nonstring),
      "header-malformed",
    );
    expect(nonstring).toEqual(originalNonstring);

    const colliding = { "anthropic-beta": "fast-mode-2099-01-01" };
    const originalColliding = clonePlain(colliding);
    expectMutationUnsupported(
      applyAnthropicProviderFastHeaders(ANTHROPIC_SUPPORTED, colliding),
      "request-collision",
    );
    expect(colliding).toEqual(originalColliding);

    const malformedTokens = { "anthropic-beta": "bad token" };
    const originalMalformed = clonePlain(malformedTokens);
    expectMutationUnsupported(
      applyAnthropicProviderFastHeaders(ANTHROPIC_SUPPORTED, malformedTokens),
      "header-malformed",
    );
    expect(malformedTokens).toEqual(originalMalformed);

    const oversized: Record<string, string> = {};
    for (
      let index = 0;
      index < PROVIDER_FAST_HEADER_MAX_COUNT + 1;
      index += 1
    ) {
      oversized[`h${index}`] = "v";
    }
    expectMutationUnsupported(
      applyAnthropicProviderFastHeaders(ANTHROPIC_SUPPORTED, oversized),
      "header-malformed",
    );
  });

  it("keeps secret-shaped header values out of serialized errors", () => {
    const headers = {
      Authorization: SECRET_AUTHORIZATION,
      "anthropic-beta": `bad ${SECRET_SHAPED_INPUT}`,
    };
    const result = applyAnthropicProviderFastHeaders(
      ANTHROPIC_SUPPORTED,
      headers,
    );
    expect(result.isErr()).toBe(true);
    const serialized = serializedMutation(result);
    expect(serialized).not.toContain(SECRET_SHAPED_INPUT);
    expect(serialized).not.toContain("sk-proj");
    expect(serialized).not.toContain(SECRET_AUTHORIZATION);
    expect(headers.Authorization).toBe(SECRET_AUTHORIZATION);
  });
});
