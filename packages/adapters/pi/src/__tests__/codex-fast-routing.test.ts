import { describe, expect, it } from "bun:test";
import type { CodexFastEligibilityInput } from "../codex-fast/routing.js";
import {
  CODEX_FAST_ALLOWLIST_REVISION,
  CODEX_FAST_MODEL_ALLOWLIST,
  CODEX_FAST_ORIGINATOR,
  CODEX_FIRST_PARTY_BASE_URL,
  CODEX_INELIGIBLE_REASONS,
  CODEX_ORIGINATOR_HEADER,
  CODEX_PROVIDER_ID,
  CODEX_ROUTING_HINT_HEADER,
  CODEX_SAFE_MODEL_ID_PATTERN_SOURCE,
  classifyCodexFastEligibility,
  findCodexFastAllowlistEntry,
  isSafeCodexModelId,
  resolveCodexFastRouting,
} from "../codex-fast/routing.js";

const SECRET_SHAPED_INPUT = "sk-proj-fast-secret-value-DO-NOT-ECHO-9f3c2a1b";

/** An allowlisted model used as the happy-path subject. */
const ELIGIBLE_MODEL = "gpt-5.6-sol";
const ELIGIBLE_RULE_ID = "codex-sub-06";

/** The exact scalar bundle a fully eligible request produces. */
function eligibleInput(): CodexFastEligibilityInput {
  return {
    providerId: CODEX_PROVIDER_ID,
    fast: true,
    modelId: ELIGIBLE_MODEL,
    ownerModelId: ELIGIBLE_MODEL,
    baseUrl: CODEX_FIRST_PARTY_BASE_URL,
    subscriptionAuthProven: true,
    collisionObserved: false,
  };
}

/**
 * Model ids that must never reach a header value: CRLF and header-injection
 * punctuation, routing-hint separators, Unicode, whitespace, over-length, and
 * non-string values.
 */
const UNSAFE_MODEL_IDS: readonly unknown[] = [
  "gpt-5.6-sol\r\nx-injected: 1",
  "gpt-5.6-sol\ninjected",
  "gpt-5.6-sol\r",
  "gpt-5.6-sol;tier=priority",
  "gpt-5.6-sol;x=1",
  "gpt-5.6-söl",
  "gpt-5.6-sol\u0000",
  "gpt-5.6-sol\u2028",
  "模型",
  "gpt 5.6 sol",
  "gpt-5.6-sol ",
  "gpt/5.6:sol",
  "a".repeat(65),
  "a".repeat(200),
  "",
  null,
  undefined,
  42,
  true,
  {},
  [],
  { toString: () => ELIGIBLE_MODEL },
];

/** Base URLs that are not the exact first-party ChatGPT backend. */
const NON_FIRST_PARTY_BASE_URLS: readonly unknown[] = [
  "http://127.0.0.1:17399/backend-api",
  "http://localhost:17399/backend-api",
  "https://chatgpt.com.evil.tld/backend-api",
  "https://evil.tld/https://chatgpt.com/backend-api",
  "https://chatgpt.com@evil.tld/backend-api",
  "https://chatgpt.com/backend-api/",
  "https://chatgpt.com/backend-api/v1",
  "https://chatgpt.com/backend-api?x=1",
  "http://chatgpt.com/backend-api",
  "https://CHATGPT.com/backend-api",
  "https://chatgpt.com:443/backend-api",
  " https://chatgpt.com/backend-api",
  "https://chatgpt.com/backend-api ",
  "https://gateway.example.com/openai",
  "",
  42,
  {},
  ["https://chatgpt.com/backend-api"],
];

