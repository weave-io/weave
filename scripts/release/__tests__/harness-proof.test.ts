import { describe, expect, it } from "bun:test";
import { errAsync, okAsync, type ResultAsync } from "neverthrow";
import {
  ADAPTER_HOST_MATRICES,
  type AdapterHostMatrices,
  parseAdapterHostMatrices,
  requiredHostSlots,
  validateAdapterHostMatrices,
} from "../acceptance-manifest.js";
import {
  type AdapterPackageName,
  type ChangedAdapterSet,
  resolveChangedAdapters,
} from "../changed-adapters.js";
import type { PublicPackageName } from "../constants.js";
import {
  type AdapterActionProof,
  type ArtifactDigestProof,
  type CleanConsumerPort,
  type CleanupProof,
  type ConsumerAttempt,
  evaluateChannelProofs,
  type FreshHostProof,
  HARNESS_PROOF_CLEANUP_STAGE,
  HARNESS_PROOF_STAGES,
  type HarnessApiKeyCredential,
  type HarnessAttempt,
  type HarnessProofPort,
  type HarnessProofStage,
  type HarnessStageError,
  type InstallProof,
  type ProofBinding,
  type ProofEntryDigest,
  PUBLIC_PACKAGE_EXPORT_PATHS,
  proveChangedAdapters,
  provePublishSetConsumers,
  type ReadinessProof,
  recordProofMarker,
  runCleanConsumer,
  runHarnessProof,
  runPackagedChannelProofs,
  validateProofCredentials,
} from "../harness-proof.js";

const CLI = "@weaveio/weave-cli";
const OPENCODE = "@weaveio/weave-adapter-opencode";
const CLAUDE = "@weaveio/weave-adapter-claude-code";
const PI = "@weaveio/weave-adapter-pi";
const SECRET = "sk-test-not-a-real-key";

function digest(seed: string): string {
  return `sha256:${new Bun.CryptoHasher("sha256").update(seed).digest("hex")}`;
}

function entry(
  packageName: PublicPackageName,
  entryPoint = "dist/index.js",
): ProofEntryDigest {
  return {
    packageName,
    entryPoint,
    digest: digest(`${packageName}:${entryPoint}`),
  };
}

function bindingFor(packages: readonly PublicPackageName[]): ProofBinding {
  return {
    tarballs: packages.map((packageName) => ({
      packageName,
      sha256: digest(`tarball:${packageName}`),
    })),
    entryPointDigests: packages.flatMap((packageName) =>
      packageName === OPENCODE
        ? [
            entry(packageName, "dist/index.js"),
            entry(packageName, "dist/plugin.js"),
          ]
        : [entry(packageName)],
    ),
  };
}

const API_KEY: HarnessApiKeyCredential = {
  kind: "api-key",
  name: "OPENAI_API_KEY",
  value: SECRET,
};

class FakeHarnessPort implements HarnessProofPort {
  readonly calls: string[] = [];
  failAt?: HarnessProofStage | typeof HARNESS_PROOF_CLEANUP_STAGE;
  skipAt?: HarnessProofStage | typeof HARNESS_PROOF_CLEANUP_STAGE;
  leftoverSessions = false;
  wrongTarballDigest?: string;
  wrongEntryDigest?: string;
  wrongHostVersion?: string;

  recordArtifactDigest(input: {
    adapter: AdapterPackageName;
    tarballDigest: string;
    credentials: readonly HarnessApiKeyCredential[];
  }): ResultAsync<ArtifactDigestProof, HarnessStageError> {
    this.calls.push("bound-artifact-digest");
    expect(input.credentials).toEqual([API_KEY]);
    return this.stage("bound-artifact-digest", {
      stage: "bound-artifact-digest",
      tarballDigest: this.wrongTarballDigest ?? input.tarballDigest,
    });
  }

