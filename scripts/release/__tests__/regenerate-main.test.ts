import { describe, expect, it } from "bun:test";
import { resolve } from "node:path";
import { errAsync, okAsync } from "neverthrow";
import type { ChangelogEntry, ChangelogEvidence } from "../changelog-format.js";
import type {
  DocsAuditGateError,
  DocsAuditGateSuccess,
} from "../docs-audit/gate.js";
import {
  AUTOMATIC_REGENERATION_MARKER,
  classifyRegenerationEvent,
  createRegenerationBuilder,
  parseRegenerateMainArgs,
  parseRegenerationEnvironment,
  REGENERATION_DOCS_CHECK_NAME,
  REGENERATION_PHASES,
  RELEASE_POLICY_CHECK_NAME,
  type RegenerationBlockingCheck,
  type RegenerationChangelogArtifact,
  type RegenerationEventInput,
  type RegenerationMainDependencies,
  type RegenerationPlanArtifact,
  type RegenerationStagePorts,
  renderRegenerationBlockingSummary,
  runRegenerateMain,
} from "../regenerate-main.js";
import type {
  PreparedRelease,
  RegenerationBuilder,
  RegenerationOutcome,
  ReleasePrError,
  ReleasePrState,
} from "../release-pr.js";

const SHA = "a".repeat(40);
const NEXT_SHA = "b".repeat(40);
const MARKER = "c".repeat(40);
const DIGEST = `sha256:${"d".repeat(64)}`;
const PR_URL = "https://github.com/weave-io/weave/pull/412";
const IDENTITY = { id: "feature", sourceDigest: "e".repeat(64) };
const NEW_IDENTITY = { id: "new-feature", sourceDigest: "f".repeat(64) };
const WORKFLOW_PATH = resolve(
  import.meta.dir,
  "../../../.github/workflows/release-stable-regenerate.yml",
);

function entry(prose: string, source = IDENTITY): ChangelogEntry {
  return { prose, sourceChangesets: [source] };
}

const EVIDENCE: ChangelogEvidence = { pullRequests: [412] };

function planArtifact(
  baseSha = NEXT_SHA,
  currentEntries: readonly ChangelogEntry[] = [entry("old generated prose")],
  candidateSources: RegenerationPlanArtifact["candidateSources"] = [[IDENTITY]],
): RegenerationPlanArtifact {
  return {
    baseSha,
    expectedHead: MARKER,
    publicImpact: "public-impact",
    currentEntries,
    currentEvidence: EVIDENCE,
    candidateSources,
    evidence: EVIDENCE,
  };
}

function passGate(baseSha: string): DocsAuditGateSuccess {
  return {
    type: "pass",
    outcome: {
      auditedSha: baseSha,
      deterministicResultDigest: DIGEST,
      aiResultDigestOrStatus: DIGEST,
    },
    warnings: [],
  };
}

function prepared(
  baseSha: string,
  entries: readonly ChangelogEntry[],
): PreparedRelease {
  return {
    baseSha,
    title: "chore(release): update stable release PR",
    body: "Release prose",
    commitSubject: "chore(release): regenerate stable release PR",
    files: [
      {
        path: "packages/cli/package.json",
        contents: '{"name":"@weaveio/weave-cli","version":"0.1.1"}\n',
      },
      {
        path: "packages/cli/CHANGELOG.md",
        contents: "# @weaveio/weave-cli\n",
      },
    ],
    changes: [
      {
        path: "packages/cli/package.json",
        status: "modified",
        manifestFields: ["version"],
      },
      { path: "packages/cli/CHANGELOG.md", status: "modified" },
    ],
    docsAuditedSha: baseSha,
    entries,
    evidence: EVIDENCE,
  };
}

function pullRequest(): Extract<
  RegenerationOutcome,
  { kind: "Regenerated" }
>["pullRequest"] {
  return {
    number: 412,
    url: PR_URL,
    state: "open",
    merged: false,
    headRef: "release-pr/stable",
    headSha: MARKER,
    baseRef: "main",
    title: "chore(release): update stable release PR",
    body: "release",
    labels: ["release:stable"],
  };
}

function liveState(): ReleasePrState {
  return {
    kind: "live",
    marker: { ref: "release-pr/stable", sha: MARKER },
    pullRequest: pullRequest(),
    mergedRelease: null,
  };
}

