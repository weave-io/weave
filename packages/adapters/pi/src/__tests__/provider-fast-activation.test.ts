import { describe, expect, it } from "bun:test";
import { PROVIDER_FAST_ACTIVATION_STATUSES } from "@weaveio/weave-engine";
import {
  CODEX_FAST_REASONS,
  type CodexFastSnapshot,
  createCodexFastAttempt,
} from "../codex-fast/attempt.js";
import {
  type CodexFastEligibility,
  classifyCodexFastEligibility,
} from "../codex-fast/routing.js";
import {
  classifyProviderFastIntent,
  isProviderFastRuleId,
  PROVIDER_FAST_DEGRADED_SNAPSHOT,
  PROVIDER_FAST_EVIDENCE_KINDS,
  PROVIDER_FAST_EVIDENCE_OUTCOMES,
  PROVIDER_FAST_REASONS,
  PROVIDER_FAST_RULE_IDS,
  PROVIDER_FAST_STATES,
  PROVIDER_FAST_UNSUPPORTED_REASON,
  PROVIDER_FAST_UNSUPPORTED_SNAPSHOT,
  type ProviderFastReason,
  projectCodexFastSnapshot,
  recomputeProviderFastAfterAppliedModel,
} from "../provider-fast-activation.js";

const SECRET_SHAPED_INPUT = "sk-proj-fast-secret-value-DO-NOT-ECHO-9f3c2a1b";

const ELIGIBLE_MODEL_ID = "gpt-5.6-luna";
const ELIGIBLE_RULE_ID = "codex-sub-05";

function eligibility(
  overrides: Record<string, unknown> = {},
): CodexFastEligibility {
  return classifyCodexFastEligibility({
    providerId: "openai-codex",
    fast: true,
    modelId: ELIGIBLE_MODEL_ID,
    ownerModelId: ELIGIBLE_MODEL_ID,
    baseUrl: undefined,
    subscriptionAuthProven: true,
    collisionObserved: false,
    ...overrides,
  });
}

/** Drive one eligible call up to the point both routing parts landed. */
function requestedAttempt(): {
  attempt: ReturnType<typeof createCodexFastAttempt>;
  sequence: number;
} {
  const attempt = createCodexFastAttempt(eligibility());
  attempt.resolvePayload("priority-set");
  const opened = attempt.beginFetchAttempt();
  if (opened.kind !== "opened") {
    throw new Error("expected an opened attempt");
  }
  attempt.activateHeaders({ originator: true, routingHint: true });
  return { attempt, sequence: opened.attempt };
}

function forged(overrides: Record<string, unknown>): CodexFastSnapshot {
  return {
    state: "not-confirmed",
    reason: "none",
    ruleId: ELIGIBLE_RULE_ID,
    collision: false,
    attemptCount: 1,
    attemptsCapped: false,
    evidenceKind: "openai-service-tier",
    evidenceOutcome: "standard",
    terminal: true,
    ...overrides,
  } as CodexFastSnapshot;
}

