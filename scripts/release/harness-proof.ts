/**
 * Exact-tarball clean-consumer tests and the five-stage packaged harness
 * proof runner.
 *
 * Every channel (stable, next, nightly) must prove the bytes it is about to
 * publish. A missing, skipped, failed, or digest-mismatched consumer or
 * harness result blocks the whole channel before OIDC.
 *
 * Stages follow docs/testing/adapter-verification.md, then cleanup:
 * bound artifact digest → install with entry-digest proof → fresh host
 * process → inventory/readiness → one adapter-owned action. Cleanup always
 * runs. Proof records bind the exact tarball digest and become Task 20
 * proof-chain markers.
 *
 * Tests inject fake ports. Live hosts belong to later readiness tasks.
 */
import {
  err,
  errAsync,
  ok,
  okAsync,
  type Result,
  type ResultAsync,
} from "neverthrow";
import {
  ADAPTER_HOST_MATRICES,
  type AdapterHostMatrices,
  type HostMatrixRole,
  requiredHostSlots,
} from "./acceptance-manifest.js";
import {
  type AdapterPackageName,
  adaptersInPublishSet,
  type ChangedAdapterSet,
  isAdapterPackage,
} from "./changed-adapters.js";
import {
  PRIVATE_PACKAGE_NAMES,
  type PublicPackageName,
  type ReleaseChannel,
} from "./constants.js";
import { publishablePackageNames } from "./package-policy.js";
import type { ReleaseProofMarker } from "./release-plan.js";

export const HARNESS_PROOF_STAGES = [
  "bound-artifact-digest",
  "install-entry-digest",
  "fresh-host-process",
  "inventory-readiness",
  "adapter-action",
] as const;

export type HarnessProofStage = (typeof HARNESS_PROOF_STAGES)[number];
export const HARNESS_PROOF_CLEANUP_STAGE = "cleanup-verification" as const;

export const PUBLIC_PACKAGE_EXPORT_PATHS = {
  "@weaveio/weave-cli": ["."],
  "@weaveio/weave-adapter-opencode": [".", "./plugin", "./server"],
  "@weaveio/weave-adapter-claude-code": ["."],
  "@weaveio/weave-adapter-pi": [".", "./cli", "./extension"],
} as const satisfies Record<PublicPackageName, readonly string[]>;

export interface HarnessApiKeyCredential {
  readonly kind: "api-key";
  readonly name: string;
  readonly value: string;
}

export type ProofCredentialError =
  | { type: "OauthCredentialRejected"; name: string }
  | { type: "PersistedSessionRejected"; reason: string }
  | { type: "UnsupportedCredentialKind"; kind: string }
  | { type: "EmptyCredential"; field: "name" | "value" };

export interface ProofTarball {
  readonly packageName: PublicPackageName;
  readonly sha256: string;
}

export interface ProofEntryDigest {
  readonly packageName: PublicPackageName;
  readonly entryPoint: string;
  readonly digest: string;
}

export interface ProofBinding {
  readonly tarballs: readonly ProofTarball[];
  readonly entryPointDigests: readonly ProofEntryDigest[];
}

export interface ArtifactDigestProof {
  readonly stage: "bound-artifact-digest";
  readonly tarballDigest: string;
}

export interface InstallProof {
  readonly stage: "install-entry-digest";
  readonly installedPath: string;
  readonly entryDigests: readonly ProofEntryDigest[];
}

export interface FreshHostProof {
  readonly stage: "fresh-host-process";
  readonly processId: string;
  readonly hostVersion: string;
}

export interface ReadinessProof {
  readonly stage: "inventory-readiness";
  readonly loadedFrom: string;
  readonly ready: true;
  readonly resourcesRegisteredOnce: true;
}

export interface AdapterActionProof {
  readonly stage: "adapter-action";
  readonly action: string;
  readonly structuredResult: Readonly<
    Record<string, string | number | boolean>
  >;
}

export interface CleanupProof {
  readonly stage: "cleanup-verification";
  readonly processStopped: true;
  readonly persistedSessions: readonly string[];
}

export type HarnessStageError =
  | {
      type: "StageSkipped";
      adapter?: AdapterPackageName;
      stage: HarnessProofStage | typeof HARNESS_PROOF_CLEANUP_STAGE;
      reason: string;
    }
  | {
      type: "StageFailed";
      adapter?: AdapterPackageName;
      stage: HarnessProofStage | typeof HARNESS_PROOF_CLEANUP_STAGE;
      reason: string;
    }
  | {
      type: "EntryDigestMismatch";
      entryPoint: string;
      expected: string;
      actual: string;
    }
  | { type: "TarballDigestMismatch"; expected: string; actual: string }
  | { type: "PersistedSessionLeft"; sessions: readonly string[] };

