import { describe, expect, it } from "bun:test";
import { errAsync, okAsync, type Result, type ResultAsync } from "neverthrow";
import {
  bindArtifactsToPlan,
  type PlanBindingError,
  type PlanBoundArtifact,
  verifyPlanBoundArtifact,
} from "../artifact-binding.js";
import {
  type PlanArtifactError,
  validatePlanArtifact,
  verifyManifestAgainstPlan,
} from "../artifact-manifest.js";
import { RELEASE_PR_MARKER_REF } from "../constants.js";
import { isJsonObject, type JsonObject, parseJsonValue } from "../json.js";
import type { ArtifactManifest } from "../model.js";
import {
  assertPlanPathAllowed,
  attachReleasePlanBinding,
  type MergedReleasePullRequest,
  parseBoundedJson,
  parsePlanMetadataBlock,
  parseReleasePlan,
  RELEASE_PLAN_LIMITS,
  RELEASE_PLAN_MARKER,
  RELEASE_PLAN_SCHEMA_VERSION,
  type RecomputedPlanFacts,
  type RecomputePortFailure,
  type ReleaseDocsAudit,
  type ReleasePlan,
  type ReleasePlanBinding,
  type ReleasePlanError,
  type ReleasePlanRecomputePorts,
  readPlanCarrier,
  recomputePlan,
  releasePlanDigest,
  renderPlanMetadataBlock,
  resolveReleasedSha,
  serializeReleasePlan,
  serializeReleasePlanArtifact,
  validateReleasePlan,
  verifyReleasePlanBinding,
  verifyReleasePlanDigest,
  writePlanCarrier,
} from "../release-plan.js";

const CLI = "@weaveio/weave-cli";
const OPENCODE = "@weaveio/weave-adapter-opencode";
const PI = "@weaveio/weave-adapter-pi";

const BASE_SHA = "a".repeat(40);
const RELEASED_SHA = "c".repeat(40);
const REPOSITORY_ROOT = "/home/runner/work/weave/weave";
const CARRIER_OPTIONS = { repositoryRoot: REPOSITORY_ROOT };

/** Real digests, so fixtures carry the shapes the schema demands. */
function hex(seed: string): string {
  return new Bun.CryptoHasher("sha256").update(seed).digest("hex");
}
function digest(seed: string): string {
  return `sha256:${hex(seed)}`;
}
function planDigest(value: ReleasePlan): string {
  const result = releasePlanDigest(value);
  if (result.isErr()) throw new Error(JSON.stringify(result.error));
  return result.value;
}

const PORTABLE_LIMITS = hex("portable-delegation-limits");
const SETTLEMENT_BUDGET = hex("pi-settlement-budget");

function docsAudit(
  overrides: Partial<ReleaseDocsAudit> = {},
): ReleaseDocsAudit {
  return {
    auditedSha: BASE_SHA,
    deterministicResultDigest: digest("docs-deterministic"),
    aiResultDigestOrStatus: "not-required",
    ...overrides,
  };
}

function plan(overrides: Partial<ReleasePlan> = {}): ReleasePlan {
  return {
    schemaVersion: RELEASE_PLAN_SCHEMA_VERSION,
    channel: "stable",
    seed: [CLI],
    closure: {
      seed: [CLI],
      selected: [CLI, OPENCODE],
      added: [
        {
          package: OPENCODE,
          reason: {
            kind: "shared-changeset",
            evidence: {
              changesetId: "portable-delegation-limits",
              sourceDigest: PORTABLE_LIMITS,
              trigger: CLI,
              members: [CLI, OPENCODE],
            },
          },
        },
      ],
    },
    consumed: [
      { id: "pi-settlement-budget", sourceDigest: SETTLEMENT_BUDGET },
      { id: "portable-delegation-limits", sourceDigest: PORTABLE_LIMITS },
    ],
    versions: [
      { packageName: CLI, previousVersion: "0.0.1", version: "0.1.0" },
      { packageName: OPENCODE, previousVersion: "0.0.1", version: "0.1.0" },
    ],
    changelogDigests: [
      {
        packageName: CLI,
        version: "0.1.0",
        documentDigest: digest("cli-changelog"),
      },
      {
        packageName: OPENCODE,
        version: "0.1.0",
        documentDigest: digest("opencode-changelog"),
      },
    ],
    baseSha: BASE_SHA,
    releasedSha: null,
    docsAudit: docsAudit(),
    binding: null,
    ...overrides,
  };
}

function binding(
  overrides: Partial<ReleasePlanBinding> = {},
): ReleasePlanBinding {
  return {
    schemaVersion: RELEASE_PLAN_SCHEMA_VERSION,
    builtSha: RELEASED_SHA,
    tarballs: [
      {
        packageName: CLI,
        version: "0.1.0",
        path: "artifacts/@weaveio-weave-cli-0.1.0.tgz",
        sha256: digest("cli-tarball"),
      },
      {
        packageName: OPENCODE,
        version: "0.1.0",
        path: "artifacts/@weaveio-weave-adapter-opencode-0.1.0.tgz",
        sha256: digest("opencode-tarball"),
      },
    ],
    manifestDigests: [
      {
        packageName: CLI,
        stagedManifestDigest: digest("cli-staged"),
        publicManifestDigest: digest("cli-public"),
      },
      {
        packageName: OPENCODE,
        stagedManifestDigest: digest("opencode-staged"),
        publicManifestDigest: digest("opencode-public"),
      },
    ],
    changelogDigests: plan().changelogDigests,
    entryPointDigests: [
      {
        packageName: CLI,
        entryPoint: "dist/index.js",
        digest: digest("cli-entry"),
      },
      {
        packageName: OPENCODE,
        entryPoint: "dist/index.js",
        digest: digest("opencode-entry"),
      },
    ],
    proofMarkers: {
      attestation: { status: "pending" },
      cleanConsumer: { status: "pending" },
      harnessProof: { status: "pending" },
      registryVerification: { status: "pending" },
    },
    ...overrides,
  };
}

