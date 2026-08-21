import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { errAsync, okAsync, type Result, type ResultAsync } from "neverthrow";
import { BunCommandRunner } from "../command-runner.js";
import type { FileSystem } from "../filesystem.js";
import {
  NpmCliRegistryClient,
  type PublishedTarballState,
  type PublishRegistry,
  type PublishTag,
} from "../npm-registry-client.js";
import {
  PUBLICATION_REPORT_LIMITS,
  type PublicationProofChain,
  PublishExecutor,
  parsePublicationReport,
  publishTagForChannel,
  requiresHarnessProof,
  serializePublicationReport,
  validatePublicationReport,
  validatePublicationRequest,
} from "../publish-executor.js";
import { parsePublishMainArgs, runPublishMain } from "../publish-main.js";
import {
  RELEASE_PLAN_SCHEMA_VERSION,
  type ReleasePlan,
  type ReleasePlanBinding,
  serializeReleasePlanArtifact,
} from "../release-plan.js";
import { LEGACY_DENYLIST_IDENTIFIERS } from "./legacy-denylist.js";

const CLI = "@weaveio/weave-cli";
const OPENCODE = "@weaveio/weave-adapter-opencode";
const CLAUDE = "@weaveio/weave-adapter-claude-code";
const PI = "@weaveio/weave-adapter-pi";
const BASE_SHA = "a".repeat(40);
const RELEASED_SHA = "c".repeat(40);
const ARTIFACTS = "/tmp/publish-artifacts";
const PORTABLE = hexDigest("portable-delegation-limits");
const SETTLEMENT = hexDigest("pi-settlement-budget");
const TAR = {
  [CLI]: "cli-tarball",
  [OPENCODE]: "opencode-tarball",
  [CLAUDE]: "claude-tarball",
  [PI]: "pi-tarball",
} as const;

function digestSeed(seed: string): string {
  return `sha256:${new Bun.CryptoHasher("sha256").update(seed).digest("hex")}`;
}
function hexDigest(seed: string): string {
  return new Bun.CryptoHasher("sha256").update(seed).digest("hex");
}
function bytesFor(seed: string): Uint8Array {
  return new TextEncoder().encode(seed);
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

const STABLE_CHANGELOGS = [
  {
    packageName: CLI,
    version: "0.1.0",
    documentDigest: digestSeed("cli-changelog"),
  },
  {
    packageName: OPENCODE,
    version: "0.1.0",
    documentDigest: digestSeed("opencode-changelog"),
  },
] as const;

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
              sourceDigest: PORTABLE,
              trigger: CLI,
              members: [CLI, OPENCODE],
            },
          },
        },
      ],
    },
    consumed: [
      { id: "pi-settlement-budget", sourceDigest: SETTLEMENT },
      { id: "portable-delegation-limits", sourceDigest: PORTABLE },
    ],
    versions: [
      { packageName: CLI, previousVersion: "0.0.1", version: "0.1.0" },
      { packageName: OPENCODE, previousVersion: "0.0.1", version: "0.1.0" },
    ],
    changelogDigests: [...STABLE_CHANGELOGS],
    baseSha: BASE_SHA,
    releasedSha: RELEASED_SHA,
    docsAudit: {
      auditedSha: BASE_SHA,
      deterministicResultDigest: digestSeed("docs-deterministic"),
      aiResultDigestOrStatus: "not-required",
    },
    binding: binding(),
    ...overrides,
  };
}

function binding(
  overrides: Partial<ReleasePlanBinding> = {},
): ReleasePlanBinding {
  return {
    schemaVersion: RELEASE_PLAN_SCHEMA_VERSION,
    builtSha: RELEASED_SHA,
    tarballs: [tarball(CLI, "0.1.0"), tarball(OPENCODE, "0.1.0")],
    manifestDigests: [
      {
        packageName: CLI,
        stagedManifestDigest: digestSeed("cli-staged"),
        publicManifestDigest: digestSeed("cli-public"),
      },
      {
        packageName: OPENCODE,
        stagedManifestDigest: digestSeed("opencode-staged"),
        publicManifestDigest: digestSeed("opencode-public"),
      },
    ],
    changelogDigests: [...STABLE_CHANGELOGS],
    entryPointDigests: [
      {
        packageName: CLI,
        entryPoint: "dist/index.js",
        digest: digestSeed("cli-entry"),
      },
      {
        packageName: OPENCODE,
        entryPoint: "dist/index.js",
        digest: digestSeed("opencode-entry"),
      },
    ],
    proofMarkers: recordedProofs(true),
    ...overrides,
  };
}

