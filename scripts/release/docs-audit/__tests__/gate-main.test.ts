import { describe, expect, test } from "bun:test";
import type { DocsAuditGateInputRecord } from "../gate-main.js";
import {
  aiStatusFromJob,
  buildPrimaryGateInput,
  evaluateDocsAuditGate,
  followUpStatusFromJob,
} from "../gate-main.js";
import {
  AUDITED_SHA,
  DETERMINISTIC_DIGEST,
  gateInput,
  hardFinding,
  OTHER_SHA,
  styleWarning,
} from "./fixtures/gate-cases.js";

type GateInputOverrides = {
  publicImpact?: Partial<DocsAuditGateInputRecord["publicImpact"]>;
  deterministic?: Partial<DocsAuditGateInputRecord["deterministic"]>;
  ai?: Partial<DocsAuditGateInputRecord["ai"]>;
  followUp?: Partial<DocsAuditGateInputRecord["followUp"]>;
};

function terminalInput(
  overrides: GateInputOverrides = {},
): DocsAuditGateInputRecord {
  const base = gateInput();
  const publicImpact = { ...base.publicImpact, ...overrides.publicImpact };
  const deterministic = {
    ...base.deterministic,
    ...overrides.deterministic,
  };
  const ai = { ...base.ai, ...overrides.ai };
  const followUp = { ...base.followUp, ...overrides.followUp };
  return {
    schemaVersion: 1,
    publicImpact,
    deterministic,
    ai: {
      auditedSha: ai.auditedSha,
      status: ai.status,
      ...(ai.digest === undefined ? {} : { digest: ai.digest }),
      findings: [...(ai.findings ?? [])],
    },
    followUp,
  };
}

describe("docs-audit terminal gate", () => {
  test("returns a successful not-required result for no public impact", () => {
    const result = evaluateDocsAuditGate(
      terminalInput({
        publicImpact: { auditedSha: AUDITED_SHA, classification: "no-impact" },
        deterministic: {
          auditedSha: AUDITED_SHA,
          digest: DETERMINISTIC_DIGEST,
          passed: false,
        },
        ai: { auditedSha: AUDITED_SHA, status: "missing", findings: [] },
        followUp: { auditedSha: AUDITED_SHA, status: "awaiting" },
      }),
    );

    expect(result.isOk()).toBe(true);
    if (result.isErr()) return;
    expect(result.value).toMatchObject({
      name: "docs-audit",
      conclusion: "success",
      status: "not-required",
      warnings: 0,
    });
  });

  test("passes an affected trusted result", () => {
    const result = evaluateDocsAuditGate(terminalInput());

    expect(result.isOk()).toBe(true);
    if (result.isErr()) return;
    expect(result.value).toMatchObject({
      name: "docs-audit",
      conclusion: "success",
      status: "pass",
    });
  });

  test("fails on a hard AI finding", () => {
    const result = evaluateDocsAuditGate(
      terminalInput({ ai: { findings: [hardFinding()] } }),
    );

    expect(result.isOk()).toBe(true);
    if (result.isErr()) return;
    expect(result.value).toMatchObject({
      conclusion: "failure",
      status: "fail",
      errorType: "DocsAuditHardFinding",
    });
  });

  test("passes with style warnings and reports their count", () => {
    const result = evaluateDocsAuditGate(
      terminalInput({ ai: { findings: [styleWarning()] } }),
    );

    expect(result.isOk()).toBe(true);
    if (result.isErr()) return;
    expect(result.value).toMatchObject({
      conclusion: "success",
      status: "pass",
      warnings: 1,
    });
  });

  test.each([
    "missing",
    "skipped",
    "cancelled",
    "unavailable",
  ] as const)("fails when the affected trusted AI job is %s", (status) => {
    const result = evaluateDocsAuditGate(
      terminalInput({ ai: { status, digest: undefined, findings: [] } }),
    );

    expect(result.isOk()).toBe(true);
    if (result.isErr()) return;
    expect(result.value).toMatchObject({
      conclusion: "failure",
      status: "fail",
      errorType: "DocsAuditMissingRequiredAiResult",
    });
  });

  test("fails when the deterministic job fails", () => {
    const result = evaluateDocsAuditGate(
      terminalInput({ deterministic: { passed: false } }),
    );

    expect(result.isOk()).toBe(true);
    if (result.isErr()) return;
    expect(result.value).toMatchObject({
      conclusion: "failure",
      status: "fail",
      errorType: "DocsAuditDeterministicFailed",
    });
  });

  test("fails an affected fork while its follow-up is awaiting", () => {
    const result = evaluateDocsAuditGate(
      terminalInput({
        ai: { status: "submitted" },
        followUp: { status: "awaiting" },
      }),
    );

    expect(result.isOk()).toBe(true);
    if (result.isErr()) return;
    expect(result.value).toMatchObject({
      conclusion: "failure",
      status: "fail",
      errorType: "DocsAuditFollowUpFailed",
    });
  });

  test("fails a failed fork follow-up", () => {
    const result = evaluateDocsAuditGate(
      terminalInput({
        ai: { status: "submitted" },
        followUp: { status: "failed" },
      }),
    );

    expect(result.isOk()).toBe(true);
    if (result.isErr()) return;
    expect(result.value.errorType).toBe("DocsAuditFollowUpFailed");
  });

  test("fails mixed SHA input", () => {
    const result = evaluateDocsAuditGate(
      terminalInput({ ai: { auditedSha: OTHER_SHA } }),
    );

    expect(result.isOk()).toBe(true);
    if (result.isErr()) return;
    expect(result.value.errorType).toBe("DocsAuditShaMismatch");
  });

  test("rejects hostile descriptor input before schema access", () => {
    const hostile: Record<string, unknown> = {};
    Object.defineProperty(hostile, "publicImpact", {
      enumerable: true,
      get: () => {
        throw new Error("getter executed");
      },
    });
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;

    expect(evaluateDocsAuditGate(hostile).isErr()).toBe(true);
    expect(evaluateDocsAuditGate(cycle).isErr()).toBe(true);
  });

  test("maps conditional job outcomes to closed gate statuses", () => {
    expect(aiStatusFromJob("success", true)).toBe("submitted");
    expect(aiStatusFromJob("skipped", false)).toBe("skipped");
    expect(aiStatusFromJob("cancelled", false)).toBe("cancelled");
    expect(aiStatusFromJob(undefined, false)).toBe("missing");
    expect(followUpStatusFromJob("success", true)).toBe("passed");
    expect(followUpStatusFromJob("skipped", false)).toBe("awaiting");
    expect(followUpStatusFromJob("cancelled", false)).toBe("failed");
  });

  test("builds a failing input when the required AI artifact is absent", () => {
    const result = buildPrimaryGateInput({
      auditedSha: AUDITED_SHA,
      classification: "public-impact",
      deterministic: {
        auditedSha: AUDITED_SHA,
        digest: DETERMINISTIC_DIGEST,
        passed: true,
      },
      aiJobResult: "skipped",
      aiArtifactPresent: false,
    });

    expect(result.isOk()).toBe(true);
    if (result.isErr()) return;
    expect(result.value.ai.status).toBe("skipped");
  });
});
