import { describe, expect, it } from "bun:test";
import { okAsync } from "neverthrow";
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
  collectAuthoritativeReleaseLifecycle,
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
import {
  RELEASE_PR_ENVELOPE_SCHEMA_VERSION,
  RELEASE_PR_LABEL,
  type ReleasePrOwnership,
  renderReleasePrEnvelope,
} from "../release-pr-contract.js";
import type { DiscoveredRelease, ReleaseAuthority } from "../release-state.js";
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
const MERGE_SHA = "d".repeat(40);
const TREE_SHA = "f".repeat(40);
const DIGEST = `sha256:${"e".repeat(64)}`;
const BAD_DIGEST = `sha256:${"f".repeat(64)}`;
const DOCTOR_RUN_NOW = Date.parse("2026-08-19T00:00:00.000Z");

interface LifecycleRoute {
  readonly status?: number;
  readonly body?: unknown;
  readonly reject?: string;
}

function lifecycleFetch(routes: Record<string, LifecycleRoute>) {
  const calls: { method: string; url: string }[] = [];
  const fetchImpl = async (input: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({ method, url: input });
    const path = input.replace("https://api.github.com", "");
    const route = routes[`${method} ${path}`];
    if (route?.reject !== undefined) throw new Error(route.reject);
    if (route === undefined)
      return new Response("{}", { status: 404, statusText: "Not Found" });
    return new Response(JSON.stringify(route.body ?? {}), {
      status: route.status ?? 200,
      statusText: route.status === 500 ? "Internal Server Error" : "OK",
    });
  };
  return { calls, fetchImpl };
}

function lifecycleRoutes(
  marker: string | null,
  open: readonly Record<string, unknown>[],
  closed: readonly Record<string, unknown>[],
  message?: string,
) {
  return {
    [`GET /repos/${RELEASE_REPOSITORY}/git/ref/heads/${RELEASE_PR_MARKER_REF}`]:
      marker === null ? { status: 404 } : { body: { object: { sha: marker } } },
    [`GET /repos/${RELEASE_REPOSITORY}/pulls?state=open&per_page=100&head=weave-io%3Arelease-pr%2Fstable`]:
      { body: open },
    [`GET /repos/${RELEASE_REPOSITORY}/pulls?state=closed&per_page=100&head=weave-io%3Arelease-pr%2Fstable`]:
      { body: closed },
    ...(marker === null
      ? {}
      : {
          [`GET /repos/${RELEASE_REPOSITORY}/git/commits/${marker}`]: {
            body: { message: message ?? "" },
          },
        }),
  } satisfies Record<string, LifecycleRoute>;
}

function productionAuthorityWorld(published = false) {
  const routes: Record<string, LifecycleRoute> = lifecycleRoutes(
    null,
    [],
    [mergedPull()],
  );
  for (const [packageName, packageInfo] of Object.entries(PUBLIC_PACKAGES)) {
    const version =
      packageName === "@weaveio/weave-adapter-pi" ? "0.0.1" : "0.1.0";
    const path = `${packageInfo.directory}/package.json`;
    routes[
      `GET /repos/${RELEASE_REPOSITORY}/contents/${path}?ref=${MERGE_SHA}`
    ] = {
      body: {
        type: "file",
        encoding: "base64",
        content: btoa(JSON.stringify({ version })),
      },
    };
  }
  routes[`GET /repos/${RELEASE_REPOSITORY}/git/commits/${MERGE_SHA}`] = {
    body: { tree: { sha: TREE_SHA } },
  };
  routes[`GET /repos/${RELEASE_REPOSITORY}/git/trees/${TREE_SHA}?recursive=1`] =
    {
      body: { truncated: false, tree: [] },
    };
  const world = lifecycleFetch(routes);
  const registryCalls: string[] = [];
  const registryFetch = async (input: string, init?: RequestInit) => {
    registryCalls.push(`${init?.method ?? "GET"} ${input}`);
    if (!published)
      return new Response("not found", {
        status: 404,
        statusText: "Not Found",
      });
    const url = new URL(input);
    const packageName = decodeURIComponent(url.pathname.split("/")[1] ?? "");
    const tarball = `https://registry.npmjs.org/${packageName}/-/${packageName.split("/").pop()}-${url.pathname.split("/").pop()}.tgz`;
    if (url.pathname.endsWith(".tgz"))
      return new Response("published tarball", { status: 200 });
    return new Response(JSON.stringify({ dist: { tarball } }), { status: 200 });
  };
  return { ...world, registryCalls, registryFetch };
}