export type HarnessProofError =
  | ProofCredentialError
  | HarnessStageError
  | { type: "MissingBoundTarball"; packageName: PublicPackageName }
  | { type: "MissingEntryDigests"; packageName: PublicPackageName }
  | {
      type: "IncompleteHostMatrix";
      adapter: AdapterPackageName;
      missing: HostMatrixRole;
    }
  | {
      type: "HostVersionMismatch";
      adapter: AdapterPackageName;
      role: HostMatrixRole;
      expected: string;
      actual: string;
    }
  | {
      type: "CleanupFailed";
      adapter?: AdapterPackageName;
      reason: string;
      priorError?: HarnessProofError;
    };

export interface HarnessProofPort {
  recordArtifactDigest(input: {
    adapter: AdapterPackageName;
    tarballDigest: string;
    credentials: readonly HarnessApiKeyCredential[];
  }): ResultAsync<ArtifactDigestProof, HarnessStageError>;
  installExactTarball(input: {
    adapter: AdapterPackageName;
    tarballDigest: string;
    expectedEntryDigests: readonly ProofEntryDigest[];
    credentials: readonly HarnessApiKeyCredential[];
  }): ResultAsync<InstallProof, HarnessStageError>;
  startFreshHost(input: {
    adapter: AdapterPackageName;
    hostVersion: string;
    credentials: readonly HarnessApiKeyCredential[];
  }): ResultAsync<FreshHostProof, HarnessStageError>;
  probeInventoryAndReadiness(input: {
    adapter: AdapterPackageName;
    processId: string;
    credentials: readonly HarnessApiKeyCredential[];
  }): ResultAsync<ReadinessProof, HarnessStageError>;
  runAdapterAction(input: {
    adapter: AdapterPackageName;
    processId: string;
    credentials: readonly HarnessApiKeyCredential[];
  }): ResultAsync<AdapterActionProof, HarnessStageError>;
  verifyCleanup(input: {
    adapter: AdapterPackageName;
    processId: string | undefined;
  }): ResultAsync<CleanupProof, HarnessStageError>;
}

export interface CleanConsumerInstall {
  readonly installedPath: string;
  readonly tarballDigest: string;
}

export type CleanConsumerError =
  | { type: "ConsumerSkipped"; packageName: PublicPackageName; reason: string }
  | { type: "ConsumerFailed"; packageName: PublicPackageName; reason: string }
  | {
      type: "ConsumerDigestMismatch";
      packageName: PublicPackageName;
      expected: string;
      actual: string;
    }
  | {
      type: "PrivatePackageExternal";
      packageName: PublicPackageName;
      dependency: string;
    }
  | {
      type: "MissingExport";
      packageName: PublicPackageName;
      exportPath: string;
    }
  | {
      type: "EntryDigestMismatch";
      packageName: PublicPackageName;
      entryPoint: string;
      expected: string;
      actual: string;
    }
  | { type: "WeaveHelpFailed"; reason: string }
  | { type: "MissingBoundTarball"; packageName: PublicPackageName };

export interface CleanConsumerPort {
  installExactTarball(input: {
    packageName: PublicPackageName;
    tarballDigest: string;
  }): ResultAsync<CleanConsumerInstall, CleanConsumerError>;
  importExports(input: {
    packageName: PublicPackageName;
    exportPaths: readonly string[];
  }): ResultAsync<readonly string[], CleanConsumerError>;
  inspectExternalDependencies(input: {
    packageName: PublicPackageName;
  }): ResultAsync<readonly string[], CleanConsumerError>;
  verifyEntryDigests(input: {
    packageName: PublicPackageName;
    expected: readonly ProofEntryDigest[];
  }): ResultAsync<readonly ProofEntryDigest[], CleanConsumerError>;
  runWeaveHelp(): ResultAsync<{ stdout: string }, CleanConsumerError>;
}

export interface CleanConsumerPassRecord {
  readonly kind: "clean-consumer";
  readonly packageName: PublicPackageName;
  readonly tarballDigest: string;
  readonly importedExports: readonly string[];
  readonly entryDigests: readonly ProofEntryDigest[];
}

export interface HarnessProofPassRecord {
  readonly kind: "harness-proof";
  readonly adapter: AdapterPackageName;
  readonly hostRole: HostMatrixRole;
  readonly hostVersion: string;
  readonly tarballDigest: string;
  readonly stages: readonly HarnessProofStage[];
  readonly action: string;
}