  installExactTarball(input: {
    adapter: AdapterPackageName;
    tarballDigest: string;
    expectedEntryDigests: readonly ProofEntryDigest[];
    credentials: readonly HarnessApiKeyCredential[];
  }): ResultAsync<InstallProof, HarnessStageError> {
    this.calls.push("install-entry-digest");
    expect(input.credentials).toEqual([API_KEY]);
    const entryDigests = input.expectedEntryDigests.map((item) => ({
      ...item,
      digest: this.wrongEntryDigest ?? item.digest,
    }));
    return this.stage("install-entry-digest", {
      stage: "install-entry-digest",
      installedPath: `/tmp/proof/${input.adapter}`,
      entryDigests,
    });
  }

  startFreshHost(input: {
    adapter: AdapterPackageName;
    hostVersion: string;
    credentials: readonly HarnessApiKeyCredential[];
  }): ResultAsync<FreshHostProof, HarnessStageError> {
    this.calls.push("fresh-host-process");
    expect(input.credentials).toEqual([API_KEY]);
    return this.stage("fresh-host-process", {
      stage: "fresh-host-process",
      processId: `proc-${input.adapter}`,
      hostVersion: this.wrongHostVersion ?? input.hostVersion,
    });
  }

  probeInventoryAndReadiness(input: {
    adapter: AdapterPackageName;
    processId: string;
    credentials: readonly HarnessApiKeyCredential[];
  }): ResultAsync<ReadinessProof, HarnessStageError> {
    this.calls.push("inventory-readiness");
    expect(input.credentials).toEqual([API_KEY]);
    expect(input.processId).toBe(`proc-${input.adapter}`);
    return this.stage("inventory-readiness", {
      stage: "inventory-readiness",
      loadedFrom: input.processId,
      ready: true as const,
      resourcesRegisteredOnce: true as const,
    });
  }

  runAdapterAction(input: {
    adapter: AdapterPackageName;
    processId: string;
    credentials: readonly HarnessApiKeyCredential[];
  }): ResultAsync<AdapterActionProof, HarnessStageError> {
    this.calls.push("adapter-action");
    expect(input.credentials).toEqual([API_KEY]);
    expect(input.processId).toBe(`proc-${input.adapter}`);
    return this.stage("adapter-action", {
      stage: "adapter-action",
      action: `${input.adapter}:health`,
      structuredResult: { ok: true },
    });
  }

  verifyCleanup(input: {
    adapter: AdapterPackageName;
    processId: string | undefined;
  }): ResultAsync<CleanupProof, HarnessStageError> {
    this.calls.push("cleanup-verification");
    if (input.processId !== undefined)
      expect(input.processId).toBe(`proc-${input.adapter}`);
    if (this.failAt === HARNESS_PROOF_CLEANUP_STAGE)
      return errAsync<CleanupProof, HarnessStageError>({
        type: "StageFailed",
        stage: HARNESS_PROOF_CLEANUP_STAGE,
        reason: "host process still running",
      });
    if (this.skipAt === HARNESS_PROOF_CLEANUP_STAGE)
      return errAsync<CleanupProof, HarnessStageError>({
        type: "StageSkipped",
        stage: HARNESS_PROOF_CLEANUP_STAGE,
        reason: "cleanup skipped",
      });
    return okAsync<CleanupProof, HarnessStageError>({
      stage: HARNESS_PROOF_CLEANUP_STAGE,
      processStopped: true as const,
      persistedSessions: this.leftoverSessions ? ["/tmp/session"] : [],
    });
  }

  private stage<T>(
    name: HarnessProofStage,
    success: T,
  ): ResultAsync<T, HarnessStageError> {
    if (this.failAt === name)
      return errAsync<T, HarnessStageError>({
        type: "StageFailed",
        stage: name,
        reason: `${name} failed`,
      });
    if (this.skipAt === name)
      return errAsync<T, HarnessStageError>({
        type: "StageSkipped",
        stage: name,
        reason: `${name} skipped`,
      });
    return okAsync<T, HarnessStageError>(success);
  }
}

