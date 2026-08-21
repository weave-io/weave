import { describe, expect, it } from "bun:test";
import { resolve } from "node:path";
import type { Result } from "neverthrow";
import {
  BunChangesetFileSystem,
  ChangesetPolicyValidator,
  type ValidatedChangeset,
} from "../changeset-policy.js";
import type { ConsumptionLedger } from "../consumption-ledger.js";
import { docsAuditOutcomeDigest } from "../docs-audit/gate.js";
import {
  type ReleasePlan,
  releasePlanDigest,
  renderPlanMetadataBlock,
  validateReleasePlan,
} from "../release-plan.js";
import {
  CONSUMED_CHANGESET_FIX,
  checkReleasePolicy,
  extractPlanDigest,
  parseDocsAuditMetadata,
  RELEASE_POLICY_LIMITS,
  RELEASE_POLICY_RECOVERY_HINT,
  type ReleasePolicyCheckInput,
  type ReleasePolicyError,
  validateReleasePolicyInput,
} from "../release-policy-check.js";

const CLI = "@weaveio/weave-cli" as const;
const BASE_SHA = "a".repeat(40);
const OTHER_SHA = "b".repeat(40);

function digest(seed: string): string {
  return `sha256:${new Bun.CryptoHasher("sha256").update(seed).digest("hex")}`;
}

function validPlan(baseSha = BASE_SHA): ReleasePlan {
  const candidate = {
    schemaVersion: 1 as const,
    channel: "stable" as const,
    seed: [CLI],
    closure: { seed: [CLI], selected: [CLI], added: [] },
    consumed: [],
    versions: [
      { packageName: CLI, previousVersion: "0.0.1", version: "0.1.0" },
    ],
    changelogDigests: [
      {
        packageName: CLI,
        version: "0.1.0",
        documentDigest: digest("changelog"),
      },
    ],
    baseSha,
    releasedSha: null,
    docsAudit: {
      auditedSha: baseSha,
      deterministicResultDigest: digest("deterministic"),
      aiResultDigestOrStatus: "not-required" as const,
    },
    binding: null,
  };
  const parsed = validateReleasePlan(candidate);
  if (parsed.isErr())
    throw new Error(`invalid plan fixture: ${JSON.stringify(parsed.error)}`);
  return parsed.value;
}

function emptyLedger(): ConsumptionLedger {
  return { records: [], identities: new Map() };
}

function digestOf(plan: ReleasePlan): string {
  return releasePlanDigest(plan).match(
    (digest) => digest,
    (error) => {
      throw new Error(`invalid plan fixture: ${error.type}`);
    },
  );
}

function validRequest(
  overrides: Partial<ReleasePolicyCheckInput> = {},
): ReleasePolicyCheckInput {
  const plan = validPlan();
  return {
    mode: "stable",
    changedPaths: ["packages/cli/package.json", "packages/cli/CHANGELOG.md"],
    changes: [
      {
        path: "packages/cli/package.json",
        status: "modified",
        manifestFields: ["version"],
      },
      { path: "packages/cli/CHANGELOG.md", status: "modified" },
    ],
    changesets: [],
    ledger: emptyLedger(),
    currentMainSha: BASE_SHA,
    plan,
    planDigest: digestOf(plan),
    docsAuditMetadata: {
      schemaVersion: 1,
      auditedSha: BASE_SHA,
      outcome: "not-required",
      outcomeDigest: docsAuditOutcomeDigest(plan.docsAudit),
      warnings: 0,
    },
    ...overrides,
  };
}

function expectError(
  result: Result<unknown, ReleasePolicyError>,
): ReleasePolicyError {
  if (result.isOk()) throw new Error("expected a policy failure");
  return result.error;
}