export type ConsumerAttempt =
  | { status: "pass"; record: CleanConsumerPassRecord }
  | { status: "skip"; packageName: PublicPackageName; reason: string }
  | { status: "fail"; packageName: PublicPackageName; reason: string }
  | {
      status: "digest-mismatch";
      packageName: PublicPackageName;
      expected: string;
      actual: string;
    };

export type HarnessAttempt =
  | { status: "pass"; record: HarnessProofPassRecord }
  | {
      status: "skip";
      adapter: AdapterPackageName;
      hostRole: HostMatrixRole;
      hostVersion: string;
      reason: string;
    }
  | {
      status: "fail";
      adapter: AdapterPackageName;
      hostRole: HostMatrixRole;
      hostVersion: string;
      reason: string;
    }
  | {
      status: "digest-mismatch";
      adapter: AdapterPackageName;
      expected: string;
      actual: string;
    };

export type ChannelProofBlocker =
  | { type: "EmptyPublishSet" }
  | { type: "MissingConsumerProof"; packageName: PublicPackageName }
  | {
      type: "SkippedConsumerProof";
      packageName: PublicPackageName;
      reason: string;
    }
  | {
      type: "FailedConsumerProof";
      packageName: PublicPackageName;
      reason: string;
    }
  | {
      type: "ConsumerDigestMismatch";
      packageName: PublicPackageName;
      expected: string;
      actual: string;
    }
  | {
      type: "MissingHarnessProof";
      adapter: AdapterPackageName;
      hostRole: HostMatrixRole;
      hostVersion: string;
    }
  | {
      type: "SkippedHarnessProof";
      adapter: AdapterPackageName;
      hostRole: HostMatrixRole;
      hostVersion: string;
      reason: string;
    }
  | {
      type: "FailedHarnessProof";
      adapter: AdapterPackageName;
      hostRole: HostMatrixRole;
      hostVersion: string;
      reason: string;
    }
  | {
      type: "HarnessDigestMismatch";
      adapter: AdapterPackageName;
      expected: string;
      actual: string;
    }
  | {
      type: "IncompleteHostMatrix";
      adapter: AdapterPackageName;
      missing: HostMatrixRole;
    }
  | { type: "AdapterPublishingWithoutProof"; adapter: AdapterPackageName }
  | { type: "PublishSetNotClosed"; missing: readonly PublicPackageName[] }
  | { type: "WeaveHelpMissing" };

export interface ChannelProofPass {
  readonly channel: ReleaseChannel;
  readonly publishSet: readonly PublicPackageName[];
  readonly changedAdapters: readonly AdapterPackageName[];
  readonly tarballDigests: Readonly<Record<string, string>>;
  readonly consumerRecords: readonly CleanConsumerPassRecord[];
  readonly harnessRecords: readonly HarnessProofPassRecord[];
  readonly proofMarkers: {
    readonly cleanConsumer: ReleaseProofMarker & { status: "recorded" };
    readonly harnessProof: ReleaseProofMarker & { status: "recorded" };
  };
}

export function validateProofCredentials(
  credentials: readonly unknown[],
): Result<readonly HarnessApiKeyCredential[], ProofCredentialError> {
  const accepted: HarnessApiKeyCredential[] = [];
  for (const credential of credentials) {
    if (typeof credential !== "object" || credential === null)
      return err({
        type: "UnsupportedCredentialKind",
        kind: typeof credential,
      });
    const record = credential as Record<string, unknown>;
    if (hasPersistedSession(record))
      return err({
        type: "PersistedSessionRejected",
        reason: "credentials must not carry a persisted session",
      });
    if (record.kind === "oauth" || record.kind === "oauth-token")
      return err({
        type: "OauthCredentialRejected",
        name: typeof record.name === "string" ? record.name : "oauth",
      });
    if (record.kind !== "api-key")
      return err({
        type: "UnsupportedCredentialKind",
        kind:
          typeof record.kind === "string" ? record.kind : typeof record.kind,
      });
    if (typeof record.name !== "string" || record.name.length === 0)
      return err({ type: "EmptyCredential", field: "name" });
    if (typeof record.value !== "string" || record.value.length === 0)
      return err({ type: "EmptyCredential", field: "value" });
    accepted.push({
      kind: "api-key",
      name: record.name,
      value: record.value,
    });
  }
  return ok(accepted);
}

export function recordProofMarker(payload: unknown): {
  status: "recorded";
  digest: string;
} {
  return { status: "recorded", digest: canonicalDigest(payload) };
}

export function boundTarballDigest(
  binding: ProofBinding,
  packageName: PublicPackageName,
): Result<
  string,
  { type: "MissingBoundTarball"; packageName: PublicPackageName }