class FakeConsumerPort implements CleanConsumerPort {
  failPackage?: PublicPackageName;
  skipPackage?: PublicPackageName;
  mismatchPackage?: PublicPackageName;
  leakPrivateOn?: PublicPackageName;
  missingExportOn?: PublicPackageName;
  helpStdout = "USAGE";

  installExactTarball(input: {
    packageName: PublicPackageName;
    tarballDigest: string;
  }) {
    if (this.skipPackage === input.packageName)
      return errAsync({
        type: "ConsumerSkipped" as const,
        packageName: input.packageName,
        reason: "skipped",
      });
    if (this.failPackage === input.packageName)
      return errAsync({
        type: "ConsumerFailed" as const,
        packageName: input.packageName,
        reason: "install failed",
      });
    return okAsync({
      installedPath: `/tmp/consumer/${input.packageName}`,
      tarballDigest:
        this.mismatchPackage === input.packageName
          ? digest("other")
          : input.tarballDigest,
    });
  }

  importExports(input: {
    packageName: PublicPackageName;
    exportPaths: readonly string[];
  }) {
    if (this.missingExportOn === input.packageName)
      return okAsync(input.exportPaths.slice(1));
    return okAsync(input.exportPaths);
  }

  inspectExternalDependencies(input: { packageName: PublicPackageName }) {
    if (this.leakPrivateOn === input.packageName)
      return okAsync(["@weaveio/weave-core"]);
    return okAsync(["neverthrow", "zod"]);
  }

  verifyEntryDigests(input: {
    packageName: PublicPackageName;
    expected: readonly ProofEntryDigest[];
  }) {
    return okAsync(input.expected);
  }

  runWeaveHelp() {
    if (this.helpStdout.length === 0)
      return errAsync({
        type: "WeaveHelpFailed" as const,
        reason: "empty help",
      });
    return okAsync({ stdout: this.helpStdout });
  }
}

function consumerPass(
  packageName: PublicPackageName,
  binding: ProofBinding,
): ConsumerAttempt {
  return {
    status: "pass",
    record: {
      kind: "clean-consumer",
      packageName,
      tarballDigest: digest(`tarball:${packageName}`),
      importedExports: [...PUBLIC_PACKAGE_EXPORT_PATHS[packageName]],
      entryDigests: binding.entryPointDigests.filter(
        (item) => item.packageName === packageName,
      ),
    },
  };
}

function harnessPass(
  adapter: AdapterPackageName,
  role: "minimum" | "latest",
  version: string,
): HarnessAttempt {
  return {
    status: "pass",
    record: {
      kind: "harness-proof",
      adapter,
      hostRole: role,
      hostVersion: version,
      tarballDigest: digest(`tarball:${adapter}`),
      stages: [...HARNESS_PROOF_STAGES],
      action: `${adapter}:health`,
    },
  };
}

function allHarnessPasses(
  adapters: readonly AdapterPackageName[],
): HarnessAttempt[] {
  const attempts: HarnessAttempt[] = [];
  for (const adapter of adapters) {
    const slots = requiredHostSlots(adapter)._unsafeUnwrap();
    const seen = new Set<string>();
    for (const slot of slots) {
      if (seen.has(slot.version)) continue;
      seen.add(slot.version);
      attempts.push(harnessPass(adapter, slot.role, slot.version));
    }
  }
  return attempts;
}

function changed(
  channel: ChangedAdapterSet["channel"],
  selected: readonly PublicPackageName[],
): ChangedAdapterSet {
  if (channel === "nightly")
    return resolveChangedAdapters({
      channel,
      affected: { affected: selected },
    })._unsafeUnwrap();
  return resolveChangedAdapters({
    channel,
    closure: { selected },
  })._unsafeUnwrap();
}