function markerEnvelope(baseSha = OTHER_SHA) {
  return renderReleasePrEnvelope({
    schemaVersion: RELEASE_PR_ENVELOPE_SCHEMA_VERSION,
    ref: RELEASE_PR_MARKER_REF,
    ownerGeneration: OWNER,
    plannedBaseSha: baseSha,
    baseSha,
    regeneratedFrom: [],
    entryProse: [],
    evidenceDigest: DIGEST,
  })._unsafeUnwrap();
}

function mergedPull(number = 7) {
  return {
    number,
    html_url: `https://github.com/${RELEASE_REPOSITORY}/pull/${number}`,
    state: "closed",
    merged: true,
    merged_at: "2026-08-19T00:00:00.000Z",
    closed_at: "2026-08-19T00:00:00.000Z",
    created_at: "2026-08-18T00:00:00.000Z",
    updated_at: "2026-08-19T00:00:00.000Z",
    merge_commit_sha: MERGE_SHA,
    title: "release",
    body: "",
    head: { ref: "release-pr/stable", sha: SHA },
    base: { ref: "main", sha: OTHER_SHA },
    labels: [{ name: RELEASE_PR_LABEL }],
  };
}

function authorityFor(primary: "pending" | "incident"): ReleaseAuthority {
  return {
    pullRequest: {
      number: 7,
      url: `https://github.com/${RELEASE_REPOSITORY}/pull/7`,
      merged: true,
      closed: true,
      mergeCommitSha: MERGE_SHA,
      headRef: "release-pr/stable",
    },
    releasedSha: MERGE_SHA,
    channel: "stable",
    members: [
      {
        packageName: "@weaveio/weave-cli",
        version: "0.1.0",
        published: primary === "incident",
        registryDigest: primary === "incident" ? DIGEST : null,
        provenanceSubjectDigest: primary === "incident" ? DIGEST : null,
        recordedDigest: null,
        deprecated: null,
        cacheDigest: primary === "pending" ? DIGEST : null,
        cacheValid: primary === "pending",
        rebuiltDigest: primary === "incident" ? BAD_DIGEST : null,
        proofChainComplete: primary === "pending",
        registryVerified: primary === "incident",
      },
    ],
    tags: {},
    releases: {},
    cleanupMerged: false,
    cleanupRequired: false,
    markerPresent: false,
    markerSha: null,
    associatedPullRequestSettled: false,
    incident:
      primary === "incident"
        ? {
            requiredMessage: "incident",
            affected: [
              {
                packageName: "@weaveio/weave-cli",
                version: "0.1.0",
                digest: DIGEST,
              },
            ],
            checkRunAtReleasedSha: false,
            releasesCarryNotice: false,
            deprecationsMatch: false,
          }
        : null,
    comments: ["synthetic completion comment"],
  };
}

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

  it("collects authoritative no-release state without writes", async () => {
    const world = lifecycleFetch(lifecycleRoutes(null, [], []));
    const result = await collectAuthoritativeReleaseLifecycle({
      token: "token",
      fetchImpl: world.fetchImpl,
    });
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.authoritative).toBe(true);
      expect(result.value.marker).toEqual({
        present: false,
        openReleasePr: false,
        associatedPullRequestSettled: false,
        creationPollExhausted: false,
        markerCleanupPending: false,
      });
      expect(result.value.discovered).toEqual([]);
    }
    expect(world.calls.length).toBeGreaterThan(0);
    expect(world.calls).toContainEqual({
      method: "GET",
      url: `https://api.github.com/repos/${RELEASE_REPOSITORY}/git/ref/heads/${RELEASE_PR_MARKER_REF}`,
    });
    expect(world.calls.every((call) => call.method === "GET")).toBe(true);
  });

  it("uses the production Task 14 reader from merged source and only reads", async () => {
    const world = productionAuthorityWorld();
    const result = await collectAuthoritativeReleaseLifecycle({
      token: "token",
      fetchImpl: world.fetchImpl,
      registryFetch: world.registryFetch,
    });
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.authoritative).toBe(true);
      expect(result.value.mergedRelease?.state).toBe("PendingArtifactsOrProof");
      expect(result.value.discovered?.[0]).toMatchObject({
        kind: "merged-release",
        case: "no-packages-published",
      });
    }
    expect(world.calls.every((call) => call.method === "GET")).toBe(true);
    expect(world.registryCalls.every((call) => call.startsWith("GET "))).toBe(
      true,
    );
    expect(world.calls.some((call) => call.method !== "GET")).toBe(false);
    expect(world.registryCalls.some((call) => !call.startsWith("GET "))).toBe(
      false,
    );
  });

  it("does not turn a registry readback into Task 14 verification", async () => {
    const world = productionAuthorityWorld(true);
    const result = await collectAuthoritativeReleaseLifecycle({
      token: "token",
      fetchImpl: world.fetchImpl,
      registryFetch: world.registryFetch,
    });
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.mergedRelease?.state).toBe(
        "PendingRegistryVerification",
      );
      expect(result.value.discovered?.[0]).toMatchObject({
        kind: "merged-release",
        case: "registry-verification-incomplete",
      });
    }
    expect(world.calls.every((call) => call.method === "GET")).toBe(true);
    expect(world.registryCalls.every((call) => call.startsWith("GET "))).toBe(
      true,
    );
  });

  it("keeps an open marker and release PR authoritative without mutation", async () => {
    const marker = SHA;
    const envelope = markerEnvelope();
    const open = {
      number: 12,
      html_url: `https://github.com/${RELEASE_REPOSITORY}/pull/12`,
      state: "open",
      title: "release",
      body: envelope,
      created_at: "2026-08-18T00:00:00.000Z",
      updated_at: "2026-08-19T00:00:00.000Z",
      closed_at: null,
      merged_at: null,
      merge_commit_sha: null,
      head: { ref: "release-pr/stable", sha: marker },
      base: { ref: "main", sha: OTHER_SHA },
      labels: [{ name: RELEASE_PR_LABEL }],
    };
    const world = lifecycleFetch(lifecycleRoutes(marker, [open], [], envelope));
    const result = await collectAuthoritativeReleaseLifecycle({
      token: "token",
      fetchImpl: world.fetchImpl,
    });
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.authoritative).toBe(true);
      expect(result.value.marker.present).toBe(true);
      expect(result.value.marker.openReleasePr).toBe(true);
      expect(result.value.marker.ownerGeneration).toBe(OWNER);
      expect(result.value.discovered).toEqual([]);
    }
    expect(world.calls.every((call) => call.method === "GET")).toBe(true);
  });

  it("separates a live orphan from a recorded CreationCleanupPending identity", async () => {
    const marker = SHA;
    const envelope = markerEnvelope();
    const orphanWorld = lifecycleFetch(
      lifecycleRoutes(marker, [], [], envelope),
    );
    const orphan = await collectAuthoritativeReleaseLifecycle({
      token: "token",
      fetchImpl: orphanWorld.fetchImpl,
    });
    expect(orphan.isOk()).toBe(true);
    if (orphan.isOk()) {
      expect(orphan.value.discovered).toEqual([]);
      expect(orphan.value.marker.creationPollExhausted).toBe(true);
      expect(orphan.value.marker.recordedCleanup).toBeUndefined();
    }

    const recordedWorld = lifecycleFetch(
      lifecycleRoutes(marker, [], [], envelope),
    );
    const recorded = await collectAuthoritativeReleaseLifecycle({
      token: "token",
      fetchImpl: recordedWorld.fetchImpl,
      readCreationCleanupIdentity: () => okAsync(ownership()),
    });
    expect(recorded.isOk()).toBe(true);
    if (recorded.isOk()) {
      expect(recorded.value.marker.recordedCleanup).toEqual(ownership());
      expect(recorded.value.discovered).toEqual([
        { kind: "creation-cleanup-pending", ownership: ownership() },
      ]);
    }
    expect(recordedWorld.calls.every((call) => call.method === "GET")).toBe(
      true,
    );

    const malformedWorld = lifecycleFetch(
      lifecycleRoutes(marker, [], [], envelope),
    );
    const malformed = await collectAuthoritativeReleaseLifecycle({
      token: "token",
      fetchImpl: malformedWorld.fetchImpl,
      readCreationCleanupIdentity: () => okAsync({} as ReleasePrOwnership),
    });
    expect(malformed.isErr()).toBe(true);
    if (malformed.isErr())
      expect(malformed.error.operation).toContain(
        "release.lifecycle.read creation cleanup",
      );
  });

  it("requires a unique exact stable PR association", async () => {
    const marker = SHA;
    const envelope = markerEnvelope();
    const unlabeled = {
      ...mergedPull(),
      head: { ref: RELEASE_PR_MARKER_REF, sha: marker },
      labels: [],
    };
    const orphanWorld = lifecycleFetch(
      lifecycleRoutes(marker, [], [unlabeled], envelope),
    );
    const orphan = await collectAuthoritativeReleaseLifecycle({
      token: "token",
      fetchImpl: orphanWorld.fetchImpl,
    });
    expect(orphan.isOk()).toBe(true);
    if (orphan.isOk()) {
      expect(orphan.value.marker.associatedPullRequestSettled).toBe(false);
      expect(orphan.value.marker.creationPollExhausted).toBe(true);
      expect(orphan.value.discovered).toEqual([]);
    }

    const duplicateLabelWorld = lifecycleFetch(
      lifecycleRoutes(
        marker,
        [],
        [
          {
            ...mergedPull(),
            head: { ref: RELEASE_PR_MARKER_REF, sha: marker },
            labels: [{ name: RELEASE_PR_LABEL }, { name: RELEASE_PR_LABEL }],
          },
        ],
        envelope,
      ),
    );
    const duplicateLabel = await collectAuthoritativeReleaseLifecycle({
      token: "token",
      fetchImpl: duplicateLabelWorld.fetchImpl,
    });
    expect(duplicateLabel.isOk()).toBe(true);
    if (duplicateLabel.isOk())
      expect(duplicateLabel.value.marker.associatedPullRequestSettled).toBe(
        false,
      );

    const duplicateOne = {
      ...mergedPull(7),
      head: { ref: RELEASE_PR_MARKER_REF, sha: marker },
    };
    const duplicateTwo = {
      ...mergedPull(8),
      head: { ref: RELEASE_PR_MARKER_REF, sha: marker },
    };
    const duplicateWorld = lifecycleFetch(
      lifecycleRoutes(marker, [], [duplicateOne, duplicateTwo], envelope),
    );
    const duplicate = await collectAuthoritativeReleaseLifecycle({
      token: "token",
      fetchImpl: duplicateWorld.fetchImpl,
    });
    expect(duplicate.isErr()).toBe(true);
    if (duplicate.isErr())
      expect(duplicate.error.message).toContain("more than one exact stable");
  });

  it("binds every Task 14 result field to the requested PR identity", async () => {
    const foreign = authorityFor("pending");
    const variants: readonly [string, ReleaseAuthority][] = [
      [
        "number",
        {
          ...foreign,
          pullRequest: {
            ...foreign.pullRequest,
            number: 8,
            url: `https://github.com/${RELEASE_REPOSITORY}/pull/8`,
          },
        },
      ],
      [
        "canonical URL/repo",
        {
          ...foreign,
          pullRequest: {
            ...foreign.pullRequest,
            url: "https://github.com/other/repo/pull/7",
          },
        },
      ],
      [
        "merge SHA",
        {
          ...foreign,
          pullRequest: {
            ...foreign.pullRequest,
            mergeCommitSha: OTHER_SHA,
          },
        },
      ],
      ["released SHA", { ...foreign, releasedSha: OTHER_SHA }],
      [
        "stable head ref",
        {
          ...foreign,
          pullRequest: { ...foreign.pullRequest, headRef: "other" },
        },
      ],
      [
        "merged state",
        {
          ...foreign,
          pullRequest: { ...foreign.pullRequest, merged: false },
        },
      ],
      [
        "closed state",
        {
          ...foreign,
          pullRequest: { ...foreign.pullRequest, closed: false },
        },
      ],
    ];
    for (const [field, authority] of variants) {
      const world = lifecycleFetch(lifecycleRoutes(null, [], [mergedPull()]));
      const result = await collectAuthoritativeReleaseLifecycle({
        token: "token",
        fetchImpl: world.fetchImpl,
        readAuthority: () => okAsync(authority),
      });
      expect(result.isErr(), field).toBe(true);
      if (result.isErr()) {
        expect(result.error.operation, field).toContain(
          "release.lifecycle.state",
        );
      }
      expect(
        world.calls.every((call) => call.method === "GET"),
        field,
      ).toBe(true);
    }
  });

  it("runs merged non-terminal and incident states through Task 14", async () => {
    for (const [kind, authority] of [
      ["pending", authorityFor("pending")],
      ["incident", authorityFor("incident")],
    ] as const) {
      const world = lifecycleFetch(lifecycleRoutes(null, [], [mergedPull()]));
      const result = await collectAuthoritativeReleaseLifecycle({
        token: "token",
        fetchImpl: world.fetchImpl,
        readAuthority: () => okAsync(authority),
      });
      expect(result.isOk(), kind).toBe(true);
      if (result.isOk()) {
        expect(result.value.authoritative, kind).toBe(true);
        expect(result.value.mergedRelease?.state, kind).toBe(
          kind === "pending" ? "PendingNpm" : "IntegrityIncident",
        );
        expect(result.value.discovered?.[0]?.kind, kind).toBe("merged-release");
      }
      expect(
        world.calls.every((call) => call.method === "GET"),
        kind,
      ).toBe(true);
    }
  });

  it("fails closed when a merged release has no Task 14 authority", async () => {
    const world = lifecycleFetch(lifecycleRoutes(null, [], [mergedPull()]));
    const result = await collectAuthoritativeReleaseLifecycle({
      token: "token",
      fetchImpl: world.fetchImpl,
    });
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe("DoctorPortFailed");
      expect(result.error.operation).toContain("release.lifecycle.state");
      expect(result.error.message).toContain("packages/cli/package.json");
    }
    expect(world.calls.every((call) => call.method === "GET")).toBe(true);
  });

  it("fails closed with a typed result when GitHub lifecycle reads fail", async () => {
    const world = lifecycleFetch({
      [`GET /repos/${RELEASE_REPOSITORY}/git/ref/heads/${RELEASE_PR_MARKER_REF}`]:
        {
          status: 500,
        },
    });
    const result = await collectAuthoritativeReleaseLifecycle({
      token: "token",
      fetchImpl: world.fetchImpl,
    });
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe("DoctorPortFailed");
      expect(result.error.operation).toContain("release.lifecycle");
      expect(result.error.message).toContain("500");
    }
    expect(world.calls.every((call) => call.method === "GET")).toBe(true);
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
