import { describe, expect, it } from "bun:test";
import {
  PUBLIC_PACKAGES,
  type PublicPackageName,
  RELEASE_ATTEST_WORKFLOW_PATH,
  RELEASE_PR_MARKER_REF,
  RELEASE_PUBLISH_WORKFLOW_PATH,
  RELEASE_REPOSITORY,
  RELEASE_WORKFLOW_PATH,
} from "../constants.js";
import {
  type DoctorMode,
  type DoctorSnapshot,
  LEGACY_PREFLIGHT_RUN_NAME,
  type NpmPackageObservation,
  parseDoctorMode,
  parseTrustedPublisherResponse,
  RELEASE_APP_CREDENTIAL_NAMES,
  RELEASE_APP_SECRET_ENVIRONMENTS,
  REQUIRED_RELEASE_SECRET_NAMES,
  recentSuccessfulOldRun,
  verifyDoctorSnapshot,
} from "../doctor.js";
import { PRODUCTION_ENTRYPOINTS } from "../entrypoint-inventory.js";
import type { ReleasePrOwnership } from "../release-pr-contract.js";
import type { DiscoveredRelease } from "../release-state.js";
import {
  createRolloutActivationRecord,
  createRolloutFreezeRecord,
  type RolloutStage,
  validateRolloutTuple,
  type WorkflowTopology,
} from "../rollout-stage.js";

const SHA = "a".repeat(40);
const OTHER_SHA = "b".repeat(40);
const OWNER = "c".repeat(64);
const DOCTOR_RUN_NOW = Date.parse("2026-08-19T00:00:00.000Z");

// Shape follows GitHub's documented Workflow Run list response.
const realisticScheduledRun = {
  id: 123456789,
  name: "Publish control plane",
  node_id: "WFR_kwDOExample",
  head_branch: "main",
  head_sha: SHA,
  path: RELEASE_WORKFLOW_PATH,
  run_number: 88,
  event: "schedule",
  status: "completed",
  conclusion: "success",
  workflow_id: 987654,
  url: "https://api.github.com/repos/weave-io/weave/actions/runs/123456789",
  html_url: "https://github.com/weave-io/weave/actions/runs/123456789",
  pull_requests: [],
  created_at: "2026-08-18T22:00:00.000Z",
  updated_at: "2026-08-18T23:00:00.000Z",
  run_started_at: "2026-08-18T22:00:01.000Z",
  jobs_url:
    "https://api.github.com/repos/weave-io/weave/actions/runs/123456789/jobs",
  logs_url:
    "https://api.github.com/repos/weave-io/weave/actions/runs/123456789/logs",
  check_suite_url:
    "https://api.github.com/repos/weave-io/weave/check-suites/123456789",
  artifacts_url:
    "https://api.github.com/repos/weave-io/weave/actions/runs/123456789/artifacts",
  cancel_url:
    "https://api.github.com/repos/weave-io/weave/actions/runs/123456789/cancel",
  rerun_url:
    "https://api.github.com/repos/weave-io/weave/actions/runs/123456789/rerun",
  workflow_url:
    "https://api.github.com/repos/weave-io/weave/actions/workflows/987654",
  head_commit: null,
  repository: { full_name: RELEASE_REPOSITORY },
  head_repository: { full_name: RELEASE_REPOSITORY },
  display_title: "legacy-publisher-scheduled",
};

function listRuns(run: Record<string, unknown>) {
  return { total_count: 1, workflow_runs: [run] };
}

function withoutField(
  run: Record<string, unknown>,
  field: string,
): Record<string, unknown> {
  const copy = { ...run };
  delete copy[field];
  return copy;
}

const freezeRecord = createRolloutFreezeRecord({
  commitSha: SHA,
  committedAt: "2026-08-18T00:00:00.000Z",
  quiescenceEvidence: "no active release or publisher run",
})._unsafeUnwrap();
const activationRecord = createRolloutActivationRecord({
  commitSha: OTHER_SHA,
  committedAt: "2026-08-18T01:00:00.000Z",
  greenReport: "ReadyForActivation report",
})._unsafeUnwrap();

