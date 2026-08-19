import { describe, expect, test } from "bun:test";
import type { Result } from "neverthrow";
import {
  type ChangelogDocument,
  renderChangelog,
} from "../../changelog-format.js";
import type { ChangesetIdentity } from "../../changeset-policy.js";
import type { ChangelogSource } from "../../consumption-ledger.js";
import {
  AI_AUDIT_LIMITS,
  AI_AUDIT_MARKER,
  AI_AUDIT_SCHEMA_VERSION,
  type AiAuditError,
  type AiAuditMetadata,
  appendAiAuditMetadata,
  type ChangelogSourceMapping,
  canonicalizeChangelogSourceMapping,
  changelogSourceMappingFromDocuments,
  changelogSourceMappingFromSources,
  createAiAuditMetadata,
  describeAiAuditError,
  digestChangelogSubmission,
  parseAiAuditMetadata,
  parseAiAuditMetadataBlock,
  renderAiAuditMetadataBlock,
  renderAiAuditSummary,
  serializeAiAuditMetadata,
  validateAiAuditMetadata,
  verifyAuditAgainstMergedSource,
} from "../audit-metadata.js";
import { CHANGELOG_PROMPT_VERSION } from "../changelog-agent.js";
import {
  CHANGELOG_AGENT_MODEL,
  CHANGELOG_AGENT_PROVIDER,
} from "../headless-session.js";
import type { ChangelogSubmission } from "../submission-schema.js";

const CLI = "@weaveio/weave-cli" as const;
const OPENCODE = "@weaveio/weave-adapter-opencode" as const;
const GENERATED_AT = "2026-08-18T20:42:00.000Z";
const SECRET = "sk-live-audit-metadata-test-key";
const TRANSCRIPT = "assistant: hidden reasoning about the release";
const SESSION_ID = "sess_abc123xyz789";
const FULL_PROMPT = "You are the changelog agent. Write every entry.";
const EVIDENCE_BODY = "changeset body that must never appear";

function hex(seed: string): string {
  return new Bun.CryptoHasher("sha256").update(seed).digest("hex");
}

function digest(seed: string): string {
  return `sha256:${hex(seed)}`;
}

function identity(id: string, seed = id): ChangesetIdentity {
  return { id, sourceDigest: hex(seed) };
}

function audit(overrides: Partial<AiAuditMetadata> = {}): AiAuditMetadata {
  return {
    provider: CHANGELOG_AGENT_PROVIDER,
    model: CHANGELOG_AGENT_MODEL,
    promptVersion: CHANGELOG_PROMPT_VERSION,
    thinking: "medium",
    evidenceDigest: digest("evidence"),
    submissionDigest: digest("submission"),
    attempts: 1,
    generatedAt: GENERATED_AT,
    ...overrides,
  };
}

function submission(
  identities: readonly ChangesetIdentity[] = [
    identity("portable-delegation-limits"),
  ],
): ChangelogSubmission {
  return {
    packages: [
      {
        packageName: CLI,
        sections: [
          {
            name: "Added",
            entries: [
              {
                prose: "Delegation limits are portable across harnesses",
                sourceChangesets: [...identities],
              },
            ],
          },
        ],
      },
    ],
  };
}

function documentFor(
  identities: readonly ChangesetIdentity[],
  packageName: typeof CLI | typeof OPENCODE = CLI,
  version = "0.1.0",
): ChangelogDocument {
  return {
    packageName,
    versions: [
      {
        version,
        sections: [
          {
            name: "Added",
            entries: [
              {
                prose: "Delegation limits are portable across harnesses",
                sourceChangesets: [...identities],
              },
            ],
          },
        ],
      },
    ],
  };
}

function mappingFor(
  identities: readonly ChangesetIdentity[],
  packageName: typeof CLI | typeof OPENCODE = CLI,
  version = "0.1.0",
): ChangelogSourceMapping {
  const result = canonicalizeChangelogSourceMapping({
    records: [{ packageName, version, identities }],
  });
  if (result.isErr()) throw new Error(`mapping failed: ${result.error.type}`);
  return result.value;
}

