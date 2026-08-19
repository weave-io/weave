import { describe, expect, it } from "bun:test";
import { resolve } from "node:path";
import { errAsync, okAsync } from "neverthrow";
import type { BoundedEvidence } from "../ai/evidence.js";
import { HEADLESS_THINKING_LEVELS } from "../ai/headless-session.js";
import type { PublicPackageName } from "../constants.js";
import type { DocsAuditAgentResult } from "../docs-audit/agent.js";
import type {
  DeterministicDocsCheckError,
  DeterministicDocsCheckResult,
} from "../docs-audit/deterministic.js";
import {
  combineDocsAuditGate,
  type DocsAuditGateSuccess,
} from "../docs-audit/gate.js";
import type { DocsAuditFinding } from "../docs-audit/policy.js";
import type { GitHubPullRequestSummary } from "../github-client.js";
import {
  PREPARE_PACKAGE_INPUTS,
  type PrepareMainError,
  type PrepareStageError,
  parsePrepareEnvironment,
  parsePrepareInput,
  parsePrepareMainArgs,
  renderDocsAuditMetadata,
  renderPreparedRelease,
  runPrepareDocsAudit,
  runPreparedCreation,
  runPrepareMain,
  type StableChangelogPreparation,
  type StablePrepareDependencies,
  type StablePrepareInput,
  type StablePrepareReleasePrPort,
  type StableReleasePlan,
} from "../prepare-main.js";
import type {
  CreatedReleasePr,
  PreparedRelease,
  ReleasePrError,
  ReleasePrOwnership,
  ReleasePrState,
} from "../release-pr.js";

const CLI = "@weaveio/weave-cli" as PublicPackageName;
const SHA = "a".repeat(40);
const NEXT_SHA = "b".repeat(40);
const DIGEST = `sha256:${"d".repeat(64)}`;
const PR_URL = "https://github.com/weave-io/weave/pull/412";
const WORKFLOW_PATH = resolve(
  import.meta.dir,
  "../../../.github/workflows/release-stable-prepare.yml",
);

const INPUT: StablePrepareInput = {
  cli: true,
  opencode: false,
  claudeCode: false,
  pi: false,
  thinking: "medium",
};

const EVIDENCE: BoundedEvidence = {
  schemaVersion: 1,
  packages: [],
  digest: DIGEST as `sha256:${string}`,
};

function plan(
  baseSha = SHA,
  publicImpact: StableReleasePlan["publicImpact"] = "no-impact",
): StableReleasePlan {
  return {
    baseSha,
    seed: [CLI],
    closure: { seed: [CLI], selected: [CLI], added: [] },
    consumed: [],
    versions: [
      { packageName: CLI, previousVersion: "0.1.0", version: "0.1.1" },
    ],
    evidence: EVIDENCE,
    changelogEvidence: { pullRequests: [412] },
    publicImpact,
    title: "chore(release): prepare stable release",
    body: "This release updates the CLI.",
    commitSubject: "chore(release): version packages",
    manifestFiles: [
      {
        path: "packages/cli/package.json",
        contents: '{"name":"@weaveio/weave-cli","version":"0.1.1"}\n',
      },
    ],
    manifestChanges: [
      {
        path: "packages/cli/package.json",
        status: "modified",
        manifestFields: ["version"],
      },
    ],
  };
}

function changelog(): StableChangelogPreparation {
  return {
    entries: [],
    files: [
      {
        path: "packages/cli/CHANGELOG.md",
        contents: "# @weaveio/weave-cli\n",
      },
    ],
    changes: [{ path: "packages/cli/CHANGELOG.md", status: "modified" }],
  };
}

function prepared(baseSha = SHA): PreparedRelease {
  return {
    baseSha,
    title: "chore(release): prepare stable release",
    body: "release",
    commitSubject: "chore(release): version packages",
    files: [],
    changes: [],
    docsAuditedSha: baseSha,
    entries: [],
    evidence: { pullRequests: [412] },
  };
}