> {
  const tarball = binding.tarballs.find(
    (entry) => entry.packageName === packageName,
  );
  if (tarball === undefined)
    return err({ type: "MissingBoundTarball", packageName });
  return ok(tarball.sha256);
}

export function boundEntryDigests(
  binding: ProofBinding,
  packageName: PublicPackageName,
): Result<
  readonly ProofEntryDigest[],
  { type: "MissingEntryDigests"; packageName: PublicPackageName }
> {
  const entries = binding.entryPointDigests.filter(
    (entry) => entry.packageName === packageName,
  );
  if (entries.length === 0)
    return err({ type: "MissingEntryDigests", packageName });
  return ok(entries);
}

export function runHarnessProof(input: {
  adapter: AdapterPackageName;
  hostRole: HostMatrixRole;
  hostVersion: string;
  binding: ProofBinding;
  credentials: readonly unknown[];
  port: HarnessProofPort;
  hostMatrices?: AdapterHostMatrices;
}): ResultAsync<HarnessProofPassRecord, HarnessProofError> {
  const credentials = validateProofCredentials(input.credentials);
  if (credentials.isErr()) return errAsync(credentials.error);
  const slots = requiredHostSlots(
    input.adapter,
    input.hostMatrices ?? ADAPTER_HOST_MATRICES,
  );
  if (slots.isErr())
    return errAsync({
      type: "IncompleteHostMatrix",
      adapter: input.adapter,
      missing:
        slots.error.type === "IncompleteHostMatrix"
          ? slots.error.missing
          : "minimum",
    });
  const expectedSlot = slots.value.find((slot) => slot.role === input.hostRole);
  if (expectedSlot === undefined)
    return errAsync({
      type: "IncompleteHostMatrix",
      adapter: input.adapter,
      missing: input.hostRole,
    });
  if (expectedSlot.version !== input.hostVersion)
    return errAsync({
      type: "HostVersionMismatch",
      adapter: input.adapter,
      role: input.hostRole,
      expected: expectedSlot.version,
      actual: input.hostVersion,
    });
  const tarballDigest = boundTarballDigest(input.binding, input.adapter);
  if (tarballDigest.isErr()) return errAsync(tarballDigest.error);
  const entryDigests = boundEntryDigests(input.binding, input.adapter);
  if (entryDigests.isErr()) return errAsync(entryDigests.error);
  const keys = credentials.value;
  return runHarnessStages({
    adapter: input.adapter,
    hostRole: input.hostRole,
    hostVersion: input.hostVersion,
    tarballDigest: tarballDigest.value,
    entryDigests: entryDigests.value,
    credentials: keys,
    port: input.port,
  });
}

export function runCleanConsumer(input: {
  packageName: PublicPackageName;
  binding: ProofBinding;
  port: CleanConsumerPort;
}): ResultAsync<CleanConsumerPassRecord, CleanConsumerError> {
  const tarballDigest = boundTarballDigest(input.binding, input.packageName);
  if (tarballDigest.isErr())
    return errAsync({
      type: "MissingBoundTarball",
      packageName: input.packageName,
    });
  const expectedEntries = boundEntryDigests(input.binding, input.packageName);
  if (expectedEntries.isErr())
    return errAsync({
      type: "ConsumerFailed",
      packageName: input.packageName,
      reason: "missing bound entry digests",
    });
  const exportPaths = PUBLIC_PACKAGE_EXPORT_PATHS[input.packageName];
  return input.port
    .installExactTarball({
      packageName: input.packageName,
      tarballDigest: tarballDigest.value,
    })
    .andThen((installed) => {
      if (installed.tarballDigest !== tarballDigest.value)
        return errAsync({
          type: "ConsumerDigestMismatch" as const,
          packageName: input.packageName,
          expected: tarballDigest.value,
          actual: installed.tarballDigest,
        });
      return input.port
        .importExports({
          packageName: input.packageName,
          exportPaths,
        })
        .andThen((importedExports) => {
          const missing = exportPaths.find(
            (path) => !importedExports.includes(path),
          );
          if (missing !== undefined)
            return errAsync({
              type: "MissingExport" as const,
              packageName: input.packageName,
              exportPath: missing,
            });
          return input.port
            .inspectExternalDependencies({
              packageName: input.packageName,
            })
            .andThen((external) => {
              const leaked = external.find((dependency) =>
                (PRIVATE_PACKAGE_NAMES as readonly string[]).includes(
                  dependency,
                ),
              );
              if (leaked !== undefined)
                return errAsync({
                  type: "PrivatePackageExternal" as const,
                  packageName: input.packageName,
                  dependency: leaked,
                });
              return input.port
                .verifyEntryDigests({
                  packageName: input.packageName,
                  expected: expectedEntries.value,
                })
                .map((entryDigests) => ({
                  kind: "clean-consumer" as const,
                  packageName: input.packageName,
                  tarballDigest: tarballDigest.value,
                  importedExports,
                  entryDigests,
                }));
            });
        });
    });
}