function stagePorts(
  options: {
    plan?: RegenerationPlanArtifact;
    docs?: DocsAuditGateSuccess;
    docsError?: DocsAuditGateError;
    changelog?: RegenerationChangelogArtifact;
    onGenerate?: (keys: readonly string[]) => void;
    rendered?: PreparedRelease[];
  } = {},
): RegenerationStagePorts {
  return {
    computePlan: ({ baseSha, expectedHead }) =>
      okAsync({
        ...(options.plan ?? planArtifact(baseSha)),
        baseSha,
        expectedHead,
      }),
    runDocsAudit: ({ baseSha }) =>
      options.docsError === undefined
        ? okAsync(options.docs ?? passGate(baseSha))
        : errAsync(options.docsError),
    runChangelogAi: ({ generate }) => {
      options.onGenerate?.(
        generate.map(({ sources }) =>
          sources
            .map((source) => `${source.id}@${source.sourceDigest}`)
            .join("|"),
        ),
      );
      return okAsync(
        options.changelog ?? {
          generated: [entry("new generated prose")],
          current: [entry("old generated prose")],
          evidence: EVIDENCE,
          docsAuditedSha: NEXT_SHA,
        },
      );
    },
    render: ({ baseSha, entries }) => {
      const value = prepared(baseSha, entries);
      options.rendered?.push(value);
      return okAsync(value);
    },
  };
}

function dependencies(
  options: {
    state?: ReleasePrState;
    outcome?: RegenerationOutcome;
    docsError?: DocsAuditGateError;
    onGenerate?: (keys: readonly string[]) => void;
    rendered?: PreparedRelease[];
    onCheck?: (check: RegenerationBlockingCheck) => void;
    authorize?: boolean;
  } = {},
): RegenerationMainDependencies {
  const stages = stagePorts({
    docsError: options.docsError,
    onGenerate: options.onGenerate,
    rendered: options.rendered,
    plan: planArtifact(NEXT_SHA),
  });
  const state = options.state ?? liveState();
  const outcome =
    options.outcome ??
    ({
      kind: "RegenerationSuperseded",
      survivingBaseSha: NEXT_SHA,
      baseSha: NEXT_SHA,
    } satisfies RegenerationOutcome);
  return {
    stages,
    manager: {
      discover: () => okAsync(state),
      regenerate: ({ builder }) =>
        builder
          .build({ baseSha: NEXT_SHA, expectedHead: MARKER })
          .andThen((draft) =>
            builder.render({ baseSha: NEXT_SHA, entries: draft.generated }),
          )
          .map(() => outcome)
          .mapErr(
            (failure): ReleasePrError => ({
              type: "ReleasePreparationFailed",
              stage: failure.stage,
              message: failure.message,
              retryable: failure.retryable ?? false,
            }),
          ),
      assertStableRequestAuthorized: (actor) =>
        options.authorize === false
          ? errAsync<never, ReleasePrError>({
              type: "UnauthorizedStableRequest",
              actor,
              team: "weave-io/release-maintainers",
              reason: "not-a-member",
            })
          : okAsync(actor),
    },
    checks: {
      publishBlockingCheck: (check) => {
        options.onCheck?.(check);
        return okAsync(undefined);
      },
    },
  };
}

function docsError(type: DocsAuditGateError["type"]): DocsAuditGateError {
  if (type === "DocsAuditDeterministicFailed")
    return {
      type,
      auditedSha: NEXT_SHA,
      deterministicResultDigest: DIGEST,
    };
  if (type === "DocsAuditMissingRequiredAiResult")
    return { type, auditedSha: NEXT_SHA, status: "missing" };
  if (type === "DocsAuditHardFinding")
    return {
      type,
      auditedSha: NEXT_SHA,
      findings: [],
    };
  return {
    type: "DocsAuditShaMismatch",
    auditedShas: [NEXT_SHA, SHA, NEXT_SHA, NEXT_SHA],
  };
}

const PUSH: RegenerationEventInput = {
  event: "push",
  ref: "refs/heads/main",
};