function created(baseSha = SHA): CreatedReleasePr {
  const pullRequest: GitHubPullRequestSummary = {
    number: 412,
    url: PR_URL,
    state: "open",
    merged: false,
    headRef: "release-pr/stable",
    headSha: NEXT_SHA,
    baseRef: "main",
    title: "chore(release): prepare stable release",
    body: "release",
    labels: ["release:stable"],
  };
  return {
    pullRequest,
    ownership: {
      ref: "refs/heads/release-pr/stable",
      ownerGeneration: "e".repeat(64),
      expectedMarkerSha: "f".repeat(40),
      plannedBaseSha: baseSha,
    },
    baseSha,
  };
}

function gateFor(
  baseSha: string,
  type: "not-required" | "pass" = "not-required",
): DocsAuditGateSuccess {
  return type === "not-required"
    ? {
        type,
        outcome: {
          auditedSha: baseSha,
          deterministicResultDigest: DIGEST,
          aiResultDigestOrStatus: "not-required",
        },
      }
    : {
        type,
        outcome: {
          auditedSha: baseSha,
          deterministicResultDigest: DIGEST,
          aiResultDigestOrStatus: DIGEST,
        },
        warnings: [],
      };
}

interface FakeOptions {
  auth?: ReleasePrError;
  state?: ReleasePrState;
  head?: string;
  plan?: StableReleasePlan;
  docs?: DocsAuditGateSuccess;
  docsError?: PrepareStageError;
  createError?: ReleasePrError;
  onPrepare?: (baseSha: string, previous: PreparedRelease | null) => void;
}

function fakeDependencies(options: FakeOptions = {}): {
  dependencies: StablePrepareDependencies;
  calls: string[];
} {
  const calls: string[] = [];
  const dependencies: StablePrepareDependencies = {
    manager: {
      assertStableRequestAuthorized: (actor) => {
        calls.push(`authorize:${actor}`);
        return options.auth === undefined
          ? okAsync(actor)
          : errAsync(options.auth);
      },
      discover: () => {
        calls.push("discover");
        return okAsync(
          options.state ?? { kind: "absent", mergedRelease: null },
        );
      },
      createStableReleasePr: (request) => {
        calls.push("create");
        if (options.createError !== undefined)
          return errAsync<CreatedReleasePr, ReleasePrError>(
            options.createError,
          );
        return request.preparer
          .prepare({ baseSha: options.head ?? SHA, previous: null })
          .map((value) => {
            calls.push(`prepared:${value.baseSha}`);
            return created(value.baseSha);
          })
          .mapErr(
            (error): ReleasePrError => ({
              type: "ReleasePreparationFailed",
              stage: error.stage,
              message: error.message,
              retryable: error.retryable ?? false,
            }),
          );
      },
    },
    readGreenMainHead: () => {
      calls.push("green-main");
      return okAsync(options.head ?? SHA);
    },
    computePlan: (request) => {
      calls.push(
        `plan:${request.baseSha}:${request.previous?.baseSha ?? "none"}`,
      );
      options.onPrepare?.(request.baseSha, request.previous);
      return okAsync(options.plan ?? plan(request.baseSha));
    },
    runDocsAudit: (request) => {
      calls.push(`docs:${request.baseSha}`);
      return options.docsError === undefined
        ? okAsync(options.docs ?? gateFor(request.baseSha))
        : errAsync(options.docsError);
    },
    runChangelogAi: (request) => {
      calls.push(`changelog:${request.baseSha}`);
      return okAsync(changelog());
    },
  };
  return { dependencies, calls };
}

function finding(severity: DocsAuditFinding["severity"]): DocsAuditFinding {
  return {
    severity,
    kind: severity === "block" ? "missing-required" : "style",
    evidence: {
      path: "RELEASING.md",
      excerpt: "excerpt",
      excerptDigest: DIGEST,
    },
    claim: "The release documentation needs review.",
  };
}

function deterministic(passed: boolean): DeterministicDocsCheckResult {
  return {
    schemaVersion: 1,
    passed,
    issues: [],
    digest: DIGEST,
  };
}