describe("provider-fast contract vocabulary", () => {
  it("covers exactly the engine's five neutral activation statuses", () => {
    // The engine owns this vocabulary. The adapter may only report a token
    // the engine already knows, and it must be able to report all of them.
    expect([...PROVIDER_FAST_STATES]).toEqual([
      ...PROVIDER_FAST_ACTIVATION_STATUSES,
    ]);
    expect([...PROVIDER_FAST_STATES]).toEqual([
      "declared",
      "requested",
      "applied",
      "not-confirmed",
      "unsupported",
    ]);
  });

  it("keeps every enum inside the normative sanitized-evidence contract", () => {
    expect([...PROVIDER_FAST_EVIDENCE_KINDS]).toEqual([
      "none",
      "openai-service-tier",
      "anthropic-usage-speed",
    ]);
    expect([...PROVIDER_FAST_EVIDENCE_OUTCOMES]).toEqual([
      "confirmed",
      "standard",
      "absent",
      "ambiguous",
      "inaccessible",
    ]);
    expect([...PROVIDER_FAST_REASONS]).toEqual([
      "none",
      "harness-seam-unavailable",
      "provider-not-codex",
      "model-id-unsafe",
      "model-not-allowed",
      "model-owner-mismatch",
      "transport-not-first-party",
      "auth-not-subscription",
      "request-collision",
      "response-proof-unavailable",
      "attempt-uncorrelated",
      "canceled",
      "timed-out",
      "wrapper-degraded",
    ]);
  });

  it("covers every reason the codex mapping can terminate with", () => {
    for (const reason of CODEX_FAST_REASONS) {
      expect(PROVIDER_FAST_REASONS).toContain(reason);
    }
    // The hook seam's own reason is part of the same bounded set.
    expect(PROVIDER_FAST_REASONS).toContain(PROVIDER_FAST_UNSUPPORTED_REASON);
    expect(PROVIDER_FAST_UNSUPPORTED_REASON).toBe("harness-seam-unavailable");
  });

  it("exposes allowlist rule IDs as the only model-adjacent tokens", () => {
    expect(PROVIDER_FAST_RULE_IDS.length).toBeGreaterThan(0);
    for (const ruleId of PROVIDER_FAST_RULE_IDS) {
      expect(ruleId).toMatch(/^codex-sub-\d{2}$/);
      expect(isProviderFastRuleId(ruleId)).toBe(true);
    }
    expect(new Set(PROVIDER_FAST_RULE_IDS).size).toBe(
      PROVIDER_FAST_RULE_IDS.length,
    );
    expect(isProviderFastRuleId("none")).toBe(false);
    expect(isProviderFastRuleId(ELIGIBLE_MODEL_ID)).toBe(false);
    expect(isProviderFastRuleId(SECRET_SHAPED_INPUT)).toBe(false);
    expect(isProviderFastRuleId(undefined)).toBe(false);
  });

  it("keeps provider strings, model text, URLs and headers out of the vocabulary", () => {
    const vocabulary = JSON.stringify([
      PROVIDER_FAST_STATES,
      PROVIDER_FAST_REASONS,
      PROVIDER_FAST_EVIDENCE_KINDS,
      PROVIDER_FAST_EVIDENCE_OUTCOMES,
      PROVIDER_FAST_RULE_IDS,
    ]);
    for (const forbidden of [
      "gpt-",
      "service_tier",
      "priority",
      "originator",
      "codex_cli_rs",
      "x-codex-routing-hint",
      "chatgpt.com",
      "https://",
      "Bearer",
      "anthropic-beta",
    ]) {
      expect(vocabulary).not.toContain(forbidden);
    }
  });

  it("reports the hook-seam outcome with no evidence and a frozen snapshot", () => {
    expect(PROVIDER_FAST_UNSUPPORTED_SNAPSHOT).toEqual({
      state: "unsupported",
      evidenceKind: "none",
      evidenceOutcome: "absent",
      reason: PROVIDER_FAST_UNSUPPORTED_REASON,
    });
    expect(Object.isFrozen(PROVIDER_FAST_UNSUPPORTED_SNAPSHOT)).toBe(true);
    // No mapping matched, so no model-adjacent token exists to report.
    expect(PROVIDER_FAST_UNSUPPORTED_SNAPSHOT.ruleId).toBeUndefined();
    expect(JSON.stringify(PROVIDER_FAST_UNSUPPORTED_SNAPSHOT)).not.toContain(
      "applied",
    );
  });

  it("degrades to the same answer as no mapping, never a better one", () => {
    expect(PROVIDER_FAST_DEGRADED_SNAPSHOT).toEqual({
      state: "unsupported",
      evidenceKind: "none",
      evidenceOutcome: "absent",
      reason: "wrapper-degraded",
    });
    expect(Object.isFrozen(PROVIDER_FAST_DEGRADED_SNAPSHOT)).toBe(true);
  });
});