function declaration(stage: RolloutStage) {
  return {
    schemaVersion: 1 as const,
    stage,
    freezeRecord: stage === "pre-cutover" ? null : freezeRecord,
    activationRecord: stage === "ready" ? activationRecord : null,
  };
}

function topology(stage: RolloutStage): WorkflowTopology {
  if (stage === "pre-cutover")
    return {
      oldWorkflowPresent: true,
      oldWorkflowScheduled: true,
      newWorkflowPresent: false,
      newWorkflowScheduled: false,
    };
  return {
    oldWorkflowPresent: false,
    oldWorkflowScheduled: false,
    newWorkflowPresent: true,
    newWorkflowScheduled: true,
  };
}

function trust(workflow: string): readonly Record<string, unknown>[] {
  return [
    {
      provider: "github-actions",
      workflow,
      action: "npm publish",
      repository: RELEASE_REPOSITORY,
      environment: null,
    },
  ];
}

function packageObservation(
  packageName: PublicPackageName,
  published: boolean,
): NpmPackageObservation {
  return {
    packageName,
    exists: true,
    published,
    ownershipVerified: true,
    owners: ["weave-io"],
    distTags: published ? { latest: "0.1.0" } : {},
  };
}

function stageForMode(mode: DoctorMode): RolloutStage {
  if (mode === "pre-cutover") return "pre-cutover";
  if (mode === "cutover" || mode === "post-bootstrap-frozen") return "frozen";
  return "ready";
}

function modeValue(mode: DoctorMode): "disabled" | "dry-run" | "enabled" {
  if (mode === "pre-cutover") return "disabled";
  if (mode === "final") return "enabled";
  return "disabled";
}

function snapshotFor(mode: DoctorMode = "final"): DoctorSnapshot {
  const stage = stageForMode(mode);
  const published = mode !== "pre-cutover" && mode !== "cutover";
  const trustWorkflow =
    mode === "pre-cutover"
      ? RELEASE_WORKFLOW_PATH
      : RELEASE_PUBLISH_WORKFLOW_PATH;
  const trustedPublishers: Record<string, unknown> = {};
  for (const packageName of Object.keys(PUBLIC_PACKAGES) as PublicPackageName[])
    trustedPublishers[packageName] =
      (mode === "pre-cutover" || mode === "cutover") &&
      packageName !== "@weaveio/weave-cli" &&
      packageName !== "@weaveio/weave-adapter-opencode"
        ? []
        : trust(trustWorkflow);

  return {
    declaration: declaration(stage),
    rolloutMode: modeValue(mode),
    topology: topology(stage),
    packages: (Object.keys(PUBLIC_PACKAGES) as PublicPackageName[]).map(
      (packageName) =>
        packageObservation(
          packageName,
          published ||
            packageName === "@weaveio/weave-cli" ||
            packageName === "@weaveio/weave-adapter-opencode",
        ),
    ),
    trustedPublishers,
    github: {
      environments: {
        release: {
          name: "release",
          exists: true,
          readable: true,
          protectionConfigured: true,
        },
        prerelease: {
          name: "prerelease",
          exists: true,
          readable: true,
          protectionConfigured: true,
        },
      },
      ruleset: {
        exists: true,
        readable: true,
        targetBranch: "main",
        requiredChecks: ["ci", "release-policy", "api-reports", "docs-audit"],
        dismissStalePullRequestApprovals: true,
      },
      team: {
        organization: "weave-io",
        slug: "release-maintainers",
        exists: true,
        readable: true,
      },
      app: {
        installationReadable: true,
        permissions: {
          contents: "write",
          pullRequests: "write",
          checks: "write",
          members: "read",
        },
      },
      secrets: {
        readable: true,
        repositoryNames: [],
        environmentNames: {
          release: [],
          prerelease: [],
          "release-ai": ["WEAVE_RELEASE_AI_API_KEY"],
          "release-app": ["RELEASE_APP_ID", "RELEASE_APP_PRIVATE_KEY"],
          "docs-audit-patch": ["RELEASE_APP_ID", "RELEASE_APP_PRIVATE_KEY"],
          "release-refs": ["RELEASE_APP_ID", "RELEASE_APP_PRIVATE_KEY"],
        },
      },
    },
    attestationWorkflow: {
      readable: true,
      present: mode !== "pre-cutover",
      declaresWorkflowCall: false,
    },
    oldSystem: {
      authoritative: true,
      publicationPathEnabled: true,
      recentSuccessfulRun: true,
      readOnlyPreflight: false,
      runId: 42,
      evidence: "successful scheduled run 42 on protected main",
    },
    harness: {
      binaries: { opencode: true, claude: true, pi: true },
      proofJobsAvailable: true,
    },
    model: {
      provider: "opencode-go",
      model: "gpt-5.6-luna",
      reachable: true,
      minimalPingPerformed: true,
    },
    policy: {
      packagePolicyPassed: true,
      docsPolicyPassed: true,
    },
    lifecycle: {
      authoritative: true,
      marker: { present: false, openReleasePr: false },
    },
  };
}