export function provePublishSetConsumers(input: {
  publishSet: readonly PublicPackageName[];
  binding: ProofBinding;
  port: CleanConsumerPort;
}): ResultAsync<
  { records: readonly CleanConsumerPassRecord[]; weaveHelpObserved: boolean },
  CleanConsumerError
> {
  let chain: ResultAsync<CleanConsumerPassRecord[], CleanConsumerError> =
    okAsync([]);
  for (const packageName of input.publishSet)
    chain = chain.andThen((records) =>
      runCleanConsumer({
        packageName,
        binding: input.binding,
        port: input.port,
      }).map((record) => [...records, record]),
    );
  const needsHelp = input.publishSet.includes("@weaveio/weave-cli");
  return chain.andThen((records) => {
    if (!needsHelp) return okAsync({ records, weaveHelpObserved: false });
    return input.port.runWeaveHelp().map((help) => ({
      records,
      weaveHelpObserved: help.stdout.length > 0,
    }));
  });
}

export function proveChangedAdapters(input: {
  changed: ChangedAdapterSet;
  binding: ProofBinding;
  credentials: readonly unknown[];
  port: HarnessProofPort;
  hostMatrices?: AdapterHostMatrices;
}): ResultAsync<readonly HarnessProofPassRecord[], HarnessProofError> {
  const matrices = input.hostMatrices ?? ADAPTER_HOST_MATRICES;
  const jobs: {
    adapter: AdapterPackageName;
    role: HostMatrixRole;
    version: string;
  }[] = [];
  for (const adapter of input.changed.adapters) {
    const slots = requiredHostSlots(adapter, matrices);
    if (slots.isErr())
      return errAsync({
        type: "IncompleteHostMatrix",
        adapter,
        missing:
          slots.error.type === "IncompleteHostMatrix"
            ? slots.error.missing
            : "minimum",
      });
    const seenVersions = new Set<string>();
    for (const slot of slots.value) {
      if (seenVersions.has(slot.version)) continue;
      seenVersions.add(slot.version);
      jobs.push({ adapter, role: slot.role, version: slot.version });
    }
  }
  let chain: ResultAsync<HarnessProofPassRecord[], HarnessProofError> = okAsync(
    [],
  );
  for (const job of jobs)
    chain = chain.andThen((records) =>
      runHarnessProof({
        adapter: job.adapter,
        hostRole: job.role,
        hostVersion: job.version,
        binding: input.binding,
        credentials: input.credentials,
        port: input.port,
        hostMatrices: matrices,
      }).map((record) => [...records, record]),
    );
  return chain;
}