// The core CAS state machine is covered by release-pr.test.ts. These tests
// cover the automatic controller boundary and its job/artifact contracts.
describe("automatic regeneration event contract", () => {
  it("defines the plan, docs, changelog, and update phases", () => {
    expect(REGENERATION_PHASES).toEqual([
      "detect",
      "plan",
      "docs-release-audit",
      "changelog-ai",
      "update-pr",
    ]);
  });

  it("rejects non-main events and malformed boolean carriers", () => {
    expect(
      classifyRegenerationEvent({
        ...PUSH,
        ref: "refs/heads/release-pr/stable",
      })._unsafeUnwrapErr().type,
    ).toBe("RegenerationRefNotMain");
    expect(
      parseRegenerationEnvironment({
        GITHUB_EVENT_NAME: "push",
        GITHUB_REF: "refs/heads/main",
        PENDING_CHANGES_CHANGED: "yes",
      })._unsafeUnwrapErr().type,
    ).toBe("InvalidRegenerationEvent");
  });

  it("skips self release and cleanup merges only when no pending changes changed", () => {
    expect(
      classifyRegenerationEvent({
        ...PUSH,
        selfReleaseMerge: true,
        pendingChangesChanged: false,
      })._unsafeUnwrap(),
    ).toEqual({
      kind: "skip",
      reason: "self-release-merge-without-pending-changes",
      attribution: "automatic-main-advance",
    });
    expect(
      classifyRegenerationEvent({
        ...PUSH,
        changesetCleanupMerge: true,
        pendingChangesChanged: false,
      })._unsafeUnwrap(),
    ).toMatchObject({
      kind: "skip",
      reason: "changeset-cleanup-merge-without-pending-changes",
    });
    expect(
      classifyRegenerationEvent({
        ...PUSH,
        selfReleaseMerge: true,
        pendingChangesChanged: true,
      })._unsafeUnwrap(),
    ).toEqual({ kind: "run", attribution: "automatic-main-advance" });
  });

  it("recognizes self-merge messages without trusting them as skips", () => {
    expect(
      classifyRegenerationEvent({
        ...PUSH,
        commitMessage: "chore(release): version packages",
        pendingChangesChanged: false,
      }).isOk(),
    ).toBe(true);
    expect(
      classifyRegenerationEvent({
        ...PUSH,
        commitMessage: "chore(release): version packages",
        pendingChangesChanged: true,
      })._unsafeUnwrap().kind,
    ).toBe("run");
  });
});