function tarball(
  packageName: keyof typeof TAR,
  version: string,
): ReleasePlanBinding["tarballs"][number] {
  return {
    packageName,
    version,
    path: `artifacts/${packageName.replace("/", "-")}-${version}.tgz`,
    sha256: digestSeed(TAR[packageName]),
  };
}

function recordedProofs(harness: boolean): ReleasePlanBinding["proofMarkers"] {
  return {
    attestation: { status: "pending" },
    cleanConsumer: {
      status: "recorded",
      digest: digestSeed("consumer-proof"),
    },
    harnessProof: harness
      ? { status: "recorded", digest: digestSeed("harness-proof") }
      : { status: "pending" },
    registryVerification: { status: "pending" },
  };
}

function proofChain(source: ReleasePlanBinding): PublicationProofChain {
  return {
    schemaVersion: 1,
    markers: source.tarballs.map((entry) => ({
      packageName: entry.packageName,
      version: entry.version,
      tarballSha256: entry.sha256,
      cleanConsumer: {
        status: "recorded" as const,
        digest: digestSeed(`consumer:${entry.packageName}`),
      },
      ...(requiresHarnessProof(entry.packageName)
        ? {
            harnessProof: {
              status: "recorded" as const,
              digest: digestSeed(`harness:${entry.packageName}`),
            },
          }
        : {}),
    })),
  };
}

function threePackagePlan(): ReleasePlan {
  const versions = [
    { packageName: CLI, previousVersion: "0.0.1", version: "0.1.0" },
    { packageName: OPENCODE, previousVersion: "0.0.1", version: "0.1.0" },
    { packageName: PI, previousVersion: "0.0.1", version: "0.1.0" },
  ] as const;
  const changelogs = versions.map((entry) => ({
    packageName: entry.packageName,
    version: entry.version,
    documentDigest: digestSeed(`${entry.packageName}-changelog`),
  }));
  const bound = binding({
    tarballs: versions.map((entry) =>
      tarball(entry.packageName, entry.version),
    ),
    manifestDigests: versions.map((entry) => ({
      packageName: entry.packageName,
      stagedManifestDigest: digestSeed(`${entry.packageName}-staged`),
      publicManifestDigest: digestSeed(`${entry.packageName}-public`),
    })),
    changelogDigests: changelogs,
    entryPointDigests: versions.map((entry) => ({
      packageName: entry.packageName,
      entryPoint: "dist/index.js",
      digest: digestSeed(`${entry.packageName}-entry`),
    })),
  });
  return plan({
    closure: {
      seed: [CLI],
      selected: [CLI, OPENCODE, PI],
      added: [
        {
          package: OPENCODE,
          reason: {
            kind: "shared-changeset",
            evidence: {
              changesetId: "portable-delegation-limits",
              sourceDigest: PORTABLE,
              trigger: CLI,
              members: [CLI, OPENCODE],
            },
          },
        },
        {
          package: PI,
          reason: {
            kind: "shared-changeset",
            evidence: {
              changesetId: "pi-settlement-budget",
              sourceDigest: SETTLEMENT,
              trigger: CLI,
              members: [CLI, PI],
            },
          },
        },
      ],
    },
    versions: [...versions],
    changelogDigests: changelogs,
    binding: bound,
  });
}

function cliOnlyPlan(): ReleasePlan {
  const changelogs: ReleasePlan["changelogDigests"] = [
    {
      packageName: CLI,
      version: "0.1.0",
      documentDigest: digestSeed("cli-changelog"),
    },
  ];
  return plan({
    seed: [CLI],
    closure: { seed: [CLI], selected: [CLI], added: [] },
    consumed: [{ id: "portable-delegation-limits", sourceDigest: PORTABLE }],
    versions: [
      { packageName: CLI, previousVersion: "0.0.1", version: "0.1.0" },
    ],
    changelogDigests: changelogs,
    binding: binding({
      tarballs: [tarball(CLI, "0.1.0")],
      manifestDigests: [
        {
          packageName: CLI,
          stagedManifestDigest: digestSeed("cli-staged"),
          publicManifestDigest: digestSeed("cli-public"),
        },
      ],
      changelogDigests: changelogs,
      entryPointDigests: [
        {
          packageName: CLI,
          entryPoint: "dist/index.js",
          digest: digestSeed("cli-entry"),
        },
      ],
      proofMarkers: recordedProofs(false),
    }),
  });
}