export function evaluateChannelProofs(input: {
  channel: ReleaseChannel;
  closedPublishSet: readonly PublicPackageName[];
  binding: ProofBinding;
  consumerAttempts: readonly ConsumerAttempt[];
  harnessAttempts: readonly HarnessAttempt[];
  hostMatrices?: AdapterHostMatrices;
  weaveHelpObserved?: boolean;
  claimedPublishSet?: readonly PublicPackageName[];
}): Result<ChannelProofPass, ChannelProofBlocker> {
  if (input.closedPublishSet.length === 0)
    return err({ type: "EmptyPublishSet" });
  const catalog = new Set<string>(publishablePackageNames());
  for (const packageName of input.closedPublishSet)
    if (!catalog.has(packageName))
      return err({
        type: "PublishSetNotClosed",
        missing: [packageName as PublicPackageName],
      });
  if (input.claimedPublishSet !== undefined) {
    const closed = new Set(input.closedPublishSet);
    const missing = input.closedPublishSet.filter(
      (packageName) => !input.claimedPublishSet?.includes(packageName),
    );
    const extra = input.claimedPublishSet.filter(
      (packageName) => !closed.has(packageName),
    );
    if (missing.length > 0 || extra.length > 0)
      return err({
        type: "PublishSetNotClosed",
        missing: missing.length > 0 ? missing : extra,
      });
  }
  const matrices = input.hostMatrices ?? ADAPTER_HOST_MATRICES;
  const publishSet = orderCatalog(input.closedPublishSet);
  const changedAdapters = adaptersInPublishSet(publishSet);
  if (
    publishSet.includes("@weaveio/weave-cli") &&
    input.weaveHelpObserved !== true
  )
    return err({ type: "WeaveHelpMissing" });

  const tarballDigests: Record<string, string> = {};
  const consumerRecords: CleanConsumerPassRecord[] = [];
  for (const packageName of publishSet) {
    const expected = boundTarballDigest(input.binding, packageName);
    if (expected.isErr())
      return err({ type: "MissingConsumerProof", packageName });
    tarballDigests[packageName] = expected.value;
    const attempt = input.consumerAttempts.find(
      (candidate) => consumerPackage(candidate) === packageName,
    );
    if (attempt === undefined)
      return err({ type: "MissingConsumerProof", packageName });
    if (attempt.status === "skip")
      return err({
        type: "SkippedConsumerProof",
        packageName,
        reason: attempt.reason,
      });
    if (attempt.status === "fail")
      return err({
        type: "FailedConsumerProof",
        packageName,
        reason: attempt.reason,
      });
    if (attempt.status === "digest-mismatch")
      return err({
        type: "ConsumerDigestMismatch",
        packageName,
        expected: attempt.expected,
        actual: attempt.actual,
      });
    if (attempt.record.tarballDigest !== expected.value)
      return err({
        type: "ConsumerDigestMismatch",
        packageName,
        expected: expected.value,
        actual: attempt.record.tarballDigest,
      });
    consumerRecords.push(attempt.record);
  }

  const harnessRecords: HarnessProofPassRecord[] = [];
  for (const adapter of changedAdapters) {
    const adapterAttempts = input.harnessAttempts.filter(
      (attempt) => harnessAdapter(attempt) === adapter,
    );
    if (adapterAttempts.length === 0)
      return err({ type: "AdapterPublishingWithoutProof", adapter });
    const slots = requiredHostSlots(adapter, matrices);
    if (slots.isErr())
      return err({
        type: "IncompleteHostMatrix",
        adapter,
        missing:
          slots.error.type === "IncompleteHostMatrix"
            ? slots.error.missing
            : "minimum",
      });
    const expectedDigest = boundTarballDigest(input.binding, adapter);
    if (expectedDigest.isErr())
      return err({
        type: "MissingHarnessProof",
        adapter,
        hostRole: slots.value[0]?.role ?? "minimum",
        hostVersion: slots.value[0]?.version ?? "",
      });
    for (const slot of slots.value) {
      const covering = adapterAttempts.find((attempt) =>
        harnessCoversSlot(attempt, adapter, slot.role, slot.version),
      );
      if (covering === undefined)
        return err({
          type: "MissingHarnessProof",
          adapter,
          hostRole: slot.role,
          hostVersion: slot.version,
        });
      if (covering.status === "skip")
        return err({
          type: "SkippedHarnessProof",
          adapter,
          hostRole: slot.role,
          hostVersion: slot.version,
          reason: covering.reason,
        });
      if (covering.status === "fail")
        return err({
          type: "FailedHarnessProof",
          adapter,
          hostRole: slot.role,
          hostVersion: slot.version,
          reason: covering.reason,
        });
      if (covering.status === "digest-mismatch")
        return err({
          type: "HarnessDigestMismatch",
          adapter,
          expected: covering.expected,
          actual: covering.actual,
        });
      if (covering.record.tarballDigest !== expectedDigest.value)
        return err({
          type: "HarnessDigestMismatch",
          adapter,
          expected: expectedDigest.value,
          actual: covering.record.tarballDigest,
        });
      if (!harnessRecords.includes(covering.record))
        harnessRecords.push(covering.record);
    }
  }

  return ok({
    channel: input.channel,
    publishSet,
    changedAdapters,
    tarballDigests,
    consumerRecords,
    harnessRecords,
    proofMarkers: {
      cleanConsumer: recordProofMarker(consumerRecords),
      harnessProof: recordProofMarker(harnessRecords),
    },
  });
}

export function runPackagedChannelProofs(input: {
  changed: ChangedAdapterSet;
  binding: ProofBinding;
  consumerPort: CleanConsumerPort;
  harnessPort: HarnessProofPort;
  credentials: readonly unknown[];
  hostMatrices?: AdapterHostMatrices;
}): ResultAsync<ChannelProofPass, ChannelProofBlocker> {
  return provePublishSetConsumers({
    publishSet: input.changed.publishSet,
    binding: input.binding,
    port: input.consumerPort,
  })
    .mapErr(consumerErrorToBlocker)
    .andThen((consumers) =>
      proveChangedAdapters({
        changed: input.changed,
        binding: input.binding,
        credentials: input.credentials,
        port: input.harnessPort,
        hostMatrices: input.hostMatrices,
      })
        .mapErr(harnessErrorToBlocker)
        .andThen((harnessRecords) =>
          evaluateChannelProofs({
            channel: input.changed.channel,
            closedPublishSet: input.changed.publishSet,
            binding: input.binding,
            consumerAttempts: consumers.records.map((record) => ({
              status: "pass",
              record,
            })),
            harnessAttempts: harnessRecords.map((record) => ({
              status: "pass",
              record,
            })),
            hostMatrices: input.hostMatrices,
            weaveHelpObserved:
              consumers.weaveHelpObserved ||
              !input.changed.publishSet.includes("@weaveio/weave-cli"),
          }),
        ),
    );
}

