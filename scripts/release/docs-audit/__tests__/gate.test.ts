import { describe, expect, test } from "bun:test";
import {
  combineDocsAuditGate,
  docsAuditOutcomeDigest,
  parseDocsAuditOutcome,
} from "../gate.js";
import {
  AUDITED_SHA,
  DETERMINISTIC_DIGEST,
  gateInput,
  hardFinding,
  OTHER_SHA,
  styleWarning,
} from "./fixtures/gate-cases.js";

describe("docs-audit gate", () => {
  test("returns typed not-required success when there is no public impact", () => {
    const result = combineDocsAuditGate(
      gateInput({
        publicImpact: { classification: "no-impact" },
        deterministic: { passed: false },
        ai: { status: "missing" },
        followUp: { status: "awaiting" },
      }),
    );
    if (result.isErr()) throw new Error(`unexpected ${result.error.type}`);
    expect(result.value.type).toBe("not-required");
    expect(result.value.outcome).toEqual({
      auditedSha: AUDITED_SHA,
      deterministicResultDigest: DETERMINISTIC_DIGEST,
      aiResultDigestOrStatus: "not-required",
    });
  });

  test("passes a required audit with style warnings only", () => {
    const result = combineDocsAuditGate(
      gateInput({ ai: { findings: [styleWarning()] } }),
    );
    if (result.isErr()) throw new Error(`unexpected ${result.error.type}`);
    expect(result.value.type).toBe("pass");
    if (result.value.type !== "pass") return;
    expect(result.value.warnings).toEqual([styleWarning()]);
    expect(result.value.outcome.aiResultDigestOrStatus).toMatch(/^sha256:/);
  });

  test("fails on a hard finding", () => {
    const result = combineDocsAuditGate(
      gateInput({ ai: { findings: [hardFinding()] } }),
    );
    expect(result.isErr()).toBe(true);
    if (result.isOk()) return;
    expect(result.error.type).toBe("DocsAuditHardFinding");
  });

  test.each([
    "missing",
    "skipped",
    "cancelled",
    "unavailable",
    "not-required",
  ] as const)("fails when the required AI result is %s", (status) => {
    const result = combineDocsAuditGate(
      gateInput({ ai: { status, digest: undefined, findings: [] } }),
    );
    expect(result.isErr()).toBe(true);
    if (result.isOk()) return;
    expect(result.error.type).toBe("DocsAuditMissingRequiredAiResult");
  });

  test("fails when the deterministic checker failed", () => {
    const result = combineDocsAuditGate(
      gateInput({ deterministic: { passed: false } }),
    );
    expect(result.isErr()).toBe(true);
    if (result.isOk()) return;
    expect(result.error.type).toBe("DocsAuditDeterministicFailed");
  });

  test.each(["awaiting", "failed"] as const)(
    "fails when fork follow-up is %s",
    (status) => {
      const result = combineDocsAuditGate(
        gateInput({ followUp: { status } }),
      );
      expect(result.isErr()).toBe(true);
      if (result.isOk()) return;
      expect(result.error.type).toBe("DocsAuditFollowUpFailed");
    },
  );

  test("combines same-SHA inputs", () => {
    const result = combineDocsAuditGate(gateInput());
    if (result.isErr()) throw new Error(`unexpected ${result.error.type}`);
    expect(result.value.outcome.auditedSha).toBe(AUDITED_SHA);
  });

  test("fails typed DocsAuditShaMismatch on mixed SHAs", () => {
    const result = combineDocsAuditGate(
      gateInput({ ai: { auditedSha: OTHER_SHA } }),
    );
    expect(result.isErr()).toBe(true);
    if (result.isOk()) return;
    expect(result.error.type).toBe("DocsAuditShaMismatch");
  });

  test("fails typed DocsAuditShaMismatch on a missing SHA", () => {
    const result = combineDocsAuditGate(
      gateInput({ followUp: { auditedSha: "" } }),
    );
    expect(result.isErr()).toBe(true);
    if (result.isOk()) return;
    expect(result.error.type).toBe("DocsAuditShaMismatch");
  });

  test("round-trips the digestable outcome record", () => {
    const result = combineDocsAuditGate(gateInput());
    if (result.isErr()) throw new Error(`unexpected ${result.error.type}`);
    const parsed = parseDocsAuditOutcome(result.value.outcome);
    if (parsed.isErr()) throw new Error(parsed.error.type);
    expect(parsed.value).toEqual(result.value.outcome);
    expect(docsAuditOutcomeDigest(parsed.value)).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(docsAuditOutcomeDigest(parsed.value)).toBe(
      docsAuditOutcomeDigest(result.value.outcome),
    );
  });
});
