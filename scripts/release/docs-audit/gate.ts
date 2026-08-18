/**
 * Shared docs-audit gate. Combines public-impact classification, the
 * deterministic checker, the AI result-or-status, and fork follow-up into
 * one SHA-bound terminal outcome.
 */
import { err, ok, type Result } from "neverthrow";
import { FullShaSchema } from "../model.js";
import {
  DOCS_AUDIT_AI_STATUSES,
  ReleaseDocsAuditSchema,
  type ReleaseDocsAudit,
} from "../release-plan.js";
import { docsAuditDigest } from "./deterministic.js";
import type { DocsAuditFinding } from "./policy.js";

export type DocsAuditPublicImpactClassification =
  | "public-impact"
  | "no-impact";

export type DocsAuditAiStatusInput =
  | "submitted"
  | "not-required"
  | "unavailable"
  | "skipped"
  | "cancelled"
  | "missing";

export type DocsAuditFollowUpStatus =
  | "not-applicable"
  | "passed"
  | "awaiting"
  | "failed";

export interface DocsAuditPublicImpactInput {
  readonly auditedSha: string;
  readonly classification: DocsAuditPublicImpactClassification;
}

export interface DocsAuditDeterministicInput {
  readonly auditedSha: string;
  readonly digest: string;
  readonly passed: boolean;
}

export interface DocsAuditAiInput {
  readonly auditedSha: string;
  readonly status: DocsAuditAiStatusInput;
  readonly digest?: string;
  readonly findings?: readonly DocsAuditFinding[];
}

export interface DocsAuditFollowUpInput {
  readonly auditedSha: string;
  readonly status: DocsAuditFollowUpStatus;
}

export interface DocsAuditGateInput {
  readonly publicImpact: DocsAuditPublicImpactInput;
  readonly deterministic: DocsAuditDeterministicInput;
  readonly ai: DocsAuditAiInput;
  readonly followUp: DocsAuditFollowUpInput;
}

export type DocsAuditGateSuccess =
  | {
      readonly type: "not-required";
      readonly outcome: ReleaseDocsAudit;
    }
  | {
      readonly type: "pass";
      readonly outcome: ReleaseDocsAudit;
      readonly warnings: readonly DocsAuditFinding[];
    };

export type DocsAuditGateError =
  | {
      readonly type: "DocsAuditShaMismatch";
      readonly auditedShas: readonly (string | undefined)[];
    }
  | {
      readonly type: "DocsAuditDeterministicFailed";
      readonly auditedSha: string;
      readonly deterministicResultDigest: string;
    }
  | {
      readonly type: "DocsAuditMissingRequiredAiResult";
      readonly auditedSha: string;
      readonly status: DocsAuditAiStatusInput;
    }
  | {
      readonly type: "DocsAuditHardFinding";
      readonly auditedSha: string;
      readonly findings: readonly DocsAuditFinding[];
    }
  | {
      readonly type: "DocsAuditFollowUpFailed";
      readonly auditedSha: string;
      readonly status: Extract<DocsAuditFollowUpStatus, "awaiting" | "failed">;
    };

const REQUIRED_AI_STATUSES = new Set<DocsAuditAiStatusInput>([
  "unavailable",
  "skipped",
  "cancelled",
  "missing",
]);

/**
 * Combines the four SHA-bound inputs. Mixed or missing SHAs fail typed
 * `DocsAuditShaMismatch`. Success records round-trip through the Task 8 slot.
 */
export function combineDocsAuditGate(
  input: DocsAuditGateInput,
): Result<DocsAuditGateSuccess, DocsAuditGateError> {
  const shas = [
    input.publicImpact.auditedSha,
    input.deterministic.auditedSha,
    input.ai.auditedSha,
    input.followUp.auditedSha,
  ];
  if (shas.some((sha) => FullShaSchema.safeParse(sha).success !== true))
    return err({ type: "DocsAuditShaMismatch", auditedShas: shas });
  const auditedSha = shas[0];
  if (auditedSha === undefined)
    return err({ type: "DocsAuditShaMismatch", auditedShas: shas });
  if (shas.some((sha) => sha !== auditedSha))
    return err({ type: "DocsAuditShaMismatch", auditedShas: shas });

  if (input.publicImpact.classification === "no-impact")
    return ok({
      type: "not-required",
      outcome: bindOutcome(auditedSha, input.deterministic.digest, "not-required"),
    });

  if (!input.deterministic.passed)
    return err({
      type: "DocsAuditDeterministicFailed",
      auditedSha,
      deterministicResultDigest: input.deterministic.digest,
    });

  if (input.ai.status !== "submitted")
    return err({
      type: "DocsAuditMissingRequiredAiResult",
      auditedSha,
      status: input.ai.status,
    });
  if (input.ai.digest === undefined)
    return err({
      type: "DocsAuditMissingRequiredAiResult",
      auditedSha,
      status: "missing",
    });

  const findings = input.ai.findings ?? [];
  const hard = findings.filter((finding) => finding.severity === "block");
  if (hard.length > 0)
    return err({
      type: "DocsAuditHardFinding",
      auditedSha,
      findings: hard,
    });

  if (input.followUp.status === "awaiting" || input.followUp.status === "failed")
    return err({
      type: "DocsAuditFollowUpFailed",
      auditedSha,
      status: input.followUp.status,
    });

  const warnings = findings.filter((finding) => finding.severity === "warn");
  return ok({
    type: "pass",
    outcome: bindOutcome(auditedSha, input.deterministic.digest, input.ai.digest),
    warnings,
  });
}

export function parseDocsAuditOutcome(
  value: unknown,
): Result<ReleaseDocsAudit, { type: "InvalidDocsAuditOutcome" }> {
  const parsed = ReleaseDocsAuditSchema.safeParse(value);
  if (!parsed.success) return err({ type: "InvalidDocsAuditOutcome" });
  return ok(parsed.data);
}

export function docsAuditOutcomeDigest(outcome: ReleaseDocsAudit): string {
  return docsAuditDigest(outcome);
}

function bindOutcome(
  auditedSha: string,
  deterministicResultDigest: string,
  aiResultDigestOrStatus: string,
): ReleaseDocsAudit {
  return {
    auditedSha,
    deterministicResultDigest,
    aiResultDigestOrStatus,
  };
}

export function isDocsAuditAiStatus(
  value: string,
): value is (typeof DOCS_AUDIT_AI_STATUSES)[number] {
  return (DOCS_AUDIT_AI_STATUSES as readonly string[]).includes(value);
}

export function isMissingRequiredAiStatus(
  status: DocsAuditAiStatusInput,
): boolean {
  return REQUIRED_AI_STATUSES.has(status) || status === "not-required";
}