type PlanVersion = ReleasePlan["versions"][number];
type PlanChangelogDigest = ReleasePlan["changelogDigests"][number];
type PlanTarball = ReleasePlanBinding["tarballs"][number];
type PlanManifestDigest = ReleasePlanBinding["manifestDigests"][number];
type PlanEntryPointDigest = ReleasePlanBinding["entryPointDigests"][number];

function versionAt(index: number): PlanVersion {
  const value = plan().versions[index];
  if (value === undefined) throw new Error(`missing plan version ${index}`);
  return value;
}
function changelogAt(index: number): PlanChangelogDigest {
  const value = plan().changelogDigests[index];
  if (value === undefined) throw new Error(`missing changelog digest ${index}`);
  return value;
}
function tarballAt(index: number): PlanTarball {
  const value = binding().tarballs[index];
  if (value === undefined) throw new Error(`missing tarball ${index}`);
  return value;
}
function manifestDigestAt(index: number): PlanManifestDigest {
  const value = binding().manifestDigests[index];
  if (value === undefined) throw new Error(`missing manifest digest ${index}`);
  return value;
}
function entryPointAt(index: number): PlanEntryPointDigest {
  const value = binding().entryPointDigests[index];
  if (value === undefined) throw new Error(`missing entry point ${index}`);
  return value;
}

/** A merged plan: released, and carrying the build that proved that SHA. */
function releasedPlan(overrides: Partial<ReleasePlan> = {}): ReleasePlan {
  return plan({ releasedSha: RELEASED_SHA, binding: binding(), ...overrides });
}

function expectOk<T, E>(result: Result<T, E>): T {
  if (result.isErr())
    throw new Error(`Unexpected failure: ${JSON.stringify(result.error)}`);
  return result.value;
}
function expectErr<T, E>(result: Result<T, E>): E {
  if (result.isOk())
    throw new Error(`Unexpected success: ${JSON.stringify(result.value)}`);
  return result.error;
}

// ---------------------------------------------------------------------------
// Recompute ports
// ---------------------------------------------------------------------------

function facts(overrides: Partial<RecomputedPlanFacts> = {}) {
  const source = plan();
  return {
    closure: source.closure,
    consumed: source.consumed,
    versions: source.versions,
    changelogDigests: source.changelogDigests,
    docsAudit: source.docsAudit,
    ...overrides,
  } satisfies RecomputedPlanFacts;
}

function mergedPullRequest(
  overrides: Partial<MergedReleasePullRequest> = {},
): MergedReleasePullRequest {
  return {
    number: 4242,
    merged: true,
    mergeCommitSha: RELEASED_SHA,
    baseSha: BASE_SHA,
    baseRef: "main",
    headRef: RELEASE_PR_MARKER_REF,
    ...overrides,
  };
}

interface PortOptions {
  facts?: RecomputedPlanFacts;
  factsFailure?: RecomputePortFailure;
  merged?: MergedReleasePullRequest;
  mergeFailure?: RecomputePortFailure;
  withoutMergePort?: boolean;
  seen?: {
    request?: { ref: string; channel: string; seed: readonly string[] };
  };
}