function changelogSource(
  identities: readonly ChangesetIdentity[],
  packageName: typeof CLI | typeof OPENCODE = CLI,
): ChangelogSource {
  const rendered = renderChangelog(documentFor(identities, packageName));
  if (rendered.isErr())
    throw new Error(`render failed: ${rendered.error.type}`);
  return {
    packageName,
    path: `packages/${packageName}/CHANGELOG.md`,
    contents: rendered.value,
  };
}

function expectOk<T>(result: Result<T, AiAuditError>): T {
  if (result.isErr()) throw new Error(`unexpected error: ${result.error.type}`);
  return result.value;
}

function expectErr<T>(result: Result<T, AiAuditError>): AiAuditError {
  if (result.isOk()) throw new Error("expected an audit error");
  return result.error;
}

function visible(value: unknown): string {
  return JSON.stringify(value) ?? "";
}

describe("ai audit metadata schema", () => {
  test("round-trips a strict validated record", () => {
    const record = audit();
    const serialized = expectOk(serializeAiAuditMetadata(record));
    const parsed = expectOk(parseAiAuditMetadata(serialized));
    expect(parsed).toEqual(record);
    expect(expectOk(validateAiAuditMetadata(record))).toEqual(record);
  });

  test("createAiAuditMetadata digests the submission and drops it", () => {
    const created = expectOk(
      createAiAuditMetadata({
        thinking: "medium",
        attempts: 1,
        evidenceDigest: digest("evidence"),
        submission: submission(),
        generatedAt: GENERATED_AT,
      }),
    );
    expect(created.provider).toBe(CHANGELOG_AGENT_PROVIDER);
    expect(created.model).toBe(CHANGELOG_AGENT_MODEL);
    expect(created.promptVersion).toBe(CHANGELOG_PROMPT_VERSION);
    expect(created.submissionDigest).toBe(
      digestChangelogSubmission(submission()),
    );
    expect(visible(created)).not.toContain("Delegation limits");
    expect(visible(created)).not.toContain("sourceChangesets");
  });

  test("rejects unknown keys and invalid field shapes", () => {
    expect(
      expectErr(validateAiAuditMetadata({ ...audit(), extra: true })).type,
    ).toBe("InvalidAiAuditMetadata");
    expect(
      expectErr(validateAiAuditMetadata({ ...audit(), provider: "other" }))
        .type,
    ).toBe("InvalidAiAuditMetadata");
    expect(
      expectErr(validateAiAuditMetadata({ ...audit(), attempts: 3 })).type,
    ).toBe("InvalidAiAuditMetadata");
    expect(
      expectErr(
        validateAiAuditMetadata({ ...audit(), generatedAt: "2026-08-18" }),
      ).type,
    ).toBe("InvalidAiAuditMetadata");
  });
});