function changesetFixture(path = ".changeset/consumed.md"): ValidatedChangeset {
  const source = [
    "---",
    `"${CLI}": patch`,
    "---",
    "Fix a released behavior.",
    "",
  ].join("\n");
  const result = new ChangesetPolicyValidator(
    new BunChangesetFileSystem(),
  ).validateFile(path, new TextEncoder().encode(source));
  if (result.isErr())
    throw new Error(
      `invalid changeset fixture: ${JSON.stringify(result.error)}`,
    );
  return result.value;
}

describe("release-policy check", () => {
  it("passes a fresh stable release PR with a bound plan and docs audit", () => {
    const result = checkReleasePolicy(validRequest());
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.mode).toBe("stable");
      expect(result.value.releaseRules).toBe("checked");
    }
  });

  it("rejects a release plan generated from stale main and links regeneration", () => {
    const error = expectError(
      checkReleasePolicy(validRequest({ currentMainSha: OTHER_SHA })),
    );
    expect(error.type).toBe("StaleBaseSha");
    if (error.type === "StaleBaseSha") {
      expect(error.baseSha).toBe(BASE_SHA);
      expect(error.currentMainSha).toBe(OTHER_SHA);
      expect(error.recovery).toBe(RELEASE_POLICY_RECOVERY_HINT);
    }
  });

  it("rejects an embedded plan digest that does not match recomputation", () => {
    const error = expectError(
      checkReleasePolicy(validRequest({ planDigest: digest("different") })),
    );
    expect(error.type).toBe("PlanDigestMismatch");
    if (error.type === "PlanDigestMismatch")
      expect(error.recovery).toBe(RELEASE_POLICY_RECOVERY_HINT);
  });

  it("requires docs-audit metadata and binds it to current main", () => {
    const missing = expectError(
      checkReleasePolicy(validRequest({ docsAuditMetadata: undefined })),
    );
    expect(missing.type).toBe("MissingDocsAuditMetadata");

    const mismatched = expectError(
      checkReleasePolicy(
        validRequest({
          docsAuditMetadata: {
            schemaVersion: 1,
            auditedSha: OTHER_SHA,
            outcome: "not-required",
            outcomeDigest: docsAuditOutcomeDigest(validPlan().docsAudit),
            warnings: 0,
          },
        }),
      ),
    );
    expect(mismatched.type).toBe("DocsAuditShaMismatch");
    if (mismatched.type === "DocsAuditShaMismatch")
      expect(mismatched.recovery).toBe(RELEASE_POLICY_RECOVERY_HINT);
  });

  it("skips release-only rules on an ordinary PR", () => {
    const result = checkReleasePolicy({
      mode: "ordinary",
      changedPaths: ["packages/cli/package.json", ".changeset/pending.md"],
      changes: [
        { path: "packages/cli/package.json", status: "modified" },
        { path: ".changeset/pending.md", status: "modified" },
      ],
      changedChangesetPaths: [".changeset/pending.md"],
      changesets: [changesetFixture(".changeset/pending.md")],
      ledger: emptyLedger(),
    });
    expect(result.isOk()).toBe(true);
    if (result.isOk()) expect(result.value.releaseRules).toBe("skipped");
  });

  it("rejects an edited ledger-consumed changeset with the exact fix", () => {
    const changeset = changesetFixture();
    const ledger: ConsumptionLedger = {
      records: [
        { identity: changeset.identity, packageName: CLI, version: "0.1.0" },
      ],
      identities: new Map([[changeset.identity.id, changeset.identity]]),
    };
    const edited = changesetFixture();
    const changed = {
      ...edited,
      identity: {
        ...edited.identity,
        sourceDigest: digest("edited").slice("sha256:".length),
      },
    };
    const error = expectError(
      checkReleasePolicy({
        mode: "ordinary",
        changedPaths: [".changeset/consumed.md"],
        changes: [{ path: ".changeset/consumed.md", status: "modified" }],
        changesets: [changed],
        ledger,
        changedChangesetPaths: [".changeset/consumed.md"],
      }),
    );
    expect(error.type).toBe("ConsumedChangesetModified");
    if (error.type === "ConsumedChangesetModified")
      expect(error.fix).toBe(CONSUMED_CHANGESET_FIX);
  });

  it("allows cleanup to delete only exact ledger-consumed files", () => {
    const path = ".changeset/consumed.md";
    const pass = checkReleasePolicy({
      mode: "cleanup",
      changedPaths: [path],
      changes: [{ path, status: "removed" }],
      consumedPaths: [path],
      changesets: [],
      ledger: emptyLedger(),
    });
    expect(pass.isOk()).toBe(true);

    const fail = expectError(
      checkReleasePolicy({
        mode: "cleanup",
        changedPaths: [path, "README.md"],
        changes: [
          { path, status: "removed" },
          { path: "README.md", status: "modified" },
        ],
        consumedPaths: [path],
        changesets: [],
        ledger: emptyLedger(),
      }),
    );
    expect(fail.type).toBe("ForbiddenCleanupPrPath");
  });

  it("bounds untrusted policy input", () => {
    const result = validateReleasePolicyInput({
      mode: "ordinary",
      changedPaths: Array.from(
        { length: RELEASE_POLICY_LIMITS.changedPaths + 1 },
        () => "docs/a.md",
      ),
      changes: [],
    });
    expect(result.isErr()).toBe(true);
    if (result.isErr())
      expect(result.error.type).toBe("ReleasePolicyInputBoundExceeded");
  });

  it("parses explicit plan digests and docs-audit records", () => {
    const plan = validPlan();
    const planDigest = digestOf(plan);
    const digestBody = [
      `<!-- ${"weave-release-plan-digest"}:1`,
      JSON.stringify({ planDigest }),
      "-->",
    ].join("\n");
    expect(extractPlanDigest(digestBody)).toBe(planDigest);
    const metadata = parseDocsAuditMetadata(
      JSON.stringify({
        schemaVersion: 1,
        auditedSha: BASE_SHA,
        outcome: "not-required",
        outcomeDigest: docsAuditOutcomeDigest(plan.docsAudit),
        warnings: 0,
      }),
    );
    expect(metadata.isOk()).toBe(true);

    const planBlock = renderPlanMetadataBlock(plan);
    if (planBlock.isErr()) throw new Error("plan fixture did not render");
    const prBody = [
      planBlock.value,
      "<!-- weave-release-docs-audit:1",
      JSON.stringify({
        auditedSha: BASE_SHA,
        outcome: "not-required",
        outcomeDigest: docsAuditOutcomeDigest(plan.docsAudit),
        warnings: 0,
      }),
      "-->",
    ].join("\n");
    const fromBody = checkReleasePolicy(
      validRequest({
        plan: undefined,
        planBody: prBody,
        planDigest: undefined,
        docsAuditMetadata: undefined,
      }),
    );
    expect(fromBody.isOk()).toBe(true);
  });

  it("keeps the CI job split and the original ci steps", async () => {
    const workflow = await Bun.file(
      resolve(import.meta.dir, "../../../.github/workflows/ci.yml"),
    ).text();
    expect(workflow).toContain(
      "  ci:\n    name: Lint, Typecheck, Build & Test",
    );
    expect(workflow).toContain("  release-policy:\n    name: release-policy");
    expect(workflow).toContain("  api-reports:\n    name: api-reports");
    for (const step of [
      "run: bun run changeset:check",
      "run: bun run lint",
      "run: bun run typecheck",
      "run: bun run build",
      "run: bun run test",
      "run: bun run verify:action-pins",
      "run: bun run verify:codeowners",
      "run: bun run docs:check-links",
    ])
      expect(workflow).toContain(step);
    expect(workflow.indexOf("Build declaration surfaces")).toBeLessThan(
      workflow.indexOf("Check API reports and surface coverage"),
    );
  });
});