describe("classifyProviderFastIntent", () => {
  it("returns no-intent when fast is omitted", () => {
    expect(classifyProviderFastIntent({})).toEqual({ kind: "no-intent" });
    expect(classifyProviderFastIntent({ name: "loom" })).toEqual({
      kind: "no-intent",
    });
    expect(classifyProviderFastIntent(undefined)).toEqual({
      kind: "no-intent",
    });
    expect(classifyProviderFastIntent(null)).toEqual({ kind: "no-intent" });
  });

  it("stays the no-mapping fallback: declared intent is terminal unsupported", () => {
    // Widening the vocabulary does not widen this seam. Without an eligible
    // codex attempt there is no transport or response proof at all.
    expect(classifyProviderFastIntent({ fast: true })).toEqual({
      kind: "unsupported",
      snapshot: PROVIDER_FAST_UNSUPPORTED_SNAPSHOT,
    });
    expect(
      classifyProviderFastIntent({ fast: true, model: ELIGIBLE_MODEL_ID }),
    ).toEqual({
      kind: "unsupported",
      snapshot: PROVIDER_FAST_UNSUPPORTED_SNAPSHOT,
    });
  });

  it("does not accept a truthy non-literal fast value", () => {
    for (const value of [1, "true", "fast", {}, [], Symbol.iterator]) {
      expect(
        classifyProviderFastIntent({ fast: value as unknown as true }),
      ).toEqual({ kind: "no-intent" });
    }
    expect(classifyProviderFastIntent({ fast: false })).toEqual({
      kind: "no-intent",
    });
  });

  it("ignores inherited intent and never runs an accessor", () => {
    const inherited = Object.create({ fast: true }) as object;
    expect(classifyProviderFastIntent(inherited)).toEqual({
      kind: "no-intent",
    });

    let reads = 0;
    const accessor = {};
    Object.defineProperty(accessor, "fast", {
      enumerable: true,
      configurable: true,
      get: () => {
        reads += 1;
        return true;
      },
    });
    expect(classifyProviderFastIntent(accessor)).toEqual({
      kind: "no-intent",
    });
    expect(reads).toBe(0);
  });

  it("keeps hostile and secret-shaped owner fields out of the result", () => {
    const owner = {
      fast: true as const,
      apiKey: SECRET_SHAPED_INPUT,
      provider: "openai",
      model: "gpt-5.6-sol",
      baseUrl: "https://gateway.example.com/openai",
    };
    const serialized = JSON.stringify(classifyProviderFastIntent(owner));
    expect(serialized).not.toContain(SECRET_SHAPED_INPUT);
    expect(serialized).not.toContain("sk-proj");
    expect(serialized).not.toContain("openai");
    expect(serialized).not.toContain("gpt-5.6-sol");
    expect(serialized).not.toContain("gateway.example.com");
    expect(serialized).not.toContain("applied");
  });

  it("returns the same frozen result for repeated calls", () => {
    const first = classifyProviderFastIntent({ fast: true });
    const second = classifyProviderFastIntent({ fast: true });
    expect(first).toBe(second);
    expect(Object.isFrozen(first)).toBe(true);
    expect(classifyProviderFastIntent({})).toBe(classifyProviderFastIntent({}));
  });

  it("exports no request mutation surface at all", async () => {
    const moduleExports = (await import(
      "../provider-fast-activation.js"
    )) as Record<string, unknown>;
    const exported = Object.keys(moduleExports).join(" ");
    expect(exported).not.toContain("apply");
    expect(exported).not.toContain("Header");
    expect(exported).not.toContain("Payload");
    expect(exported).not.toContain("Coordinator");
    expect(exported).not.toContain("Tracker");
    const serialized = JSON.stringify(moduleExports);
    expect(serialized).not.toContain("service_tier");
    expect(serialized).not.toContain("anthropic-beta");
    expect(serialized).not.toContain("codex_cli_rs");
    expect(serialized).not.toContain("chatgpt.com");
    expect(serialized).not.toContain(ELIGIBLE_MODEL_ID);
  });
});