describe("hidden PR carrier", () => {
  test("round-trips through a PR body with surrounding prose", () => {
    const record = audit();
    const body = expectOk(
      appendAiAuditMetadata("Seed: @weaveio/weave-cli\n", record),
    );
    expect(body).toContain(AI_AUDIT_MARKER);
    expect(body).toContain(`:${String(AI_AUDIT_SCHEMA_VERSION)}`);
    expect(expectOk(parseAiAuditMetadataBlock(body))).toEqual(record);
  });

  test("leaves the body unchanged when no audit is supplied", () => {
    expect(expectOk(appendAiAuditMetadata("unchanged\n", undefined))).toBe(
      "unchanged\n",
    );
  });

  test("rejects a missing block, duplicate blocks, and an unclosed carrier", () => {
    expect(expectErr(parseAiAuditMetadataBlock("no audit here")).type).toBe(
      "MissingAiAuditMetadataBlock",
    );
    const once = expectOk(renderAiAuditMetadataBlock(audit()));
    expect(expectErr(parseAiAuditMetadataBlock(`${once}\n${once}`)).type).toBe(
      "MultipleAiAuditMetadataBlocks",
    );
    expect(expectErr(appendAiAuditMetadata(`${once}\n`, audit())).type).toBe(
      "MultipleAiAuditMetadataBlocks",
    );
    expect(
      expectErr(
        parseAiAuditMetadataBlock(`<!-- ${AI_AUDIT_MARKER}:1\n{"provider":`),
      ).type,
    ).toBe("MalformedAiAuditJson");
  });

  test("rejects duplicate JSON keys and an oversized carrier", () => {
    const record = audit();
    const serialized = expectOk(serializeAiAuditMetadata(record));
    const duplicated = serialized.replace(
      `"provider": "${CHANGELOG_AGENT_PROVIDER}"`,
      `"provider": "${CHANGELOG_AGENT_PROVIDER}",\n  "provider": "${CHANGELOG_AGENT_PROVIDER}"`,
    );
    const duplicate = expectErr(parseAiAuditMetadata(duplicated));
    expect(duplicate).toEqual({
      type: "DuplicateAiAuditKey",
      path: "provider",
      key: "provider",
    });

    const oversized = `${"a".repeat(AI_AUDIT_LIMITS.carrierBytes + 1)}`;
    expect(expectErr(parseAiAuditMetadata(oversized))).toEqual({
      type: "AiAuditTooLarge",
      bytes: oversized.length,
      limit: AI_AUDIT_LIMITS.carrierBytes,
    });
  });

  test("rejects a tampered digest without echoing carrier contents", () => {
    const serialized = expectOk(serializeAiAuditMetadata(audit()));
    const tampered = serialized.replace(
      digest("evidence"),
      digest("tampered-evidence"),
    );
    const parsed = expectOk(parseAiAuditMetadata(tampered));
    expect(parsed.evidenceDigest).toBe(digest("tampered-evidence"));
    const verified = expectErr(
      verifyAuditAgainstMergedSource(parsed, {
        evidenceDigest: digest("evidence"),
        changelogMapping: mappingFor([identity("portable-delegation-limits")]),
        expectedChangelogMapping: mappingFor([
          identity("portable-delegation-limits"),
        ]),
      }),
    );
    expect(verified.type).toBe("AuditEvidenceDigestMismatch");
    expect(visible(verified)).not.toContain(SECRET);
    expect(visible(verified)).not.toContain(TRANSCRIPT);
  });
});

describe("merged-source verification", () => {
  test("accepts a matching recomputed evidence digest and changelog mapping", () => {
    const identities = [identity("portable-delegation-limits")];
    const record = audit({ evidenceDigest: digest("merged-evidence") });
    const mapping = mappingFor(identities);
    expect(
      expectOk(
        verifyAuditAgainstMergedSource(record, {
          evidenceDigest: digest("merged-evidence"),
          changelogMapping: mapping,
          expectedChangelogMapping: mapping,
        }),
      ),
    ).toEqual(record);
  });

  test("extracts mapping from canonical changelog sources", () => {
    const identities = [identity("portable-delegation-limits")];
    const sources = [changelogSource(identities)];
    const fromSources = expectOk(changelogSourceMappingFromSources(sources));
    const fromDocuments = expectOk(
      changelogSourceMappingFromDocuments([documentFor(identities)]),
    );
    expect(fromSources).toEqual(fromDocuments);
    expect(
      expectOk(
        verifyAuditAgainstMergedSource(audit(), {
          evidenceDigest: digest("evidence"),
          changelogMapping: sources,
          expectedChangelogMapping: [documentFor(identities)],
        }),
      ),
    ).toEqual(audit());
  });

  test("fails typed when the evidence digest diverges", () => {
    const mapping = mappingFor([identity("portable-delegation-limits")]);
    const error = expectErr(
      verifyAuditAgainstMergedSource(audit(), {
        evidenceDigest: digest("other-evidence"),
        changelogMapping: mapping,
        expectedChangelogMapping: mapping,
      }),
    );
    expect(error).toEqual({
      type: "AuditEvidenceDigestMismatch",
      expected: digest("evidence"),
      actual: digest("other-evidence"),
    });
  });

  test("fails typed when the changelog mapping diverges", () => {
    const expected = mappingFor([identity("portable-delegation-limits")]);
    const actual = mappingFor([identity("pi-settlement-budget")]);
    const error = expectErr(
      verifyAuditAgainstMergedSource(audit(), {
        evidenceDigest: digest("evidence"),
        changelogMapping: actual,
        expectedChangelogMapping: expected,
      }),
    );
    expect(error.type).toBe("AuditChangelogMappingDivergence");
    if (error.type === "AuditChangelogMappingDivergence")
      expect(error.path).toBe("records.0.identities.0.id");
    expect(visible(error)).not.toContain("Delegation limits");
  });

  test("fails typed when a provided submission digest diverges", () => {
    const mapping = mappingFor([identity("portable-delegation-limits")]);
    const error = expectErr(
      verifyAuditAgainstMergedSource(audit(), {
        evidenceDigest: digest("evidence"),
        changelogMapping: mapping,
        expectedChangelogMapping: mapping,
        submission: submission(),
      }),
    );
    expect(error.type).toBe("AuditSubmissionDigestMismatch");
  });
});

