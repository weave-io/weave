import { describe, expect, it } from "bun:test";
import {
  PUBLIC_PACKAGES,
  type PublicPackageName,
  RELEASE_ATTEST_WORKFLOW_PATH,
  RELEASE_PR_MARKER_REF,
  RELEASE_PUBLISH_WORKFLOW_PATH,
  RELEASE_REPOSITORY,
} from "../constants.js";
import { collectAuthoritativeReleaseLifecycle } from "../doctor-lifecycle.js";
import {
  INCIDENT_CHECK_RUN_NAME,
  incidentNoticeFor,
} from "../incident-resolution.js";
import { releaseTagName } from "../notes-wrapper.js";
import { RELEASE_PR_LABEL } from "../release-pr-contract.js";

const MERGE_SHA = "d".repeat(40);
const MAIN_SHA = "b".repeat(40);
const TREE_SHA = "f".repeat(40);
const MAIN_TREE_SHA = "9".repeat(40);
const OTHER_SHA = "3".repeat(40);
const VERSION = "0.1.0";
const CHANGESET = ".changeset/lucky-mice-smile.md";

const PACKAGE_NAMES = Object.keys(PUBLIC_PACKAGES) as PublicPackageName[];

// ---------------------------------------------------------------------------
// Fixture world
// ---------------------------------------------------------------------------

type ProvenanceMode =
  | "bound"
  | "absent"
  | "foreign-commit"
  | "foreign-subject"
  | "unreadable"
  | "malformed";

interface WorldOptions {
  readonly published?: boolean;
  readonly provenance?: ProvenanceMode;
  readonly tags?: boolean;
  readonly releases?: boolean;
  readonly releaseNotes?: string;
  readonly deprecated?: string | null;
  readonly changesetsAtRelease?: readonly string[];
  readonly changesetsOnMain?: readonly string[];
  readonly mainAncestry?: "behind" | "diverged";
  readonly incident?: {
    readonly affectedProvenanceDigest?: string;
    readonly affectedRegistryDigest?: string;
    readonly conclusion?: string | null;
    readonly status?: string;
    readonly text?: string;
    readonly releasedSha?: string;
    readonly duplicate?: boolean;
  };
  readonly publishArtifacts?: boolean;
  readonly attestSuccess?: boolean;
  readonly tarballBody?: string;
  readonly integrity?: string;
  readonly tarballUrl?: string;
  readonly registryStatus?: number;
}

const TARBALL_BODY = "weave release tarball bytes";

function sha256Digest(body: string): string {
  return `sha256:${new Bun.CryptoHasher("sha256").update(body).digest("hex")}`;
}

function sha512Hex(body: string): string {
  return new Bun.CryptoHasher("sha512").update(body).digest("hex");
}

function base64(value: string): string {
  return Buffer.from(value, "utf8").toString("base64");
}

function attestationDocument(
  packageName: string,
  subjectSha512: string,
  commit: string,
  repositoryUri = `git+https://github.com/${RELEASE_REPOSITORY}`,
): unknown {
  const statement = {
    _type: "https://in-toto.io/Statement/v1",
    subject: [
      {
        name: `pkg:npm/${packageName}@${VERSION}`,
        digest: { sha512: subjectSha512 },
      },
    ],
    predicateType: "https://slsa.dev/provenance/v1",
    predicate: {
      buildDefinition: {
        externalParameters: {},
        resolvedDependencies: [
          {
            uri: `${repositoryUri}@refs/heads/main`,
            digest: { gitCommit: commit },
          },
        ],
      },
    },
  };
  return {
    attestations: [
      {
        predicateType: "https://slsa.dev/provenance/v1",
        bundle: {
          dsseEnvelope: {
            payloadType: "application/vnd.in-toto+json",
            payload: base64(JSON.stringify(statement)),
          },
        },
      },
    ],
  };
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
    head: { ref: RELEASE_PR_MARKER_REF, sha: "a".repeat(40) },
    base: { ref: "main", sha: OTHER_SHA },
    labels: [{ name: RELEASE_PR_LABEL }],
  };
}

function treeBody(paths: readonly string[]) {
  return {
    truncated: false,
    tree: paths.map((path) => ({ path, type: "blob" })),
  };
}

