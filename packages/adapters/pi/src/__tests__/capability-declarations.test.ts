import { describe, expect, it } from "bun:test";
import {
  AdapterCapabilityContractSchema,
  ALL_CAPABILITY_IDS,
  type CapabilityEntry,
  type CapabilityProbeResult,
  type CapabilityReadiness,
  effectiveProviderFastReadiness,
  evaluateCoreReadinessProfile,
  evaluateEffectiveCapabilities,
  OPTIONAL_CAPABILITIES,
  PROVIDER_FAST_ACTIVATION_ID,
  PROVIDER_FAST_ACTIVATION_STATUSES,
  type ProviderFastActivationStatus,
  providerFastActivationState,
  REQUIRED_CAPABILITIES,
  readinessForProviderFastStatus,
} from "@weaveio/weave-engine";
import { PI_ADAPTER_CAPABILITY_CONTRACT } from "../capability-declarations.js";
import { createCodexFastAttempt } from "../codex-fast/attempt.js";
import { classifyCodexFastEligibility } from "../codex-fast/routing.js";
import { projectCodexFastSnapshot } from "../provider-fast-activation.js";

/** Never echoed by a declaration, a note, or a remediation hint. */
const SECRET_SHAPED_INPUT = "sk-proj-fast-secret-value-DO-NOT-ECHO-9f3c2a1b";

const ELIGIBLE_MODEL_ID = "gpt-5.6-luna";

function fastCapability(): CapabilityEntry | undefined {
  return PI_ADAPTER_CAPABILITY_CONTRACT.capabilities.find(
    (entry) => entry.id === PROVIDER_FAST_ACTIVATION_ID,
  );
}