describe("secret and transcript field rejection", () => {
  test("rejects forbidden fields without retaining their values", () => {
    const hostile = {
      ...audit(),
      reasoning: TRANSCRIPT,
      transcript: TRANSCRIPT,
      sessionId: SESSION_ID,
      apiKey: SECRET,
      prompt: FULL_PROMPT,
      evidence: EVIDENCE_BODY,
    };
    const error = expectErr(validateAiAuditMetadata(hostile));
    expect(error.type).toBe("ForbiddenAuditField");
    const serialized = visible(error);
    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toContain(TRANSCRIPT);
    expect(serialized).not.toContain(SESSION_ID);
    expect(serialized).not.toContain(FULL_PROMPT);
    expect(serialized).not.toContain(EVIDENCE_BODY);
    expect(describeAiAuditError(error)).not.toContain(SECRET);
  });

  test("rejects a forbidden key inside the JSON carrier", () => {
    const serialized = expectOk(serializeAiAuditMetadata(audit()));
    const hostile = serialized.replace(
      `"thinking": "medium"`,
      `"thinking": "medium",\n  "transcript": ${JSON.stringify(TRANSCRIPT)}`,
    );
    const error = expectErr(parseAiAuditMetadata(hostile));
    expect(error.type).toBe("ForbiddenAuditField");
    expect(visible(error)).not.toContain(TRANSCRIPT);
  });

  test("summaries name only the allowed fields", () => {
    const summary = expectOk(renderAiAuditSummary(audit()));
    expect(summary).toContain("Changelog AI audit");
    expect(summary).toContain(`provider: ${CHANGELOG_AGENT_PROVIDER}`);
    expect(summary).toContain(`model: ${CHANGELOG_AGENT_MODEL}`);
    expect(summary).toContain(
      `promptVersion: ${String(CHANGELOG_PROMPT_VERSION)}`,
    );
    expect(summary).toContain("thinking: medium");
    expect(summary).toContain("attempts: 1");
    expect(summary).toContain(`evidenceDigest: ${digest("evidence")}`);
    expect(summary).toContain(`submissionDigest: ${digest("submission")}`);
    expect(summary).toContain(`generatedAt: ${GENERATED_AT}`);
    expect(summary).not.toContain("transcript");
    expect(summary).not.toContain("sessionId");
    expect(summary).not.toContain("reasoning");
    expect(summary).not.toContain(SECRET);
    expect(summary).not.toMatch(/prompt:/i);
    expect(summary).not.toMatch(/evidence:/i);
  });
});