describe("recomputeProviderFastAfterAppliedModel", () => {
  it("recomputes fallback truth from the new owner and drops the prior applied claim", () => {
    const { attempt, sequence } = requestedAttempt();
    attempt.recordEvidence(sequence, "confirmed");
    const prior = projectCodexFastSnapshot(attempt.terminalize());
    expect(prior).toMatchObject({
      state: "applied",
      ruleId: ELIGIBLE_RULE_ID,
    });

    const recomputed = recomputeProviderFastAfterAppliedModel({
      fast: true,
      provider: "anthropic",
      model: "claude-sonnet-4-5",
    });
    expect(recomputed).toEqual({
      kind: "unsupported",
      snapshot: PROVIDER_FAST_UNSUPPORTED_SNAPSHOT,
    });
    const serialized = JSON.stringify(recomputed);
    expect(serialized).not.toContain("applied");
    expect(serialized).not.toContain(ELIGIBLE_MODEL_ID);
    expect(serialized).not.toContain(ELIGIBLE_RULE_ID);
    expect(serialized).not.toContain("openai-codex");
  });

  it("returns no-intent when the applied fallback owner omits fast intent", () => {
    expect(
      recomputeProviderFastAfterAppliedModel({
        provider: "anthropic",
        model: "claude-sonnet-4-5",
      }),
    ).toEqual({ kind: "no-intent" });
  });
});