describe("automatic regeneration lifecycle", () => {
  it("returns a neutral green no-op when there is no marker and no PR", async () => {
    const result = await runRegenerateMain(
      PUSH,
      dependencies({ state: { kind: "absent", mergedRelease: null } }),
    );
    expect(result._unsafeUnwrap().outcome).toEqual({
      kind: "NoReleasePrToRegenerate",
    });
  });

  it("returns a typed failure for a manual retry when no PR exists", async () => {
    const result = await runRegenerateMain(
      {
        event: "workflow_dispatch",
        ref: "refs/heads/main",
        actor: "maintainer",
      },
      dependencies({ state: { kind: "absent", mergedRelease: null } }),
    );
    expect(result._unsafeUnwrapErr()).toEqual({
      type: "NoReleasePrToRegenerate",
      trigger: "workflow_dispatch",
    });
  });

  it("requires maintainer authorization only for the guarded manual retry", async () => {
    const result = await runRegenerateMain(
      {
        event: "workflow_dispatch",
        ref: "refs/heads/main",
        actor: "outsider",
      },
      dependencies({ authorize: false }),
    );
    expect(result._unsafeUnwrapErr().type).toBe("UnauthorizedStableRequest");

    const push = await runRegenerateMain(
      PUSH,
      dependencies({ authorize: false }),
    );
    expect(push.isOk()).toBe(true);
  });

  it("waits through creation-in-progress and has no create port", async () => {
    let regenerated = false;
    const managerState: ReleasePrState = {
      kind: "creation-in-progress",
      marker: { ref: "release-pr/stable", sha: MARKER },
      mergedRelease: null,
    };
    const deps = dependencies({ state: managerState });
    const withRegeneration: RegenerationMainDependencies = {
      ...deps,
      manager: {
        ...deps.manager,
        regenerate: ({ builder }: { builder: RegenerationBuilder }) => {
          regenerated = true;
          return builder
            .build({ baseSha: NEXT_SHA, expectedHead: MARKER })
            .map(
              (): RegenerationOutcome => ({
                kind: "RegenerationSuperseded",
                survivingBaseSha: NEXT_SHA,
                baseSha: NEXT_SHA,
              }),
            )
            .mapErr(
              (failure): ReleasePrError => ({
                type: "ReleasePreparationFailed",
                stage: failure.stage,
                message: failure.message,
                retryable: failure.retryable ?? false,
              }),
            );
        },
      },
    };
    const result = await runRegenerateMain(PUSH, withRegeneration);
    expect(result.isOk()).toBe(true);
    expect(regenerated).toBe(true);
    expect("createStableReleasePr" in deps.manager).toBe(false);
  });

  it("preserves unchanged identity prose and asks AI only for new entries", async () => {
    const human = entry("human edit that must survive");
    const generated = entry("new generated prose", NEW_IDENTITY);
    const requested: string[][] = [];
    const rendered: PreparedRelease[] = [];
    const ports = stagePorts({
      plan: planArtifact(NEXT_SHA, [human], [[IDENTITY], [NEW_IDENTITY]]),
      onGenerate: (keys) => requested.push([...keys]),
      rendered,
      changelog: {
        generated: [generated],
        current: [human],
        evidence: EVIDENCE,
        docsAuditedSha: NEXT_SHA,
      },
    });
    const builder = createRegenerationBuilder(ports, {
      attribution: "automatic-main-advance",
    });
    const draft = await builder.build({
      baseSha: NEXT_SHA,
      expectedHead: MARKER,
    });
    expect(draft.isOk()).toBe(true);
    expect(requested).toEqual([[`new-feature@${NEW_IDENTITY.sourceDigest}`]]);
    expect(draft._unsafeUnwrap().generated).toEqual([human, generated]);
    const renderedResult = await builder.render({
      baseSha: NEXT_SHA,
      entries: draft._unsafeUnwrap().generated,
    });
    expect(renderedResult._unsafeUnwrap().body).toContain(
      AUTOMATIC_REGENERATION_MARKER,
    );
    expect(rendered).toHaveLength(1);
  });

  it("regenerates every entry when its identity digest changes", async () => {
    const old = entry("human edit", IDENTITY);
    const changed = entry("fresh prose", {
      id: IDENTITY.id,
      sourceDigest: "1".repeat(64),
    });
    const requested: string[][] = [];
    const ports = stagePorts({
      plan: planArtifact(NEXT_SHA, [old], [changed.sourceChangesets]),
      onGenerate: (keys) => requested.push([...keys]),
      changelog: {
        generated: [changed],
        current: [old],
        evidence: EVIDENCE,
        docsAuditedSha: NEXT_SHA,
      },
    });
    const result = await createRegenerationBuilder(ports, {
      attribution: "automatic-main-advance",
    }).build({ baseSha: NEXT_SHA, expectedHead: MARKER });
    expect(result.isOk()).toBe(true);
    expect(requested).toHaveLength(1);
    expect(result._unsafeUnwrap().generated).toEqual([changed]);
  });

  it("passes EditConflict with both human and generated versions without mutation", async () => {
    const conflict: ReleasePrError = {
      type: "EditConflict",
      entries: [
        {
          key: "feature@old",
          changesetId: "feature",
          human: "human version",
          generated: "new version",
        },
      ],
    };
    const deps = dependencies({});
    const withConflict: RegenerationMainDependencies = {
      ...deps,
      manager: { ...deps.manager, regenerate: () => errAsync(conflict) },
    };
    const result = await runRegenerateMain(PUSH, withConflict);
    expect(result._unsafeUnwrapErr()).toEqual(conflict);
    expect(conflict.entries[0]).toMatchObject({
      human: "human version",
      generated: "new version",
    });
  });

  it("passes audit trail, lease retry, pre-CAS retry, and superseded outcomes through as typed results", async () => {
    const outcomes: RegenerationOutcome[] = [
      {
        kind: "Regenerated",
        pullRequest: pullRequest(),
        baseSha: NEXT_SHA,
        commitSha: MARKER,
        regeneratedFrom: [SHA],
        preserved: ["feature@digest"],
      },
      {
        kind: "RegenerationSuperseded",
        survivingBaseSha: NEXT_SHA,
        baseSha: SHA,
      },
    ];
    for (const outcome of outcomes) {
      const result = await runRegenerateMain(PUSH, dependencies({ outcome }));
      expect(result._unsafeUnwrap().outcome).toEqual(outcome);
      expect(result._unsafeUnwrap().attribution).toBe("automatic-main-advance");
    }
  });

  it("re-runs the docs gate at each new base before an update", async () => {
    const audited: string[] = [];
    const ports = stagePorts({
      plan: planArtifact(NEXT_SHA),
      docs: passGate(NEXT_SHA),
    });
    const original = ports.runDocsAudit;
    const withAuditTrace: RegenerationStagePorts = {
      ...ports,
      runDocsAudit: (input) => {
        audited.push(input.baseSha);
        return original(input);
      },
    };
    const builder = createRegenerationBuilder(withAuditTrace, {
      attribution: "automatic-main-advance",
    });
    expect(
      (await builder.build({ baseSha: NEXT_SHA, expectedHead: MARKER })).isOk(),
    ).toBe(true);
    expect(
      (await builder.build({ baseSha: SHA, expectedHead: MARKER })).isErr(),
    ).toBe(true);
    expect(audited).toEqual([NEXT_SHA, SHA]);
  });
});