describe("host matrices", () => {
  it("declares minimum and latest hosts for OpenCode, Claude Code, and Pi", () => {
    const validated = validateAdapterHostMatrices(ADAPTER_HOST_MATRICES);
    expect(validated.isOk()).toBe(true);
    expect(ADAPTER_HOST_MATRICES[OPENCODE].minimum).toBe("1.15.9");
    expect(ADAPTER_HOST_MATRICES[OPENCODE].latest).toBe("1.15.9");
    expect(ADAPTER_HOST_MATRICES[CLAUDE].minimum).toBe("2.1.220");
    expect(ADAPTER_HOST_MATRICES[CLAUDE].latest).toBe("2.1.220");
    expect(ADAPTER_HOST_MATRICES[PI].minimum).toBe("0.81.1");
    expect(ADAPTER_HOST_MATRICES[PI].latest).toBe("0.84.2");
    expect(requiredHostSlots(PI)._unsafeUnwrap()).toEqual([
      { role: "minimum", version: "0.81.1" },
      { role: "latest", version: "0.84.2" },
    ]);
  });

  it("matches the checked-in host matrix snapshot", async () => {
    const snapshot = parseAdapterHostMatrices(
      await Bun.file("scripts/release/pi-acceptance/host-matrices.json").json(),
    );
    expect(snapshot.isOk()).toBe(true);
    if (snapshot.isErr()) return;
    expect(snapshot.value).toEqual(ADAPTER_HOST_MATRICES);
  });

  it("rejects an incomplete matrix", () => {
    const incomplete = {
      ...ADAPTER_HOST_MATRICES,
      [PI]: { ...ADAPTER_HOST_MATRICES[PI], latest: "" },
    } as AdapterHostMatrices;
    expect(validateAdapterHostMatrices(incomplete).isErr()).toBe(true);
  });
});

describe("credentials", () => {
  it("accepts isolated API keys and rejects OAuth or persisted sessions", () => {
    expect(validateProofCredentials([API_KEY])._unsafeUnwrap()).toEqual([
      API_KEY,
    ]);
    expect(
      validateProofCredentials([
        { kind: "oauth", name: "refresh", value: "token" },
      ])._unsafeUnwrapErr().type,
    ).toBe("OauthCredentialRejected");
    expect(
      validateProofCredentials([
        { kind: "api-key", name: "k", value: "v", sessionPath: "/tmp/s" },
      ])._unsafeUnwrapErr().type,
    ).toBe("PersistedSessionRejected");
  });
});