function doctorFailure(result: ReturnType<typeof verifyDoctorSnapshot>) {
  expect(result.isErr()).toBe(true);
  if (result.isOk()) throw new Error("expected doctor failure");
  expect(result.error.type).toBe("DoctorFailed");
  if (result.error.type !== "DoctorFailed") throw new Error("wrong error");
  return result.error;
}

function ownership(
  overrides: Partial<ReleasePrOwnership> = {},
): ReleasePrOwnership {
  return {
    ref: RELEASE_PR_MARKER_REF,
    ownerGeneration: OWNER,
    expectedMarkerSha: SHA,
    plannedBaseSha: OTHER_SHA,
    ...overrides,
  };
}

function mergedDiscovery(
  primary: string,
  markerCleanupPending = false,
): DiscoveredRelease {
  return {
    kind: "merged-release",
    case:
      primary === "IntegrityIncident" ? "integrity-incident" : "partial-npm",
    state: {
      primary: primary as never,
      markerCleanupPending,
      releasedSha: SHA,
      pullRequestUrl: "https://github.com/weave-io/weave/pull/42",
      pullRequestNumber: 42,
      unreproducible: [],
    },
  };
}

describe("release doctor", () => {
  it("parses exactly one explicit mode and defaults to final", () => {
    expect(parseDoctorMode([])._unsafeUnwrap()).toBe("final");
    expect(parseDoctorMode(["--pre-cutover"])._unsafeUnwrap()).toBe(
      "pre-cutover",
    );
    expect(parseDoctorMode(["--pre-cutover", "--cutover"]).isErr()).toBe(true);
    expect(parseDoctorMode(["--final"]).isErr()).toBe(true);
  });

  it("validates the allowed rollout tuple table and rejects dual or absent publishers", () => {
    expect(
      validateRolloutTuple(
        declaration("pre-cutover"),
        "dry-run",
        topology("pre-cutover"),
      ).isOk(),
    ).toBe(true);
    expect(
      validateRolloutTuple(
        declaration("frozen"),
        "disabled",
        topology("frozen"),
      ).isOk(),
    ).toBe(true);
    expect(
      validateRolloutTuple(
        declaration("ready"),
        "enabled",
        topology("ready"),
      )._unsafeUnwrap().publicationCapable,
    ).toBe(true);

    const invalid = [
      ["pre-cutover", "enabled"],
      ["frozen", "dry-run"],
      ["ready", "dry-run"],
    ] as const;
    for (const [stage, mode] of invalid)
      expect(
        validateRolloutTuple(declaration(stage), mode, topology(stage)).isErr(),
      ).toBe(true);

    expect(
      validateRolloutTuple(declaration("frozen"), "disabled", {
        ...topology("frozen"),
        oldWorkflowPresent: true,
      }).isErr(),
    ).toBe(true);
    expect(
      validateRolloutTuple(declaration("ready"), "enabled", {
        oldWorkflowPresent: false,
        oldWorkflowScheduled: false,
        newWorkflowPresent: false,
        newWorkflowScheduled: false,
      }).isErr(),
    ).toBe(true);
    expect(
      validateRolloutTuple(declaration("frozen"), "disabled", {
        ...topology("frozen"),
        newWorkflowScheduled: false,
      }).isErr(),
    ).toBe(true);
    expect(
      validateRolloutTuple(declaration("frozen"), "disabled", {
        ...topology("frozen"),
        newWorkflowGateDisabled: false,
      }).isErr(),
    ).toBe(true);
    expect(
      validateRolloutTuple(
        { ...declaration("frozen"), freezeRecord: null },
        "disabled",
        topology("frozen"),
      ).isErr(),
    ).toBe(true);
    expect(
      validateRolloutTuple(
        { ...declaration("ready"), activationRecord: null },
        "disabled",
        topology("ready"),
      ).isErr(),
    ).toBe(true);
  });

  it("returns the typed success for every doctor rung", () => {
    const expected = [
      ["pre-cutover", "ReadyForCutover"],
      ["cutover", "CutoverVerified"],
      ["post-bootstrap-frozen", "ReadyForActivation"],
      ["activation-ready", "ActivationReadyVerified"],
      ["final", "FinalVerified"],
    ] as const;
    for (const [mode, status] of expected) {
      const result = verifyDoctorSnapshot(snapshotFor(mode), mode);
      expect(result.isOk()).toBe(true);
      if (result.isOk()) expect(result.value.status).toBe(status);
    }
  });

  it("rejects neighboring tuples for each exact mode", () => {
    const wrong = [
      ["pre-cutover", snapshotFor("final")],
      ["cutover", snapshotFor("pre-cutover")],
      ["post-bootstrap-frozen", snapshotFor("activation-ready")],
      ["activation-ready", snapshotFor("post-bootstrap-frozen")],
      ["final", { ...snapshotFor("final"), rolloutMode: "disabled" }],
    ] as const;
    for (const [mode, snapshot] of wrong)
      doctorFailure(verifyDoctorSnapshot(snapshot, mode));
  });

  it("detects a premature trust switch during the pre-cutover proof", () => {
    const snapshot = snapshotFor("pre-cutover");
    const trustedPublishers = { ...snapshot.trustedPublishers };
    trustedPublishers["@weaveio/weave-cli"] = trust(
      RELEASE_PUBLISH_WORKFLOW_PATH,
    );
    const failure = doctorFailure(
      verifyDoctorSnapshot({ ...snapshot, trustedPublishers }, "pre-cutover"),
    );
    expect(
      failure.failures.some((item) => item.id.includes("trusted-publisher")),
    ).toBe(true);
  });

  it("parses npm's GitHub claims response without weakening exact identity checks", () => {
    const parsed = parseTrustedPublisherResponse({
      id: "trust-1",
      type: "github",
      claims: {
        repository: RELEASE_REPOSITORY,
        workflow_ref: { file: "release-publish.yml" },
      },
    });
    expect(parsed.isOk()).toBe(true);
    if (parsed.isOk())
      expect(parsed.value[0]).toEqual({
        provider: "github-actions",
        workflow: RELEASE_PUBLISH_WORKFLOW_PATH,
        action: "npm publish",
        repository: RELEASE_REPOSITORY,
        environment: null,
      });
  });

  it("fails every named unverifiable or wrong trusted-publisher record", () => {
    const cases: readonly [string, unknown][] = [
      ["wrong filename", trust(RELEASE_WORKFLOW_PATH)],
      [
        "wrong repository",
        [
          {
            ...trust(RELEASE_PUBLISH_WORKFLOW_PATH)[0],
            repository: "other/repo",
          },
        ],
      ],
      [
        "environment restriction",
        [
          {
            ...trust(RELEASE_PUBLISH_WORKFLOW_PATH)[0],
            environment: "release",
          },
        ],
      ],
      [
        "multiple configurations",
        [
          ...trust(RELEASE_PUBLISH_WORKFLOW_PATH),
          ...trust(RELEASE_PUBLISH_WORKFLOW_PATH),
        ],
      ],
      ["unparseable response", "not-json"],
      ["attestation trust", trust(RELEASE_ATTEST_WORKFLOW_PATH)],
    ];
    for (const [name, value] of cases) {
      const snapshot = snapshotFor("final");
      const trustedPublishers = { ...snapshot.trustedPublishers };
      trustedPublishers["@weaveio/weave-cli"] = value;
      const failure = doctorFailure(
        verifyDoctorSnapshot({ ...snapshot, trustedPublishers }, "final"),
      );
      expect(failure.failures.length, name).toBeGreaterThan(0);
    }
    expect(parseTrustedPublisherResponse("not-json").isErr()).toBe(true);
    expect(parseTrustedPublisherResponse(undefined).isErr()).toBe(true);
  });

  it("blocks an attestation workflow that declares workflow_call", () => {
    const failure = doctorFailure(
      verifyDoctorSnapshot(
        {
          ...snapshotFor("final"),
          attestationWorkflow: {
            readable: true,
            present: true,
            declaresWorkflowCall: true,
          },
        },
        "final",
      ),
    );
    expect(
      failure.failures.some(
        (item) => item.id === "github.attestation-workflow",
      ),
    ).toBe(true);
  });

  it("checks stale approvals, team, App, secrets, and setup gates", () => {
    const base = snapshotFor("final");
    const failures = [
      {
        ...base,
        github: {
          ...base.github,
          ruleset: {
            ...base.github.ruleset,
            dismissStalePullRequestApprovals: false,
          },
        },
      },
      {
        ...base,
        github: {
          ...base.github,
          team: { ...base.github.team, slug: "wrong-team" },
        },
      },
      {
        ...base,
        github: {
          ...base.github,
          app: {
            ...base.github.app,
            permissions: {
              contents: "read",
              pullRequests: "write",
              checks: "write",
              members: "read",
            },
          },
        },
      },
      {
        ...base,
        github: {
          ...base.github,
          secrets: {
            ...base.github.secrets,
            environmentNames: {
              ...base.github.secrets.environmentNames,
              "release-ai": [],
            },
          },
        },
      },
      { ...base, harness: { ...base.harness, proofJobsAvailable: false } },
      { ...base, model: { ...base.model, reachable: false } },
      { ...base, policy: { ...base.policy, docsPolicyPassed: false } },
    ];
    for (const snapshot of failures)
      doctorFailure(verifyDoctorSnapshot(snapshot, "final"));
  });

  it("requires protected App credentials in every mutation environment", () => {
    const base = snapshotFor("final");
    const missing = {
      ...base,
      github: {
        ...base.github,
        secrets: {
          ...base.github.secrets,
          environmentNames: {
            ...base.github.secrets.environmentNames,
            "release-refs": [],
          },
        },
      },
    };
    const failure = doctorFailure(verifyDoctorSnapshot(missing, "final"));
    expect(failure.failures[0]?.detail).toContain("release-refs");
    expect(RELEASE_APP_CREDENTIAL_NAMES).toEqual([
      "RELEASE_APP_ID",
      "RELEASE_APP_PRIVATE_KEY",
    ]);
    expect(RELEASE_APP_SECRET_ENVIRONMENTS).toEqual([
      "release-app",
      "docs-audit-patch",
      "release-refs",
    ]);
    expect(REQUIRED_RELEASE_SECRET_NAMES).not.toContain(
      ["RELEASE", "APP", "TOKEN"].join("_"),
    );
  });

  it("rejects obsolete and repository-wide App credential metadata", () => {
    const base = snapshotFor("final");
    const obsoleteName = ["RELEASE", "APP", "TOKEN"].join("_");
    const obsolete = {
      ...base,
      github: {
        ...base.github,
        secrets: {
          ...base.github.secrets,
          repositoryNames: [obsoleteName],
        },
      },
    };
    const obsoleteFailure = doctorFailure(
      verifyDoctorSnapshot(obsolete, "final"),
    );
    expect(obsoleteFailure.failures[0]?.detail).toContain("obsolete");

    const repositoryCredential = {
      ...base,
      github: {
        ...base.github,
        secrets: {
          ...base.github.secrets,
          repositoryNames: ["RELEASE_APP_ID"],
        },
      },
    };
    const repositoryFailure = doctorFailure(
      verifyDoctorSnapshot(repositoryCredential, "final"),
    );
    expect(repositoryFailure.failures[0]?.detail).toContain(
      "repository-wide App credential",
    );
  });

  it("requires old-system operational proof and the old schedule before cutover", () => {
    const noProof = doctorFailure(
      verifyDoctorSnapshot(
        {
          ...snapshotFor("pre-cutover"),
          oldSystem: {
            authoritative: true,
            publicationPathEnabled: true,
            recentSuccessfulRun: false,
            readOnlyPreflight: false,
          },
        },
        "pre-cutover",
      ),
    );
    expect(
      noProof.failures.some(
        (item) => item.id === "release.old-system-operational",
      ),
    ).toBe(true);
    const noSchedule = doctorFailure(
      verifyDoctorSnapshot(
        {
          ...snapshotFor("pre-cutover"),
          topology: { ...topology("pre-cutover"), oldWorkflowScheduled: false },
        },
        "pre-cutover",
      ),
    );
    expect(
      noSchedule.failures.some((item) => item.id === "rollout.tuple"),
    ).toBe(true);
  });

  it("accepts only a positively identified recent scheduled or read-only preflight run", () => {
    const now = DOCTOR_RUN_NOW;
    const common = {
      ...realisticScheduledRun,
      id: 43,
      display_title: "legacy-publisher-scheduled",
      workflow_ref:
        "weave-io/weave/.github/workflows/publish.yml@refs/heads/main",
    };
    const scheduled = recentSuccessfulOldRun(
      listRuns({ ...common, event: "schedule" }),
      now,
    );
    expect(scheduled).toEqual({
      kind: "scheduled",
      runId: 43,
      evidence: "successful scheduled run 43 on protected main",
    });

    const preflight = recentSuccessfulOldRun(
      {
        workflow_runs: [
          {
            ...common,
            id: 44,
            event: "workflow_dispatch",
            display_title: LEGACY_PREFLIGHT_RUN_NAME,
          },
        ],
      },
      now,
    );
    expect(preflight).toEqual({
      kind: "read-only-preflight",
      runId: 44,
      evidence: "successful read-only preflight run 44 on protected main",
    });

    const snapshot = snapshotFor("pre-cutover");
    const result = verifyDoctorSnapshot(
      {
        ...snapshot,
        oldSystem: {
          authoritative: true,
          publicationPathEnabled: true,
          recentSuccessfulRun: false,
          readOnlyPreflight: true,
          runId: 44,
          evidence: "successful read-only preflight run 44 on protected main",
        },
      },
      "pre-cutover",
    );
    expect(result.isOk()).toBe(true);
  });

  it("rejects disabled, arbitrary, ambiguous, wrong-branch, and stale dispatch evidence", () => {
    const now = DOCTOR_RUN_NOW;
    const base = {
      ...realisticScheduledRun,
      id: 45,
      event: "workflow_dispatch",
      display_title: LEGACY_PREFLIGHT_RUN_NAME,
      workflow_ref:
        "weave-io/weave/.github/workflows/publish.yml@refs/heads/main",
    };
    expect(
      recentSuccessfulOldRun(
        {
          workflow_runs: [
            { ...base, display_title: "legacy-publisher-nightly" },
          ],
        },
        now,
      ),
    ).toBeNull();
    expect(
      recentSuccessfulOldRun(
        listRuns(withoutField(base, "display_title")),
        now,
      ),
    ).toBeNull();
    expect(
      recentSuccessfulOldRun(
        {
          workflow_runs: [
            {
              ...base,
              display_title: LEGACY_PREFLIGHT_RUN_NAME,
              run_name: "legacy-publisher-dispatch",
            },
          ],
        },
        now,
      ),
    ).toBeNull();
    expect(
      recentSuccessfulOldRun(
        {
          workflow_runs: [
            {
              ...base,
              display_title: LEGACY_PREFLIGHT_RUN_NAME,
              head_branch: "release/old",
            },
          ],
        },
        now,
      ),
    ).toBeNull();
    expect(
      recentSuccessfulOldRun(
        {
          workflow_runs: [
            {
              ...base,
              display_title: LEGACY_PREFLIGHT_RUN_NAME,
              updated_at: "2026-01-01T00:00:00.000Z",
            },
          ],
        },
        now,
      ),
    ).toBeNull();
  });

  it("accepts realistic GitHub list-runs path forms without workflow_ref", () => {
    const result = recentSuccessfulOldRun(
      listRuns(realisticScheduledRun),
      DOCTOR_RUN_NOW,
    );
    expect(result).toEqual({
      kind: "scheduled",
      runId: 123456789,
      evidence: "successful scheduled run 123456789 on protected main",
    });
    expect(
      recentSuccessfulOldRun(
        listRuns(withoutField(realisticScheduledRun, "run_started_at")),
        DOCTOR_RUN_NOW,
      ),
    ).toEqual(result);
    for (const path of [
      `${RELEASE_WORKFLOW_PATH}@main`,
      `${RELEASE_REPOSITORY}/${RELEASE_WORKFLOW_PATH}@main`,
    ]) {
      expect(
        recentSuccessfulOldRun(
          listRuns({ ...realisticScheduledRun, path }),
          DOCTOR_RUN_NOW,
        ),
      ).toEqual(result);
    }

    const preflight = recentSuccessfulOldRun(
      listRuns({
        ...realisticScheduledRun,
        id: 123456790,
        event: "workflow_dispatch",
        display_title: LEGACY_PREFLIGHT_RUN_NAME,
      }),
      DOCTOR_RUN_NOW,
    );
    expect(preflight).toEqual({
      kind: "read-only-preflight",
      runId: 123456790,
      evidence:
        "successful read-only preflight run 123456790 on protected main",
    });
  });

  it("rejects a run when any required list-runs field is missing", () => {
    const scheduled = realisticScheduledRun as Record<string, unknown>;
    const missing: readonly [string, Record<string, unknown>][] = [
      ["id", withoutField(scheduled, "id")],
      ["path", withoutField(scheduled, "path")],
      ["name", withoutField(scheduled, "name")],
      ["repository.full_name", { ...scheduled, repository: {} }],
      ["head_repository.full_name", { ...scheduled, head_repository: {} }],
      ["head_branch", withoutField(scheduled, "head_branch")],
      ["event", withoutField(scheduled, "event")],
      ["conclusion", withoutField(scheduled, "conclusion")],
      ["created_at", withoutField(scheduled, "created_at")],
      ["updated_at", withoutField(scheduled, "updated_at")],
      ["display_title", withoutField(scheduled, "display_title")],
    ];

    for (const [field, run] of missing)
      expect(
        recentSuccessfulOldRun(listRuns(run), DOCTOR_RUN_NOW),
        field,
      ).toBeNull();

    const missingPreflightDisplay = withoutField(
      { ...scheduled, event: "workflow_dispatch" },
      "display_title",
    );
    expect(
      recentSuccessfulOldRun(listRuns(missingPreflightDisplay), DOCTOR_RUN_NOW),
    ).toBeNull();
  });

  it("rejects a run when an identity or outcome field is wrong", () => {
    const scheduled = realisticScheduledRun as Record<string, unknown>;
    const wrong: readonly [string, Record<string, unknown>][] = [
      ["id", { ...scheduled, id: 0 }],
      ["path", { ...scheduled, path: ".github/workflows/other.yml" }],
      ["name", { ...scheduled, name: "Other workflow" }],
      [
        "repository.full_name",
        { ...scheduled, repository: { full_name: "attacker/repo" } },
      ],
      [
        "head_repository.full_name",
        { ...scheduled, head_repository: { full_name: "attacker/repo" } },
      ],
      ["head_branch", { ...scheduled, head_branch: "release/old" }],
      ["event", { ...scheduled, event: "push" }],
      ["conclusion", { ...scheduled, conclusion: "failure" }],
      ["created_at", { ...scheduled, created_at: "not-a-timestamp" }],
      ["updated_at", { ...scheduled, updated_at: "not-a-timestamp" }],
    ];

    for (const [field, run] of wrong)
      expect(
        recentSuccessfulOldRun(listRuns(run), DOCTOR_RUN_NOW),
        field,
      ).toBeNull();

    expect(
      recentSuccessfulOldRun(
        listRuns({
          ...scheduled,
          event: "workflow_dispatch",
          display_title: "not-the-read-only-preflight",
        }),
        DOCTOR_RUN_NOW,
      ),
    ).toBeNull();
    expect(
      recentSuccessfulOldRun(
        listRuns({
          ...scheduled,
          workflow_ref:
            "weave-io/weave/.github/workflows/other.yml@refs/heads/main",
        }),
        DOCTOR_RUN_NOW,
      ),
    ).toBeNull();
  });

  it("keeps npm trust verification independent from preflight evidence", () => {
    const base = snapshotFor("pre-cutover");
    const trustedPublishers = { ...base.trustedPublishers };
    trustedPublishers["@weaveio/weave-cli"] = trust(
      RELEASE_PUBLISH_WORKFLOW_PATH,
    );
    const failure = doctorFailure(
      verifyDoctorSnapshot(
        {
          ...base,
          oldSystem: {
            authoritative: true,
            publicationPathEnabled: true,
            recentSuccessfulRun: false,
            readOnlyPreflight: true,
            runId: 44,
            evidence: "successful read-only preflight run 44 on protected main",
          },
          trustedPublishers,
        },
        "pre-cutover",
      ),
    );
    expect(
      failure.failures.some((item) =>
        item.id.startsWith("npm.trusted-publisher."),
      ),
    ).toBe(true);
  });

  it("reports orphan, creation-cleanup, marker-cleanup, incomplete, and incident states", () => {
    const base = snapshotFor("final");
    const orphan = doctorFailure(
      verifyDoctorSnapshot(
        {
          ...base,
          lifecycle: {
            ...base.lifecycle,
            marker: {
              present: true,
              ownerGeneration: OWNER,
              plannedBaseSha: OTHER_SHA,
              markerSha: SHA,
              openReleasePr: false,
              creationPollExhausted: true,
            },
          },
        },
        "final",
      ),
    );
    expect(orphan.failures[0]?.fix).toContain("stable-resume");

    const cleanup = doctorFailure(
      verifyDoctorSnapshot(
        {
          ...base,
          lifecycle: {
            ...base.lifecycle,
            marker: {
              present: true,
              ownerGeneration: OWNER,
              plannedBaseSha: OTHER_SHA,
              markerSha: SHA,
              openReleasePr: false,
              recordedCleanup: ownership({ ownerGeneration: "d".repeat(64) }),
            },
          },
        },
        "final",
      ),
    );
    expect(cleanup.failures[0]?.detail).toContain("stale cleanup generation");

    const markerCleanup = doctorFailure(
      verifyDoctorSnapshot(
        {
          ...base,
          lifecycle: {
            ...base.lifecycle,
            marker: {
              present: true,
              ownerGeneration: OWNER,
              plannedBaseSha: OTHER_SHA,
              markerSha: SHA,
              openReleasePr: false,
              associatedPullRequestSettled: true,
            },
          },
        },
        "final",
      ),
    );
    expect(markerCleanup.failures[0]?.detail).toContain("MarkerCleanupPending");

    const incomplete = doctorFailure(
      verifyDoctorSnapshot(
        {
          ...base,
          lifecycle: {
            ...base.lifecycle,
            discovered: [mergedDiscovery("PendingNpm")],
          },
        },
        "final",
      ),
    );
    expect(incomplete.failures[0]?.fix).toContain("stable-resume");

    const incident = doctorFailure(
      verifyDoctorSnapshot(
        {
          ...base,
          lifecycle: {
            ...base.lifecycle,
            discovered: [mergedDiscovery("IntegrityIncident")],
            mergedRelease: {
              state: "IntegrityIncident",
              markerCleanupPending: false,
              incidentAuthorizationRecordPresent: true,
              incidentDeprecatedVerified: false,
            },
          },
        },
        "final",
      ),
    );
    expect(incident.failures[0]?.fix).toContain("incident-resolution");
    expect(incident.failures[0]?.fix).toContain("interactive");
  });

  it("fails closed on malformed snapshot input", () => {
    const result = verifyDoctorSnapshot({ declaration: {} }, "final");
    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.type).toBe("InvalidDoctorSnapshot");
  });

  it("keeps the release doctor root in the production inventory", () => {
    expect(
      PRODUCTION_ENTRYPOINTS.some(
        (entry) => entry.path === "scripts/release/doctor.ts",
      ),
    ).toBe(true);
  });
});