describe("codex fast constants", () => {
  it("pins the two-part contract tokens and the first-party transport", () => {
    expect(CODEX_FAST_ORIGINATOR).toBe("codex_cli_rs");
    expect(CODEX_ORIGINATOR_HEADER).toBe("originator");
    expect(CODEX_ROUTING_HINT_HEADER).toBe("x-codex-routing-hint");
    expect(CODEX_FIRST_PARTY_BASE_URL).toBe("https://chatgpt.com/backend-api");
    expect(CODEX_PROVIDER_ID).toBe("openai-codex");
    expect(CODEX_SAFE_MODEL_ID_PATTERN_SOURCE).toBe("^[A-Za-z0-9._-]{1,64}$");
  });

  it("freezes the seven-entry codex-sub-r1 allowlist in spec order", () => {
    expect(CODEX_FAST_ALLOWLIST_REVISION).toBe("codex-sub-r1");
    expect(CODEX_FAST_MODEL_ALLOWLIST).toHaveLength(7);
    expect(
      CODEX_FAST_MODEL_ALLOWLIST.map((entry) => [entry.modelId, entry.ruleId]),
    ).toEqual([
      ["gpt-5.3-codex-spark", "codex-sub-01"],
      ["gpt-5.4", "codex-sub-02"],
      ["gpt-5.4-mini", "codex-sub-03"],
      ["gpt-5.5", "codex-sub-04"],
      ["gpt-5.6-luna", "codex-sub-05"],
      ["gpt-5.6-sol", "codex-sub-06"],
      ["gpt-5.6-terra", "codex-sub-07"],
    ]);
    expect(Object.isFrozen(CODEX_FAST_MODEL_ALLOWLIST)).toBe(true);
    for (const entry of CODEX_FAST_MODEL_ALLOWLIST) {
      expect(Object.isFrozen(entry)).toBe(true);
      expect(isSafeCodexModelId(entry.modelId)).toBe(true);
    }
  });

  it("keeps the ineligible reason set bounded and frozen", () => {
    expect(CODEX_INELIGIBLE_REASONS).toEqual([
      "provider-not-codex",
      "model-id-unsafe",
      "model-not-allowed",
      "model-owner-mismatch",
      "transport-not-first-party",
      "auth-not-subscription",
      "request-collision",
    ]);
    expect(Object.isFrozen(CODEX_INELIGIBLE_REASONS)).toBe(true);
  });
});

describe("isSafeCodexModelId", () => {
  it("accepts exactly the allowed character rule", () => {
    expect(isSafeCodexModelId("a")).toBe(true);
    expect(isSafeCodexModelId("a".repeat(64))).toBe(true);
    expect(isSafeCodexModelId("gpt-5.6-sol")).toBe(true);
    expect(isSafeCodexModelId("GPT_5.6-sol")).toBe(true);
  });

  it("rejects every unsafe id", () => {
    for (const modelId of UNSAFE_MODEL_IDS) {
      expect(isSafeCodexModelId(modelId)).toBe(false);
    }
  });
});

describe("findCodexFastAllowlistEntry", () => {
  it("matches allowlist ids exactly", () => {
    expect(findCodexFastAllowlistEntry("gpt-5.4")?.ruleId).toBe("codex-sub-02");
    expect(findCodexFastAllowlistEntry("gpt-5.4-mini")?.ruleId).toBe(
      "codex-sub-03",
    );
  });

  it("does not match prefixes, aliases, casing, or non-strings", () => {
    for (const modelId of [
      "gpt-5.4-",
      "gpt-5.4-2026-08-17",
      "GPT-5.4",
      "gpt-5",
      "openai/gpt-5.4",
      "gpt-5.4 ",
      42,
      null,
      undefined,
    ]) {
      expect(findCodexFastAllowlistEntry(modelId)).toBeUndefined();
    }
  });
});