describe("five-stage harness runner", () => {
  it("runs every stage in order and always verifies cleanup", async () => {
    const port = new FakeHarnessPort();
    const result = await runHarnessProof({
      adapter: PI,
      hostRole: "latest",
      hostVersion: "0.84.2",
      binding: bindingFor([PI]),
      credentials: [API_KEY],
      port,
    });
    expect(result.isOk()).toBe(true);
    if (result.isErr()) return;
    expect(port.calls).toEqual([
      ...HARNESS_PROOF_STAGES,
      "cleanup-verification",
    ]);
    expect(result.value.stages).toEqual([...HARNESS_PROOF_STAGES]);
    expect(result.value.tarballDigest).toBe(
      digest("tarball:@weaveio/weave-adapter-pi"),
    );
    expect(JSON.stringify(result.value)).not.toContain(SECRET);
  });

  it("stops later stages after a failure but still cleans up", async () => {
    const port = new FakeHarnessPort();
    port.failAt = "fresh-host-process";
    const result = await runHarnessProof({
      adapter: OPENCODE,
      hostRole: "minimum",
      hostVersion: "1.15.9",
      binding: bindingFor([OPENCODE]),
      credentials: [API_KEY],
      port,
    });
    expect(result._unsafeUnwrapErr()).toEqual({
      type: "StageFailed",
      adapter: OPENCODE,
      stage: "fresh-host-process",
      reason: "fresh-host-process failed",
    });
    expect(port.calls).toEqual([
      "bound-artifact-digest",
      "install-entry-digest",
      "fresh-host-process",
      "cleanup-verification",
    ]);
  });

  it("treats a skipped stage as a typed skip", async () => {
    const port = new FakeHarnessPort();
    port.skipAt = "inventory-readiness";
    const result = await runHarnessProof({
      adapter: CLAUDE,
      hostRole: "latest",
      hostVersion: "2.1.220",
      binding: bindingFor([CLAUDE]),
      credentials: [API_KEY],
      port,
    });
    expect(result._unsafeUnwrapErr().type).toBe("StageSkipped");
    expect(port.calls.at(-1)).toBe("cleanup-verification");
  });

  it("blocks on a cleanup failure after a passing run", async () => {
    const port = new FakeHarnessPort();
    port.failAt = "cleanup-verification";
    const result = await runHarnessProof({
      adapter: PI,
      hostRole: "minimum",
      hostVersion: "0.81.1",
      binding: bindingFor([PI]),
      credentials: [API_KEY],
      port,
    });
    expect(result._unsafeUnwrapErr().type).toBe("CleanupFailed");
  });

  it("blocks leftover persisted sessions", async () => {
    const port = new FakeHarnessPort();
    port.leftoverSessions = true;
    const result = await runHarnessProof({
      adapter: PI,
      hostRole: "latest",
      hostVersion: "0.84.2",
      binding: bindingFor([PI]),
      credentials: [API_KEY],
      port,
    });
    expect(result._unsafeUnwrapErr()).toMatchObject({
      type: "CleanupFailed",
      reason: "persisted session remained after proof",
    });
  });

  it("binds the exact tarball and entry digests", async () => {
    const port = new FakeHarnessPort();
    port.wrongTarballDigest = digest("other-bytes");
    const digestMismatch = await runHarnessProof({
      adapter: PI,
      hostRole: "latest",
      hostVersion: "0.84.2",
      binding: bindingFor([PI]),
      credentials: [API_KEY],
      port,
    });
    expect(digestMismatch._unsafeUnwrapErr().type).toBe(
      "TarballDigestMismatch",
    );

    const entryPort = new FakeHarnessPort();
    entryPort.wrongEntryDigest = digest("installed-other");
    const entryMismatch = await runHarnessProof({
      adapter: PI,
      hostRole: "latest",
      hostVersion: "0.84.2",
      binding: bindingFor([PI]),
      credentials: [API_KEY],
      port: entryPort,
    });
    expect(entryMismatch._unsafeUnwrapErr().type).toBe("EntryDigestMismatch");
  });
});

describe("clean consumer runner", () => {
  it("imports every export path and rejects private workspace deps", async () => {
    const port = new FakeConsumerPort();
    const binding = bindingFor([CLI, PI]);
    const result = await runCleanConsumer({
      packageName: PI,
      binding,
      port,
    });
    expect(result._unsafeUnwrap().importedExports).toEqual([
      ".",
      "./cli",
      "./extension",
    ]);

    port.leakPrivateOn = CLI;
    const leaked = await runCleanConsumer({
      packageName: CLI,
      binding,
      port,
    });
    expect(leaked._unsafeUnwrapErr().type).toBe("PrivatePackageExternal");
  });

  it("runs weave --help when the CLI is in the publish set", async () => {
    const port = new FakeConsumerPort();
    const result = await provePublishSetConsumers({
      publishSet: [CLI, OPENCODE],
      binding: bindingFor([CLI, OPENCODE]),
      port,
    });
    expect(result._unsafeUnwrap().weaveHelpObserved).toBe(true);
  });
});