function docsAgent(
  auditedSha: string,
  findings: readonly DocsAuditFinding[] = [],
): DocsAuditAgentResult {
  return {
    promptVersion: 1,
    policyVersion: 1,
    model: "opencode-go/gpt-5.6-luna",
    thinking: "medium",
    attempts: 1,
    auditedSha,
    submission: { findings: [...findings] },
    findings,
    patches: [],
    digest: DIGEST,
    session: {} as DocsAuditAgentResult["session"],
  };
}

describe("stable preparation input", () => {
  it("has exactly four package inputs and defaults thinking to medium", () => {
    expect(PREPARE_PACKAGE_INPUTS).toEqual([
      "cli",
      "opencode",
      "claude-code",
      "pi",
    ]);
    expect(HEADLESS_THINKING_LEVELS).toContain("medium");
    expect(
      parsePrepareInput({
        cli: true,
        opencode: false,
        claudeCode: false,
        pi: false,
      })._unsafeUnwrap().thinking,
    ).toBe("medium");
  });

  it("rejects an empty selection and malformed workflow booleans", () => {
    expect(
      parsePrepareInput({
        cli: false,
        opencode: false,
        claudeCode: false,
        pi: false,
      })._unsafeUnwrapErr(),
    ).toEqual({ type: "EmptySelection" });
    expect(
      parsePrepareEnvironment({
        INPUT_CLI: "yes",
        INPUT_OPENCODE: "false",
        INPUT_CLAUDE_CODE: "false",
        INPUT_PI: "false",
      })._unsafeUnwrapErr().type,
    ).toBe("InvalidPrepareInput");
  });

  it("rejects invalid phase commands and accepts bounded attempts", () => {
    expect(
      parsePrepareMainArgs(["--phase", "nope"])._unsafeUnwrapErr().type,
    ).toBe("InvalidPrepareCommand");
    expect(
      parsePrepareMainArgs([
        "--phase",
        "open-pr",
        "--unknown",
        "x",
      ])._unsafeUnwrapErr(),
    ).toEqual({
      type: "InvalidPrepareCommand",
      issues: ["unknown option --unknown"],
    });
    expect(
      parsePrepareMainArgs([
        "--phase",
        "open-pr",
        "--phase",
        "plan",
      ])._unsafeUnwrapErr(),
    ).toEqual({
      type: "InvalidPrepareCommand",
      issues: ["duplicate option --phase"],
    });
    expect(
      parsePrepareMainArgs([
        "--phase",
        "open-pr",
        "--attempt",
        "5",
      ])._unsafeUnwrapErr(),
    ).toEqual({ type: "InvalidPrepareAttempt", attempt: "5" });
    expect(
      parsePrepareMainArgs([
        "--phase",
        "open-pr",
        "--attempt",
        "2",
      ])._unsafeUnwrap(),
    ).toEqual({ phase: "open-pr", attempt: 2 });
  });
});