interface World {
  readonly calls: { method: string; url: string }[];
  readonly registryCalls: string[];
  readonly fetchImpl: (input: string, init?: RequestInit) => Promise<Response>;
  readonly registryFetch: (
    input: string,
    init?: RequestInit,
  ) => Promise<Response>;
  readonly requiredMessage: string;
}

function buildWorld(options: WorldOptions = {}): World {
  const published = options.published ?? false;
  const tarballBody = options.tarballBody ?? TARBALL_BODY;
  const registryDigest = sha256Digest(tarballBody);
  const requiredMessage = incidentNoticeFor(MERGE_SHA);
  const changesetsAtRelease = options.changesetsAtRelease ?? [];
  const changesetsOnMain = options.changesetsOnMain ?? [];

  const routes: Record<string, { status?: number; body?: unknown }> = {
    [`GET /repos/${RELEASE_REPOSITORY}/git/ref/heads/${RELEASE_PR_MARKER_REF}`]:
      { status: 404 },
    [`GET /repos/${RELEASE_REPOSITORY}/pulls?state=open&per_page=100&head=weave-io%3Arelease-pr%2Fstable`]:
      { body: [] },
    [`GET /repos/${RELEASE_REPOSITORY}/pulls?state=closed&per_page=100&head=weave-io%3Arelease-pr%2Fstable`]:
      { body: [mergedPull()] },
    [`GET /repos/${RELEASE_REPOSITORY}/git/commits/${MERGE_SHA}`]: {
      body: { tree: { sha: TREE_SHA } },
    },
    [`GET /repos/${RELEASE_REPOSITORY}/git/trees/${TREE_SHA}?recursive=1`]: {
      body: treeBody(changesetsAtRelease),
    },
    [`GET /repos/${RELEASE_REPOSITORY}/compare/${MERGE_SHA}...main`]: {
      body: { status: options.mainAncestry ?? "behind" },
    },
    [`GET /repos/${RELEASE_REPOSITORY}/git/ref/heads/main`]: {
      body: { object: { sha: MAIN_SHA } },
    },
    [`GET /repos/${RELEASE_REPOSITORY}/git/commits/${MAIN_SHA}`]: {
      body: { tree: { sha: MAIN_TREE_SHA } },
    },
    [`GET /repos/${RELEASE_REPOSITORY}/git/trees/${MAIN_TREE_SHA}?recursive=1`]:
      { body: treeBody(changesetsOnMain) },
  };

  for (const [packageName, info] of Object.entries(PUBLIC_PACKAGES)) {
    routes[
      `GET /repos/${RELEASE_REPOSITORY}/contents/${info.directory}/package.json?ref=${MERGE_SHA}`
    ] = {
      body: {
        type: "file",
        encoding: "base64",
        content: base64(JSON.stringify({ version: VERSION })),
      },
    };
    const tag = releaseTagName(packageName as PublicPackageName, VERSION);
    if (options.tags === true)
      routes[`GET /repos/${RELEASE_REPOSITORY}/git/ref/tags/${tag}`] = {
        body: { object: { sha: MERGE_SHA } },
      };
    if (options.releases === true)
      routes[
        `GET /repos/${RELEASE_REPOSITORY}/releases/tags/${encodeURIComponent(tag)}`
      ] = {
        body: {
          id: 1,
          tag_name: tag,
          target_commitish: MERGE_SHA,
          body: options.releaseNotes ?? "notes",
          draft: false,
          immutable: true,
          assets: [],
        },
      };
  }

  const publishFile = RELEASE_PUBLISH_WORKFLOW_PATH.split("/").pop() ?? "";
  const attestFile = RELEASE_ATTEST_WORKFLOW_PATH.split("/").pop() ?? "";
  routes[
    `GET /repos/${RELEASE_REPOSITORY}/actions/workflows/${publishFile}/runs?head_sha=${MERGE_SHA}&per_page=100`
  ] = {
    body:
      options.publishArtifacts === true
        ? {
            total_count: 1,
            workflow_runs: [
              {
                id: 11,
                event: "workflow_dispatch",
                status: "completed",
                conclusion: "success",
                head_sha: MERGE_SHA,
              },
            ],
          }
        : { total_count: 0, workflow_runs: [] },
  };
  routes[`GET /repos/${RELEASE_REPOSITORY}/actions/runs/11/artifacts`] = {
    body: {
      total_count: 1,
      artifacts: [
        {
          id: 21,
          name: "release-payload",
          digest: sha256Digest("payload"),
          expired: false,
          size_in_bytes: 128,
        },
      ],
    },
  };
  routes[
    `GET /repos/${RELEASE_REPOSITORY}/actions/workflows/${attestFile}/runs?head_sha=${MERGE_SHA}&per_page=100`
  ] = {
    body:
      options.attestSuccess === true
        ? {
            total_count: 1,
            workflow_runs: [
              {
                id: 12,
                event: "workflow_run",
                status: "completed",
                conclusion: "success",
                head_sha: MERGE_SHA,
              },
            ],
          }
        : { total_count: 0, workflow_runs: [] },
  };

  const incident = options.incident;
  const checkRuns: unknown[] = [];
  if (incident !== undefined) {
    const record = {
      schemaVersion: 1,
      releasedSha: incident.releasedSha ?? MERGE_SHA,
      requiredMessage,
      affected: [
        {
          packageName: PACKAGE_NAMES[0],
          version: VERSION,
          digest: incident.affectedRegistryDigest ?? registryDigest,
          provenanceSubjectDigest:
            incident.affectedProvenanceDigest ?? `sha256:${"1".repeat(64)}`,
        },
      ],
      generatedAt: "2026-08-19T00:00:00.000Z",
    };
    const run = {
      id: 31,
      name: INCIDENT_CHECK_RUN_NAME,
      status: incident.status ?? "completed",
      conclusion:
        incident.conclusion === undefined ? "success" : incident.conclusion,
      head_sha: MERGE_SHA,
      output: {
        title: "integrity incident",
        summary: requiredMessage,
        text: incident.text ?? JSON.stringify(record),
      },
    };
    checkRuns.push(run);
    if (incident.duplicate === true) checkRuns.push({ ...run, id: 32 });
  }
  routes[
    `GET /repos/${RELEASE_REPOSITORY}/commits/${MERGE_SHA}/check-runs?check_name=${encodeURIComponent(INCIDENT_CHECK_RUN_NAME)}&per_page=100`
  ] = { body: { total_count: checkRuns.length, check_runs: checkRuns } };

  const calls: { method: string; url: string }[] = [];
  const fetchImpl = async (input: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({ method, url: input });
    const path = input.replace("https://api.github.com", "");
    const route = routes[`${method} ${path}`];
    if (route === undefined)
      return new Response("{}", { status: 404, statusText: "Not Found" });
    return new Response(JSON.stringify(route.body ?? {}), {
      status: route.status ?? 200,
      statusText: route.status === 500 ? "Internal Server Error" : "OK",
    });
  };

  const registryCalls: string[] = [];
  const registryFetch = async (input: string, init?: RequestInit) => {
    registryCalls.push(`${init?.method ?? "GET"} ${input}`);
    const url = new URL(input);
    if (url.pathname.startsWith("/-/npm/v1/attestations/")) {
      const mode = options.provenance ?? "absent";
      if (mode === "absent") return new Response("not found", { status: 404 });
      if (mode === "unreadable") return new Response("boom", { status: 500 });
      if (mode === "malformed")
        return new Response(JSON.stringify({ attestations: "nope" }), {
          status: 200,
        });
      const target = decodeURIComponent(
        url.pathname.slice("/-/npm/v1/attestations/".length),
      );
      const packageName = target.slice(0, target.lastIndexOf("@"));
      const subject =
        mode === "foreign-subject"
          ? sha512Hex("other bytes entirely")
          : sha512Hex(tarballBody);
      const commit = mode === "foreign-commit" ? OTHER_SHA : MERGE_SHA;
      return new Response(
        JSON.stringify(attestationDocument(packageName, subject, commit)),
        { status: 200 },
      );
    }
    if (!published) return new Response("not found", { status: 404 });
    if (options.registryStatus !== undefined)
      return new Response("boom", { status: options.registryStatus });
    if (url.pathname.endsWith(".tgz"))
      return new Response(tarballBody, { status: 200 });
    const packageName = decodeURIComponent(url.pathname.split("/")[1] ?? "");
    const unscoped = packageName.split("/").pop();
    const tarball =
      options.tarballUrl ??
      `https://registry.npmjs.org/${packageName}/-/${unscoped}-${VERSION}.tgz`;
    const isAffected = packageName === PACKAGE_NAMES[0];
    return new Response(
      JSON.stringify({
        dist: {
          tarball,
          ...(options.integrity === undefined
            ? {}
            : { integrity: options.integrity }),
        },
        ...(options.deprecated === undefined || options.deprecated === null
          ? {}
          : { deprecated: isAffected ? options.deprecated : undefined }),
      }),
      { status: 200 },
    );
  };

  return { calls, registryCalls, fetchImpl, registryFetch, requiredMessage };
}