describe("channel proof gate", () => {
  it("records Task 20 markers for a closed publish set on every channel", () => {
    for (const channel of ["stable", "next", "nightly"] as const) {
      const publishSet = [CLI, OPENCODE, CLAUDE, PI] as const;
      const binding = bindingFor(publishSet);
      const result = evaluateChannelProofs({
        channel,
        closedPublishSet: publishSet,
        binding,
        consumerAttempts: publishSet.map((packageName) =>
          consumerPass(packageName, binding),
        ),
        harnessAttempts: allHarnessPasses([OPENCODE, CLAUDE, PI]),
        weaveHelpObserved: true,
      });
      expect(result.isOk()).toBe(true);
      if (result.isErr()) return;
      expect(result.value.proofMarkers.cleanConsumer.status).toBe("recorded");
      expect(result.value.proofMarkers.harnessProof.status).toBe("recorded");
      expect(result.value.proofMarkers.cleanConsumer.digest).toMatch(
        /^sha256:[0-9a-f]{64}$/,
      );
      expect(result.value.changedAdapters).toEqual([OPENCODE, CLAUDE, PI]);
    }
  });

  it("blocks a missing, skipped, failed, or mismatched consumer result", () => {
    const publishSet = [CLI, PI] as const;
    const binding = bindingFor(publishSet);
    const base = {
      channel: "stable" as const,
      closedPublishSet: publishSet,
      binding,
      harnessAttempts: allHarnessPasses([PI]),
      weaveHelpObserved: true,
    };
    expect(
      evaluateChannelProofs({
        ...base,
        consumerAttempts: [consumerPass(CLI, binding)],
      })._unsafeUnwrapErr(),
    ).toEqual({ type: "MissingConsumerProof", packageName: PI });
    expect(
      evaluateChannelProofs({
        ...base,
        consumerAttempts: [
          consumerPass(CLI, binding),
          { status: "skip", packageName: PI, reason: "not packed" },
        ],
      })._unsafeUnwrapErr().type,
    ).toBe("SkippedConsumerProof");
    expect(
      evaluateChannelProofs({
        ...base,
        consumerAttempts: [
          consumerPass(CLI, binding),
          { status: "fail", packageName: PI, reason: "import failed" },
        ],
      })._unsafeUnwrapErr().type,
    ).toBe("FailedConsumerProof");
    expect(
      evaluateChannelProofs({
        ...base,
        consumerAttempts: [
          consumerPass(CLI, binding),
          {
            status: "digest-mismatch",
            packageName: PI,
            expected: digest("tarball:@weaveio/weave-adapter-pi"),
            actual: digest("other"),
          },
        ],
      })._unsafeUnwrapErr().type,
    ).toBe("ConsumerDigestMismatch");
  });

  it("blocks a missing, skipped, failed, or mismatched harness proof", () => {
    const publishSet = [PI] as const;
    const binding = bindingFor(publishSet);
    const consumers = [consumerPass(PI, binding)];
    const base = {
      channel: "next" as const,
      closedPublishSet: publishSet,
      binding,
      consumerAttempts: consumers,
      weaveHelpObserved: false,
    };
    expect(
      evaluateChannelProofs({
        ...base,
        harnessAttempts: [],
      })._unsafeUnwrapErr(),
    ).toEqual({ type: "AdapterPublishingWithoutProof", adapter: PI });
    expect(
      evaluateChannelProofs({
        ...base,
        harnessAttempts: [
          harnessPass(PI, "minimum", "0.81.1"),
          {
            status: "skip",
            adapter: PI,
            hostRole: "latest",
            hostVersion: "0.84.2",
            reason: "host unavailable",
          },
        ],
      })._unsafeUnwrapErr().type,
    ).toBe("SkippedHarnessProof");
    expect(
      evaluateChannelProofs({
        ...base,
        harnessAttempts: [
          harnessPass(PI, "minimum", "0.81.1"),
          {
            status: "fail",
            adapter: PI,
            hostRole: "latest",
            hostVersion: "0.84.2",
            reason: "not ready",
          },
        ],
      })._unsafeUnwrapErr().type,
    ).toBe("FailedHarnessProof");
    expect(
      evaluateChannelProofs({
        ...base,
        harnessAttempts: [
          harnessPass(PI, "minimum", "0.81.1"),
          {
            status: "digest-mismatch",
            adapter: PI,
            expected: digest("tarball:@weaveio/weave-adapter-pi"),
            actual: digest("other"),
          },
        ],
      })._unsafeUnwrapErr().type,
    ).toBe("HarnessDigestMismatch");
    expect(
      evaluateChannelProofs({
        ...base,
        harnessAttempts: [harnessPass(PI, "minimum", "0.81.1")],
      })._unsafeUnwrapErr(),
    ).toEqual({
      type: "MissingHarnessProof",
      adapter: PI,
      hostRole: "latest",
      hostVersion: "0.84.2",
    });
  });

  it("blocks when a closure-added package is omitted from the claimed set", () => {
    const binding = bindingFor([OPENCODE, PI]);
    expect(
      evaluateChannelProofs({
        channel: "stable",
        closedPublishSet: [OPENCODE, PI],
        claimedPublishSet: [OPENCODE],
        binding,
        consumerAttempts: [consumerPass(OPENCODE, binding)],
        harnessAttempts: allHarnessPasses([OPENCODE]),
        weaveHelpObserved: false,
      })._unsafeUnwrapErr(),
    ).toEqual({ type: "PublishSetNotClosed", missing: [PI] });
  });

  it("lets one proof cover both roles when min and latest are the same version", () => {
    const binding = bindingFor([OPENCODE]);
    const result = evaluateChannelProofs({
      channel: "nightly",
      closedPublishSet: [OPENCODE],
      binding,
      consumerAttempts: [consumerPass(OPENCODE, binding)],
      harnessAttempts: [harnessPass(OPENCODE, "minimum", "1.15.9")],
      weaveHelpObserved: false,
    });
    expect(result.isOk()).toBe(true);
  });

  it("requires weave --help when the CLI publishes", () => {
    const binding = bindingFor([CLI]);
    expect(
      evaluateChannelProofs({
        channel: "stable",
        closedPublishSet: [CLI],
        binding,
        consumerAttempts: [consumerPass(CLI, binding)],
        harnessAttempts: [],
        weaveHelpObserved: false,
      })._unsafeUnwrapErr().type,
    ).toBe("WeaveHelpMissing");
  });
});

