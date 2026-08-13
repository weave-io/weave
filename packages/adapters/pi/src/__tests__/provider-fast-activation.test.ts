import { describe, expect, it } from "bun:test";
import {
  classifyProviderFastIntent,
  PROVIDER_FAST_EVIDENCE_KINDS,
  PROVIDER_FAST_EVIDENCE_OUTCOMES,
  PROVIDER_FAST_STATES,
  PROVIDER_FAST_UNSUPPORTED_REASON,
  PROVIDER_FAST_UNSUPPORTED_REASONS,
  PROVIDER_FAST_UNSUPPORTED_SNAPSHOT,
} from "../provider-fast-activation.js";

const SECRET_SHAPED_INPUT = "sk-proj-fast-secret-value-DO-NOT-ECHO-9f3c2a1b";

describe("provider-fast contract vocabulary", () => {
  it("keeps every enum inside the normative sanitized-evidence contract", () => {
    // The normative contract fixes these token sets. A value outside them
    // could not be persisted or rendered truthfully.
    expect(PROVIDER_FAST_EVIDENCE_KINDS).toEqual([
      "none",
      "openai-service-tier",
      "anthropic-usage-speed",
    ]);
    expect(PROVIDER_FAST_EVIDENCE_OUTCOMES).toEqual([
      "confirmed",
      "standard",
      "absent",
      "ambiguous",
      "inaccessible",
    ]);
    expect(PROVIDER_FAST_UNSUPPORTED_REASONS).toEqual([
      "harness-seam-unavailable",
    ]);
  });

  it("can reach no state other than unsupported", () => {
    expect(PROVIDER_FAST_STATES).toEqual(["unsupported"]);
    expect(PROVIDER_FAST_STATES).not.toContain("requested");
    expect(PROVIDER_FAST_STATES).not.toContain("applied");
    expect(PROVIDER_FAST_STATES).not.toContain("not-confirmed");
    expect(PROVIDER_FAST_STATES).not.toContain("declared");
  });

  it("reports the terminal outcome with no evidence and a frozen snapshot", () => {
    expect(PROVIDER_FAST_UNSUPPORTED_SNAPSHOT).toEqual({
      state: "unsupported",
      evidenceKind: "none",
      evidenceOutcome: "absent",
      reason: PROVIDER_FAST_UNSUPPORTED_REASON,
    });
    expect(Object.isFrozen(PROVIDER_FAST_UNSUPPORTED_SNAPSHOT)).toBe(true);
    expect(JSON.stringify(PROVIDER_FAST_UNSUPPORTED_SNAPSHOT)).not.toContain(
      "applied",
    );
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

  it("classifies exact fast true as the terminal unsupported outcome", () => {
    expect(classifyProviderFastIntent({ fast: true })).toEqual({
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
    expect(JSON.stringify(moduleExports)).not.toContain("service_tier");
    expect(JSON.stringify(moduleExports)).not.toContain("anthropic-beta");
  });
});