describe("docs re-audit failure invariants", () => {
  for (const type of [
    "DocsAuditDeterministicFailed",
    "DocsAuditMissingRequiredAiResult",
    "DocsAuditHardFinding",
  ] as const) {
    it(`publishes a typed blocking check for ${type}`, async () => {
      let check: RegenerationBlockingCheck | undefined;
      const result = await runRegenerateMain(
        PUSH,
        dependencies({
          docsError: docsError(type),
          onCheck: (value) => {
            check = value;
          },
        }),
      );
      expect(result._unsafeUnwrapErr()).toMatchObject({
        type: "RegenerationDocsBlocked",
      });
      expect(check).toMatchObject({
        name: REGENERATION_DOCS_CHECK_NAME,
        conclusion: "failure",
        status: "completed",
        pullRequestUrl: PR_URL,
        mergeBlockedBy: RELEASE_POLICY_CHECK_NAME,
        attribution: "automatic-main-advance",
      });
      expect(check?.error.type).toBe(type);
    });
  }

  it("leaves the existing PR and marker untouched on a docs failure", async () => {
    const state = liveState();
    const before = JSON.stringify(state);
    let updates = 0;
    const deps = dependencies({
      state,
      docsError: docsError("DocsAuditDeterministicFailed"),
    });
    const withFailure: RegenerationMainDependencies = {
      ...deps,
      manager: {
        ...deps.manager,
        regenerate: ({ builder }: { builder: RegenerationBuilder }) =>
          builder
            .build({ baseSha: NEXT_SHA, expectedHead: MARKER })
            .mapErr(
              (): ReleasePrError => ({
                type: "ReleasePreparationFailed",
                stage: "docs-gate",
                message: "DocsAuditDeterministicFailed",
                retryable: false,
              }),
            )
            .map(() => {
              updates += 1;
              return {
                kind: "RegenerationSuperseded",
                survivingBaseSha: NEXT_SHA,
                baseSha: NEXT_SHA,
              } satisfies RegenerationOutcome;
            }),
      },
    };
    const result = await runRegenerateMain(PUSH, withFailure);
    expect(result.isErr()).toBe(true);
    expect(updates).toBe(0);
    expect(JSON.stringify(state)).toBe(before);
  });

  it("renders a bounded summary that names release-policy freshness", () => {
    const check: RegenerationBlockingCheck = {
      name: REGENERATION_DOCS_CHECK_NAME,
      conclusion: "failure",
      status: "completed",
      auditedSha: NEXT_SHA,
      pullRequestUrl: PR_URL,
      error: docsError("DocsAuditHardFinding"),
      mergeBlockedBy: RELEASE_POLICY_CHECK_NAME,
      attribution: "automatic-main-advance",
    };
    const summary = renderRegenerationBlockingSummary(check)._unsafeUnwrap();
    expect(summary).toContain("release-policy");
    expect(summary).toContain("not mutated");
  });
});

describe("workflow and CLI contract", () => {
  it("parses bounded phase commands and rejects unsafe paths", () => {
    expect(
      parseRegenerateMainArgs([
        "--phase",
        "update-pr",
        "--attempt",
        "2",
        "--input",
        "plan.json",
      ])._unsafeUnwrap(),
    ).toMatchObject({ phase: "update-pr", attempt: 2, inputPath: "plan.json" });
    expect(
      parseRegenerateMainArgs([
        "--phase",
        "update-pr",
        "--input",
        "../secret.json",
      ])._unsafeUnwrapErr().type,
    ).toBe("InvalidRegenerationCommand");
  });

  it("has no release-PR concurrency group and only update-pr names Task 9 regeneration", async () => {
    const workflow = await Bun.file(WORKFLOW_PATH).text();
    expect(workflow).not.toMatch(/^\s*concurrency:/m);
    expect(workflow).toContain("push:");
    expect(workflow).toContain("branches:\n      - main");
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain("Task 9's regenerate");
    expect(workflow.match(/--phase update-pr/g)).toHaveLength(1);
    expect(workflow).not.toContain("npm publish");
    expect(workflow).not.toContain("createPullRequest");
    expect(workflow).toContain("RELEASE_APP_TOKEN");
    expect(workflow).toContain("WEAVE_RELEASE_AI_API_KEY");
    expect(
      workflow.match(/@[0-9a-f]{40}(?:\s+#.*)?$/gm)?.length,
    ).toBeGreaterThanOrEqual(8);
  });
});