describe("projectCodexFastSnapshot", () => {
  it("emits no state when the mapping produced none", () => {
    const noIntent = createCodexFastAttempt(eligibility({ fast: false }));
    expect(noIntent.terminalize()).toBeUndefined();
    expect(projectCodexFastSnapshot(noIntent.terminalize())).toBeUndefined();
    expect(projectCodexFastSnapshot(undefined)).toBeUndefined();
  });

  it("maps a confirmed attempt to applied with its exact evidence", () => {
    const { attempt, sequence } = requestedAttempt();
    attempt.recordEvidence(sequence, "confirmed");
    const terminal = attempt.terminalize();
    expect(terminal?.state).toBe("applied");

    const projected = projectCodexFastSnapshot(terminal);
    expect(projected).toEqual({
      state: "applied",
      evidenceKind: "openai-service-tier",
      evidenceOutcome: "confirmed",
      reason: "none",
      ruleId: ELIGIBLE_RULE_ID,
    });
    expect(Object.isFrozen(projected)).toBe(true);
  });

  it("maps a standard-tier attempt to not-confirmed, never applied", () => {
    const { attempt, sequence } = requestedAttempt();
    attempt.recordEvidence(sequence, "standard");
    const projected = projectCodexFastSnapshot(attempt.terminalize());
    expect(projected).toEqual({
      state: "not-confirmed",
      evidenceKind: "openai-service-tier",
      evidenceOutcome: "standard",
      reason: "none",
      ruleId: ELIGIBLE_RULE_ID,
    });
  });

  it("maps an unread response proof to not-confirmed with its bounded reason", () => {
    const { attempt } = requestedAttempt();
    const projected = projectCodexFastSnapshot(attempt.terminalize());
    expect(projected).toEqual({
      state: "not-confirmed",
      evidenceKind: "openai-service-tier",
      evidenceOutcome: "absent",
      reason: "response-proof-unavailable",
      ruleId: ELIGIBLE_RULE_ID,
    });
  });

  it("carries the live requested state without pretending it is applied", () => {
    const { attempt, sequence } = requestedAttempt();
    attempt.recordEvidence(sequence, "confirmed");
    const live = attempt.snapshot();
    expect(live?.terminal).toBe(false);

    const projected = projectCodexFastSnapshot(live);
    expect(projected?.state).toBe("requested");
    expect(projected?.ruleId).toBe(ELIGIBLE_RULE_ID);
    expect(JSON.stringify(projected)).not.toContain("applied");
  });

  it("maps each ineligible verdict to unsupported with no rule ID", () => {
    const cases: ReadonlyArray<
      readonly [Record<string, unknown>, ProviderFastReason]
    > = [
      [{ modelId: "o3-mini", ownerModelId: "o3-mini" }, "model-not-allowed"],
      [{ providerId: "openai" }, "provider-not-codex"],
      [{ ownerModelId: "gpt-5.4" }, "model-owner-mismatch"],
      [
        { baseUrl: "https://chatgpt.com.evil.tld/backend-api" },
        "transport-not-first-party",
      ],
      [{ subscriptionAuthProven: false }, "auth-not-subscription"],
      [{ collisionObserved: true }, "request-collision"],
      [{ modelId: "gpt-5.6-luna\r\nx: y" }, "model-id-unsafe"],
    ];
    for (const [overrides, reason] of cases) {
      const attempt = createCodexFastAttempt(eligibility(overrides));
      const projected = projectCodexFastSnapshot(attempt.terminalize());
      expect(projected).toEqual({
        state: "unsupported",
        evidenceKind: "none",
        evidenceOutcome: "absent",
        reason,
      });
      expect(projected?.ruleId).toBeUndefined();
    }
  });

  it("maps a canceled call before any request to unsupported", () => {
    const attempt = createCodexFastAttempt(eligibility());
    attempt.resolvePayload("priority-set");
    attempt.cancel();
    const projected = projectCodexFastSnapshot(attempt.terminalize());
    expect(projected?.state).toBe("unsupported");
    expect(projected?.reason).toBe("canceled");
  });

  it("never upgrades a forged applied state past its own evidence", () => {
    for (const overrides of [
      { state: "applied", evidenceOutcome: "absent" },
      { state: "applied", evidenceOutcome: "standard" },
      { state: "applied", evidenceKind: "none", evidenceOutcome: "confirmed" },
      {
        state: "applied",
        evidenceKind: "anthropic-usage-speed",
        evidenceOutcome: "confirmed",
      },
    ]) {
      expect(projectCodexFastSnapshot(forged(overrides))).toEqual(
        PROVIDER_FAST_DEGRADED_SNAPSHOT,
      );
    }
  });

  it("rejects an attempt state that names no allowlist rule", () => {
    for (const state of ["requested", "applied", "not-confirmed"]) {
      expect(
        projectCodexFastSnapshot(
          forged({
            state,
            ruleId: "none",
            evidenceOutcome: state === "applied" ? "confirmed" : "standard",
          }),
        ),
      ).toEqual(PROVIDER_FAST_DEGRADED_SNAPSHOT);
    }
  });

  it("rejects unknown tokens and secret-shaped values without echoing them", () => {
    const rejected = [
      forged({ state: "active" }),
      forged({ state: SECRET_SHAPED_INPUT }),
      forged({ reason: "response-body-evidence-unavailable" }),
      forged({ reason: SECRET_SHAPED_INPUT }),
      forged({ evidenceKind: "response-status" }),
      forged({ evidenceOutcome: "unavailable" }),
      forged({ ruleId: "codex-sub-99" }),
      forged({ ruleId: ELIGIBLE_MODEL_ID }),
      forged({ ruleId: SECRET_SHAPED_INPUT }),
    ];
    for (const snapshot of rejected) {
      const projected = projectCodexFastSnapshot(snapshot);
      expect(projected).toEqual(PROVIDER_FAST_DEGRADED_SNAPSHOT);
      const serialized = JSON.stringify(projected);
      expect(serialized).not.toContain(SECRET_SHAPED_INPUT);
      expect(serialized).not.toContain("sk-proj");
      expect(serialized).not.toContain(ELIGIBLE_MODEL_ID);
    }
  });

  it("degrades instead of throwing on a hostile snapshot object", () => {
    const hostile = {} as Record<string, unknown>;
    Object.defineProperty(hostile, "state", {
      enumerable: true,
      get: () => {
        throw new Error(SECRET_SHAPED_INPUT);
      },
    });
    const projected = projectCodexFastSnapshot(
      hostile as unknown as CodexFastSnapshot,
    );
    expect(projected).toEqual(PROVIDER_FAST_DEGRADED_SNAPSHOT);
    expect(JSON.stringify(projected)).not.toContain(SECRET_SHAPED_INPUT);
  });

  it("drops every field outside the public snapshot shape", () => {
    const projected = projectCodexFastSnapshot(
      forged({
        collision: true,
        attemptCount: 7,
        attemptsCapped: true,
        apiKey: SECRET_SHAPED_INPUT,
        model: "gpt-5.6-sol",
        baseUrl: "https://chatgpt.com/backend-api",
      }),
    );
    expect(Object.keys(projected ?? {}).sort()).toEqual([
      "evidenceKind",
      "evidenceOutcome",
      "reason",
      "ruleId",
      "state",
    ]);
    const serialized = JSON.stringify(projected);
    expect(serialized).not.toContain(SECRET_SHAPED_INPUT);
    expect(serialized).not.toContain("gpt-5.6-sol");
    expect(serialized).not.toContain("chatgpt.com");
  });
});