function channelPlan(
  channel: "next" | "nightly",
  version: string,
): ReleasePlan {
  const source = plan();
  const versions = source.versions.map((entry) => ({
    ...entry,
    version,
  }));
  const changelogs = versions.map((entry) => ({
    packageName: entry.packageName,
    version,
    documentDigest: digestSeed(`${entry.packageName}-${channel}-changelog`),
  }));
  const bound = binding({
    tarballs: versions.map((entry) =>
      tarball(entry.packageName, entry.version),
    ),
    changelogDigests: changelogs,
  });
  return plan({
    channel,
    versions,
    changelogDigests: changelogs,
    binding: bound,
  });
}

class FakeRegistry implements PublishRegistry {
  readonly published: { path: string; tag: PublishTag }[] = [];
  readonly verified: string[] = [];
  readonly reads: string[] = [];
  readonly versions = new Map<string, string>();
  failOnPublishCall?: number;
  failVerifyFor?: string;
  private publishCalls = 0;

  readPublishedTarballDigest(
    packageName: string,
    version: string,
  ): ResultAsync<
    PublishedTarballState,
    { type: "RegistryError"; operation: string; message: string }
  > {
    this.reads.push(`${packageName}@${version}`);
    const sha256 = this.versions.get(`${packageName}@${version}`);
    if (sha256 === undefined) return okAsync({ state: "unpublished" });
    return okAsync({ state: "published", sha256 });
  }

  publishWithProvenance(
    tarballPath: string,
    tag: PublishTag,
  ): ResultAsync<
    void,
    { type: "RegistryError"; operation: string; message: string }
  > {
    this.publishCalls += 1;
    if (this.failOnPublishCall === this.publishCalls)
      return errAsync({
        type: "RegistryError",
        operation: "publish",
        message: "publish failed",
      });
    this.published.push({ path: tarballPath, tag });
    return okAsync(undefined);
  }

  verifyPublished(
    packageName: string,
    version: string,
    expectedSha256: string,
  ): ResultAsync<
    void,
    { type: "RegistryError"; operation: string; message: string }
  > {
    this.verified.push(`${packageName}@${version}`);
    if (this.failVerifyFor === `${packageName}@${version}`)
      return errAsync({
        type: "RegistryError",
        operation: "verifyPublished",
        message: "HTTP 503",
      });
    this.versions.set(`${packageName}@${version}`, expectedSha256);
    return okAsync(undefined);
  }
}

function filesFor(source: ReleasePlanBinding): FileSystem {
  const bytes = new Map<string, Uint8Array>();
  for (const entry of source.tarballs) {
    const seed = TAR[entry.packageName as keyof typeof TAR];
    bytes.set(join(ARTIFACTS, entry.path), bytesFor(seed));
  }
  return memoryFiles({ bytes });
}

function memoryFiles(initial: {
  texts?: Map<string, string>;
  bytes?: Map<string, Uint8Array>;
}): FileSystem & { texts: Map<string, string> } {
  const texts = initial.texts ?? new Map<string, string>();
  const bytes = initial.bytes ?? new Map<string, Uint8Array>();
  return {
    texts,
    exists: (path) => okAsync(texts.has(path) || bytes.has(path)),
    readBytes: (path) => {
      const value = bytes.get(path);
      if (value === undefined)
        return errAsync({
          type: "FileSystemError",
          path,
          message: "missing",
        });
      return okAsync(value);
    },
    readText: (path) => {
      const value = texts.get(path);
      if (value === undefined)
        return errAsync({
          type: "FileSystemError",
          path,
          message: "missing",
        });
      return okAsync(value);
    },
    writeText: (path, contents) => {
      texts.set(path, contents);
      return okAsync(undefined);
    },
    delete: () => okAsync(undefined),
  };
}

function requestFor(source: ReleasePlan) {
  const bound = source.binding;
  if (bound === null) throw new Error("fixture plan must be bound");
  return {
    plan: source,
    proofChain: proofChain(bound),
    artifactDirectory: ARTIFACTS,
  };
}

function execute(source: ReleasePlan, registry: FakeRegistry) {
  const bound = source.binding;
  if (bound === null) throw new Error("fixture plan must be bound");
  return new PublishExecutor({
    registry,
    files: filesFor(bound),
  }).execute(requestFor(source));
}