describe("resolveCodexFastRouting", () => {
  it("emits both routing parts for fast intent with a resolved priority tier", () => {
    const routing = resolveCodexFastRouting({
      modelId: ELIGIBLE_MODEL,
      fast: true,
      serviceTier: "priority",
    });
    expect(routing).toEqual({
      kind: "routing",
      originatorHeader: "originator",
      originator: "codex_cli_rs",
      routingHintHeader: "x-codex-routing-hint",
      routingHint: "model=gpt-5.6-sol;tier=priority",
    });
  });

  it("emits neither part when fast intent is absent or not the literal true", () => {
    for (const fast of [false, undefined, null, 1, "true", "fast", {}, []]) {
      expect(
        resolveCodexFastRouting({
          modelId: ELIGIBLE_MODEL,
          fast,
          serviceTier: "priority",
        }),
      ).toEqual({ kind: "none" });
    }
  });

  it("emits neither part when the tier is not exactly priority", () => {
    for (const serviceTier of [
      undefined,
      null,
      "default",
      "fast",
      "flex",
      "Priority",
      "PRIORITY",
      " priority",
      "priority ",
      true,
      1,
      {},
    ]) {
      expect(
        resolveCodexFastRouting({
          modelId: ELIGIBLE_MODEL,
          fast: true,
          serviceTier,
        }),
      ).toEqual({ kind: "none" });
    }
  });

  it("refuses to build a header value from an unsafe model id", () => {
    for (const modelId of UNSAFE_MODEL_IDS) {
      expect(
        resolveCodexFastRouting({
          modelId,
          fast: true,
          serviceTier: "priority",
        }),
      ).toEqual({ kind: "none" });
    }
  });

  it("never lets CRLF, semicolons, unicode, or over-length text reach a header value", () => {
    for (const modelId of UNSAFE_MODEL_IDS) {
      const routing = resolveCodexFastRouting({
        modelId,
        fast: true,
        serviceTier: "priority",
      });
      const serialized = JSON.stringify(routing);
      expect(serialized).not.toContain("x-injected");
      expect(serialized).not.toContain("\\r");
      expect(serialized).not.toContain("\\n");
      expect(serialized).not.toContain("model=");
    }

    const routing = resolveCodexFastRouting({
      modelId: "a".repeat(64),
      fast: true,
      serviceTier: "priority",
    });
    expect(routing.kind).toBe("routing");
    if (routing.kind === "routing") {
      expect(routing.routingHint).toBe(`model=${"a".repeat(64)};tier=priority`);
      expect(routing.routingHint).not.toMatch(/[\r\n]/);
    }
  });

  it("suppresses a secret-shaped model id that cannot enter a header", () => {
    for (const modelId of [
      `${SECRET_SHAPED_INPUT};tier=priority`,
      `${SECRET_SHAPED_INPUT}\r\nauthorization: Bearer x`,
      `Bearer ${SECRET_SHAPED_INPUT}`,
    ]) {
      const routing = resolveCodexFastRouting({
        modelId,
        fast: true,
        serviceTier: "priority",
      });
      expect(routing).toEqual({ kind: "none" });
      expect(JSON.stringify(routing)).not.toContain(SECRET_SHAPED_INPUT);
    }
  });

  it("keeps a non-allowlisted safe id out of the mapping through eligibility", () => {
    // Routing echoes the caller's model id by design; the allowlist gate that
    // stops an arbitrary safe string from ever reaching it is eligibility.
    expect(
      classifyCodexFastEligibility({
        ...eligibleInput(),
        modelId: SECRET_SHAPED_INPUT,
        ownerModelId: SECRET_SHAPED_INPUT,
      }),
    ).toEqual({ kind: "ineligible", reason: "model-not-allowed" });
  });

  it("returns frozen results on both branches", () => {
    expect(
      Object.isFrozen(
        resolveCodexFastRouting({
          modelId: ELIGIBLE_MODEL,
          fast: false,
          serviceTier: "priority",
        }),
      ),
    ).toBe(true);
    expect(
      Object.isFrozen(
        resolveCodexFastRouting({
          modelId: ELIGIBLE_MODEL,
          fast: true,
          serviceTier: "priority",
        }),
      ),
    ).toBe(true);
  });
});

