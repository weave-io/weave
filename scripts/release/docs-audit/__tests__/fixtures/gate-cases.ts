import type { DocsAuditFinding } from "../../policy.js";
import type {
  DocsAuditAiInput,
  DocsAuditDeterministicInput,
  DocsAuditFollowUpInput,
  DocsAuditGateInput,
  DocsAuditPublicImpactInput,
} from "../../gate.js";

export const AUDITED_SHA = "a".repeat(40);
export const OTHER_SHA = "b".repeat(40);
export const DETERMINISTIC_DIGEST =
  "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
export const AI_DIGEST =
  "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";

export function styleWarning(): DocsAuditFinding {
  return {
    severity: "warn",
    kind: "style",
    evidence: {
      path: "README.md",
      excerpt: "Public packages",
      excerptDigest: AI_DIGEST,
    },
    claim: "Heading tone could be tighter.",
  };
}

export function hardFinding(): DocsAuditFinding {
  return {
    severity: "block",
    kind: "factual-contradiction",
    evidence: {
      path: "README.md",
      excerpt: "no adapter package exists yet",
      excerptDigest: AI_DIGEST,
    },
    claim: "Pi adapter is published; the README still says it is planned.",
  };
}

export function gateInput(
  overrides: {
    publicImpact?: Partial<DocsAuditPublicImpactInput>;
    deterministic?: Partial<DocsAuditDeterministicInput>;
    ai?: Partial<DocsAuditAiInput>;
    followUp?: Partial<DocsAuditFollowUpInput>;
  } = {},
): DocsAuditGateInput {
  return {
    publicImpact: {
      auditedSha: AUDITED_SHA,
      classification: "public-impact",
      ...overrides.publicImpact,
    },
    deterministic: {
      auditedSha: AUDITED_SHA,
      digest: DETERMINISTIC_DIGEST,
      passed: true,
      ...overrides.deterministic,
    },
    ai: {
      auditedSha: AUDITED_SHA,
      status: "submitted",
      digest: AI_DIGEST,
      findings: [],
      ...overrides.ai,
    },
    followUp: {
      auditedSha: AUDITED_SHA,
      status: "not-applicable",
      ...overrides.followUp,
    },
  };
}
