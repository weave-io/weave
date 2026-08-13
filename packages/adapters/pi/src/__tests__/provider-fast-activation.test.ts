import { describe, expect, it } from "bun:test";
import {
  applyAnthropicProviderFastHeaders,
  applyAnthropicProviderFastPayload,
  applyOpenAiProviderFastPayload,
  classifyProviderFastActivation,
  PROVIDER_FAST_ALLOWLIST_RULE_IDS,
  PROVIDER_FAST_ANTHROPIC_BETA_TOKEN,
  PROVIDER_FAST_ATTEMPT_PENDING_LIMIT,
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
  type ProviderFastAttemptBeginInput,
  type ProviderFastAttemptError,
  type ProviderFastAttemptPublicSnapshot,
  type ProviderFastAttemptToken,
  ProviderFastAttemptTracker,
  ProviderFastCoordinator,
  type ProviderFastCoordinatorError,
  type ProviderFastCoordinatorSnapshot,
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

const SECRET_PRIMARY = "loom-sk-proj-fast-secret-primary";
const SECRET_PROVIDER = "openai-sk-proj-fast-secret-provider";
const SECRET_MODEL = "gpt-5.6-sol-sk-proj-fast-secret-model";

function supportedSnapshot(
  overrides: Partial<ProviderFastAttemptBeginInput["snapshot"]> = {},
): ProviderFastAttemptBeginInput["snapshot"] {
  return {
    generation: 1,
    primaryName: "loom",
    selectedModel: {
      provider: "openai",
      id: "gpt-5.6-sol",
    },
    fast: true,
    ...overrides,
  };
}

function beginSupported(
  tracker: ProviderFastAttemptTracker,
  overrides: Partial<ProviderFastAttemptBeginInput> = {},
) {
  return tracker.begin({
    snapshot: supportedSnapshot(),
    apiFamily: "openai-responses",
    classification: OPENAI_SUPPORTED,
    ...overrides,
  });
}

function expectAttemptError(
  result: {
    isOk(): boolean;
    isErr(): boolean;
    error?: ProviderFastAttemptError;
  },
  error: ProviderFastAttemptError,
): void {
  expect(result.isErr()).toBe(true);
  if (result.isOk()) {
    return;
  }
  expect(result.error).toEqual(error);
}

function serializedAttempt(value: unknown): string {
  return JSON.stringify(value);
}

function expectSanitizedSnapshot(
  snapshot: ProviderFastAttemptPublicSnapshot,
  expected: Omit<ProviderFastAttemptPublicSnapshot, "pendingCount"> & {
    readonly pendingCount?: number;
  },
): void {
  expect(snapshot).toEqual({
    pendingCount: expected.pendingCount ?? snapshot.pendingCount,
    sequence: expected.sequence,
    providerFamily: expected.providerFamily,
    apiFamily: expected.apiFamily,
    allowlistRuleId: expected.allowlistRuleId,
    collision: expected.collision,
    state: expected.state,
    evidenceKind: expected.evidenceKind,
    evidenceOutcome: expected.evidenceOutcome,
    reason: expected.reason,
  });
  const serialized = serializedAttempt(snapshot);
  expect(serialized).not.toContain(SECRET_PRIMARY);
  expect(serialized).not.toContain(SECRET_PROVIDER);
  expect(serialized).not.toContain(SECRET_MODEL);
  expect(serialized).not.toContain(SECRET_SHAPED_INPUT);
  expect(serialized).not.toContain("sk-proj");
  expect(serialized).not.toContain("loom");
  expect(serialized).not.toContain("tapestry");
  expect(serialized).not.toContain("gpt-5.6-sol");
  expect(serialized).not.toContain("applied");
}

describe("ProviderFastAttemptTracker", () => {
  it("returns no state for no-intent and omitted fast", () => {
    const tracker = new ProviderFastAttemptTracker();
    const noIntent = tracker.begin({
      snapshot: supportedSnapshot({ fast: undefined }),
      apiFamily: "openai-responses",
      classification: NO_INTENT,
    });
    expect(noIntent.isOk()).toBe(true);
    if (noIntent.isErr()) {
      return;
    }
    expect(noIntent.value).toEqual({ kind: "no-state", pendingCount: 0 });
    expect(tracker.pendingCount()).toBe(0);

    const omittedFast = tracker.begin({
      snapshot: {
        generation: 1,
        primaryName: "loom",
        selectedModel: { provider: "openai", id: "gpt-5.6-sol" },
      },
      apiFamily: "openai-responses",
      classification: OPENAI_SUPPORTED,
    });
    expect(omittedFast.isOk()).toBe(true);
    if (omittedFast.isErr()) {
      return;
    }
    expect(omittedFast.value).toEqual({ kind: "no-state", pendingCount: 0 });
    expect(tracker.pendingCount()).toBe(0);
  });

  it("returns sanitized unsupported state without creating a pending attempt", () => {
    const tracker = new ProviderFastAttemptTracker();
    const result = tracker.begin({
      snapshot: supportedSnapshot({
        primaryName: SECRET_PRIMARY,
        selectedModel: {
          provider: SECRET_PROVIDER,
          id: SECRET_MODEL,
        },
      }),
      apiFamily: "openai-responses",
      classification: {
        kind: "unsupported",
        reason: "model-not-allowed",
      },
    });
    expect(result.isOk()).toBe(true);
    if (result.isErr()) {
      return;
    }
    expect(result.value.kind).toBe("unsupported");
    if (result.value.kind !== "unsupported") {
      return;
    }
    expectSanitizedSnapshot(result.value.snapshot, {
      sequence: 1,
      pendingCount: 0,
      providerFamily: "none",
      apiFamily: "openai-responses",
      allowlistRuleId: "none",
      collision: false,
      state: "unsupported",
      evidenceKind: "none",
      evidenceOutcome: "none",
      reason: "model-not-allowed",
    });
    expect(tracker.pendingCount()).toBe(0);
  });

  it("records request-collision as sanitized unsupported collision state", () => {
    const tracker = new ProviderFastAttemptTracker();
    const result = tracker.begin({
      snapshot: supportedSnapshot({
        primaryName: SECRET_PRIMARY,
        selectedModel: {
          provider: SECRET_PROVIDER,
          id: SECRET_MODEL,
        },
      }),
      apiFamily: "anthropic-messages",
      classification: {
        kind: "unsupported",
        reason: "request-collision",
      },
    });
    expect(result.isOk()).toBe(true);
    if (result.isErr()) {
      return;
    }
    expect(result.value.kind).toBe("unsupported");
    if (result.value.kind !== "unsupported") {
      return;
    }
    expectSanitizedSnapshot(result.value.snapshot, {
      sequence: 1,
      pendingCount: 0,
      providerFamily: "none",
      apiFamily: "anthropic-messages",
      allowlistRuleId: "none",
      collision: true,
      state: "unsupported",
      evidenceKind: "none",
      evidenceOutcome: "none",
      reason: "request-collision",
    });
    expect(tracker.pendingCount()).toBe(0);
  });

  it("transitions declared to requested to not-confirmed for 200 and failures", () => {
    const tracker = new ProviderFastAttemptTracker();
    const first = beginSupported(tracker);
    expect(first.isOk()).toBe(true);
    if (first.isErr() || first.value.kind !== "pending") {
      return;
    }
    expectSanitizedSnapshot(first.value.snapshot, {
      sequence: 1,
      pendingCount: 1,
      providerFamily: "openai",
      apiFamily: "openai-responses",
      allowlistRuleId: "openai-gpt-5-6-sol",
      collision: false,
      state: "declared",
      evidenceKind: "none",
      evidenceOutcome: "none",
      reason: "none",
    });

    const requested = tracker.markRequested(first.value.token);
    expect(requested.isOk()).toBe(true);
    if (requested.isErr()) {
      return;
    }
    expectSanitizedSnapshot(requested.value, {
      sequence: 1,
      pendingCount: 1,
      providerFamily: "openai",
      apiFamily: "openai-responses",
      allowlistRuleId: "openai-gpt-5-6-sol",
      collision: false,
      state: "requested",
      evidenceKind: "none",
      evidenceOutcome: "none",
      reason: "none",
    });

    const confirmed = tracker.observeResponse(first.value.token, {
      status: 200,
    });
    expect(confirmed.isOk()).toBe(true);
    if (confirmed.isErr()) {
      return;
    }
    expectSanitizedSnapshot(confirmed.value, {
      sequence: 1,
      pendingCount: 0,
      providerFamily: "openai",
      apiFamily: "openai-responses",
      allowlistRuleId: "openai-gpt-5-6-sol",
      collision: false,
      state: "not-confirmed",
      evidenceKind: "response-status",
      evidenceOutcome: "unavailable",
      reason: "response-body-evidence-unavailable",
    });
    expect(confirmed.value).not.toHaveProperty("applied");
    expect(tracker.pendingCount()).toBe(0);

    const second = beginSupported(tracker);
    expect(second.isOk()).toBe(true);
    if (second.isErr() || second.value.kind !== "pending") {
      return;
    }
    const secondRequested = tracker.markRequested(second.value.token);
    expect(secondRequested.isOk()).toBe(true);
    const failed = tracker.observeResponse(second.value.token, {
      status: 500,
    });
    expect(failed.isOk()).toBe(true);
    if (failed.isErr()) {
      return;
    }
    expectSanitizedSnapshot(failed.value, {
      sequence: 2,
      pendingCount: 0,
      providerFamily: "openai",
      apiFamily: "openai-responses",
      allowlistRuleId: "openai-gpt-5-6-sol",
      collision: false,
      state: "not-confirmed",
      evidenceKind: "response-status",
      evidenceOutcome: "unavailable",
      reason: "response-body-evidence-unavailable",
    });
  });

  it("cannot prove applied from any integer HTTP status", () => {
    const tracker = new ProviderFastAttemptTracker();
    const statuses = [0, 200, 201, 204, 400, 401, 403, 429, 500, -1];
    for (const [index, status] of statuses.entries()) {
      const begun = beginSupported(tracker);
      expect(begun.isOk()).toBe(true);
      if (begun.isErr() || begun.value.kind !== "pending") {
        return;
      }
      expect(tracker.markRequested(begun.value.token).isOk()).toBe(true);
      const observed = tracker.observeResponse(begun.value.token, { status });
      expect(observed.isOk()).toBe(true);
      if (observed.isErr()) {
        return;
      }
      expect(observed.value.state).toBe("not-confirmed");
      expect(observed.value.reason).toBe("response-body-evidence-unavailable");
      expect(observed.value.sequence).toBe(index + 1);
      expect(serializedAttempt(observed.value)).not.toContain("applied");
    }
  });

  it("rejects duplicate, out-of-order, forged, and stale tokens without mutating others", () => {
    const tracker = new ProviderFastAttemptTracker();
    const first = beginSupported(tracker);
    const second = beginSupported(tracker);
    expect(first.isOk() && second.isOk()).toBe(true);
    if (
      first.isErr() ||
      second.isErr() ||
      first.value.kind !== "pending" ||
      second.value.kind !== "pending"
    ) {
      return;
    }
    expect(tracker.pendingCount()).toBe(2);

    expectAttemptError(
      tracker.observeResponse(first.value.token, { status: 200 }),
      { type: "OutOfOrderAttempt", reason: "out-of-order" },
    );
    expect(tracker.pendingCount()).toBe(2);

    const requested = tracker.markRequested(first.value.token);
    expect(requested.isOk()).toBe(true);
    expectAttemptError(tracker.markRequested(first.value.token), {
      type: "DuplicateAttemptToken",
      reason: "duplicate-token",
    });
    expect(tracker.pendingCount()).toBe(2);

    const settled = tracker.observeResponse(first.value.token, { status: 200 });
    expect(settled.isOk()).toBe(true);
    expectAttemptError(
      tracker.observeResponse(first.value.token, { status: 200 }),
      { type: "StaleAttemptToken", reason: "stale-token" },
    );
    expectAttemptError(tracker.markRequested({ sequence: 99 }), {
      type: "InvalidAttemptToken",
      reason: "forged-token",
    });
    expectAttemptError(tracker.markRequested({ sequence: 0 }), {
      type: "InvalidAttemptToken",
      reason: "forged-token",
    });
    expectAttemptError(
      tracker.markRequested({ sequence: 1, extra: true } as never),
      { type: "InvalidAttemptToken", reason: "forged-token" },
    );
    expect(tracker.pendingCount()).toBe(1);

    const remaining = tracker.markRequested(second.value.token);
    expect(remaining.isOk()).toBe(true);
    if (remaining.isErr()) {
      return;
    }
    expect(remaining.value.sequence).toBe(2);
    expect(remaining.value.state).toBe("requested");
  });

  it("treats retries as separate attempts", () => {
    const tracker = new ProviderFastAttemptTracker();
    const first = beginSupported(tracker);
    expect(first.isOk() && first.value.kind === "pending").toBe(true);
    if (first.isErr() || first.value.kind !== "pending") {
      return;
    }
    expect(tracker.markRequested(first.value.token).isOk()).toBe(true);
    const firstObserved = tracker.observeResponse(first.value.token, {
      status: 429,
    });
    expect(firstObserved.isOk()).toBe(true);
    if (firstObserved.isErr()) {
      return;
    }
    expect(firstObserved.value.sequence).toBe(1);
    expect(firstObserved.value.state).toBe("not-confirmed");

    const retry = beginSupported(tracker);
    expect(retry.isOk() && retry.value.kind === "pending").toBe(true);
    if (retry.isErr() || retry.value.kind !== "pending") {
      return;
    }
    expect(retry.value.token.sequence).toBe(2);
    expect(retry.value.snapshot.sequence).toBe(2);
    expect(tracker.markRequested(retry.value.token).isOk()).toBe(true);
    const retryObserved = tracker.observeResponse(retry.value.token, {
      status: 200,
    });
    expect(retryObserved.isOk()).toBe(true);
    if (retryObserved.isErr()) {
      return;
    }
    expect(retryObserved.value.sequence).toBe(2);
    expect(retryObserved.value.state).toBe("not-confirmed");
    expect(retryObserved.value.reason).toBe(
      "response-body-evidence-unavailable",
    );
  });

  it("settles concurrent attempts independently and out of order", () => {
    const tracker = new ProviderFastAttemptTracker();
    const first = beginSupported(tracker);
    const second = beginSupported(tracker, {
      snapshot: supportedSnapshot({
        generation: 1,
        selectedModel: { provider: "anthropic", id: "claude-opus-5" },
      }),
      apiFamily: "anthropic-messages",
      classification: ANTHROPIC_SUPPORTED,
    });
    expect(first.isOk() && second.isOk()).toBe(true);
    if (
      first.isErr() ||
      second.isErr() ||
      first.value.kind !== "pending" ||
      second.value.kind !== "pending"
    ) {
      return;
    }
    expect(tracker.markRequested(first.value.token).isOk()).toBe(true);
    expect(tracker.markRequested(second.value.token).isOk()).toBe(true);

    const secondSettled = tracker.observeResponse(second.value.token, {
      status: 503,
    });
    expect(secondSettled.isOk()).toBe(true);
    if (secondSettled.isErr()) {
      return;
    }
    expectSanitizedSnapshot(secondSettled.value, {
      sequence: 2,
      pendingCount: 1,
      providerFamily: "anthropic",
      apiFamily: "anthropic-messages",
      allowlistRuleId: "anthropic-claude-opus-5",
      collision: false,
      state: "not-confirmed",
      evidenceKind: "response-status",
      evidenceOutcome: "unavailable",
      reason: "response-body-evidence-unavailable",
    });

    const firstSettled = tracker.observeResponse(first.value.token, {
      status: 200,
    });
    expect(firstSettled.isOk()).toBe(true);
    if (firstSettled.isErr()) {
      return;
    }
    expect(firstSettled.value.sequence).toBe(1);
    expect(firstSettled.value.state).toBe("not-confirmed");
    expect(tracker.pendingCount()).toBe(0);
  });

  it("expires a generation and reset without letting a prior token settle later work", () => {
    const tracker = new ProviderFastAttemptTracker();
    const first = beginSupported(tracker, {
      snapshot: supportedSnapshot({ generation: 1 }),
    });
    expect(first.isOk() && first.value.kind === "pending").toBe(true);
    if (first.isErr() || first.value.kind !== "pending") {
      return;
    }
    expect(tracker.markRequested(first.value.token).isOk()).toBe(true);
    const expired = tracker.expireGeneration(1);
    expect(expired.isOk()).toBe(true);
    if (expired.isErr()) {
      return;
    }
    expect(expired.value).toEqual({ expiredCount: 1 });
    expect(tracker.pendingCount()).toBe(0);

    const next = beginSupported(tracker, {
      snapshot: supportedSnapshot({ generation: 2, primaryName: "tapestry" }),
    });
    expect(next.isOk() && next.value.kind === "pending").toBe(true);
    if (next.isErr() || next.value.kind !== "pending") {
      return;
    }
    expectAttemptError(
      tracker.observeResponse(first.value.token, { status: 200 }),
      { type: "StaleAttemptToken", reason: "stale-token" },
    );
    expect(tracker.pendingCount()).toBe(1);
    expect(tracker.markRequested(next.value.token).isOk()).toBe(true);

    const cancelled = tracker.cancel(next.value.token, "primary-switched");
    expect(cancelled.isOk()).toBe(true);
    if (cancelled.isErr()) {
      return;
    }
    expect(cancelled.value.reason).toBe("primary-switched");
    expect(tracker.pendingCount()).toBe(0);

    const later = beginSupported(tracker, {
      snapshot: supportedSnapshot({ generation: 3 }),
    });
    expect(later.isOk() && later.value.kind === "pending").toBe(true);
    if (later.isErr() || later.value.kind !== "pending") {
      return;
    }
    const reset = tracker.reset();
    expect(reset.isOk()).toBe(true);
    if (reset.isErr()) {
      return;
    }
    expect(reset.value).toEqual({ expiredCount: 1 });
    expectAttemptError(tracker.markRequested(later.value.token), {
      type: "StaleAttemptToken",
      reason: "stale-token",
    });
    expect(tracker.pendingCount()).toBe(0);
  });

  it("fails closed on pending capacity overflow without evicting existing attempts", () => {
    const tracker = new ProviderFastAttemptTracker({ pendingLimit: 2 });
    const first = beginSupported(tracker);
    const second = beginSupported(tracker);
    expect(first.isOk() && second.isOk()).toBe(true);
    if (
      first.isErr() ||
      second.isErr() ||
      first.value.kind !== "pending" ||
      second.value.kind !== "pending"
    ) {
      return;
    }
    expectAttemptError(beginSupported(tracker), {
      type: "AttemptCapacityExceeded",
      reason: "pending-capacity-exceeded",
    });
    expect(tracker.pendingCount()).toBe(2);
    expect(tracker.markRequested(first.value.token).isOk()).toBe(true);
    expect(tracker.markRequested(second.value.token).isOk()).toBe(true);
    expect(PROVIDER_FAST_ATTEMPT_PENDING_LIMIT).toBe(32);
  });

  it("rejects sequence overflow without wrapping", () => {
    const tracker = new ProviderFastAttemptTracker({ sequenceMax: 1 });
    const first = beginSupported(tracker);
    expect(first.isOk() && first.value.kind === "pending").toBe(true);
    if (first.isErr() || first.value.kind !== "pending") {
      return;
    }
    expectAttemptError(beginSupported(tracker), {
      type: "AttemptSequenceOverflow",
      reason: "sequence-overflow",
    });
    expect(tracker.pendingCount()).toBe(1);
    expect(first.value.token.sequence).toBe(1);
  });

  it("keeps secret-shaped snapshot and error fields out of serialized public state", () => {
    const tracker = new ProviderFastAttemptTracker();
    const begun = tracker.begin({
      snapshot: supportedSnapshot({
        primaryName: SECRET_PRIMARY,
        selectedModel: {
          provider: SECRET_PROVIDER,
          id: SECRET_MODEL,
          name: SECRET_SHAPED_INPUT,
        },
      }),
      apiFamily: "openai-responses",
      classification: OPENAI_SUPPORTED,
    });
    expect(begun.isOk() && begun.value.kind === "pending").toBe(true);
    if (begun.isErr() || begun.value.kind !== "pending") {
      return;
    }
    const requested = tracker.markRequested(begun.value.token);
    const observed = tracker.observeResponse(begun.value.token, {
      status: 200,
    });
    const forged = tracker.markRequested({
      sequence: Number.MAX_SAFE_INTEGER,
    });
    const serialized = serializedAttempt({
      begun: begun.value,
      requested: requested.match(
        (value) => value,
        (error) => error,
      ),
      observed: observed.match(
        (value) => value,
        (error) => error,
      ),
      forged: forged.match(
        (value) => value,
        (error) => error,
      ),
    });
    expect(serialized).not.toContain(SECRET_PRIMARY);
    expect(serialized).not.toContain(SECRET_PROVIDER);
    expect(serialized).not.toContain(SECRET_MODEL);
    expect(serialized).not.toContain(SECRET_SHAPED_INPUT);
    expect(serialized).not.toContain("sk-proj");
    expect(serialized).not.toContain("loom");
    expect(serialized).not.toContain("gpt-5.6");
    expect(serialized).not.toContain("applied");
  });
});

function coordinatorSnapshot(
  overrides: Partial<ProviderFastCoordinatorSnapshot> = {},
): ProviderFastCoordinatorSnapshot {
  return {
    generation: 1,
    primaryName: "loom",
    selectedModel: {
      provider: "openai",
      id: "gpt-5.6-sol",
      api: "openai-responses",
    },
    fast: true,
    ...overrides,
  };
}

function expectCoordinatorError(
  result: {
    isOk(): boolean;
    isErr(): boolean;
    error?: ProviderFastCoordinatorError;
  },
  error: ProviderFastCoordinatorError,
): void {
  expect(result.isErr()).toBe(true);
  if (result.isOk()) {
    return;
  }
  expect(result.error).toEqual(error);
}

function expectIdleLatest(coordinator: ProviderFastCoordinator): void {
  expectSanitizedSnapshot(coordinator.latest(), {
    sequence: 0,
    pendingCount: 0,
    providerFamily: "none",
    apiFamily: "none",
    allowlistRuleId: "none",
    collision: false,
    state: "unsupported",
    evidenceKind: "none",
    evidenceOutcome: "none",
    reason: "none",
  });
}

describe("ProviderFastCoordinator", () => {
  it("runs the exact OpenAI sequence and never serializes applied", () => {
    const coordinator = new ProviderFastCoordinator();
    const snapshot = coordinatorSnapshot();
    const headers = { Authorization: SECRET_AUTHORIZATION };
    const payload = {
      model: "gpt-5.6-sol",
      messages: [{ role: "user", content: "hi" }],
    };
    const originalPayload = clonePlain(payload);

    const begun = coordinator.beginHeaders(snapshot, headers);
    expect(begun.isOk()).toBe(true);
    if (begun.isErr() || begun.value.kind !== "pending") {
      return;
    }
    expect(headers).toEqual({ Authorization: SECRET_AUTHORIZATION });
    expectSanitizedSnapshot(begun.value.snapshot, {
      sequence: 1,
      pendingCount: 1,
      providerFamily: "openai",
      apiFamily: "openai-responses",
      allowlistRuleId: "openai-gpt-5-6-sol",
      collision: false,
      state: "declared",
      evidenceKind: "none",
      evidenceOutcome: "none",
      reason: "none",
    });

    const requested = coordinator.applyRequest(
      snapshot,
      begun.value.token,
      payload,
    );
    expect(requested.isOk()).toBe(true);
    if (requested.isErr()) {
      return;
    }
    expect(payload).toEqual(originalPayload);
    expect(requested.value.payload).not.toBe(payload);
    expect(requested.value.payload).toEqual({
      ...originalPayload,
      service_tier: "fast",
    });
    expectSanitizedSnapshot(requested.value.snapshot, {
      sequence: 1,
      pendingCount: 1,
      providerFamily: "openai",
      apiFamily: "openai-responses",
      allowlistRuleId: "openai-gpt-5-6-sol",
      collision: false,
      state: "requested",
      evidenceKind: "none",
      evidenceOutcome: "none",
      reason: "none",
    });

    const observed = coordinator.observeResponse(begun.value.token, 200);
    expect(observed.isOk()).toBe(true);
    if (observed.isErr()) {
      return;
    }
    expectSanitizedSnapshot(observed.value, {
      sequence: 1,
      pendingCount: 0,
      providerFamily: "openai",
      apiFamily: "openai-responses",
      allowlistRuleId: "openai-gpt-5-6-sol",
      collision: false,
      state: "not-confirmed",
      evidenceKind: "response-status",
      evidenceOutcome: "unavailable",
      reason: "response-body-evidence-unavailable",
    });
    expect(observed.value).not.toHaveProperty("applied");
    expect(serializedAttempt(coordinator.latest())).not.toContain("applied");
    expect(serializedAttempt(coordinator.latest())).not.toContain(
      SECRET_AUTHORIZATION,
    );
  });

  it("runs the exact Anthropic sequence and mutates only the beta header", () => {
    const coordinator = new ProviderFastCoordinator();
    const snapshot = coordinatorSnapshot({
      selectedModel: {
        provider: "anthropic",
        id: "claude-opus-5",
        api: "anthropic-messages",
      },
    });
    const headers: Record<string, string> = {
      Authorization: SECRET_AUTHORIZATION,
      "x-request-id": "req-1",
    };
    const payload = {
      model: "claude-opus-5",
      max_tokens: 32,
      messages: [{ role: "user", content: "hi" }],
    };
    const originalPayload = clonePlain(payload);

    const begun = coordinator.beginHeaders(snapshot, headers);
    expect(begun.isOk()).toBe(true);
    if (begun.isErr() || begun.value.kind !== "pending") {
      return;
    }
    expect(headers).toEqual({
      Authorization: SECRET_AUTHORIZATION,
      "x-request-id": "req-1",
      "anthropic-beta": PROVIDER_FAST_ANTHROPIC_BETA_TOKEN,
    });
    expectSanitizedSnapshot(begun.value.snapshot, {
      sequence: 1,
      pendingCount: 1,
      providerFamily: "anthropic",
      apiFamily: "anthropic-messages",
      allowlistRuleId: "anthropic-claude-opus-5",
      collision: false,
      state: "declared",
      evidenceKind: "none",
      evidenceOutcome: "none",
      reason: "none",
    });

    const requested = coordinator.applyRequest(
      snapshot,
      begun.value.token,
      payload,
    );
    expect(requested.isOk()).toBe(true);
    if (requested.isErr()) {
      return;
    }
    expect(payload).toEqual(originalPayload);
    expect(requested.value.payload).toEqual({
      ...originalPayload,
      speed: "fast",
    });

    const observed = coordinator.observeResponse(begun.value.token, 529);
    expect(observed.isOk()).toBe(true);
    if (observed.isErr()) {
      return;
    }
    expect(observed.value.state).toBe("not-confirmed");
    expect(observed.value.reason).toBe("response-body-evidence-unavailable");
  });

  it("is an exact no-op for no-intent and omitted fast", () => {
    const coordinator = new ProviderFastCoordinator();
    const headers = { Authorization: SECRET_AUTHORIZATION };
    const payload = { model: "gpt-5.6-sol" };
    const noIntent = coordinator.beginHeaders(
      coordinatorSnapshot({ fast: undefined }),
      headers,
    );
    expect(noIntent.isOk()).toBe(true);
    if (noIntent.isErr()) {
      return;
    }
    expect(noIntent.value).toEqual({ kind: "no-state" });
    expect(headers).toEqual({ Authorization: SECRET_AUTHORIZATION });
    expectIdleLatest(coordinator);

    const omitted = coordinator.beginHeaders(
      {
        generation: 1,
        primaryName: "loom",
        selectedModel: {
          provider: "openai",
          id: "gpt-5.6-sol",
          api: "openai-responses",
        },
      },
      headers,
    );
    expect(omitted.isOk()).toBe(true);
    if (omitted.isErr()) {
      return;
    }
    expect(omitted.value).toEqual({ kind: "no-state" });
    expect(payload).toEqual({ model: "gpt-5.6-sol" });
    expectIdleLatest(coordinator);
  });

  it("sanitizes unsupported host APIs and unknown models", () => {
    const coordinator = new ProviderFastCoordinator();
    const headers = { Authorization: SECRET_AUTHORIZATION };
    const result = coordinator.beginHeaders(
      coordinatorSnapshot({
        primaryName: SECRET_PRIMARY,
        selectedModel: {
          provider: SECRET_PROVIDER,
          id: SECRET_MODEL,
          api: "openai-compatible",
        },
      }),
      headers,
    );
    expect(result.isOk()).toBe(true);
    if (result.isErr() || result.value.kind !== "unsupported") {
      return;
    }
    expect(headers).toEqual({ Authorization: SECRET_AUTHORIZATION });
    expectSanitizedSnapshot(result.value.snapshot, {
      sequence: 1,
      pendingCount: 0,
      providerFamily: "none",
      apiFamily: "none",
      allowlistRuleId: "none",
      collision: false,
      state: "unsupported",
      evidenceKind: "none",
      evidenceOutcome: "none",
      reason: "endpoint-not-allowed",
    });
    expect(serializedAttempt(result.value.snapshot)).not.toContain(
      "openai-compatible",
    );

    const unknownModel = coordinator.beginHeaders(
      coordinatorSnapshot({
        selectedModel: {
          provider: "openai",
          id: "gpt-5.6",
          api: "openai-responses",
        },
      }),
      headers,
    );
    expect(unknownModel.isOk()).toBe(true);
    if (unknownModel.isErr() || unknownModel.value.kind !== "unsupported") {
      return;
    }
    expect(unknownModel.value.snapshot.reason).toBe("model-not-allowed");
    expect(unknownModel.value.snapshot.apiFamily).toBe("openai-responses");
  });

  it("records collision as sanitized unsupported and leaves the original request", () => {
    const coordinator = new ProviderFastCoordinator();
    const headers = {
      Authorization: SECRET_AUTHORIZATION,
      "anthropic-beta": "fast-mode-2099-01-01",
    };
    const original = clonePlain(headers);
    const result = coordinator.beginHeaders(
      coordinatorSnapshot({
        selectedModel: {
          provider: "anthropic",
          id: "claude-opus-5",
          api: "anthropic-messages",
        },
      }),
      headers,
    );
    expect(result.isOk()).toBe(true);
    if (result.isErr() || result.value.kind !== "unsupported") {
      return;
    }
    expect(headers).toEqual(original);
    expectSanitizedSnapshot(result.value.snapshot, {
      sequence: 1,
      pendingCount: 0,
      providerFamily: "none",
      apiFamily: "anthropic-messages",
      allowlistRuleId: "none",
      collision: true,
      state: "unsupported",
      evidenceKind: "none",
      evidenceOutcome: "none",
      reason: "request-collision",
    });

    const payloadCoordinator = new ProviderFastCoordinator();
    const payloadSnapshot = coordinatorSnapshot();
    const begun = payloadCoordinator.beginHeaders(payloadSnapshot, {});
    expect(begun.isOk() && begun.value.kind === "pending").toBe(true);
    if (begun.isErr() || begun.value.kind !== "pending") {
      return;
    }
    const collidingPayload = { service_tier: "priority" };
    const originalPayload = clonePlain(collidingPayload);
    expectCoordinatorError(
      payloadCoordinator.applyRequest(
        payloadSnapshot,
        begun.value.token,
        collidingPayload,
      ),
      { type: "AmbiguousFastAttempt", reason: "out-of-order" },
    );
    expect(collidingPayload).toEqual(originalPayload);
    expectIdleLatest(payloadCoordinator);
  });

  it("fails closed on overlap, order, token, snapshot, generation, and reset", () => {
    const coordinator = new ProviderFastCoordinator();
    const snapshot = coordinatorSnapshot();
    const first = coordinator.beginHeaders(snapshot, {});
    expect(first.isOk() && first.value.kind === "pending").toBe(true);
    if (first.isErr() || first.value.kind !== "pending") {
      return;
    }

    expectCoordinatorError(coordinator.beginHeaders(snapshot, {}), {
      type: "AmbiguousFastAttempt",
      reason: "out-of-order",
    });
    expectIdleLatest(coordinator);

    const restarted = coordinator.beginHeaders(snapshot, {});
    expect(restarted.isOk() && restarted.value.kind === "pending").toBe(true);
    if (restarted.isErr() || restarted.value.kind !== "pending") {
      return;
    }
    const token: ProviderFastAttemptToken = restarted.value.token;
    const originalPayload = { model: "gpt-5.6-sol" };
    const payload = clonePlain(originalPayload);

    expectCoordinatorError(
      coordinator.applyRequest(snapshot, { sequence: 99 }, payload),
      { type: "InvalidAttemptToken", reason: "forged-token" },
    );
    expect(payload).toEqual(originalPayload);
    expectIdleLatest(coordinator);

    const afterForged = coordinator.beginHeaders(snapshot, {});
    expect(afterForged.isOk() && afterForged.value.kind === "pending").toBe(
      true,
    );
    if (afterForged.isErr() || afterForged.value.kind !== "pending") {
      return;
    }
    expectCoordinatorError(
      coordinator.applyRequest(
        coordinatorSnapshot({ generation: 2 }),
        afterForged.value.token,
        payload,
      ),
      { type: "AmbiguousFastAttempt", reason: "out-of-order" },
    );
    expect(payload).toEqual(originalPayload);
    expectIdleLatest(coordinator);

    const afterGeneration = coordinator.beginHeaders(snapshot, {});
    expect(
      afterGeneration.isOk() && afterGeneration.value.kind === "pending",
    ).toBe(true);
    if (afterGeneration.isErr() || afterGeneration.value.kind !== "pending") {
      return;
    }
    expectCoordinatorError(
      coordinator.applyRequest(
        coordinatorSnapshot({ primaryName: "tapestry" }),
        afterGeneration.value.token,
        payload,
      ),
      { type: "AmbiguousFastAttempt", reason: "out-of-order" },
    );
    expectIdleLatest(coordinator);

    const afterPrimary = coordinator.beginHeaders(snapshot, {});
    expect(afterPrimary.isOk() && afterPrimary.value.kind === "pending").toBe(
      true,
    );
    if (afterPrimary.isErr() || afterPrimary.value.kind !== "pending") {
      return;
    }
    expectCoordinatorError(
      coordinator.applyRequest(
        coordinatorSnapshot({
          selectedModel: {
            provider: "openai",
            id: "gpt-5.6-terra",
            api: "openai-responses",
          },
        }),
        afterPrimary.value.token,
        payload,
      ),
      { type: "AmbiguousFastAttempt", reason: "out-of-order" },
    );
    expect(payload).toEqual(originalPayload);
    expectIdleLatest(coordinator);

    const afterModel = coordinator.beginHeaders(snapshot, {});
    expect(afterModel.isOk() && afterModel.value.kind === "pending").toBe(true);
    if (afterModel.isErr() || afterModel.value.kind !== "pending") {
      return;
    }
    const requested = coordinator.applyRequest(
      snapshot,
      afterModel.value.token,
      payload,
    );
    expect(requested.isOk()).toBe(true);
    expectCoordinatorError(
      coordinator.applyRequest(snapshot, afterModel.value.token, payload),
      { type: "DuplicateAttemptToken", reason: "duplicate-token" },
    );
    expectIdleLatest(coordinator);

    const afterDuplicate = coordinator.beginHeaders(snapshot, {});
    expect(
      afterDuplicate.isOk() && afterDuplicate.value.kind === "pending",
    ).toBe(true);
    if (afterDuplicate.isErr() || afterDuplicate.value.kind !== "pending") {
      return;
    }
    expectCoordinatorError(
      coordinator.observeResponse(afterDuplicate.value.token, 200),
      { type: "OutOfOrderAttempt", reason: "out-of-order" },
    );
    expectIdleLatest(coordinator);

    const afterOrder = coordinator.beginHeaders(snapshot, {});
    expect(afterOrder.isOk() && afterOrder.value.kind === "pending").toBe(true);
    if (afterOrder.isErr() || afterOrder.value.kind !== "pending") {
      return;
    }
    expect(
      coordinator
        .applyRequest(snapshot, afterOrder.value.token, payload)
        .isOk(),
    ).toBe(true);
    const reset = coordinator.reset();
    expect(reset.isOk()).toBe(true);
    if (reset.isErr()) {
      return;
    }
    expect(reset.value).toEqual({ expiredCount: 1 });
    expectIdleLatest(coordinator);
    expectCoordinatorError(
      coordinator.observeResponse(afterOrder.value.token, 200),
      { type: "AmbiguousFastAttempt", reason: "out-of-order" },
    );
    expect(token.sequence).toBe(2);
  });

  it("treats retries after settlement as a new sequence", () => {
    const coordinator = new ProviderFastCoordinator();
    const snapshot = coordinatorSnapshot({
      selectedModel: {
        provider: "openai",
        id: "gpt-5.6-luna",
        api: "openai-completions",
      },
    });
    const first = coordinator.beginHeaders(snapshot, {});
    expect(first.isOk() && first.value.kind === "pending").toBe(true);
    if (first.isErr() || first.value.kind !== "pending") {
      return;
    }
    expect(
      coordinator
        .applyRequest(snapshot, first.value.token, { model: "gpt-5.6-luna" })
        .isOk(),
    ).toBe(true);
    const firstObserved = coordinator.observeResponse(first.value.token, 429);
    expect(firstObserved.isOk()).toBe(true);
    if (firstObserved.isErr()) {
      return;
    }
    expect(firstObserved.value.sequence).toBe(1);
    expect(firstObserved.value.state).toBe("not-confirmed");
    expect(firstObserved.value.apiFamily).toBe("openai-completions");

    const retry = coordinator.beginHeaders(snapshot, {});
    expect(retry.isOk() && retry.value.kind === "pending").toBe(true);
    if (retry.isErr() || retry.value.kind !== "pending") {
      return;
    }
    expect(retry.value.token.sequence).toBe(2);
    expect(
      coordinator
        .applyRequest(snapshot, retry.value.token, { model: "gpt-5.6-luna" })
        .isOk(),
    ).toBe(true);
    const retryObserved = coordinator.observeResponse(retry.value.token, 200);
    expect(retryObserved.isOk()).toBe(true);
    if (retryObserved.isErr()) {
      return;
    }
    expect(retryObserved.value.sequence).toBe(2);
    expect(retryObserved.value.state).toBe("not-confirmed");
    expectCoordinatorError(
      coordinator.observeResponse(first.value.token, 200),
      { type: "AmbiguousFastAttempt", reason: "out-of-order" },
    );
  });

  it("starts a settled retry without rewriting headers", () => {
    const coordinator = new ProviderFastCoordinator();
    const snapshot = coordinatorSnapshot();
    const headers = { Authorization: SECRET_AUTHORIZATION };
    const begun = coordinator.beginHeaders(snapshot, headers);
    expect(begun.isOk() && begun.value.kind === "pending").toBe(true);
    if (begun.isErr() || begun.value.kind !== "pending") {
      return;
    }
    expect(
      coordinator
        .applyRequest(snapshot, begun.value.token, { model: "gpt-5.6-sol" })
        .isOk(),
    ).toBe(true);
    expect(coordinator.observeResponse(begun.value.token, 429).isOk()).toBe(
      true,
    );
    const retry = coordinator.beginSettledRetry(snapshot);
    expect(retry.isOk() && retry.value.kind === "pending").toBe(true);
    if (retry.isErr() || retry.value.kind !== "pending") {
      return;
    }
    expect(retry.value.token.sequence).toBe(2);
    expect(headers).toEqual({ Authorization: SECRET_AUTHORIZATION });
    expect(
      coordinator
        .applyRequest(snapshot, retry.value.token, { model: "gpt-5.6-sol" })
        .isOk(),
    ).toBe(true);
    expectCoordinatorError(coordinator.beginSettledRetry(snapshot), {
      type: "AmbiguousFastAttempt",
      reason: "out-of-order",
    });
  });

  it("settles every integer status as not-confirmed and rejects headers or bodies", () => {
    const coordinator = new ProviderFastCoordinator();
    const snapshot = coordinatorSnapshot();
    const statuses = [0, 200, 201, 204, 400, 401, 403, 429, 500, -1];
    for (const [index, status] of statuses.entries()) {
      const begun = coordinator.beginHeaders(snapshot, {});
      expect(begun.isOk() && begun.value.kind === "pending").toBe(true);
      if (begun.isErr() || begun.value.kind !== "pending") {
        return;
      }
      expect(
        coordinator
          .applyRequest(snapshot, begun.value.token, { model: "gpt-5.6-sol" })
          .isOk(),
      ).toBe(true);
      const observed = coordinator.observeResponse(begun.value.token, status);
      expect(observed.isOk()).toBe(true);
      if (observed.isErr()) {
        return;
      }
      expect(observed.value.state).toBe("not-confirmed");
      expect(observed.value.sequence).toBe(index + 1);
      expect(serializedAttempt(observed.value)).not.toContain("applied");
    }

    const next = coordinator.beginHeaders(snapshot, {});
    expect(next.isOk() && next.value.kind === "pending").toBe(true);
    if (next.isErr() || next.value.kind !== "pending") {
      return;
    }
    expect(
      coordinator
        .applyRequest(snapshot, next.value.token, { model: "gpt-5.6-sol" })
        .isOk(),
    ).toBe(true);
    expectCoordinatorError(
      coordinator.observeResponse(next.value.token, Number.NaN),
      { type: "InvalidResponseStatus", reason: "invalid-status" },
    );
    expectIdleLatest(coordinator);
    expect(
      (
        coordinator.observeResponse as unknown as (
          token: ProviderFastAttemptToken,
          observation: unknown,
        ) => unknown
      ).length,
    ).toBe(2);
  });

  it("keeps secret-shaped snapshot and header values out of latest()", () => {
    const coordinator = new ProviderFastCoordinator();
    const secretSnapshot = coordinatorSnapshot({
      primaryName: SECRET_PRIMARY,
      selectedModel: {
        provider: "openai",
        id: "gpt-5.6-sol",
        name: SECRET_SHAPED_INPUT,
        api: "openai-responses",
      },
    });
    const begun = coordinator.beginHeaders(secretSnapshot, {
      Authorization: SECRET_AUTHORIZATION,
    });
    expect(begun.isOk() && begun.value.kind === "pending").toBe(true);
    if (begun.isErr() || begun.value.kind !== "pending") {
      return;
    }
    const requested = coordinator.applyRequest(
      secretSnapshot,
      begun.value.token,
      { prompt: SECRET_SHAPED_INPUT },
    );
    const observed = coordinator.observeResponse(begun.value.token, 200);
    const serialized = serializedAttempt({
      begun: begun.value,
      requested: requested.match(
        (value) => value.snapshot,
        (error) => error,
      ),
      observed: observed.match(
        (value) => value,
        (error) => error,
      ),
      latest: coordinator.latest(),
    });
    expect(serialized).not.toContain(SECRET_PRIMARY);
    expect(serialized).not.toContain(SECRET_PROVIDER);
    expect(serialized).not.toContain(SECRET_MODEL);
    expect(serialized).not.toContain(SECRET_SHAPED_INPUT);
    expect(serialized).not.toContain(SECRET_AUTHORIZATION);
    expect(serialized).not.toContain("sk-proj");
    expect(serialized).not.toContain("loom");
    expect(serialized).not.toContain("gpt-5.6");
    expect(serialized).not.toContain("applied");
    expect(serialized).not.toContain("service_tier");
    expect(serialized).not.toContain("Authorization");
  });
});