/** One eligibility verdict for the codex mapping, tweakable per case. */
function eligibility(overrides: Record<string, unknown> = {}) {
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

/**
 * Drives one real eligible attempt through the same modules the wrapped
 * provider uses, so the runtime states this test feeds the engine are the
 * states a live call actually produces rather than hand-written tokens.
 */
function liveEligibleAttempt(): {
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

/** The engine-facing runtime state of one finished eligible attempt. */
function liveTerminalState(
  outcome: "confirmed" | "standard",
): ProviderFastActivationStatus | undefined {
  const { attempt, sequence } = liveEligibleAttempt();
  attempt.recordEvidence(sequence, outcome);
  const projected = projectCodexFastSnapshot(attempt.terminalize());
  return providerFastActivationState({ fast: true, status: projected?.state });
}

function probeSet(
  fastStatus: CapabilityProbeResult["probeStatus"],
): CapabilityProbeResult[] {
  return ALL_CAPABILITY_IDS.map((capabilityId) => ({
    capabilityId,
    probeStatus:
      capabilityId === PROVIDER_FAST_ACTIVATION_ID ? fastStatus : "ok",
  }));
}

describe("Pi adapter capability contract", () => {
  it("parses the declared contract through the exported capability schema", () => {
    const parsed = AdapterCapabilityContractSchema.safeParse(
      PI_ADAPTER_CAPABILITY_CONTRACT,
    );
    expect(parsed.success).toBe(true);
  });

  it("declares provider-fast-activation as a degraded ceiling scoped to the codex subscription mapping", () => {
    const capability = fastCapability();
    const notes = capability?.notes ?? "";
    const serialized = JSON.stringify(capability);

    // One mapping, capped below `applied` on the pinned host: `native` would
    // claim an outcome no response has ever proven here, and `unsupported`
    // would deny a request the wrapped provider really sends.
    expect(capability?.readiness).toBe("degraded");
    expect(capability?.readiness).not.toBe("native");
    expect(capability?.readiness).not.toBe("emulated");
    expect(notes).toContain("One mapping only");
    expect(notes).toContain("fast true");
    expect(notes).toContain("OpenAI Codex subscription model");
    expect(notes).toContain("wrapped codex provider");
    expect(notes).toContain("first-party subscription transport");
    expect(notes).toContain("eligibility rules");
    // The observed ceiling, named as the ceiling it is.
    expect(notes).toContain("not-confirmed");
    expect(notes).toContain("standard evidence outcome");
    expect(notes).toContain("applied needs same-attempt positive evidence");
    expect(notes).toContain("byte-identical passthrough");
    expect(capability?.remediationHint).toContain("degraded");
    expect(capability?.remediationHint).toContain("unsupported");

    // No static value can name a live attempt's state, so none is declared.
    expect(capability?.runtimeStatus).toBeUndefined();

    // The declaration stays a sanitized ceiling: no wire contract, no
    // credential shape, no endpoint, no hook name.
    for (const forbidden of [
      "service_tier",
      "originator",
      "codex_cli_rs",
      "x-codex-routing-hint",
      "chatgpt.com",
      "https://",
      "Bearer",
      "Authorization",
      "anthropic-beta",
      "before_provider_request",
      "sk-proj",
      SECRET_SHAPED_INPUT,
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("keeps the public OpenAI API and every other Pi provider unsupported", () => {
    const notes = fastCapability()?.notes ?? "";

    expect(notes).toContain(
      "The public OpenAI API and every other Pi provider stay unsupported",
    );
    expect(notes).toContain("send no acceleration control");
    expect(notes).toContain("payloads and headers stay unchanged");
    // Nothing in the declaration promises the mapping makes anything faster.
    expect(notes).not.toContain("faster");
  });

  it("lets a live codex attempt lower the declared ceiling but never raise it", () => {
    const declared: CapabilityReadiness =
      fastCapability()?.readiness ?? "unsupported";
    expect(declared).toBe("degraded");

    // No intent at all: no state, and the ceiling is untouched.
    expect(providerFastActivationState({})).toBeUndefined();
    expect(effectiveProviderFastReadiness(declared, undefined)).toBe(declared);

    // Declared intent that reached no attempt yet.
    expect(providerFastActivationState({ fast: true })).toBe("declared");

    // A real eligible attempt whose response proved standard speed: the
    // shipped ceiling on the pinned host.
    expect(liveTerminalState("standard")).toBe("not-confirmed");
    expect(effectiveProviderFastReadiness(declared, "not-confirmed")).toBe(
      "degraded",
    );

    // A real eligible attempt with same-attempt confirmed evidence still
    // cannot lift the static ceiling, even though that status maps to
    // `native` in isolation.
    expect(liveTerminalState("confirmed")).toBe("applied");
    expect(readinessForProviderFastStatus("applied")).toBe("native");
    expect(effectiveProviderFastReadiness(declared, "applied")).toBe(
      "degraded",
    );

    // The live non-terminal state of the same attempt.
    const { attempt, sequence } = liveEligibleAttempt();
    attempt.recordEvidence(sequence, "confirmed");
    const requested = providerFastActivationState({
      fast: true,
      status: projectCodexFastSnapshot(attempt.snapshot())?.state,
    });
    expect(requested).toBe("requested");
    expect(effectiveProviderFastReadiness(declared, "requested")).toBe(
      "degraded",
    );

    // An ineligible call lowers the ceiling instead.
    const ineligible = createCodexFastAttempt(
      eligibility({ baseUrl: "http://127.0.0.1:17399/backend-api" }),
    );
    const lowered = providerFastActivationState({
      fast: true,
      status: projectCodexFastSnapshot(ineligible.terminalize())?.state,
    });
    expect(lowered).toBe("unsupported");
    expect(effectiveProviderFastReadiness(declared, "unsupported")).toBe(
      "unsupported",
    );

    // No status in the vocabulary can raise this declaration.
    for (const status of PROVIDER_FAST_ACTIVATION_STATUSES) {
      const effective = effectiveProviderFastReadiness(declared, status);
      expect(["degraded", "unsupported"]).toContain(effective);
      expect(effective).not.toBe("native");
      expect(effective).not.toBe("emulated");
    }
  });

  it("keeps provider-fast-activation optional, so no state it reports changes readiness", () => {
    expect(OPTIONAL_CAPABILITIES).toContain(PROVIDER_FAST_ACTIVATION_ID);
    expect(REQUIRED_CAPABILITIES).not.toContain(PROVIDER_FAST_ACTIVATION_ID);

    // Any declared level for this one entry leaves the profile ready.
    for (const readiness of [
      "native",
      "emulated",
      "degraded",
      "unsupported",
    ] as const) {
      const result = evaluateCoreReadinessProfile({
        capabilities: PI_ADAPTER_CAPABILITY_CONTRACT.capabilities.map(
          (entry) =>
            entry.id === PROVIDER_FAST_ACTIVATION_ID
              ? { ...entry, readiness }
              : entry,
        ),
      });
      expect(result.ready).toBe(true);
      expect(
        result.failures.map((failure) => failure.capabilityId),
      ).not.toContain(PROVIDER_FAST_ACTIVATION_ID);
    }

    // And any probe outcome for it leaves health-only mode alone, lowering
    // the effective entry without ever raising it.
    for (const [probeStatus, expected] of [
      ["ok", "degraded"],
      ["degraded", "degraded"],
      ["unavailable", "unsupported"],
    ] as const) {
      const evaluation = evaluateEffectiveCapabilities(
        PI_ADAPTER_CAPABILITY_CONTRACT,
        probeSet(probeStatus),
      );
      const entry = evaluation.effectiveCapabilities.find(
        (candidate) => candidate.id === PROVIDER_FAST_ACTIVATION_ID,
      );
      expect(evaluation.healthOnlyMode).toBe(false);
      expect(evaluation.profileResult.failures).toEqual([]);
      expect(entry?.declaredReadiness).toBe("degraded");
      expect(entry?.effectiveReadiness).toBe(expected);
    }
  });
});