describe("publication report validation", () => {
  it("accepts a complete catalog-ordered report", () => {
    const source = plan();
    const bound = source.binding;
    if (bound === null) throw new Error("bound");
    const report = {
      schemaVersion: 1 as const,
      channel: "stable" as const,
      tag: "latest" as const,
      releasedSha: RELEASED_SHA,
      members: bound.tarballs.map((entry) => ({
        packageName: entry.packageName,
        version: entry.version,
        tarballSha256: entry.sha256,
        status: "already-published" as const,
        verification: "digest-verified" as const,
      })),
    };
    expect(validatePublicationReport(report).isOk()).toBe(true);
    expect(
      parsePublicationReport(
        expectOk(serializePublicationReport(report)),
      ).isOk(),
    ).toBe(true);
  });

  it("rejects malformed reports", () => {
    expect(validatePublicationReport({}).isErr()).toBe(true);
    expect(
      validatePublicationReport({
        schemaVersion: 1,
        channel: "stable",
        tag: "next",
        releasedSha: RELEASED_SHA,
        members: [
          {
            packageName: CLI,
            version: "0.1.0",
            tarballSha256: digestSeed("x"),
            status: "published",
            verification: "digest-verified",
          },
        ],
      }).isErr(),
    ).toBe(true);
    expect(
      validatePublicationReport({
        schemaVersion: 1,
        channel: "stable",
        tag: "latest",
        releasedSha: RELEASED_SHA,
        extra: true,
        members: [
          {
            packageName: CLI,
            version: "0.1.0",
            tarballSha256: digestSeed("x"),
            status: "published",
            verification: "digest-verified",
          },
        ],
      }).isErr(),
    ).toBe(true);
    expect(
      parsePublicationReport(
        "x".repeat(PUBLICATION_REPORT_LIMITS.bytes + 1),
      ).isErr(),
    ).toBe(true);
  });
});

describe("publication input", () => {
  it("rejects malformed input before contacting the registry", async () => {
    const registry = new FakeRegistry();
    const result = await new PublishExecutor({
      registry,
      files: memoryFiles({}),
    }).execute({
      plan: { not: "a plan" },
      proofChain: { not: "markers" },
      artifactDirectory: ARTIFACTS,
    });
    expect(expectErr(result).type).toBe("InvalidPublicationPlan");
    expect(registry.reads).toEqual([]);
    expect(registry.published).toEqual([]);
  });

  it("refuses pending clean-consumer markers", async () => {
    const source = plan({
      binding: binding({ proofMarkers: recordedProofs(true) }),
    });
    const bound = source.binding;
    if (bound === null) throw new Error("bound");
    bound.proofMarkers.cleanConsumer = { status: "pending" };
    const registry = new FakeRegistry();
    const result = await execute(source, registry);
    const error = expectErr(result);
    expect(error.type).toBe("ProofMarkerMissing");
    if (error.type === "ProofMarkerMissing")
      expect(error.marker).toBe("cleanConsumer");
    expect(registry.published).toEqual([]);
  });

  it("refuses a missing required harness marker", async () => {
    const source = plan();
    const bound = source.binding;
    if (bound === null) throw new Error("bound");
    const chain = proofChain(bound);
    const adapter = chain.markers.find(
      (marker) => marker.packageName === OPENCODE,
    );
    if (adapter === undefined) throw new Error("adapter marker");
    delete adapter.harnessProof;
    const registry = new FakeRegistry();
    const result = await new PublishExecutor({
      registry,
      files: filesFor(bound),
    }).execute({
      plan: source,
      proofChain: chain,
      artifactDirectory: ARTIFACTS,
    });
    const error = expectErr(result);
    expect(error.type).toBe("ProofMarkerMissing");
    if (error.type === "ProofMarkerMissing")
      expect(error.marker).toBe("harnessProof");
    expect(registry.published).toEqual([]);
  });

  it("refuses a proof-chain digest that does not match the binding", async () => {
    const source = plan();
    const bound = source.binding;
    if (bound === null) throw new Error("bound");
    const chain = proofChain(bound);
    const adapter = chain.markers.find(
      (marker) => marker.packageName === OPENCODE,
    );
    if (adapter === undefined) throw new Error("adapter marker");
    adapter.tarballSha256 = digestSeed("other-bytes");
    const registry = new FakeRegistry();
    const result = await new PublishExecutor({
      registry,
      files: filesFor(bound),
    }).execute({
      plan: source,
      proofChain: chain,
      artifactDirectory: ARTIFACTS,
    });
    const error = expectErr(result);
    expect(error.type).toBe("ProofMarkerMismatch");
    if (error.type === "ProofMarkerMismatch") {
      expect(error.packageName).toBe(OPENCODE);
      expect(error.expected).toBe(digestSeed(TAR[OPENCODE]));
      expect(error.actual).toBe(digestSeed("other-bytes"));
    }
    expect(registry.published).toEqual([]);
  });

  it("allows a CLI-only binding without a harness proof", () => {
    const source = cliOnlyPlan();
    expect(validatePublicationRequest(requestFor(source)).isOk()).toBe(true);
  });
});