function runHarnessStages(input: {
  adapter: AdapterPackageName;
  hostRole: HostMatrixRole;
  hostVersion: string;
  tarballDigest: string;
  entryDigests: readonly ProofEntryDigest[];
  credentials: readonly HarnessApiKeyCredential[];
  port: HarnessProofPort;
}): ResultAsync<HarnessProofPassRecord, HarnessProofError> {
  let processId: string | undefined;
  const stages = input.port
    .recordArtifactDigest({
      adapter: input.adapter,
      tarballDigest: input.tarballDigest,
      credentials: input.credentials,
    })
    .andThen((digestProof) => {
      if (digestProof.tarballDigest !== input.tarballDigest)
        return errAsync({
          type: "TarballDigestMismatch" as const,
          expected: input.tarballDigest,
          actual: digestProof.tarballDigest,
        });
      return input.port
        .installExactTarball({
          adapter: input.adapter,
          tarballDigest: input.tarballDigest,
          expectedEntryDigests: input.entryDigests,
          credentials: input.credentials,
        })
        .andThen((installed) => {
          const mismatch = findEntryMismatch(
            input.entryDigests,
            installed.entryDigests,
          );
          if (mismatch !== undefined) return errAsync(mismatch);
          return input.port
            .startFreshHost({
              adapter: input.adapter,
              hostVersion: input.hostVersion,
              credentials: input.credentials,
            })
            .andThen((host) => {
              if (host.hostVersion !== input.hostVersion)
                return errAsync({
                  type: "StageFailed" as const,
                  stage: "fresh-host-process" as const,
                  reason: "host version did not match the declared slot",
                });
              processId = host.processId;
              return input.port
                .probeInventoryAndReadiness({
                  adapter: input.adapter,
                  processId: host.processId,
                  credentials: input.credentials,
                })
                .andThen((readiness) => {
                  if (!readiness.ready || !readiness.resourcesRegisteredOnce)
                    return errAsync({
                      type: "StageFailed" as const,
                      stage: "inventory-readiness" as const,
                      reason: "host did not report ready single-copy inventory",
                    });
                  return input.port.runAdapterAction({
                    adapter: input.adapter,
                    processId: host.processId,
                    credentials: input.credentials,
                  });
                });
            });
        });
    })
    .mapErr((error) =>
      error.type === "StageSkipped" || error.type === "StageFailed"
        ? { ...error, adapter: input.adapter }
        : error,
    );

  return stages
    .map((action) => ({ action, stageError: undefined }))
    .orElse((stageError) => okAsync({ action: undefined, stageError }))
    .andThen((outcome) =>
      input.port
        .verifyCleanup({
          adapter: input.adapter,
          processId,
        })
        .orElse((cleanupError) =>
          errAsync({
            type: "CleanupFailed" as const,
            adapter: input.adapter,
            reason: cleanupReason(cleanupError),
            priorError: outcome.stageError,
          }),
        )
        .andThen((cleanup) => {
          if (cleanup.persistedSessions.length > 0)
            return errAsync({
              type: "CleanupFailed" as const,
              adapter: input.adapter,
              reason: "persisted session remained after proof",
              priorError: outcome.stageError,
            });
          if (outcome.stageError !== undefined)
            return errAsync(outcome.stageError);
          if (outcome.action === undefined)
            return errAsync({
              type: "StageFailed" as const,
              stage: "adapter-action" as const,
              reason: "adapter action did not return a structured result",
            });
          return okAsync({
            kind: "harness-proof" as const,
            adapter: input.adapter,
            hostRole: input.hostRole,
            hostVersion: input.hostVersion,
            tarballDigest: input.tarballDigest,
            stages: [...HARNESS_PROOF_STAGES],
            action: outcome.action.action,
          });
        }),
    );
}

function findEntryMismatch(
  expected: readonly ProofEntryDigest[],
  actual: readonly ProofEntryDigest[],
): Extract<HarnessStageError, { type: "EntryDigestMismatch" }> | undefined {
  for (const entry of expected) {
    const found = actual.find(
      (candidate) =>
        candidate.packageName === entry.packageName &&
        candidate.entryPoint === entry.entryPoint,
    );
    if (found === undefined || found.digest !== entry.digest)
      return {
        type: "EntryDigestMismatch",
        entryPoint: entry.entryPoint,
        expected: entry.digest,
        actual: found?.digest ?? "",
      };
  }
  return undefined;
}