describe("packaged channel runner", () => {
  it("proves every publishing adapter on the fake port", async () => {
    const publishSet = [CLI, OPENCODE, PI] as const;
    const result = await runPackagedChannelProofs({
      changed: changed("stable", publishSet),
      binding: bindingFor(publishSet),
      consumerPort: new FakeConsumerPort(),
      harnessPort: new FakeHarnessPort(),
      credentials: [API_KEY],
    });
    expect(result.isOk()).toBe(true);
    if (result.isErr()) return;
    expect(result.value.changedAdapters).toEqual([OPENCODE, PI]);
    expect(result.value.harnessRecords.map((record) => record.adapter)).toEqual(
      [OPENCODE, PI, PI],
    );
    expect(result.value.proofMarkers.harnessProof).toEqual(
      recordProofMarker(result.value.harnessRecords),
    );
  });

  it("maps a skipped consumer into a channel blocker", async () => {
    const port = new FakeConsumerPort();
    port.skipPackage = PI;
    const result = await runPackagedChannelProofs({
      changed: changed("next", [PI]),
      binding: bindingFor([PI]),
      consumerPort: port,
      harnessPort: new FakeHarnessPort(),
      credentials: [API_KEY],
    });
    expect(result._unsafeUnwrapErr().type).toBe("SkippedConsumerProof");
  });

  it("maps a failed harness stage into a channel blocker", async () => {
    const port = new FakeHarnessPort();
    port.failAt = "adapter-action";
    const result = await runPackagedChannelProofs({
      changed: changed("nightly", [CLAUDE]),
      binding: bindingFor([CLAUDE]),
      consumerPort: new FakeConsumerPort(),
      harnessPort: port,
      credentials: [API_KEY],
    });
    expect(result._unsafeUnwrapErr().type).toBe("FailedHarnessProof");
  });
});

describe("proveChangedAdapters unique host versions", () => {
  it("runs Pi twice for distinct min and latest hosts", async () => {
    const port = new FakeHarnessPort();
    const result = await proveChangedAdapters({
      changed: changed("stable", [PI]),
      binding: bindingFor([PI]),
      credentials: [API_KEY],
      port,
    });
    expect(result._unsafeUnwrap().map((record) => record.hostVersion)).toEqual([
      "0.81.1",
      "0.84.2",
    ]);
  });
});
