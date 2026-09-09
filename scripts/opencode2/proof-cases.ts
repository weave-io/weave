import { err, ok, type Result } from "neverthrow";

export const REQUIRED_OPENCODE2_PROOF_CASES = [
  "artifact_identity",
  "host_identity",
  "plugin_activation",
  "native_inventory",
  "prompt_request",
  "model_variant",
  "skill_attachment",
  "tool_policy",
  "command_and_plan_rpc",
  "foreign_collision",
  "foreground_subagent",
  "background_subagent",
  "valid_refresh",
  "invalid_refresh",
  "negative_resources",
  "wrong_location",
  "denied_delegation",
  "concurrent_admission",
  "interruption",
  "cleanup",
] as const;

export type OpenCode2ProofCaseID =
  (typeof REQUIRED_OPENCODE2_PROOF_CASES)[number];

export interface OpenCode2ProofVerdict {
  readonly id: OpenCode2ProofCaseID;
  readonly passed: boolean;
  readonly evidence: string;
}

export interface OpenCode2ProofReport {
  readonly schemaVersion: 1;
  readonly hostVersion: "0.0.0-beta-19151";
  readonly adapterVersion: string;
  readonly tarballSha256: string;
  readonly pluginSha256: string;
  readonly verdicts: readonly OpenCode2ProofVerdict[];
}

export type OpenCode2ProofFailure = {
  readonly type:
    | "MissingCase"
    | "FailedCase"
    | "DuplicateCase"
    | "InvalidEvidence";
  readonly caseID: OpenCode2ProofCaseID;
};

const MAX_EVIDENCE_LENGTH = 240;

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined) continue;
    if (codePoint <= 31 || (codePoint >= 127 && codePoint <= 159)) return true;
  }
  return false;
}

export class OpenCode2ProofCases {
  private readonly verdicts = new Map<
    OpenCode2ProofCaseID,
    OpenCode2ProofVerdict
  >();

  pass(
    id: OpenCode2ProofCaseID,
    evidence: string,
  ): Result<void, OpenCode2ProofFailure> {
    return this.record(id, true, evidence);
  }

  fail(
    id: OpenCode2ProofCaseID,
    evidence: string,
  ): Result<void, OpenCode2ProofFailure> {
    return this.record(id, false, evidence);
  }

  complete(
    input: Omit<
      OpenCode2ProofReport,
      "schemaVersion" | "hostVersion" | "verdicts"
    >,
  ): Result<OpenCode2ProofReport, OpenCode2ProofFailure> {
    const verdicts: OpenCode2ProofVerdict[] = [];
    for (const id of REQUIRED_OPENCODE2_PROOF_CASES) {
      const verdict = this.verdicts.get(id);
      if (verdict === undefined)
        return err({ type: "MissingCase", caseID: id });
      if (!verdict.passed) return err({ type: "FailedCase", caseID: id });
      verdicts.push(verdict);
    }
    return ok({
      schemaVersion: 1,
      hostVersion: "0.0.0-beta-19151",
      ...input,
      verdicts,
    });
  }

  private record(
    id: OpenCode2ProofCaseID,
    passed: boolean,
    evidence: string,
  ): Result<void, OpenCode2ProofFailure> {
    if (this.verdicts.has(id))
      return err({ type: "DuplicateCase", caseID: id });
    if (
      evidence.length === 0 ||
      evidence.length > MAX_EVIDENCE_LENGTH ||
      hasControlCharacter(evidence)
    ) {
      return err({ type: "InvalidEvidence", caseID: id });
    }
    this.verdicts.set(id, { id, passed, evidence });
    return ok(undefined);
  }
}