describe("stable preparation request ordering and lifecycle", () => {
  it("authorizes before green-main, discovery, planning, or AI", async () => {
    const { dependencies, calls } = fakeDependencies({
      auth: {
        type: "UnauthorizedStableRequest",
        actor: "outsider",
        team: "weave-io/release-maintainers",
        reason: "not-a-member",
      },
    });
    const result = await runPrepareMain(INPUT, "outsider", dependencies);
    expect(result._unsafeUnwrapErr()).toMatchObject({
      type: "UnauthorizedStableRequest",
    });
    expect(calls).toEqual(["authorize:outsider"]);
  });

  it("rejects every live or pending merged state before creating", async () => {
    const states = [
      "PendingArtifactsOrProof",
      "PendingNpm",
      "PendingRegistryVerification",
      "PendingTagsOrReleases",
      "PendingChangesetCleanup",
      "IntegrityIncident",
    ] as const;
    for (const state of states) {
      const { dependencies, calls } = fakeDependencies({
        state: {
          kind: "absent",
          mergedRelease: { url: PR_URL, state, markerCleanupPending: false },
        },
      });
      const result = await runPrepareMain(INPUT, "maintainer", dependencies);
      expect(result._unsafeUnwrapErr()).toEqual({
        type: "PendingReleaseBlocksPrep",
        url: PR_URL,
        state,
      });
      expect(calls).toEqual(["authorize:maintainer", "green-main", "discover"]);
    }
  });

  it("allows CompleteWithIncident and rejects an existing open PR with its URL", async () => {
    const pending = fakeDependencies({
      state: {
        kind: "live",
        marker: { ref: "refs/heads/release-pr/stable", sha: SHA },
        pullRequest: created().pullRequest,
        mergedRelease: null,
      },
    });
    const blocked = await runPrepareMain(
      INPUT,
      "maintainer",
      pending.dependencies,
    );
    expect(blocked._unsafeUnwrapErr()).toEqual({
      type: "ReleasePrExists",
      url: PR_URL,
    });
    expect(pending.calls).toEqual([
      "authorize:maintainer",
      "green-main",
      "discover",
    ]);

    const allowed = fakeDependencies({
      state: {
        kind: "absent",
        mergedRelease: {
          url: PR_URL,
          state: "CompleteWithIncident",
          markerCleanupPending: false,
        },
      },
    });
    expect(
      (await runPrepareMain(INPUT, "maintainer", allowed.dependencies)).isOk(),
    ).toBe(true);
    expect(allowed.calls).toContain("create");
  });
});

describe("SHA-bound docs release gate", () => {
  it("fails before changelog or creation when the docs gate fails", async () => {
    const docsError: PrepareMainError = {
      type: "PrepareDocsAuditFailed",
      error: {
        type: "DocsAuditHardFinding",
        auditedSha: SHA,
        findings: [finding("block")],
      },
    };
    const { dependencies, calls } = fakeDependencies({ docsError });
    const result = await runPrepareMain(INPUT, "maintainer", dependencies);
    expect(result._unsafeUnwrapErr()).toEqual(docsError);
    expect(calls).not.toContain("create");
    expect(calls).not.toContain(`changelog:${SHA}`);
  });

  it("uses Task 19's combiner for deterministic failure, required AI failure, hard findings, and warnings", () => {
    const deterministicFailure = combineDocsAuditGate({
      publicImpact: { auditedSha: SHA, classification: "public-impact" },
      deterministic: { auditedSha: SHA, digest: DIGEST, passed: false },
      ai: { auditedSha: SHA, status: "submitted", digest: DIGEST },
      followUp: { auditedSha: SHA, status: "not-applicable" },
    });
    expect(deterministicFailure._unsafeUnwrapErr().type).toBe(
      "DocsAuditDeterministicFailed",
    );

    const missingAi = combineDocsAuditGate({
      publicImpact: { auditedSha: SHA, classification: "public-impact" },
      deterministic: { auditedSha: SHA, digest: DIGEST, passed: true },
      ai: { auditedSha: SHA, status: "cancelled" },
      followUp: { auditedSha: SHA, status: "not-applicable" },
    });
    expect(missingAi._unsafeUnwrapErr().type).toBe(
      "DocsAuditMissingRequiredAiResult",
    );

    const hard = combineDocsAuditGate({
      publicImpact: { auditedSha: SHA, classification: "public-impact" },
      deterministic: { auditedSha: SHA, digest: DIGEST, passed: true },
      ai: {
        auditedSha: SHA,
        status: "submitted",
        digest: DIGEST,
        findings: [finding("block")],
      },
      followUp: { auditedSha: SHA, status: "not-applicable" },
    });
    expect(hard._unsafeUnwrapErr().type).toBe("DocsAuditHardFinding");

    const warning = combineDocsAuditGate({
      publicImpact: { auditedSha: SHA, classification: "public-impact" },
      deterministic: { auditedSha: SHA, digest: DIGEST, passed: true },
      ai: {
        auditedSha: SHA,
        status: "submitted",
        digest: DIGEST,
        findings: [finding("warn")],
      },
      followUp: { auditedSha: SHA, status: "not-applicable" },
    });
    expect(warning._unsafeUnwrap()).toMatchObject({
      type: "pass",
      warnings: [finding("warn")],
    });

    const noImpact = combineDocsAuditGate({
      publicImpact: { auditedSha: SHA, classification: "no-impact" },
      deterministic: { auditedSha: SHA, digest: DIGEST, passed: false },
      ai: { auditedSha: SHA, status: "not-required" },
      followUp: { auditedSha: SHA, status: "not-applicable" },
    });
    expect(noImpact._unsafeUnwrap().type).toBe("not-required");
  });

  it("binds both deterministic and agent results to the exact requested SHA", async () => {
    const deterministicResult: DeterministicDocsCheckResult =
      deterministic(true);
    const agentResult = docsAgent(SHA);
    const result = await runPrepareDocsAudit(
      { contentRoot: ".", auditedSha: SHA, classification: "public-impact" },
      {
        deterministic: () => okAsync(deterministicResult),
        agent: () => okAsync(agentResult),
      },
    );
    expect(result._unsafeUnwrap().outcome.auditedSha).toBe(SHA);

    const wrongSha = await runPrepareDocsAudit(
      { contentRoot: ".", auditedSha: SHA, classification: "public-impact" },
      {
        deterministic: () => okAsync(deterministicResult),
        agent: () => okAsync(docsAgent(NEXT_SHA)),
      },
    );
    expect(wrongSha._unsafeUnwrapErr().type).toBe("DocsAuditShaMismatch");
  });

  it("maps deterministic provider errors to a terminal deterministic failure", async () => {
    const error: DeterministicDocsCheckError = {
      type: "DeterministicDocsRootInvalid",
      path: ".",
    };
    const result = await runPrepareDocsAudit(
      { contentRoot: ".", auditedSha: SHA, classification: "public-impact" },
      { deterministic: () => errAsync(error) },
    );
    expect(result._unsafeUnwrapErr().type).toBe("DocsAuditDeterministicFailed");
  });

  it("does not require an AI driver for a no-impact selection", async () => {
    const result = await runPrepareDocsAudit(
      {
        contentRoot: ".",
        auditedSha: SHA,
        classification: "no-impact",
      },
      { deterministic: () => okAsync(deterministic(true)) },
    );
    expect(result._unsafeUnwrap().type).toBe("not-required");
  });
});