describe("classifyCodexFastEligibility", () => {
  it("accepts a fully proven request and reports only the allowlist rule id", () => {
    const verdict = classifyCodexFastEligibility(eligibleInput());
    expect(verdict).toEqual({ kind: "eligible", ruleId: ELIGIBLE_RULE_ID });
    expect(Object.isFrozen(verdict)).toBe(true);
    expect(JSON.stringify(verdict)).not.toContain(ELIGIBLE_MODEL);
    expect(JSON.stringify(verdict)).not.toContain("chatgpt.com");
  });

  it("accepts every allowlist entry with its own rule id", () => {
    for (const entry of CODEX_FAST_MODEL_ALLOWLIST) {
      expect(
        classifyCodexFastEligibility({
          ...eligibleInput(),
          modelId: entry.modelId,
          ownerModelId: entry.modelId,
        }),
      ).toEqual({ kind: "eligible", ruleId: entry.ruleId });
    }
  });

  it("accepts the spec-authorized absent base URL", () => {
    for (const baseUrl of [undefined, null]) {
      expect(
        classifyCodexFastEligibility({ ...eligibleInput(), baseUrl }),
      ).toEqual({ kind: "eligible", ruleId: ELIGIBLE_RULE_ID });
    }
  });

  it("reports no acceleration state when intent is absent", () => {
    for (const fast of [undefined, null, false, 1, "true", {}, []]) {
      expect(
        classifyCodexFastEligibility({ ...eligibleInput(), fast }),
      ).toEqual({ kind: "no-intent" });
    }
  });

  it("refuses any provider other than the wrapped codex provider", () => {
    for (const providerId of [
      "openai",
      "openai-codex-proxy",
      "OPENAI-CODEX",
      "anthropic",
      "",
      undefined,
      null,
      42,
    ]) {
      expect(
        classifyCodexFastEligibility({ ...eligibleInput(), providerId }),
      ).toEqual({ kind: "ineligible", reason: "provider-not-codex" });
    }
  });

  it("fails closed on an unsafe model id before any allowlist lookup", () => {
    for (const modelId of UNSAFE_MODEL_IDS) {
      expect(
        classifyCodexFastEligibility({
          ...eligibleInput(),
          modelId,
          ownerModelId: modelId,
        }),
      ).toEqual({ kind: "ineligible", reason: "model-id-unsafe" });
    }
  });

  it("fails closed on a safe id that is not an exact allowlist member", () => {
    for (const modelId of [
      "gpt-5.6-mini",
      "gpt-4o",
      "gpt-5.4-2026-08-17",
      "GPT-5.4",
      "gpt-5.4.",
      "ft.gpt-5.4",
    ]) {
      expect(
        classifyCodexFastEligibility({
          ...eligibleInput(),
          modelId,
          ownerModelId: modelId,
        }),
      ).toEqual({ kind: "ineligible", reason: "model-not-allowed" });
    }
  });

  it("requires the request model to equal the active owner's resolved model", () => {
    expect(
      classifyCodexFastEligibility({
        ...eligibleInput(),
        modelId: "gpt-5.6-sol",
        ownerModelId: "gpt-5.6-luna",
      }),
    ).toEqual({ kind: "ineligible", reason: "model-owner-mismatch" });

    for (const ownerModelId of [
      undefined,
      null,
      "",
      "GPT-5.6-SOL",
      "gpt-5.6-sol ",
      42,
    ]) {
      expect(
        classifyCodexFastEligibility({ ...eligibleInput(), ownerModelId }),
      ).toEqual({ kind: "ineligible", reason: "model-owner-mismatch" });
    }
  });

  it("fails closed on gateway, localhost, lookalike, and malformed transports", () => {
    for (const baseUrl of NON_FIRST_PARTY_BASE_URLS) {
      expect(
        classifyCodexFastEligibility({ ...eligibleInput(), baseUrl }),
      ).toEqual({ kind: "ineligible", reason: "transport-not-first-party" });
    }
  });

  it("requires positive subscription-auth proof", () => {
    for (const subscriptionAuthProven of [
      false,
      undefined,
      null,
      0,
      1,
      "true",
      "yes",
      SECRET_SHAPED_INPUT,
      {},
    ]) {
      expect(
        classifyCodexFastEligibility({
          ...eligibleInput(),
          subscriptionAuthProven,
        }),
      ).toEqual({ kind: "ineligible", reason: "auth-not-subscription" });
    }
  });

  it("fails closed on an observed or unreadable collision flag", () => {
    for (const collisionObserved of [true, "true", 1, {}, null]) {
      expect(
        classifyCodexFastEligibility({
          ...eligibleInput(),
          collisionObserved,
        }),
      ).toEqual({ kind: "ineligible", reason: "request-collision" });
    }
    for (const collisionObserved of [false, undefined]) {
      expect(
        classifyCodexFastEligibility({
          ...eligibleInput(),
          collisionObserved,
        }),
      ).toEqual({ kind: "eligible", ruleId: ELIGIBLE_RULE_ID });
    }
  });

  it("never echoes secret-shaped or raw request values", () => {
    const hostile: CodexFastEligibilityInput & Record<string, unknown> = {
      providerId: SECRET_SHAPED_INPUT,
      fast: true,
      modelId: SECRET_SHAPED_INPUT,
      ownerModelId: SECRET_SHAPED_INPUT,
      baseUrl: `https://gateway.example.com/${SECRET_SHAPED_INPUT}`,
      subscriptionAuthProven: SECRET_SHAPED_INPUT,
      collisionObserved: SECRET_SHAPED_INPUT,
      accountId: SECRET_SHAPED_INPUT,
      payload: { service_tier: SECRET_SHAPED_INPUT },
    };
    const serialized = JSON.stringify(classifyCodexFastEligibility(hostile));
    expect(serialized).not.toContain(SECRET_SHAPED_INPUT);
    expect(serialized).not.toContain("sk-proj");
    expect(serialized).not.toContain("gateway.example.com");
    expect(serialized).toBe(
      JSON.stringify({ kind: "ineligible", reason: "provider-not-codex" }),
    );
  });

  it("reports only bounded reason tokens for every ineligible verdict", () => {
    const inputs: readonly CodexFastEligibilityInput[] = [
      { ...eligibleInput(), providerId: "openai" },
      { ...eligibleInput(), modelId: "gpt\r\n", ownerModelId: "gpt\r\n" },
      { ...eligibleInput(), modelId: "gpt-4o", ownerModelId: "gpt-4o" },
      { ...eligibleInput(), ownerModelId: "gpt-5.4" },
      { ...eligibleInput(), baseUrl: "http://localhost:17399" },
      { ...eligibleInput(), subscriptionAuthProven: false },
      { ...eligibleInput(), collisionObserved: true },
    ];
    for (const input of inputs) {
      const verdict = classifyCodexFastEligibility(input);
      expect(verdict.kind).toBe("ineligible");
      if (verdict.kind === "ineligible") {
        expect(CODEX_INELIGIBLE_REASONS).toContain(verdict.reason);
      }
      expect(Object.keys(verdict).sort()).toEqual(["kind", "reason"]);
    }
  });
});

describe("module purity", () => {
  it("imports nothing at all, so no pi-ai, engine, Node, or Bun module can enter", async () => {
    const source = await Bun.file(
      new URL("../codex-fast/routing.ts", import.meta.url),
    ).text();
    expect(source).not.toMatch(/^\s*import\b/m);
    expect(source).not.toMatch(/\brequire\s*\(/);
    expect(source).not.toMatch(/\bimport\s*\(/);
    for (const forbidden of [
      "@earendil-works/pi-ai",
      "@earendil-works/pi-coding-agent",
      "@weaveio/weave-engine",
      "node:",
      "bun:",
    ]) {
      expect(source).not.toContain(forbidden);
    }
  });
});