describe("PublishExecutor", () => {
  it("skips versions whose registry digest matches the binding", async () => {
    const source = plan();
    const bound = source.binding;
    if (bound === null) throw new Error("bound");
    const registry = new FakeRegistry();
    for (const entry of bound.tarballs)
      registry.versions.set(
        `${entry.packageName}@${entry.version}`,
        entry.sha256,
      );
    const result = expectOk(await execute(source, registry));
    expect(result.members.map((member) => member.status)).toEqual([
      "already-published",
      "already-published",
    ]);
    expect(
      result.members.every(
        (member) => member.verification === "digest-verified",
      ),
    ).toBe(true);
    expect(registry.published).toEqual([]);
  });

  it("aborts before publish when a registry digest mismatches", async () => {
    const source = plan();
    const bound = source.binding;
    if (bound === null) throw new Error("bound");
    const registry = new FakeRegistry();
    const first = bound.tarballs[0];
    if (first === undefined) throw new Error("tarball");
    registry.versions.set(
      `${first.packageName}@${first.version}`,
      digestSeed("foreign-bytes"),
    );
    const result = await execute(source, registry);
    const error = expectErr(result);
    expect(error.type).toBe("RegistryDigestMismatch");
    if (error.type === "RegistryDigestMismatch") {
      expect(error.packageName).toBe(CLI);
      expect(error.expected).toBe(first.sha256);
      expect(error.actual).toBe(digestSeed("foreign-bytes"));
    }
    expect(registry.published).toEqual([]);
  });

  it("publishes unpublished packages in catalog order", async () => {
    const source = threePackagePlan();
    const registry = new FakeRegistry();
    const result = expectOk(await execute(source, registry));
    expect(result.members.map((member) => member.packageName)).toEqual([
      CLI,
      OPENCODE,
      PI,
    ]);
    expect(result.members.map((member) => member.status)).toEqual([
      "published",
      "published",
      "published",
    ]);
    expect(registry.published.map((entry) => entry.path)).toEqual([
      join(ARTIFACTS, `artifacts/${CLI.replace("/", "-")}-0.1.0.tgz`),
      join(ARTIFACTS, `artifacts/${OPENCODE.replace("/", "-")}-0.1.0.tgz`),
      join(ARTIFACTS, `artifacts/${PI.replace("/", "-")}-0.1.0.tgz`),
    ]);
  });

  it("verifies each registry digest before the next publish", async () => {
    const source = plan();
    const registry = new FakeRegistry();
    registry.failVerifyFor = `${CLI}@0.1.0`;
    const result = await execute(source, registry);
    const error = expectErr(result);
    expect(error.type).toBe("PublicationIncomplete");
    if (error.type === "PublicationIncomplete") {
      expect(error.report.members.map((member) => member.status)).toEqual([
        "failed",
        "pending",
      ]);
      expect(validatePublicationReport(error.report).isOk()).toBe(true);
    }
    expect(registry.published).toHaveLength(1);
    expect(registry.verified).toEqual([`${CLI}@0.1.0`]);
  });

  it("resumes a mid-sequence failure from the validated report", async () => {
    const source = threePackagePlan();
    const registry = new FakeRegistry();
    registry.failOnPublishCall = 2;
    const first = await execute(source, registry);
    const incomplete = expectErr(first);
    expect(incomplete.type).toBe("PublicationIncomplete");
    if (incomplete.type !== "PublicationIncomplete") return;
    expect(incomplete.report.members.map((member) => member.status)).toEqual([
      "published",
      "failed",
      "pending",
    ]);
    expect(validatePublicationReport(incomplete.report).isOk()).toBe(true);
    registry.failOnPublishCall = undefined;
    const resumed = expectOk(await execute(source, registry));
    expect(resumed.members.map((member) => member.status)).toEqual([
      "already-published",
      "published",
      "published",
    ]);
    expect(
      registry.published.map((entry) => entry.path.split("/").at(-1)),
    ).toEqual([
      "@weaveio-weave-cli-0.1.0.tgz",
      "@weaveio-weave-adapter-opencode-0.1.0.tgz",
      "@weaveio-weave-adapter-pi-0.1.0.tgz",
    ]);
  });

  it("tags stable releases as latest directly", async () => {
    const registry = new FakeRegistry();
    const result = expectOk(await execute(plan(), registry));
    expect(result.tag).toBe("latest");
    expect(result.channel).toBe("stable");
    expect(registry.published.every((entry) => entry.tag === "latest")).toBe(
      true,
    );
    expect(publishTagForChannel("stable")).toBe("latest");
  });

  it("uses the channel name as the publish tag for next and nightly", async () => {
    for (const [channel, version] of [
      ["next", "0.1.0-next.20260818.aaaaaaaaaaaa"],
      ["nightly", "0.1.0-nightly.20260818.aaaaaaaaaaaa"],
    ] as const) {
      const registry = new FakeRegistry();
      const result = expectOk(
        await execute(channelPlan(channel, version), registry),
      );
      expect(result.tag).toBe(channel);
      expect(registry.published.every((entry) => entry.tag === channel)).toBe(
        true,
      );
    }
  });

  it("rejects credential sources before any registry use", async () => {
    const registry = new FakeRegistry();
    const source = plan();
    const bound = source.binding;
    if (bound === null) throw new Error("bound");
    const result = await new PublishExecutor({
      registry,
      files: filesFor(bound),
    }).execute({
      ...requestFor(source),
      credentialScan: { environment: { NPM_TOKEN: "x" } },
    });
    expect(expectErr(result)).toEqual({
      type: "CredentialSourceDetected",
      source: "NPM_TOKEN",
    });
    expect(registry.reads).toEqual([]);
    expect(registry.published).toEqual([]);
  });
});