function consumerPackage(attempt: ConsumerAttempt): PublicPackageName {
  if (attempt.status === "pass") return attempt.record.packageName;
  return attempt.packageName;
}

function harnessAdapter(attempt: HarnessAttempt): AdapterPackageName {
  if (attempt.status === "pass") return attempt.record.adapter;
  return attempt.adapter;
}

function harnessCoversSlot(
  attempt: HarnessAttempt,
  adapter: AdapterPackageName,
  role: HostMatrixRole,
  version: string,
): boolean {
  if (harnessAdapter(attempt) !== adapter) return false;
  if (attempt.status === "pass")
    return (
      attempt.record.hostVersion === version &&
      (attempt.record.hostRole === role ||
        attempt.record.hostVersion === version)
    );
  if (attempt.status === "digest-mismatch") return true;
  return attempt.hostVersion === version || attempt.hostRole === role;
}

function consumerErrorToBlocker(
  error: CleanConsumerError,
): ChannelProofBlocker {
  if (error.type === "ConsumerSkipped")
    return {
      type: "SkippedConsumerProof",
      packageName: error.packageName,
      reason: error.reason,
    };
  if (error.type === "ConsumerFailed")
    return {
      type: "FailedConsumerProof",
      packageName: error.packageName,
      reason: error.reason,
    };
  if (error.type === "ConsumerDigestMismatch")
    return {
      type: "ConsumerDigestMismatch",
      packageName: error.packageName,
      expected: error.expected,
      actual: error.actual,
    };
  if (error.type === "MissingBoundTarball")
    return { type: "MissingConsumerProof", packageName: error.packageName };
  if (error.type === "WeaveHelpFailed") return { type: "WeaveHelpMissing" };
  return {
    type: "FailedConsumerProof",
    packageName: error.packageName,
    reason: error.type,
  };
}

function harnessErrorToBlocker(error: HarnessProofError): ChannelProofBlocker {
  const adapter = adapterFromError(error);
  if (error.type === "StageSkipped")
    return {
      type: "SkippedHarnessProof",
      adapter,
      hostRole: "minimum",
      hostVersion: "",
      reason: error.reason,
    };
  if (error.type === "TarballDigestMismatch")
    return {
      type: "HarnessDigestMismatch",
      adapter,
      expected: error.expected,
      actual: error.actual,
    };
  if (error.type === "IncompleteHostMatrix")
    return {
      type: "IncompleteHostMatrix",
      adapter: error.adapter,
      missing: error.missing,
    };
  if (
    error.type === "MissingBoundTarball" &&
    isAdapterPackage(error.packageName)
  )
    return {
      type: "AdapterPublishingWithoutProof",
      adapter: error.packageName,
    };
  if (error.type === "CleanupFailed")
    return {
      type: "FailedHarnessProof",
      adapter,
      hostRole: "minimum",
      hostVersion: "",
      reason: error.reason,
    };
  return {
    type: "FailedHarnessProof",
    adapter,
    hostRole: "minimum",
    hostVersion: "",
    reason: error.type,
  };
}

function adapterFromError(error: HarnessProofError): AdapterPackageName {
  if (
    "adapter" in error &&
    error.adapter !== undefined &&
    isAdapterPackage(String(error.adapter))
  )
    return error.adapter as AdapterPackageName;
  if (
    "packageName" in error &&
    error.packageName !== undefined &&
    isAdapterPackage(String(error.packageName))
  )
    return error.packageName as AdapterPackageName;
  return "@weaveio/weave-adapter-pi";
}

function cleanupReason(error: HarnessStageError): string {
  if (error.type === "PersistedSessionLeft")
    return "persisted session remained after proof";
  if (error.type === "StageSkipped" || error.type === "StageFailed")
    return error.reason;
  return error.type;
}

function hasPersistedSession(record: Record<string, unknown>): boolean {
  return (
    record.sessionPath !== undefined ||
    record.sessionFile !== undefined ||
    record.persistedSession !== undefined ||
    record.kind === "persisted-session"
  );
}

function orderCatalog(
  packages: readonly PublicPackageName[],
): readonly PublicPackageName[] {
  const allowed = new Set(packages);
  return publishablePackageNames().filter((packageName) =>
    allowed.has(packageName),
  );
}

function canonicalDigest(value: unknown): string {
  return `sha256:${new Bun.CryptoHasher("sha256")
    .update(JSON.stringify(sortValue(value)))
    .digest("hex")}`;
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortValue((value as Record<string, unknown>)[key])]),
  );
}