function ports(options: PortOptions = {}): ReleasePlanRecomputePorts {
  const base: ReleasePlanRecomputePorts = {
    recomputeFacts(request) {
      if (options.seen !== undefined) options.seen.request = request;
      if (options.factsFailure !== undefined)
        return errAsync(options.factsFailure);
      return okAsync(options.facts ?? facts());
    },
  };
  if (options.withoutMergePort === true) return base;
  return {
    ...base,
    readMergedReleasePullRequest(): ResultAsync<
      MergedReleasePullRequest,
      RecomputePortFailure
    > {
      if (options.mergeFailure !== undefined)
        return errAsync(options.mergeFailure);
      return okAsync(options.merged ?? mergedPullRequest());
    },
  };
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

describe("release plan schema", () => {
  it("accepts a preparation plan and a released plan with a binding", () => {
    expect(validateReleasePlan(plan()).isOk()).toBe(true);
    expect(validateReleasePlan(releasedPlan()).isOk()).toBe(true);
  });

  it.each<[string, unknown]>([
    ["an unknown key", { ...plan(), extra: true }],
    ["a foreign schema version", { ...plan(), schemaVersion: 2 }],
    ["a missing docs audit", omit(plan(), "docsAudit")],
    ["a missing base SHA", omit(plan(), "baseSha")],
    ["a short base SHA", plan({ baseSha: "a".repeat(39) })],
    [
      "a docs audit bound to another SHA",
      plan({ docsAudit: docsAudit({ auditedSha: "b".repeat(40) }) }),
    ],
    ["a duplicated seed package", plan({ seed: [CLI, CLI] })],
    [
      "a seed outside catalog order",
      plan({
        seed: [OPENCODE, CLI],
        closure: { ...plan().closure, seed: [OPENCODE, CLI], added: [] },
      }),
    ],
    [
      "a closure that drops the seed",
      plan({
        closure: { seed: [CLI], selected: [OPENCODE], added: [] },
      }),
    ],
    [
      "an unexplained closure addition",
      plan({ closure: { ...plan().closure, added: [] } }),
    ],
    [
      "versions that do not match the closure",
      plan({ versions: [versionAt(0)] }),
    ],
    [
      "a changelog digest for another version",
      plan({
        changelogDigests: [
          { ...changelogAt(0), version: "0.2.0" },
          changelogAt(1),
        ],
      }),
    ],
    [
      "a version that does not move",
      plan({
        versions: [
          { packageName: CLI, previousVersion: "0.1.0", version: "0.1.0" },
          versionAt(1),
        ],
      }),
    ],
    [
      "a stable prerelease version",
      plan({
        versions: [
          {
            packageName: CLI,
            previousVersion: "0.0.1",
            version: "0.1.0-nightly.1",
          },
          versionAt(1),
        ],
        changelogDigests: [
          {
            ...changelogAt(0),
            version: "0.1.0-nightly.1",
          },
          changelogAt(1),
        ],
      }),
    ],
    [
      "a duplicated consumed identity",
      plan({
        consumed: [
          { id: "portable-delegation-limits", sourceDigest: PORTABLE_LIMITS },
          { id: "portable-delegation-limits", sourceDigest: PORTABLE_LIMITS },
        ],
      }),
    ],
    [
      "unordered consumed identities",
      plan({
        consumed: [
          { id: "portable-delegation-limits", sourceDigest: PORTABLE_LIMITS },
          { id: "pi-settlement-budget", sourceDigest: SETTLEMENT_BUDGET },
        ],
      }),
    ],
    ["a binding on a preparation plan", plan({ binding: binding() })],
    [
      "a binding built at another SHA",
      releasedPlan({ binding: binding({ builtSha: "d".repeat(40) }) }),
    ],
    [
      "a binding with duplicate tarball packages",
      releasedPlan({
        binding: binding({
          tarballs: [
            tarballAt(0),
            {
              ...tarballAt(0),
              path: "artifacts/other.tgz",
            },
          ],
        }),
      }),
    ],
    [
      "a tarball path that escapes its directory",
      releasedPlan({
        binding: binding({
          tarballs: [{ ...tarballAt(0), path: "../evil.tgz" }, tarballAt(1)],
        }),
      }),
    ],
    [
      "an entry point digest for an unbuilt package",
      releasedPlan({
        binding: binding({
          entryPointDigests: [
            ...binding().entryPointDigests,
            {
              packageName: PI,
              entryPoint: "dist/index.js",
              digest: digest("pi-entry"),
            },
          ],
        }),
      }),
    ],
  ])("rejects %s", (_name, value) => {
    const error = expectErr(validateReleasePlan(value));
    expect(error.type).toBe("InvalidReleasePlan");
  });
});

// ---------------------------------------------------------------------------
// Canonical serialization
// ---------------------------------------------------------------------------

describe("canonical serialization", () => {
  it("round-trips a plan through its canonical bytes", () => {
    const serialized = expectOk(serializeReleasePlan(plan()));
    expect(expectOk(parseReleasePlan(serialized))).toEqual(plan());
  });

  it("round-trips a released plan and its binding", () => {
    const serialized = expectOk(serializeReleasePlan(releasedPlan()));
    expect(expectOk(parseReleasePlan(serialized))).toEqual(releasedPlan());
  });

  it("serializes and digests independently of key order", () => {
    const reordered = reorderedPlan();
    expect(JSON.stringify(reordered)).not.toBe(JSON.stringify(plan()));
    expect(expectOk(serializeReleasePlan(reordered))).toBe(
      expectOk(serializeReleasePlan(plan())),
    );
    expect(planDigest(reordered)).toBe(planDigest(plan()));
  });

  it("round-trips the workflow-artifact envelope with a self-checking digest", () => {
    const artifact = expectOk(serializeReleasePlanArtifact(plan()));
    const parsedArtifact = parseJsonValue(artifact);
    if (parsedArtifact.isErr()) throw new Error(parsedArtifact.error.message);
    const parsed = expectOk(validatePlanArtifact(parsedArtifact.value));
    expect(parsed.plan).toEqual(plan());
    expect(parsed.planDigest).toBe(planDigest(plan()));
  });

  it("rejects an envelope whose digest names another plan", () => {
    const artifactText = expectOk(serializeReleasePlanArtifact(plan()));
    const artifactValue = parseJsonValue(artifactText);
    if (artifactValue.isErr()) throw new Error(artifactValue.error.message);
    if (!isJsonObject(artifactValue.value))
      throw new Error("serialized plan artifact is not an object");
    const tampered: JsonObject = Object.fromEntries([
      ...Object.entries(artifactValue.value),
      ["planDigest", digest("other-plan")],
    ]);
    const error = expectErr(validatePlanArtifact(tampered));
    expect(error.type).toBe("InvalidReleasePlanArtifact");
  });

  it("reports a plan digest mismatch with both digests", () => {
    expect(expectOk(verifyReleasePlanDigest(plan(), planDigest(plan())))).toBe(
      planDigest(plan()),
    );
    const error = expectErr(
      verifyReleasePlanDigest(plan(), digest("stale-plan")),
    );
    expect(error).toEqual({
      type: "PlanDigestMismatch",
      expected: digest("stale-plan"),
      actual: planDigest(plan()),
    });
  });
});

// ---------------------------------------------------------------------------
// Bounded input
// ---------------------------------------------------------------------------

describe("bounded plan input", () => {
  it("rejects malformed JSON", () => {
    const error = expectErr(parseReleasePlan("{"));
    expect(error.type).toBe("MalformedReleasePlanJson");
  });

  it("rejects input past the carrier bound", () => {
    const oversized = `"${"x".repeat(RELEASE_PLAN_LIMITS.carrierBytes)}"`;
    const error = expectErr(parseReleasePlan(oversized));
    expect(error).toEqual({
      type: "ReleasePlanTooLarge",
      bytes: oversized.length,
      limit: RELEASE_PLAN_LIMITS.carrierBytes,
    });
  });

  it("rejects input past the nesting bound", () => {
    const depth = RELEASE_PLAN_LIMITS.jsonDepth + 4;
    const nested = `${"[".repeat(depth)}${"]".repeat(depth)}`;
    const error = expectErr(parseBoundedJson(nested));
    expect(error).toEqual({
      type: "ReleasePlanTooDeep",
      depth: RELEASE_PLAN_LIMITS.jsonDepth + 1,
      limit: RELEASE_PLAN_LIMITS.jsonDepth,
    });
  });

  it("rejects a duplicated top-level key that JSON.parse would silently collapse", () => {
    const error = expectErr(
      parseBoundedJson('{"channel":"stable","channel":"nightly"}'),
    );
    expect(error).toEqual({
      type: "DuplicateReleasePlanKey",
      path: "channel",
      key: "channel",
    });
  });

  it("names the path of a duplicated nested key", () => {
    const error = expectErr(
      parseBoundedJson(
        '{"docsAudit":{"auditedSha":"a","auditedSha":"b"},"seed":["x","x"]}',
      ),
    );
    expect(error).toEqual({
      type: "DuplicateReleasePlanKey",
      path: "docsAudit.auditedSha",
      key: "auditedSha",
    });
  });

  it("accepts repeated values that are not repeated keys", () => {
    expect(expectOk(parseBoundedJson('{"a":["x","x"],"b":{"a":1}}'))).toEqual({
      a: ["x", "x"],
      b: { a: 1 },
    });
  });
});

// ---------------------------------------------------------------------------
// Hidden release-PR metadata
// ---------------------------------------------------------------------------

describe("hidden release-PR metadata", () => {
  it("round-trips a plan through a release-PR body", () => {
    const block = expectOk(renderPlanMetadataBlock(plan()));
    const body = [
      "## Release: @weaveio/weave-cli 0.1.0",
      "",
      "<!-- a maintainer's own note -->",
      "",
      block,
      "",
      "Closes #140",
    ].join("\n");
    expect(expectOk(parsePlanMetadataBlock(body))).toEqual(plan());
  });

  it("reports a body with no plan block", () => {
    expect(expectErr(parsePlanMetadataBlock("no plan here")).type).toBe(
      "MissingPlanMetadataBlock",
    );
  });

  it("refuses a body claiming two plans", () => {
    const block = expectOk(renderPlanMetadataBlock(plan()));
    const error = expectErr(parsePlanMetadataBlock(`${block}\n\n${block}`));
    expect(error).toEqual({ type: "MultiplePlanMetadataBlocks", count: 2 });
  });

  it("refuses a foreign block schema version", () => {
    const body = `<!-- ${RELEASE_PLAN_MARKER}:9\n{}\n-->`;
    expect(expectErr(parsePlanMetadataBlock(body))).toEqual({
      type: "UnsupportedPlanSchema",
      schemaVersion: 9,
    });
  });

  it("refuses an unclosed plan comment", () => {
    const body = `<!-- ${RELEASE_PLAN_MARKER}:1\n{}`;
    expect(expectErr(parsePlanMetadataBlock(body)).type).toBe(
      "MalformedReleasePlanJson",
    );
  });

  it("refuses a block whose payload is not a plan", () => {
    const body = `<!-- ${RELEASE_PLAN_MARKER}:1\n{"channel":"stable"}\n-->`;
    expect(expectErr(parsePlanMetadataBlock(body)).type).toBe(
      "InvalidReleasePlan",
    );
  });
});

// ---------------------------------------------------------------------------
// Carriers
// ---------------------------------------------------------------------------

describe("plan carriers", () => {
  it("reads a plan from a workflow artifact outside the repository", () => {
    const contents = expectOk(serializeReleasePlanArtifact(plan()));
    const read = readPlanCarrier(
      { kind: "workflow-artifact", path: "/tmp/release/plan.json", contents },
      CARRIER_OPTIONS,
    );
    expect(expectOk(read)).toEqual(plan());
  });

  it("reads a plan from a release-PR body", () => {
    const body = expectOk(renderPlanMetadataBlock(plan()));
    expect(
      expectOk(
        readPlanCarrier(
          { kind: "pull-request-metadata", body },
          CARRIER_OPTIONS,
        ),
      ),
    ).toEqual(plan());
  });

  it("writes only through validated carriers", () => {
    expect(
      expectOk(
        writePlanCarrier(
          plan(),
          { kind: "workflow-artifact", path: "/tmp/release/plan.json" },
          CARRIER_OPTIONS,
        ),
      ),
    ).toBe(expectOk(serializeReleasePlanArtifact(plan())));
    expect(
      expectOk(
        writePlanCarrier(
          plan(),
          { kind: "pull-request-metadata" },
          CARRIER_OPTIONS,
        ),
      ),
    ).toBe(expectOk(renderPlanMetadataBlock(plan())));
  });

  it.each<
    [
      string,
      string,
      Extract<ReleasePlanError, { type: "ForbiddenPlanCarrier" }>["reason"],
    ]
  >([
    [
      "a committed repository path",
      `${REPOSITORY_ROOT}/.release/plan.json`,
      "committed-repository-path",
    ],
    [
      "a committed source path",
      `${REPOSITORY_ROOT}/packages/cli/plan.json`,
      "committed-repository-path",
    ],
    [
      "the repository root itself",
      REPOSITORY_ROOT,
      "committed-repository-path",
    ],
    [
      "a release state directory anywhere",
      "/tmp/.release/plan.json",
      "release-state-directory",
    ],
    ["a repository-relative path", ".release/plan.json", "relative-path"],
    ["a bare relative path", "plan.json", "relative-path"],
  ])("refuses %s", (_name, path, reason) => {
    const error = expectErr(assertPlanPathAllowed(path, CARRIER_OPTIONS));
    expect(error.type).toBe("ForbiddenPlanCarrier");
    if (error.type !== "ForbiddenPlanCarrier")
      throw new Error(`unexpected carrier error: ${error.type}`);
    expect(error.reason).toBe(reason);
  });

  it("refuses to read or write a plan through a committed path", () => {
    const path = `${REPOSITORY_ROOT}/.release/plan.json`;
    const contents = expectOk(serializeReleasePlanArtifact(plan()));
    expect(
      expectErr(
        readPlanCarrier(
          { kind: "workflow-artifact", path, contents },
          CARRIER_OPTIONS,
        ),
      ).type,
    ).toBe("ForbiddenPlanCarrier");
    expect(
      expectErr(
        writePlanCarrier(
          plan(),
          { kind: "workflow-artifact", path },
          CARRIER_OPTIONS,
        ),
      ).type,
    ).toBe("ForbiddenPlanCarrier");
  });

  it("refuses a traversal that lands back inside the repository", () => {
    const error = expectErr(
      assertPlanPathAllowed(
        `${REPOSITORY_ROOT}/../weave/.release/plan.json`,
        CARRIER_OPTIONS,
      ),
    );
    expect(error.type).toBe("ForbiddenPlanCarrier");
  });
});

// ---------------------------------------------------------------------------
// Released-SHA resolution
// ---------------------------------------------------------------------------

describe("released SHA resolution", () => {
  const port = (merged: MergedReleasePullRequest) => ({
    readMergedReleasePullRequest: () => okAsync(merged),
  });

  it("resolves the merged PR's merge commit", async () => {
    const resolved = await resolveReleasedSha(
      { pullRequestNumber: 4242 },
      port(mergedPullRequest()),
    );
    expect(expectOk(resolved).mergeCommitSha).toBe(RELEASED_SHA);
  });

  it.each<[string, MergedReleasePullRequest, ReleasePlanError["type"]]>([
    [
      "an open PR",
      mergedPullRequest({ merged: false, mergeCommitSha: null }),
      "ReleasePrNotMerged",
    ],
    [
      "a merged PR with no merge commit",
      mergedPullRequest({ mergeCommitSha: null }),
      "MissingMergeCommitSha",
    ],
    [
      "a merge commit that is not a full SHA",
      mergedPullRequest({ mergeCommitSha: "abc" }),
      "MissingMergeCommitSha",
    ],
    [
      "a PR merged into another branch",
      mergedPullRequest({ baseRef: "release/20260101-abcdefabcdef" }),
      "UnexpectedReleasePrRef",
    ],
    [
      "a PR from another head ref",
      mergedPullRequest({ headRef: "feature/whatever" }),
      "UnexpectedReleasePrRef",
    ],
  ])("refuses %s", async (_name, merged, type) => {
    const resolved = await resolveReleasedSha(
      { pullRequestNumber: 4242 },
      port(merged),
    );
    expect(expectErr(resolved).type).toBe(type);
  });

  it("surfaces a port failure as a typed recompute failure", async () => {
    const resolved = await resolveReleasedSha(
      { pullRequestNumber: 4242 },
      {
        readMergedReleasePullRequest: () =>
          errAsync({ port: "pull-request", message: "rate limited" }),
      },
    );
    expect(expectErr(resolved)).toEqual({
      type: "RecomputePortFailed",
      port: "pull-request",
      message: "rate limited",
    });
  });
});

// ---------------------------------------------------------------------------
// Recompute and compare
// ---------------------------------------------------------------------------

describe("recompute-before-trust", () => {
  it("returns the recomputed plan when preparation agrees", async () => {
    const seen: PortOptions["seen"] = {};
    const result = await recomputePlan(
      { ref: BASE_SHA, stored: plan(), mode: { kind: "preparation" } },
      ports({ seen }),
    );
    expect(expectOk(result)).toEqual(plan());
    expect(seen.request).toEqual({
      ref: BASE_SHA,
      channel: "stable",
      seed: [CLI],
    });
  });

  it("returns the recomputed plan when a merged release agrees", async () => {
    const result = await recomputePlan(
      {
        ref: RELEASED_SHA,
        stored: releasedPlan(),
        mode: { kind: "post-merge", pullRequestNumber: 4242 },
      },
      ports(),
    );
    expect(expectOk(result)).toEqual(releasedPlan());
  });

  it("refuses a ref that is not a full SHA", async () => {
    const result = await recomputePlan(
      { ref: "main", stored: plan(), mode: { kind: "preparation" } },
      ports(),
    );
    expect(expectErr(result)).toEqual({
      type: "InvalidRecomputeRef",
      ref: "main",
    });
  });

  it("refuses an unparseable stored plan before touching any port", async () => {
    const result = await recomputePlan(
      {
        ref: BASE_SHA,
        stored: { channel: "stable" },
        mode: { kind: "preparation" },
      },
      ports({
        factsFailure: { port: "facts", message: "must never be called" },
      }),
    );
    expect(expectErr(result).type).toBe("InvalidReleasePlan");
  });

  it.each<[string, RecomputedPlanFacts, string]>([
    [
      "closure",
      facts({
        closure: {
          seed: [CLI],
          selected: [CLI, OPENCODE],
          added: [
            {
              package: OPENCODE,
              reason: {
                kind: "artifact-dependency",
                evidence: {
                  changesetId: "portable-delegation-limits",
                  sourceDigest: PORTABLE_LIMITS,
                  trigger: CLI,
                  source: "@weaveio/weave-engine",
                  relationship: "declared-impact",
                  dependencyPath: [],
                },
              },
            },
          ],
        },
      }),
      "closure.added.0.reason.evidence.dependencyPath",
    ],
    [
      "consumed",
      facts({
        consumed: [
          { id: "portable-delegation-limits", sourceDigest: PORTABLE_LIMITS },
        ],
      }),
      "consumed.length",
    ],
    [
      "versions",
      facts({
        versions: [
          { packageName: CLI, previousVersion: "0.0.1", version: "0.2.0" },
          versionAt(1),
        ],
        changelogDigests: [
          { ...changelogAt(0), version: "0.2.0" },
          changelogAt(1),
        ],
      }),
      "changelogDigests.0.version",
    ],
    [
      "changelogDigests",
      facts({
        changelogDigests: [
          {
            ...changelogAt(0),
            documentDigest: digest("rewritten-cli-changelog"),
          },
          changelogAt(1),
        ],
      }),
      "changelogDigests.0.documentDigest",
    ],
    [
      "docsAudit",
      facts({
        docsAudit: docsAudit({
          deterministicResultDigest: digest("docs-drifted"),
        }),
      }),
      "docsAudit.deterministicResultDigest",
    ],
    [
      "the docs audit AI slot",
      facts({
        docsAudit: docsAudit({ aiResultDigestOrStatus: digest("docs-ai") }),
      }),
      "docsAudit.aiResultDigestOrStatus",
    ],
  ])("names the diverging %s field", async (_name, recomputed, path) => {
    const result = await recomputePlan(
      { ref: BASE_SHA, stored: plan(), mode: { kind: "preparation" } },
      ports({ facts: recomputed }),
    );
    const error = expectErr(result);
    expect(error.type).toBe("PlanDivergence");
    if (error.type !== "PlanDivergence")
      throw new Error(`unexpected recompute error: ${error.type}`);
    expect(error.path).toBe(path);
  });

  it("names baseSha when a stored plan claims another preparation SHA", async () => {
    const other = "b".repeat(40);
    const result = await recomputePlan(
      {
        ref: other,
        stored: plan(),
        mode: { kind: "preparation" },
      },
      ports({ facts: facts({ docsAudit: docsAudit({ auditedSha: other }) }) }),
    );
    const error = expectErr(result);
    expect(error).toEqual({
      type: "PlanDivergence",
      path: "baseSha",
      expected: other,
      actual: BASE_SHA,
    });
  });

  it("names baseSha when the merged PR was opened against another SHA", async () => {
    const other = "b".repeat(40);
    const result = await recomputePlan(
      {
        ref: RELEASED_SHA,
        stored: releasedPlan(),
        mode: { kind: "post-merge", pullRequestNumber: 4242 },
      },
      ports({
        merged: mergedPullRequest({ baseSha: other }),
        facts: facts({ docsAudit: docsAudit({ auditedSha: other }) }),
      }),
    );
    const error = expectErr(result);
    expect(error).toEqual({
      type: "PlanDivergence",
      path: "baseSha",
      expected: other,
      actual: BASE_SHA,
    });
  });

  it("names releasedSha when a preparation plan claims a release", async () => {
    const result = await recomputePlan(
      {
        ref: BASE_SHA,
        stored: plan({ releasedSha: RELEASED_SHA, binding: null }),
        mode: { kind: "preparation" },
      },
      ports(),
    );
    const error = expectErr(result);
    expect(error).toEqual({
      type: "PlanDivergence",
      path: "releasedSha",
      expected: null,
      actual: RELEASED_SHA,
    });
  });

  it("names releasedSha when a merged plan records the wrong merge commit", async () => {
    const result = await recomputePlan(
      {
        ref: "e".repeat(40),
        stored: plan({ releasedSha: RELEASED_SHA, binding: null }),
        mode: { kind: "post-merge", pullRequestNumber: 4242 },
      },
      ports({ merged: mergedPullRequest({ mergeCommitSha: "e".repeat(40) }) }),
    );
    expect(expectErr(result)).toEqual({
      type: "PlanDivergence",
      path: "releasedSha",
      expected: "e".repeat(40),
      actual: RELEASED_SHA,
    });
  });

  it("refuses a cached binding built before the actual merge commit", async () => {
    const result = await recomputePlan(
      {
        ref: "e".repeat(40),
        stored: releasedPlan(),
        mode: { kind: "post-merge", pullRequestNumber: 4242 },
      },
      ports({ merged: mergedPullRequest({ mergeCommitSha: "e".repeat(40) }) }),
    );
    expect(expectErr(result)).toEqual({
      type: "BindingShaMismatch",
      expected: "e".repeat(40),
      actual: RELEASED_SHA,
    });
  });

  it("refuses a ref that is not the resolved merge commit", async () => {
    const result = await recomputePlan(
      {
        ref: "e".repeat(40),
        stored: releasedPlan(),
        mode: { kind: "post-merge", pullRequestNumber: 4242 },
      },
      ports(),
    );
    expect(expectErr(result)).toEqual({
      type: "MergedShaMismatch",
      expected: RELEASED_SHA,
      actual: "e".repeat(40),
    });
  });

  it("refuses a post-merge recompute with no merge-state port", async () => {
    const result = await recomputePlan(
      {
        ref: RELEASED_SHA,
        stored: releasedPlan(),
        mode: { kind: "post-merge", pullRequestNumber: 4242 },
      },
      ports({ withoutMergePort: true }),
    );
    expect(expectErr(result)).toEqual({ type: "MergedPullRequestPortMissing" });
  });

  it("refuses a recompute with no docs-audit outcome at the ref", async () => {
    const result = await recomputePlan(
      { ref: BASE_SHA, stored: plan(), mode: { kind: "preparation" } },
      ports({ facts: facts({ docsAudit: null }) }),
    );
    expect(expectErr(result)).toEqual({
      type: "MissingDocsAudit",
      ref: BASE_SHA,
    });
  });

  it("refuses a docs-audit outcome computed at another SHA", async () => {
    const result = await recomputePlan(
      { ref: BASE_SHA, stored: plan(), mode: { kind: "preparation" } },
      ports({
        facts: facts({ docsAudit: docsAudit({ auditedSha: "b".repeat(40) }) }),
      }),
    );
    expect(expectErr(result)).toEqual({
      type: "DocsAuditShaMismatch",
      auditedSha: "b".repeat(40),
      baseSha: BASE_SHA,
    });
  });

  it("refuses a stored binding built at another SHA", async () => {
    const stored = {
      ...releasedPlan(),
      binding: { ...binding(), builtSha: "f".repeat(40) },
    };
    const result = await recomputePlan(
      {
        ref: RELEASED_SHA,
        stored,
        mode: { kind: "post-merge", pullRequestNumber: 4242 },
      },
      ports(),
    );
    // The schema refuses the stored plan before any port is consulted.
    expect(expectErr(result).type).toBe("InvalidReleasePlan");
  });

  it("surfaces a facts-port failure", async () => {
    const result = await recomputePlan(
      { ref: BASE_SHA, stored: plan(), mode: { kind: "preparation" } },
      ports({ factsFailure: { port: "facts", message: "worktree missing" } }),
    );
    expect(expectErr(result)).toEqual({
      type: "RecomputePortFailed",
      port: "facts",
      message: "worktree missing",
    });
  });

  it("refuses recomputed facts that are not a valid plan", async () => {
    const result = await recomputePlan(
      { ref: BASE_SHA, stored: plan(), mode: { kind: "preparation" } },
      ports({
        facts: facts({
          versions: [
            { packageName: CLI, previousVersion: "0.0.1", version: "0.1.0" },
          ],
        }),
      }),
    );
    expect(expectErr(result).type).toBe("InvalidRecomputedPlan");
  });
});

// ---------------------------------------------------------------------------
// Binding
// ---------------------------------------------------------------------------

describe("publication binding", () => {
  it("attaches a binding built at the released SHA", () => {
    const attached = expectOk(
      attachReleasePlanBinding(plan({ releasedSha: RELEASED_SHA }), binding()),
    );
    expect(attached.binding).toEqual(binding());
    expect(expectOk(verifyReleasePlanBinding(attached))).toEqual(binding());
  });

  it("refuses a binding built at any other SHA", () => {
    const error = expectErr(
      attachReleasePlanBinding(
        plan({ releasedSha: RELEASED_SHA }),
        binding({ builtSha: "d".repeat(40) }),
      ),
    );
    expect(error).toEqual({
      type: "BindingShaMismatch",
      expected: RELEASED_SHA,
      actual: "d".repeat(40),
    });
  });

  it("refuses a binding on a plan that has not been released", () => {
    expect(expectErr(attachReleasePlanBinding(plan(), binding()))).toEqual({
      type: "PlanNotReleased",
    });
  });

  it("refuses a binding for other packages or other versions", () => {
    const released = plan({ releasedSha: RELEASED_SHA });
    const wrongPackages = expectErr(
      attachReleasePlanBinding(
        released,
        binding({
          tarballs: [
            {
              ...tarballAt(0),
              packageName: PI,
              path: "artifacts/@weaveio-weave-adapter-pi-0.1.0.tgz",
            },
            tarballAt(1),
          ],
          manifestDigests: [
            { ...manifestDigestAt(0), packageName: PI },
            manifestDigestAt(1),
          ],
          changelogDigests: [
            { ...changelogAt(0), packageName: PI },
            changelogAt(1),
          ],
          entryPointDigests: [
            { ...entryPointAt(0), packageName: PI },
            entryPointAt(1),
          ],
        }),
      ),
    );
    expect(wrongPackages.type).toBe("BindingMismatch");
    const wrongVersion = expectErr(
      attachReleasePlanBinding(
        released,
        binding({
          tarballs: [{ ...tarballAt(0), version: "0.2.0" }, tarballAt(1)],
        }),
      ),
    );
    expect(wrongVersion).toMatchObject({
      type: "BindingMismatch",
      path: "binding.tarballs.0.version",
    });
  });

  it("refuses a stable binding whose packed changelog is not the plan's", () => {
    const error = expectErr(
      attachReleasePlanBinding(
        plan({ releasedSha: RELEASED_SHA }),
        binding({
          changelogDigests: [
            {
              ...changelogAt(0),
              documentDigest: digest("scratch-changelog"),
            },
            changelogAt(1),
          ],
        }),
      ),
    );
    expect(error).toMatchObject({
      type: "BindingMismatch",
      path: "binding.changelogDigests.0.documentDigest",
    });
  });

  it("allows a nightly scratch changelog override", () => {
    const nightly = plan({
      channel: "nightly",
      releasedSha: RELEASED_SHA,
      versions: [
        {
          packageName: CLI,
          previousVersion: "0.0.1",
          version: "0.1.0-nightly.20260818.abcdefabcdef",
        },
        versionAt(1),
      ],
      changelogDigests: [
        {
          ...changelogAt(0),
          version: "0.1.0-nightly.20260818.abcdefabcdef",
        },
        changelogAt(1),
      ],
    });
    const attached = attachReleasePlanBinding(
      nightly,
      binding({
        tarballs: [
          {
            ...tarballAt(0),
            version: "0.1.0-nightly.20260818.abcdefabcdef",
          },
          tarballAt(1),
        ],
        changelogDigests: [
          {
            ...changelogAt(0),
            version: "0.1.0-nightly.20260818.abcdefabcdef",
            documentDigest: digest("scratch-changelog"),
          },
          changelogAt(1),
        ],
      }),
    );
    expect(attached.isOk()).toBe(true);
  });

  it("reports a missing binding rather than inventing one", () => {
    expect(expectErr(verifyReleasePlanBinding(plan()))).toEqual({
      type: "MissingBinding",
    });
  });

  it("keeps every proof marker slot later tasks fill", () => {
    const recorded = binding({
      proofMarkers: {
        attestation: { status: "recorded", digest: digest("attestation") },
        cleanConsumer: { status: "recorded", digest: digest("consumer") },
        harnessProof: { status: "recorded", digest: digest("harness") },
        registryVerification: { status: "pending" },
      },
    });
    const attached = expectOk(
      attachReleasePlanBinding(plan({ releasedSha: RELEASED_SHA }), recorded),
    );
    expect(attached.binding?.proofMarkers).toEqual(recorded.proofMarkers);
  });

  it("refuses a proof marker recorded without a digest", () => {
    const error = expectErr(
      verifyReleasePlanBinding(plan({ releasedSha: RELEASED_SHA }), {
        ...binding(),
        proofMarkers: {
          ...binding().proofMarkers,
          attestation: { status: "recorded" },
        },
      }),
    );
    expect(error.type).toBe("InvalidReleasePlanBinding");
  });
});

// ---------------------------------------------------------------------------
// Artifact modules
// ---------------------------------------------------------------------------

describe("plan-aware artifacts", () => {
  const uploaded: PlanBoundArtifact["artifacts"] = [
    {
      name: "release-tarballs",
      serverArtifactId: 101,
      uploadDigest: digest("upload"),
      sizeInBytes: 4096,
    },
  ];
  function uploadedAt(index: number): PlanBoundArtifact["artifacts"][number] {
    const value = uploaded[index];
    if (value === undefined)
      throw new Error(`missing uploaded artifact ${index}`);
    return value;
  }

  function bound(): PlanBoundArtifact {
    return expectOk(
      bindArtifactsToPlan({
        plan: releasedPlan(),
        binding: binding(),
        artifacts: uploaded,
      }),
    );
  }

  it("binds uploaded artifacts to the plan they were built for", () => {
    const result = bound();
    expect(result.planDigest).toBe(planDigest(releasedPlan()));
    expect(expectOk(verifyPlanBoundArtifact(result, releasedPlan()))).toEqual(
      binding(),
    );
  });

  it("refuses artifacts bound to a build from another SHA", () => {
    const error = expectErr(
      bindArtifactsToPlan({
        plan: releasedPlan(),
        binding: binding({ builtSha: "d".repeat(40) }),
        artifacts: uploaded,
      }),
    );
    expect(error.type).toBe("BindingShaMismatch");
  });

  it.each<[string, PlanBoundArtifact["artifacts"]]>([
    ["no artifact", []],
    [
      "duplicate artifact names",
      [uploadedAt(0), { ...uploadedAt(0), serverArtifactId: 2 }],
    ],
    ["an unusable server ID", [{ ...uploadedAt(0), serverArtifactId: 0 }]],
  ])("refuses %s", (_name, artifacts) => {
    const error = expectErr(
      bindArtifactsToPlan({
        plan: releasedPlan(),
        binding: binding(),
        artifacts,
      }),
    );
    expect(error.type).toBe("InvalidBoundArtifacts");
  });

  it("refuses a cached artifact carrying a stale plan digest", () => {
    const stale: PlanBoundArtifact = {
      ...bound(),
      planDigest: digest("stale-plan"),
    };
    const error: PlanBindingError = expectErr(
      verifyPlanBoundArtifact(stale, releasedPlan()),
    );
    expect(error.type).toBe("PlanDigestMismatch");
  });

  it("cross-checks a cached manifest against the plan", () => {
    const manifest: ArtifactManifest = {
      schemaVersion: 1,
      releaseSubjectSha: RELEASED_SHA,
      channel: "stable",
      packages: [CLI, OPENCODE],
      versions: { [CLI]: "0.1.0", [OPENCODE]: "0.1.0" },
      artifacts: [
        {
          filename: "@weaveio-weave-cli-0.1.0.tgz",
          checksumFilename: "@weaveio-weave-cli-0.1.0.tgz.sha256",
          sizeBytes: 12,
          sha256: digest("cli-tarball"),
        },
        {
          filename: "@weaveio-weave-adapter-opencode-0.1.0.tgz",
          checksumFilename: "@weaveio-weave-adapter-opencode-0.1.0.tgz.sha256",
          sizeBytes: 12,
          sha256: digest("opencode-tarball"),
        },
      ],
    };
    expect(
      expectOk(verifyManifestAgainstPlan(manifest, releasedPlan())),
    ).toEqual(manifest);
    const drifted: ArtifactManifest = {
      ...manifest,
      releaseSubjectSha: "d".repeat(40),
    };
    const error: PlanArtifactError = expectErr(
      verifyManifestAgainstPlan(drifted, releasedPlan()),
    );
    expect(error).toMatchObject({
      type: "PlanManifestMismatch",
      path: "manifest.releaseSubjectSha",
    });
    expect(expectErr(verifyManifestAgainstPlan(manifest, plan())).type).toBe(
      "PlanNotReleased",
    );
  });
});

function omit<T extends object>(value: T, key: keyof T): Omit<T, keyof T> {
  const { [key]: _removed, ...rest } = value;
  return rest;
}

function reorderedPlan(): ReleasePlan {
  const original = plan();
  return {
    binding: original.binding,
    docsAudit: original.docsAudit,
    releasedSha: original.releasedSha,
    baseSha: original.baseSha,
    changelogDigests: original.changelogDigests,
    versions: original.versions,
    consumed: original.consumed,
    closure: original.closure,
    seed: original.seed,
    channel: original.channel,
    schemaVersion: original.schemaVersion,
  };
}