function run(world: World) {
  return collectAuthoritativeReleaseLifecycle({
    token: "token",
    fetchImpl: world.fetchImpl,
    registryFetch: world.registryFetch,
  });
}

function expectReadOnly(world: World): void {
  expect(world.calls.every((call) => call.method === "GET")).toBe(true);
  expect(world.registryCalls.every((call) => call.startsWith("GET "))).toBe(
    true,
  );
}

// ---------------------------------------------------------------------------
// Reachable states
// ---------------------------------------------------------------------------

describe("production Task 14 authority states", () => {
  it("reaches PendingArtifactsOrProof when nothing is published or proven", async () => {
    const world = buildWorld();
    const result = await run(world);
    expect(result.isOk()).toBe(true);
    if (result.isOk())
      expect(result.value.mergedRelease?.state).toBe("PendingArtifactsOrProof");
    expectReadOnly(world);
  });

  it("reaches PendingNpm when the artifact cache and independent proof exist", async () => {
    const world = buildWorld({
      publishArtifacts: true,
      attestSuccess: true,
    });
    const result = await run(world);
    expect(result.isOk()).toBe(true);
    if (result.isOk())
      expect(result.value.mergedRelease?.state).toBe("PendingNpm");
  });

  it("reaches PendingRegistryVerification when npm has published no provenance", async () => {
    const world = buildWorld({ published: true, provenance: "absent" });
    const result = await run(world);
    expect(result.isOk()).toBe(true);
    if (result.isOk())
      expect(result.value.mergedRelease?.state).toBe(
        "PendingRegistryVerification",
      );
  });

  it("reaches PendingTagsOrReleases once provenance binds the released commit", async () => {
    const world = buildWorld({ published: true, provenance: "bound" });
    const result = await run(world);
    expect(result.isOk()).toBe(true);
    if (result.isOk())
      expect(result.value.mergedRelease?.state).toBe("PendingTagsOrReleases");
  });

  it("reaches PendingChangesetCleanup while a consumed changeset survives on main", async () => {
    const world = buildWorld({
      published: true,
      provenance: "bound",
      tags: true,
      releases: true,
      changesetsAtRelease: [CHANGESET],
      changesetsOnMain: [CHANGESET],
    });
    const result = await run(world);
    expect(result.isOk()).toBe(true);
    if (result.isOk())
      expect(result.value.mergedRelease?.state).toBe("PendingChangesetCleanup");
  });

  it("observes a cleanup pull request merged after the release and reaches Complete", async () => {
    const world = buildWorld({
      published: true,
      provenance: "bound",
      tags: true,
      releases: true,
      changesetsAtRelease: [CHANGESET],
      changesetsOnMain: [],
    });
    const result = await run(world);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.mergedRelease?.state).toBe("Complete");
      expect(result.value.discovered).toEqual([]);
    }
    expect(
      world.calls.some((call) =>
        call.url.includes(`/git/trees/${MAIN_TREE_SHA}`),
      ),
    ).toBe(true);
    expectReadOnly(world);
  });

  it("reaches Complete with no cleanup required", async () => {
    const world = buildWorld({
      published: true,
      provenance: "bound",
      tags: true,
      releases: true,
    });
    const result = await run(world);
    expect(result.isOk()).toBe(true);
    if (result.isOk())
      expect(result.value.mergedRelease?.state).toBe("Complete");
  });

  it("reaches IntegrityIncident from the authorized incident check run", async () => {
    const world = buildWorld({
      published: true,
      provenance: "bound",
      tags: true,
      releases: true,
      incident: {},
    });
    const result = await run(world);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.mergedRelease?.state).toBe("IntegrityIncident");
      expect(
        result.value.mergedRelease?.incidentAuthorizationRecordPresent,
      ).toBe(true);
      expect(result.value.mergedRelease?.incidentDeprecatedVerified).toBe(
        false,
      );
    }
  });

  it("reaches CompleteWithIncident once deprecations and notices are proven", async () => {
    const requiredMessage = incidentNoticeFor(MERGE_SHA);
    const world = buildWorld({
      published: true,
      provenance: "bound",
      tags: true,
      releases: true,
      releaseNotes: `${requiredMessage}\n\nchangelog`,
      deprecated: requiredMessage,
      incident: {},
    });
    const result = await run(world);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.mergedRelease?.state).toBe("CompleteWithIncident");
      expect(result.value.mergedRelease?.incidentDeprecatedVerified).toBe(true);
      expect(result.value.discovered).toEqual([]);
    }
    expectReadOnly(world);
  });
});