describe("npm provenance command arguments", () => {
  it("publishes with provenance and the direct channel tag", async () => {
    const calls: string[][] = [];
    const client = new NpmCliRegistryClient({
      run: (argv) => {
        calls.push([...argv]);
        return okAsync({ exitCode: 0, stdout: "", stderr: "" });
      },
    });
    const latest = await client.publishWithProvenance("pkg.tgz", "latest");
    const next = await client.publishWithProvenance("pkg.tgz", "next");
    expect(latest.isOk()).toBe(true);
    expect(next.isOk()).toBe(true);
    expect(calls).toEqual([
      ["npm", "publish", "pkg.tgz", "--provenance", "--tag", "latest"],
      ["npm", "publish", "pkg.tgz", "--provenance", "--tag", "next"],
    ]);
  });

  it("treats a missing registry tarball as unpublished", async () => {
    const fetchNotFound: typeof fetch = Object.assign(
      (..._args: Parameters<typeof fetch>): ReturnType<typeof fetch> =>
        Promise.resolve(new Response(null, { status: 404 })),
      { preconnect: fetch.preconnect },
    );
    const client = new NpmCliRegistryClient(
      { run: () => okAsync({ exitCode: 0, stdout: "", stderr: "" }) },
      fetchNotFound,
    );
    const result = expectOk(
      await client.readPublishedTarballDigest(CLI, "0.1.0"),
    );
    expect(result).toEqual({ state: "unpublished" });
  });

  it("rejects extra flags on the provenance publish form", async () => {
    const result = await new BunCommandRunner().run([
      "npm",
      "publish",
      "pkg.tgz",
      "--provenance",
      "--tag",
      "latest",
      "--force",
    ]);
    expect(expectErr(result).type).toBe("CommandRejected");
  });
});