describe("workflow shape", () => {
  it("keeps request inputs, permissions, pins, and credentials bounded", async () => {
    const workflow = await Bun.file(WORKFLOW_PATH).text();
    expect(workflow.match(/^\s+type: boolean$/gm)).toHaveLength(4);
    expect(workflow).toContain("default: medium");
    expect(workflow).not.toMatch(/^\s*concurrency:/m);
    expect(workflow).not.toContain("id-token:");
    expect(workflow).not.toContain("npm publish");
    expect(workflow).not.toContain("--phase regenerate");
    expect(
      workflow.match(/@[0-9a-f]{40}(?:\s+#.*)?$/gm)?.length,
    ).toBeGreaterThanOrEqual(4);
    const jobBlock = (job: string): string => {
      const start = workflow.indexOf(`  ${job}:`);
      const rest = workflow.slice(start + 3);
      const next = rest.search(/\n {2}[a-z][a-z0-9-]*:/);
      const end = next === -1 ? -1 : start + 3 + next;
      return workflow.slice(start, end === -1 ? workflow.length : end);
    };
    for (const job of [
      "docs-release-audit",
      "changelog-ai",
      "docs-release-audit-2",
      "changelog-ai-2",
      "docs-release-audit-3",
      "changelog-ai-3",
    ]) {
      const block = jobBlock(job);
      expect(block).toContain("WEAVE_RELEASE_AI_API_KEY");
      expect(block).not.toContain("RELEASE_APP_INSTALLATION_TOKEN");
    }
    for (const job of ["open-pr", "open-pr-2", "open-pr-3"]) {
      const block = jobBlock(job);
      expect(block).toContain("RELEASE_APP_INSTALLATION_TOKEN");
      expect(block).toContain("acquireCreationOwnership");
      expect(block).toContain("finalizeCreation");
      expect(block).toContain("abortOwnedCreation");
      expect(block).not.toContain("WEAVE_RELEASE_AI_API_KEY");
    }
  });
});

describe("replans, race results, and prepared surface", () => {
  it("re-runs every preparation stage at a fresh head and passes prior content", async () => {
    const seen: Array<{ baseSha: string; previous: PreparedRelease | null }> =
      [];
    const dependencies = fakeDependencies({
      head: SHA,
      onPrepare: (baseSha, previous) => seen.push({ baseSha, previous }),
    });
    dependencies.dependencies.manager.createStableReleasePr = (request) =>
      request.preparer
        .prepare({ baseSha: NEXT_SHA, previous: prepared(SHA) })
        .map(() => created(NEXT_SHA))
        .mapErr(
          (error): ReleasePrError => ({
            type: "ReleasePreparationFailed",
            stage: error.stage,
            message: error.message,
            retryable: error.retryable ?? false,
          }),
        );
    const result = await runPrepareMain(
      INPUT,
      "maintainer",
      dependencies.dependencies,
    );
    expect(result.isOk()).toBe(true);
    expect(seen).toEqual([
      { baseSha: SHA, previous: null },
      { baseSha: NEXT_SHA, previous: prepared(SHA) },
    ]);
    expect(dependencies.calls).toContain(`docs:${NEXT_SHA}`);
    expect(dependencies.calls).toContain(`changelog:${NEXT_SHA}`);
  });

  it("uses explicit Task 9 ownership phases for a stale-head replan", async () => {
    const calls: string[] = [];
    const ownership: ReleasePrOwnership = {
      ref: "refs/heads/release-pr/stable",
      ownerGeneration: "e".repeat(64),
      expectedMarkerSha: "f".repeat(40),
      plannedBaseSha: SHA,
    };
    let finalizeCalls = 0;
    const manager: StablePrepareReleasePrPort = {
      assertStableRequestAuthorized: () => okAsync("maintainer"),
      discover: () => okAsync({ kind: "absent", mergedRelease: null }),
      createStableReleasePr: () =>
        errAsync({
          type: "ReleasePrCreationStalled",
          ref: ownership.ref,
          attempts: 1,
        }),
      acquireCreationOwnership: () => {
        calls.push("acquire");
        return okAsync(ownership);
      },
      finalizeCreation: ({ prepared }) => {
        finalizeCalls += 1;
        calls.push(`finalize:${prepared.baseSha}`);
        return finalizeCalls === 1
          ? errAsync<CreatedReleasePr, ReleasePrError>({
              type: "PreparationStale",
              newHead: NEXT_SHA,
              baseSha: SHA,
              ownership,
            })
          : okAsync(created(NEXT_SHA));
      },
      abortOwnedCreation: () => {
        calls.push("abort");
        return okAsync({ kind: "marker-deleted", ownership });
      },
    };
    const result = await runPreparedCreation(
      {
        selected: [CLI],
        plannedBaseSha: SHA,
        prepared: prepared(SHA),
        reprepare: ({ baseSha, previous }) => {
          calls.push(`reprepare:${baseSha}:${previous.baseSha}`);
          return okAsync(prepared(baseSha));
        },
      },
      manager,
    );
    expect(result.isOk()).toBe(true);
    expect(calls).toEqual([
      "acquire",
      `finalize:${SHA}`,
      `reprepare:${NEXT_SHA}:${SHA}`,
      `finalize:${NEXT_SHA}`,
    ]);
  });

  it("aborts the owned marker on freshness exhaustion and preserves cleanup errors", async () => {
    const ownership: ReleasePrOwnership = {
      ref: "refs/heads/release-pr/stable",
      ownerGeneration: "e".repeat(64),
      expectedMarkerSha: "f".repeat(40),
      plannedBaseSha: SHA,
    };
    let finalizeCalls = 0;
    let abortCalls = 0;
    const manager: StablePrepareReleasePrPort = {
      assertStableRequestAuthorized: () => okAsync("maintainer"),
      discover: () => okAsync({ kind: "absent", mergedRelease: null }),
      createStableReleasePr: () =>
        errAsync({
          type: "ReleasePrCreationStalled",
          ref: ownership.ref,
          attempts: 1,
        }),
      acquireCreationOwnership: () => okAsync(ownership),
      finalizeCreation: () => {
        finalizeCalls += 1;
        return errAsync<CreatedReleasePr, ReleasePrError>({
          type: "PreparationStale",
          newHead: NEXT_SHA,
          baseSha: SHA,
          ownership,
        });
      },
      abortOwnedCreation: () => {
        abortCalls += 1;
        return okAsync({ kind: "marker-deleted", ownership });
      },
    };
    const exhausted = await runPreparedCreation(
      {
        selected: [CLI],
        plannedBaseSha: SHA,
        prepared: prepared(SHA),
        reprepare: ({ baseSha }) => okAsync(prepared(baseSha)),
      },
      manager,
    );
    expect(exhausted._unsafeUnwrapErr()).toEqual({
      type: "PreparationFreshnessExhausted",
      attempts: 3,
      retryable: true,
      cleanup: "marker-deleted",
    });
    expect(finalizeCalls).toBe(3);
    expect(abortCalls).toBe(1);

    const cleanupError: ReleasePrError = {
      type: "CreationCleanupPending",
      ref: ownership.ref,
      ownerGeneration: ownership.ownerGeneration,
      expectedMarkerSha: ownership.expectedMarkerSha,
      plannedBaseSha: SHA,
      reason: "ownership-changed",
    };
    const pendingManager: StablePrepareReleasePrPort = {
      ...manager,
      abortOwnedCreation: () => errAsync(cleanupError),
    };
    const pending = await runPreparedCreation(
      {
        selected: [CLI],
        plannedBaseSha: SHA,
        prepared: prepared(SHA),
        reprepare: ({ baseSha }) => okAsync(prepared(baseSha)),
      },
      pendingManager,
    );
    expect(pending._unsafeUnwrapErr()).toEqual(cleanupError);
  });

  it("passes Task 9 race, exhaustion, and cleanup results through unchanged", async () => {
    const errors: ReleasePrError[] = [
      { type: "ReleasePrExists", url: PR_URL },
      {
        type: "PreparationFreshnessExhausted",
        attempts: 3,
        retryable: true,
        cleanup: "marker-deleted",
      },
      {
        type: "CreationCleanupPending",
        ref: "refs/heads/release-pr/stable",
        ownerGeneration: "e".repeat(64),
        expectedMarkerSha: "f".repeat(40),
        plannedBaseSha: SHA,
        reason: "cas-delete-failed",
      },
    ];
    for (const createError of errors) {
      const { dependencies } = fakeDependencies({ createError });
      const result = await runPrepareMain(INPUT, "maintainer", dependencies);
      expect(result._unsafeUnwrapErr()).toEqual(createError);
    }
  });

  it("embeds an exact docs audit record and preserves the permitted diff surface", async () => {
    const gate = gateFor(SHA, "pass");
    const result = await renderPreparedRelease({
      baseSha: SHA,
      plan: plan(SHA, "public-impact"),
      docsAudit: gate,
      changelog: changelog(),
      previous: null,
    });
    const value = result._unsafeUnwrap();
    expect(value.baseSha).toBe(SHA);
    expect(value.docsAuditedSha).toBe(SHA);
    expect(value.files.map((file) => file.path)).toEqual([
      "packages/cli/package.json",
      "packages/cli/CHANGELOG.md",
    ]);
    expect(value.body).toContain(`auditedSha`);
    expect(renderDocsAuditMetadata(SHA, gate)).toContain(SHA);
  });

  it("rejects a renderer whose docs audit is bound to an older head", async () => {
    const result = await renderPreparedRelease({
      baseSha: SHA,
      plan: plan(SHA),
      docsAudit: gateFor(NEXT_SHA),
      changelog: changelog(),
      previous: null,
    });
    expect(result._unsafeUnwrapErr()).toMatchObject({
      type: "PrepareRenderFailed",
    });
  });
});