// ---------------------------------------------------------------------------
// Fail-closed behaviour
// ---------------------------------------------------------------------------

describe("production Task 14 authority fails closed", () => {
  const failures: readonly [string, WorldOptions, string][] = [
    [
      "npm provenance that does not describe the published bytes",
      { published: true, provenance: "foreign-subject" },
      "npm provenance does not describe the published bytes",
    ],
    [
      "npm provenance built from another commit",
      { published: true, provenance: "foreign-commit" },
      "not the released commit",
    ],
    [
      "an unreadable provenance document",
      { published: true, provenance: "unreadable" },
      "npm provenance read failed",
    ],
    [
      "a malformed provenance document",
      { published: true, provenance: "malformed" },
      "npm provenance document is malformed",
    ],
    [
      "a noncanonical tarball URL",
      {
        published: true,
        provenance: "bound",
        tarballUrl: "https://evil.example/weave-cli-0.1.0.tgz",
      },
      "not canonical",
    ],
    [
      "registry bytes that contradict dist.integrity",
      {
        published: true,
        provenance: "bound",
        integrity: `sha512-${Buffer.alloc(64, 7).toString("base64")}`,
      },
      "do not match its own dist.integrity",
    ],
    [
      "an unreadable registry metadata document",
      { published: true, registryStatus: 500 },
      "npm metadata read failed",
    ],
    [
      "an incident record whose digest is not the served digest",
      {
        published: true,
        provenance: "bound",
        incident: { affectedRegistryDigest: `sha256:${"4".repeat(64)}` },
      },
      "the registry serves",
    ],
    [
      "an incident check run with an unparseable record",
      { published: true, provenance: "bound", incident: { text: "not json" } },
      "parseable authorization record",
    ],
    [
      "an incident check run that has not completed",
      {
        published: true,
        provenance: "bound",
        incident: { status: "in_progress" },
      },
      "has not completed",
    ],
    [
      "an incident check run that failed",
      {
        published: true,
        provenance: "bound",
        incident: { conclusion: "failure" },
      },
      "concluded failure",
    ],
    [
      "two completed incident check runs",
      { published: true, provenance: "bound", incident: { duplicate: true } },
      "more than one completed incident check run",
    ],
    [
      "an incident record naming another released commit",
      {
        published: true,
        provenance: "bound",
        incident: { releasedSha: OTHER_SHA },
      },
      "names another released commit",
    ],
    [
      "a release commit that is not an ancestor of main",
      {
        published: true,
        provenance: "bound",
        tags: true,
        releases: true,
        changesetsAtRelease: [CHANGESET],
        mainAncestry: "diverged",
      },
      "not an ancestor of main",
    ],
  ];

  for (const [name, options, message] of failures)
    it(`refuses ${name}`, async () => {
      const world = buildWorld(options);
      const result = await run(world);
      expect(result.isErr(), name).toBe(true);
      if (result.isErr()) {
        expect(result.error.type).toBe("DoctorPortFailed");
        expect(result.error.message, name).toContain(message);
      }
      expectReadOnly(world);
    });

  it("never reports a published member as verified without provenance", async () => {
    const world = buildWorld({
      published: true,
      provenance: "absent",
      tags: true,
      releases: true,
    });
    const result = await run(world);
    expect(result.isOk()).toBe(true);
    if (result.isOk())
      expect(result.value.mergedRelease?.state).not.toBe("Complete");
  });
});