describe("publish-main", () => {
  it("refuses proof-marker mismatch without publishing", async () => {
    const source = plan();
    const bound = source.binding;
    if (bound === null) throw new Error("bound");
    const chain = proofChain(bound);
    const first = chain.markers[0];
    if (first === undefined) throw new Error("marker");
    first.tarballSha256 = digestSeed("wrong");
    const texts = new Map<string, string>([
      [
        "/tmp/publish-artifacts/plan.json",
        expectOk(serializeReleasePlanArtifact(source)),
      ],
      ["/tmp/publish-artifacts/proof.json", JSON.stringify(chain)],
    ]);
    const files = memoryFiles({ texts, bytes: new Map() });
    const registry = new FakeRegistry();
    const result = await runPublishMain(
      [
        "/tmp/publish-artifacts/plan.json",
        "/tmp/publish-artifacts/proof.json",
        ARTIFACTS,
        "/tmp/publish-artifacts/report.json",
      ],
      {},
      { files, registry },
    );
    expect(expectErr(result).type).toBe("ProofMarkerMismatch");
    expect(registry.published).toEqual([]);
  });

  it("writes a resumable report after a mid-sequence failure", async () => {
    const source = plan();
    const bound = source.binding;
    if (bound === null) throw new Error("bound");
    const texts = new Map<string, string>([
      [
        "/tmp/publish-artifacts/plan.json",
        expectOk(serializeReleasePlanArtifact(source)),
      ],
      ["/tmp/publish-artifacts/proof.json", JSON.stringify(proofChain(bound))],
    ]);
    const bytes = new Map<string, Uint8Array>();
    for (const entry of bound.tarballs)
      bytes.set(join(ARTIFACTS, entry.path), bytesFor(TAR[entry.packageName]));
    const files = memoryFiles({ texts, bytes });
    const registry = new FakeRegistry();
    registry.failOnPublishCall = 2;
    const result = await runPublishMain(
      [
        "/tmp/publish-artifacts/plan.json",
        "/tmp/publish-artifacts/proof.json",
        ARTIFACTS,
        "/tmp/publish-artifacts/report.json",
      ],
      {},
      { files, registry },
    );
    expect(expectErr(result).type).toBe("PublicationIncomplete");
    const report = expectOk(
      parsePublicationReport(
        files.texts.get("/tmp/publish-artifacts/report.json") ?? "",
      ),
    );
    expect(report.members.map((member) => member.status)).toEqual([
      "published",
      "failed",
    ]);
  });

  it("rejects credentials before reading artifacts", async () => {
    const files = memoryFiles({});
    const registry = new FakeRegistry();
    const result = await runPublishMain(
      [
        "/tmp/publish-artifacts/plan.json",
        "/tmp/publish-artifacts/proof.json",
        ARTIFACTS,
        "/tmp/publish-artifacts/report.json",
      ],
      { NODE_AUTH_TOKEN: "x" },
      { files, registry },
    );
    expect(expectErr(result)).toEqual({
      type: "CredentialSourceDetected",
      source: "NODE_AUTH_TOKEN",
    });
    expect(registry.reads).toEqual([]);
  });

  it("rejects malformed argv", () => {
    expect(parsePublishMainArgs([]).isErr()).toBe(true);
    expect(
      parsePublishMainArgs([
        "../plan.json",
        "/tmp/proof.json",
        ARTIFACTS,
        "/tmp/report.json",
      ]).isErr(),
    ).toBe(true);
  });

  it("does not import Changesets, AI, or Git mutation", async () => {
    const mains = await Promise.all([
      Bun.file("scripts/release/publish-main.ts").text(),
      Bun.file("scripts/release/publish-executor.ts").text(),
    ]);
    for (const source of mains) {
      const imports = [...source.matchAll(/from ["']([^"']+)["']/g)].map(
        (match) => match[1] ?? "",
      );
      expect(
        imports.some(
          (specifier) =>
            specifier.includes("changeset") ||
            specifier.includes("/ai/") ||
            specifier.includes("github-client") ||
            LEGACY_DENYLIST_IDENTIFIERS.some((id) => specifier.includes(id)),
        ),
      ).toBe(false);
      expect(source).not.toContain("npm unpublish");
      for (const id of LEGACY_DENYLIST_IDENTIFIERS)
        expect(source, id).not.toContain(id);
    }
  });
});

describe("report coverage", () => {
  it("covers every closure member on success and failure", async () => {
    const source = threePackagePlan();
    const success = expectOk(await execute(source, new FakeRegistry()));
    expect(success.members.map((member) => member.packageName)).toEqual(
      source.closure.selected,
    );
    const failing = new FakeRegistry();
    failing.failOnPublishCall = 1;
    const incomplete = expectErr(await execute(source, failing));
    if (incomplete.type !== "PublicationIncomplete")
      throw new Error("expected incomplete");
    expect(
      incomplete.report.members.map((member) => member.packageName),
    ).toEqual(source.closure.selected);
  });
});
