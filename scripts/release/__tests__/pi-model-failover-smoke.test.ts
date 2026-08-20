import { describe, expect, it } from "bun:test";
import { err, ok } from "neverthrow";
import {
  createCleanupResourceTracker,
  runBoundedCommand,
  runWithCleanup,
} from "../pi-model-failover-smoke/command-runner.js";
import {
  ADAPTER_READY_MARKER,
  artifactDigest,
  CLEANUP_PROBE_TIMEOUT_MS,
  CLEANUP_ROOT_MAX_ATTEMPTS,
  CLEANUP_ROOT_TIMEOUT_MS,
  type CleanupProcessObservation,
  containsForbiddenContent,
  EXPECTED_FALLBACK_VISIBLE_EVENT_COUNT,
  EXPECTED_NATIVE_LINE,
  FALLBACK_SUCCESS,
  FIXTURE_CONTEXT_FACTS,
  type FixtureContextFact,
  type FixtureControlFacts,
  type FixtureHistoryDescriptor,
  type FixtureLifecycleFacts,
  type FixtureMessageDescriptor,
  type FixtureMessageFacts,
  type FixtureProviderCapture,
  type FixtureShimFacts,
  type FixtureSnapshot,
  fixtureCorrelationHash,
  fixtureDescriptorForFact,
  fixtureHistoryDescriptorForFact,
  fixtureMarkerTokenHash,
  fixtureRoleHash,
  MAX_REPORT_BYTES,
  MAX_REPORT_STRING_LENGTH,
  type NativeSessionObservation,
  PARENT_TASK,
  PROVIDER_FAILURE_MARKER,
  RECOVERY_MARKER,
  REPORT_DIAGNOSTIC_CODES,
  ROLLBACK_DISABLED_SURFACE,
  ROLLBACK_SHIM_BOUNDARY,
  redactDiagnostic,
  type ScenarioPaths,
  type SmokeReport,
  type SpawnedProcessLike,
} from "../pi-model-failover-smoke/contract.js";
import {
  buildExpectDriver,
  buildPiLaunchCommand,
  parseSmokeArgs,
  validateCreatedIsolatedPathPolicy,
  validateEphemeralReportPath,
  validateExpectedPiVersion,
  validateIsolatedPathPolicy,
  validateStrictProvenanceEnvironment,
} from "../pi-model-failover-smoke/environment.js";
import { validateFallbackFacts } from "../pi-model-failover-smoke/fallback-validation.js";
import {
  isolatedEnvironment,
  scenarioLauncherPath,
  validateScenarioLauncher,
} from "../pi-model-failover-smoke/fixture-files.js";
import {
  validateControlObserverSource,
  validateFixtureSourceBoundary,
  validateRollbackShimSource,
} from "../pi-model-failover-smoke/fixture-sources.js";
import { parseHealthFacts } from "../pi-model-failover-smoke/health-observation.js";
import {
  MAX_NATIVE_INITIAL_MODEL_ENTRIES,
  MAX_NATIVE_MODEL_TIMELINE_ENTRIES,
  validateObservedSources,
} from "../pi-model-failover-smoke/observation-validation.js";
import {
  inspectPackedArtifact,
  inspectPiCliProvenance,
  validateLoadedAdapterProvenance,
  validatePiVersion,
  verifyArtifactDigest,
  verifyArtifactFileUnchanged,
  verifyInstalledAdapterPackage,
} from "../pi-model-failover-smoke/provenance.js";
import {
  projectSanitizedSmokeReport,
  serializeSmokeReport,
  validateReportSafety,
} from "../pi-model-failover-smoke/report-projection.js";
import { writeSmokeReportAtomically } from "../pi-model-failover-smoke/report-writer.js";
import { validateRollbackFacts } from "../pi-model-failover-smoke/rollback-validation.js";
import { __testing } from "../pi-model-failover-smoke.js";

function closedStream(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.close();
    },
  });
}

function descriptorCounts(descriptors: readonly FixtureMessageDescriptor[]) {
  return {
    descriptorCount: descriptors.length,
    userCount: descriptors.filter(
      (descriptor) => descriptor.roleHash === fixtureRoleHash("user"),
    ).length,
    assistantCount: descriptors.filter(
      (descriptor) => descriptor.roleHash === fixtureRoleHash("assistant"),
    ).length,
    toolResultCount: descriptors.filter(
      (descriptor) => descriptor.roleHash === fixtureRoleHash("toolResult"),
    ).length,
    customCount: descriptors.filter(
      (descriptor) => descriptor.roleHash === fixtureRoleHash("custom"),
    ).length,
  };
}

function derivedFacts(descriptors: readonly FixtureMessageDescriptor[]) {
  const users = new Set(
    (
      [
        "original-task-user",
        "original-user",
        "steering-user",
        "follow-up-user",
        "unrelated-custom",
        "queued-user",
      ] as const
    ).map(fixtureCorrelationHash),
  );
  const userRole = fixtureRoleHash("user");
  return {
    originalUserPresent: descriptors.some(
      (descriptor) => descriptor.roleHash === userRole,
    ),
    taskPresent: descriptors.some(
      (descriptor) =>
        descriptor.correlationHash ===
        fixtureCorrelationHash("original-task-user"),
    ),
    toolCallPresent: descriptors.some(
      (descriptor) =>
        descriptor.correlationHash === fixtureCorrelationHash("tool-call"),
    ),
    toolResultPresent: descriptors.some(
      (descriptor) =>
        descriptor.correlationHash === fixtureCorrelationHash("tool-result"),
    ),
    failedAssistantPresent: descriptors.some(
      (descriptor) =>
        descriptor.correlationHash ===
        fixtureCorrelationHash("failed-assistant"),
    ),
    recoveryMarkerPresent: descriptors.some(
      (descriptor) =>
        descriptor.customTypeHash !== undefined &&
        descriptor.correlationHash === markerTokenHash,
    ),
    syntheticProviderUserMessagePresent: descriptors.some(
      (descriptor) =>
        descriptor.roleHash === userRole &&
        (descriptor.correlationHash === undefined ||
          !users.has(descriptor.correlationHash)),
    ),
  };
}

const providerFacts: readonly FixtureContextFact[] = [
  "original-task-user",
  "original-user",
  "tool-call",
  "tool-result",
  "steering-user",
  "follow-up-user",
  "unrelated-custom",
  "queued-user",
];
const markerToken = "550e8400-e29b-41d4-a716-446655440000";
const markerTokenHash = fixtureMarkerTokenHash(markerToken);

function factDescriptors(
  facts: readonly FixtureContextFact[],
): readonly FixtureMessageDescriptor[] {
  return facts.map((fact, ordinal) => {
    const descriptor = fixtureDescriptorForFact(fact, ordinal);
    if (fact !== "unrelated-custom") return descriptor;
    const { customTypeHash: _customTypeHash, ...withoutCustomType } =
      descriptor;
    return {
      ...withoutCustomType,
      roleHash: fixtureRoleHash("user"),
      contentBlockCount: 1,
    };
  });
}

function request(
  requestNumber: number,
  model: string,
  overrides: Partial<FixtureMessageFacts> = {},
): FixtureMessageFacts {
  const descriptors = overrides.descriptors ?? [
    fixtureDescriptorForFact("original-task-user", 0),
  ];
  return {
    requestNumber,
    provider: "smoke",
    model,
    messageCount: descriptors.length,
    contextHash: `${requestNumber}`.padStart(64, "0"),
    descriptors,
    ...descriptorCounts(descriptors),
    ...derivedFacts(descriptors),
    ...overrides,
  };
}

function lifecycle(
  overrides: Partial<FixtureLifecycleFacts> = {},
): FixtureLifecycleFacts {
  const merged = {
    beforeAgentStartCount: 1,
    messageStartCount: 1,
    messageEndCount: 3,
    contextCount: 1,
    modelSelectCount: 1,
    settlementCount: 2,
    markerMessageStartCount: 1,
    recoveryMarkerCount: 1,
    recoveryMarkerObserved: true,
    appliedIdentity: { provider: "smoke", id: "second" },
    ...overrides,
  };
  const markerCount =
    overrides.markerMessageStartCount ??
    overrides.recoveryMarkerCount ??
    (overrides.recoveryMarkerObserved === false
      ? 0
      : merged.recoveryMarkerCount);
  const contextRepairCount =
    overrides.contextRepairCount ??
    (overrides.contextCount === 0 ? 0 : merged.contextCount);
  return {
    ...merged,
    contextRepairCount,
    contextRepairTimesMs:
      overrides.contextRepairTimesMs ??
      Array.from({ length: contextRepairCount }, (_, index) => 1_100 + index),
    modelSelectTimesMs:
      overrides.modelSelectTimesMs ??
      Array.from(
        { length: merged.modelSelectCount },
        (_, index) => 1_200 + index,
      ),
    settlementTimesMs:
      overrides.settlementTimesMs ??
      Array.from(
        { length: merged.settlementCount },
        (_, index) => 1_300 + index,
      ),
    markerMessageStartCount: markerCount,
    markerMessageStartTimesMs:
      overrides.markerMessageStartTimesMs ??
      Array.from({ length: markerCount }, (_, index) => 1_400 + index),
    recoveryMarkerCount: markerCount,
  };
}

function providerCapture(snapshot: FixtureSnapshot): FixtureProviderCapture {
  return {
    schemaVersion: 1,
    kind: "provider",
    role: snapshot.role,
    requestCount: snapshot.requestCount,
    requests: snapshot.requests,
  };
}

function controlCapture(snapshot: FixtureSnapshot): FixtureControlFacts {
  const processIdHash = snapshot.processIdHash ?? "a".repeat(64);
  const hasTool =
    snapshot.parentToolCallIdHash !== undefined ||
    snapshot.parentToolEndCallIdHash !== undefined ||
    snapshot.parentToolPendingMs !== undefined;
  return {
    schemaVersion: 1,
    kind: "control",
    role: snapshot.role,
    processIdHash,
    processIdBeforeHash: snapshot.processIdBeforeHash ?? processIdHash,
    processIdAfterHash: snapshot.processIdAfterHash ?? processIdHash,
    ...(snapshot.childIdHash === undefined
      ? {}
      : { childIdHash: snapshot.childIdHash }),
    ...(snapshot.childIdHash === undefined
      ? {}
      : {
          childIdBeforeHash: snapshot.childIdBeforeHash ?? snapshot.childIdHash,
        }),
    ...(snapshot.childIdHash === undefined
      ? {}
      : {
          childIdAfterHash: snapshot.childIdAfterHash ?? snapshot.childIdHash,
        }),
    ...(snapshot.markerTokenHash === undefined
      ? {}
      : { markerTokenHash: snapshot.markerTokenHash }),
    ...(snapshot.failedAssistantFingerprintHash === undefined
      ? {}
      : {
          failedAssistantFingerprintHash:
            snapshot.failedAssistantFingerprintHash,
        }),
    ...(snapshot.failedAssistantShapeHash === undefined
      ? {}
      : { failedAssistantShapeHash: snapshot.failedAssistantShapeHash }),
    lifecycle: snapshot.lifecycle,
    ...(snapshot.parentToolCallIdHash === undefined
      ? {}
      : { parentToolCallIdHash: snapshot.parentToolCallIdHash }),
    ...(snapshot.parentToolEndCallIdHash === undefined
      ? {}
      : { parentToolEndCallIdHash: snapshot.parentToolEndCallIdHash }),
    ...(snapshot.parentToolStartedAtMs === undefined
      ? {}
      : { parentToolStartedAtMs: snapshot.parentToolStartedAtMs }),
    ...(snapshot.parentToolEndedAtMs === undefined
      ? {}
      : { parentToolEndedAtMs: snapshot.parentToolEndedAtMs }),
    ...(snapshot.parentToolPendingMs === undefined
      ? {}
      : { parentToolPendingMs: snapshot.parentToolPendingMs }),
    ...(hasTool
      ? {
          parentToolStartCount: snapshot.parentToolStartCount ?? 1,
          parentToolEndCount: snapshot.parentToolEndCount ?? 1,
          parentToolStartTimesMs:
            snapshot.parentToolStartTimesMs ??
            (snapshot.parentToolStartedAtMs === undefined
              ? []
              : [snapshot.parentToolStartedAtMs]),
          parentToolEndTimesMs:
            snapshot.parentToolEndTimesMs ??
            (snapshot.parentToolEndedAtMs === undefined
              ? []
              : [snapshot.parentToolEndedAtMs]),
        }
      : {}),
  };
}

function nativeObservation(
  snapshot: FixtureSnapshot,
  overrides: Partial<
    Pick<
      NativeSessionObservation,
      | "modelTransitions"
      | "modelTransitionTimesMs"
      | "modelTransitionIdentities"
      | "appliedIdentity"
    >
  > = {},
): NativeSessionObservation {
  const sessionIdHash = snapshot.sessionIdHash ?? "c".repeat(64);
  const originRequest = snapshot.requests[0];
  const originIdentity =
    originRequest === undefined
      ? undefined
      : { provider: originRequest.provider, id: originRequest.model };
  const appliedIdentity =
    overrides.appliedIdentity ??
    snapshot.lifecycle.appliedIdentity ??
    (snapshot.role === "parent" ? originIdentity : undefined);
  const identityChanged =
    originIdentity !== undefined &&
    appliedIdentity !== undefined &&
    (originIdentity.provider !== appliedIdentity.provider ||
      originIdentity.id !== appliedIdentity.id);
  let defaultModelTransitions = snapshot.lifecycle.modelSelectCount;
  if (appliedIdentity !== undefined) {
    if (identityChanged) {
      defaultModelTransitions = snapshot.role === "child" ? 3 : 2;
    } else {
      defaultModelTransitions = snapshot.role === "parent" ? 2 : 1;
    }
  }
  const modelTransitions =
    overrides.modelTransitions ?? defaultModelTransitions;
  const modelTransitionTimesMs =
    overrides.modelTransitionTimesMs ??
    Array.from({ length: modelTransitions }, (_, index) =>
      identityChanged && index === modelTransitions - 1
        ? 1_199
        : 1_000 + index * 100,
    );
  let defaultModelTransitionIdentities: readonly {
    provider: string;
    id: string;
  }[] = [];
  if (appliedIdentity !== undefined) {
    defaultModelTransitionIdentities =
      identityChanged && originIdentity !== undefined
        ? [
            ...Array.from(
              { length: modelTransitions - 1 },
              () => originIdentity,
            ),
            appliedIdentity,
          ]
        : Array.from({ length: modelTransitions }, () => appliedIdentity);
  }
  const modelTransitionIdentities =
    overrides.modelTransitionIdentities ?? defaultModelTransitionIdentities;
  return {
    role: snapshot.role,
    sessionIdHash,
    sessionIdBeforeHash: snapshot.sessionIdBeforeHash ?? sessionIdHash,
    sessionIdAfterHash: snapshot.sessionIdAfterHash ?? sessionIdHash,
    ...(snapshot.threadIdHash === undefined
      ? {}
      : { threadIdHash: snapshot.threadIdHash }),
    ...(snapshot.threadIdHash === undefined
      ? {}
      : {
          threadIdBeforeHash:
            snapshot.threadIdBeforeHash ?? snapshot.threadIdHash,
        }),
    ...(snapshot.threadIdHash === undefined
      ? {}
      : {
          threadIdAfterHash:
            snapshot.threadIdAfterHash ?? snapshot.threadIdHash,
        }),
    history: snapshot.history ?? {
      entryCount: 0,
      historyHash: "d".repeat(64),
      descriptors: [],
      descriptorCount: 0,
      userCount: 0,
      assistantCount: 0,
      toolResultCount: 0,
      customCount: 0,
      failedAssistantPresent: false,
      recoveryMarkerPresent: false,
      successfulAssistantPresent: false,
      recoveryEntryPresent: false,
    },
    modelTransitions,
    modelTransitionTimesMs,
    modelTransitionIdentities,
    recoveryMarkerCount: snapshot.lifecycle.recoveryMarkerCount,
    ...(appliedIdentity === undefined ? {} : { appliedIdentity }),
  };
}

function rollbackNativeObservation(
  snapshot: FixtureSnapshot,
): NativeSessionObservation {
  return nativeObservation(snapshot, {
    modelTransitions: 2,
    modelTransitionTimesMs: [1_100, 1_200],
    modelTransitionIdentities: [
      { provider: "smoke", id: "first" },
      { provider: "smoke", id: "first" },
    ],
    appliedIdentity: { provider: "smoke", id: "first" },
  });
}

function rollbackShim(
  phase: "before-adapter" | "after-adapter",
): FixtureShimFacts {
  return {
    schemaVersion: 1,
    kind: "rollback-shim",
    role: "parent",
    phase,
    boundary: ROLLBACK_SHIM_BOUNDARY,
    disabledSurface: ROLLBACK_DISABLED_SURFACE,
    originalSurfacePresent: true,
    disabledBeforeAdapterInitialization: true,
    requiredDelegationSurfacesIntact: true,
    adapterInitialized: phase === "after-adapter",
  };
}

const ROLLBACK_HEALTH_OUTPUT = [
  "Weave adapter mode: ready",
  "health-only: false",
  "host surface gap: capability: runtime-model-fallback; host version: 0.84.2; contract: optional runtime fallback; probe: unavailable:callable-send-message-unsupported; mode: feature-unavailable; remediation: use a host with the complete optional surface",
].join("\n");

function rollbackParentSnapshot(): FixtureSnapshot {
  const task = fixtureHistoryDescriptorForFact("original-task-user", 0, 1);
  const failed = fixtureHistoryDescriptorForFact("failed-assistant", 1, 2);
  const historyDescriptors = [task, failed] as const;
  const historyCounts = descriptorCounts(historyDescriptors);
  const history = {
    entryCount: 2,
    historyHash: "e".repeat(64),
    descriptors: historyDescriptors,
    ...historyCounts,
    failedAssistantPresent: true,
    recoveryMarkerPresent: false,
    successfulAssistantPresent: false,
    recoveryEntryPresent: false,
  };
  const providerDescriptor = fixtureDescriptorForFact("original-task-user", 0);
  return {
    schemaVersion: 1,
    role: "parent",
    processIdHash: "a".repeat(64),
    processIdBeforeHash: "a".repeat(64),
    processIdAfterHash: "a".repeat(64),
    sessionIdHash: "c".repeat(64),
    sessionIdBeforeHash: "c".repeat(64),
    sessionIdAfterHash: "c".repeat(64),
    failedAssistantFingerprintHash: failed.contentFingerprintHash,
    failedAssistantShapeHash: failed.contentShapeHash,
    requestCount: 1,
    requests: [request(1, "first", { descriptors: [providerDescriptor] })],
    history,
    lifecycle: lifecycle({
      messageStartCount: 2,
      messageEndCount: 2,
      contextCount: 1,
      contextRepairCount: 0,
      contextRepairTimesMs: [],
      modelSelectCount: 0,
      settlementCount: 1,
      markerMessageStartCount: 0,
      recoveryMarkerCount: 0,
      recoveryMarkerObserved: false,
      appliedIdentity: undefined,
    }),
    optionalSurfaceDisabled: true,
    legacySettlement: true,
  };
}

function rollbackInput() {
  const parent = rollbackParentSnapshot();
  const health = parseHealthFacts(ROLLBACK_HEALTH_OUTPUT);
  if (health.isErr()) throw new Error("test setup: rollback health is invalid");
  const observation = {
    output: `${ROLLBACK_HEALTH_OUTPUT}\nlegacy settlement only`,
    visibleEventCount: 0,
    health: health.value,
    captures: [parent],
    providerCaptures: [providerCapture(parent)],
    nativeSessions: [rollbackNativeObservation(parent)],
    controls: [controlCapture(parent)],
    shims: [rollbackShim("before-adapter"), rollbackShim("after-adapter")],
    cleanup: VERIFIED_CLEANUP,
    temporaryRootRemoved: true,
  };
  return { parent, observation };
}

function successfulFallbackInput() {
  const providerDescriptors = factDescriptors(providerFacts);
  const failedAssistant = fixtureHistoryDescriptorForFact(
    "failed-assistant",
    7,
    8,
  );
  const marker = fixtureHistoryDescriptorForFact("recovery-marker", 8, 9, {
    correlationHash: markerTokenHash,
  });
  const successfulAssistant = fixtureHistoryDescriptorForFact(
    "successful-assistant",
    9,
    10,
  );
  const queuedUser = fixtureHistoryDescriptorForFact("queued-user", 10, 11);
  const durableDescriptors: readonly FixtureHistoryDescriptor[] = [
    ...providerFacts
      .slice(0, 7)
      .map((fact, ordinal) =>
        fixtureHistoryDescriptorForFact(fact, ordinal, ordinal + 1),
      ),
    failedAssistant,
    marker,
    successfulAssistant,
    queuedUser,
  ];
  const durableCounts = descriptorCounts(durableDescriptors);
  const child: FixtureSnapshot = {
    schemaVersion: 1,
    role: "child",
    processIdHash: "a".repeat(64),
    processIdBeforeHash: "a".repeat(64),
    processIdAfterHash: "a".repeat(64),
    childIdHash: "b".repeat(64),
    childIdBeforeHash: "b".repeat(64),
    childIdAfterHash: "b".repeat(64),
    sessionIdHash: "c".repeat(64),
    sessionIdBeforeHash: "c".repeat(64),
    sessionIdAfterHash: "c".repeat(64),
    threadIdHash: "d".repeat(64),
    threadIdBeforeHash: "d".repeat(64),
    threadIdAfterHash: "d".repeat(64),
    markerTokenHash,
    failedAssistantFingerprintHash: failedAssistant.contentFingerprintHash,
    failedAssistantShapeHash: failedAssistant.contentShapeHash,
    requestCount: 3,
    requests: [
      request(1, "first", { descriptors: providerDescriptors.slice(0, 3) }),
      request(2, "first", {
        descriptors: [
          ...providerDescriptors,
          fixtureDescriptorForFact(
            "failed-assistant",
            providerDescriptors.length,
          ),
        ],
        failedAssistantPresent: true,
      }),
      request(3, "second", { descriptors: providerDescriptors }),
    ],
    history: {
      entryCount: 11,
      historyHash: "e".repeat(64),
      descriptors: durableDescriptors,
      ...durableCounts,
      failedAssistantPresent: true,
      recoveryMarkerPresent: true,
      successfulAssistantPresent: true,
      recoveryEntryPresent: true,
      markerTokenHash,
      markerTokenValid: true,
      markerCorrelation: {
        failedAssistantOrdinal: failedAssistant.ordinal,
        markerOrdinal: marker.ordinal,
        failedAssistantEntryIndex: failedAssistant.entryIndex,
        markerEntryIndex: marker.entryIndex,
        interveningNativeEntryCount: 0,
        failedAssistantFingerprintHash: failedAssistant.contentFingerprintHash,
        markerTokenHash,
      },
    },
    lifecycle: lifecycle(),
  };
  const parent: FixtureSnapshot = {
    schemaVersion: 1,
    role: "parent",
    processIdHash: "f".repeat(64),
    processIdBeforeHash: "f".repeat(64),
    processIdAfterHash: "f".repeat(64),
    sessionIdHash: "0".repeat(64),
    sessionIdBeforeHash: "0".repeat(64),
    sessionIdAfterHash: "0".repeat(64),
    requestCount: 2,
    requests: [request(1, "first"), request(2, "second")],
    lifecycle: lifecycle({
      messageEndCount: 2,
      contextCount: 0,
      contextRepairCount: 0,
      modelSelectCount: 0,
      modelSelectTimesMs: [],
      settlementCount: 1,
      recoveryMarkerCount: 0,
      markerMessageStartCount: 0,
      recoveryMarkerObserved: false,
      appliedIdentity: undefined,
    }),
    parentToolCallIdHash: "1".repeat(64),
    parentToolEndCallIdHash: "1".repeat(64),
    parentToolStartedAtMs: 100,
    parentToolEndedAtMs: 112,
    parentToolPendingMs: 12,
    parentToolStartCount: 1,
    parentToolEndCount: 1,
    parentToolStartTimesMs: [100],
    parentToolEndTimesMs: [112],
  };
  return {
    observation: {
      output: "MODEL FALLBACK\nmodel fallback · smoke/second",
      visibleEventCount: 1,
      captures: [child, parent],
      providerCaptures: [providerCapture(child), providerCapture(parent)],
      nativeSessions: [nativeObservation(child), nativeObservation(parent)],
      controls: [controlCapture(child), controlCapture(parent)],
      cleanup: VERIFIED_CLEANUP,
      temporaryRootRemoved: true,
    },
    child,
    parent,
  };
}

function rebuildFallbackInput(
  input: ReturnType<typeof successfulFallbackInput>,
  child: FixtureSnapshot,
  parent: FixtureSnapshot,
  observationOverrides: Partial<typeof input.observation> = {},
) {
  return {
    child,
    parent,
    observation: {
      ...input.observation,
      ...observationOverrides,
      captures: [child, parent],
      providerCaptures: [providerCapture(child), providerCapture(parent)],
      nativeSessions: [nativeObservation(child), nativeObservation(parent)],
      controls: observationOverrides.controls ?? [
        controlCapture(child),
        controlCapture(parent),
      ],
    },
  };
}

const VERIFIED_CLEANUP = {
  noChildProcess: true,
  noNativeChild: true,
  noActiveLease: true,
  noTemporaryPane: true,
  noFixtureProcess: true,
  noPiProcess: true,
  noHelperProcess: true,
  temporaryRootRemoved: true,
  timersDisposed: true,
  resourcesDisposed: true,
} as const;

function validFallbackReport(): SmokeReport {
  const facts = validateFallbackFacts(successfulFallbackInput());
  if (facts.isErr()) throw new Error("test setup: fallback report is invalid");
  return {
    schemaVersion: 1,
    checklistVersion: 6,
    artifact: {
      packageName: "@weaveio/weave-adapter-pi",
      packageVersion: "0.0.1",
      sha256: "a".repeat(64),
    },
    pi: { expectedVersion: "0.84.2", observedVersion: "0.84.2" },
    fallback: facts.value,
    diagnostics: [...REPORT_DIAGNOSTIC_CODES],
  };
}

function validRollbackReport(): SmokeReport {
  return {
    schemaVersion: 1,
    checklistVersion: 6,
    artifact: {
      packageName: "@weaveio/weave-adapter-pi",
      packageVersion: "0.0.1",
      sha256: "a".repeat(64),
    },
    pi: { expectedVersion: "0.84.2", observedVersion: "0.84.2" },
    rollback: {
      optionalSurfaceDisabled: true,
      healthReady: true,
      healthOnly: false,
      legacySettlementCount: 1,
      fallbackAttempted: false,
      cleanup: VERIFIED_CLEANUP,
    },
    diagnostics: ["bounded-timeout"],
  };
}

interface PackedArtifactFixture {
  readonly root: string;
  readonly archive: string;
  readonly sha256: string;
  readonly extensionSha256: string;
}

async function withPackedArtifact<T>(
  action: (artifact: PackedArtifactFixture) => Promise<T>,
): Promise<T> {
  const root = `/tmp/weave-packed-provenance-${crypto.randomUUID()}`;
  const packageRoot = `${root}/package`;
  const archive = `${root}/adapter.tgz`;
  const extension = "export default function adapter() {}\n";
  try {
    await Bun.$`mkdir -p ${packageRoot}/dist`;
    await Bun.write(
      `${packageRoot}/package.json`,
      `${JSON.stringify({ name: "@weaveio/weave-adapter-pi", version: "0.0.1" })}\n`,
    );
    await Bun.write(`${packageRoot}/dist/extension.js`, extension);
    await Bun.$`tar -czf ${archive} -C ${root} package/package.json package/dist/extension.js`;
    const bytes = await Bun.file(archive).bytes();
    return await action({
      root,
      archive,
      sha256: artifactDigest(bytes),
      extensionSha256: artifactDigest(new TextEncoder().encode(extension)),
    });
  } finally {
    await Bun.$`rm -rf ${root}`;
  }
}

function strictProvenanceEnvironment(
  overrides: Record<string, string> = {},
): Record<string, string> {
  const root = `/tmp/weave-strict-env-${crypto.randomUUID()}`;
  return {
    PATH: "/usr/bin:/bin",
    HOME: `${root}/home`,
    XDG_CONFIG_HOME: `${root}/config`,
    XDG_DATA_HOME: `${root}/data`,
    XDG_CACHE_HOME: `${root}/cache`,
    XDG_STATE_HOME: `${root}/state`,
    PI_CODING_AGENT_DIR: `${root}/pi`,
    PI_CODING_AGENT_SESSION_DIR: `${root}/pi/sessions`,
    PI_MODEL_SMOKE_CAPTURE_DIR: `${root}/capture`,
    PI_MODEL_SMOKE_EXPECTED_PACKAGE_ROOT: `${root}/pi/npm/node_modules/@weaveio/weave-adapter-pi`,
    PI_MODEL_SMOKE_EXPECTED_EXTENSION_SHA256: "a".repeat(64),
    PI_MODEL_SMOKE_EXPECTED_PACKAGE_VERSION: "0.0.1",
    PI_MODEL_SMOKE_ADAPTER_SOURCE_PROVEN: "1",
    PI_OFFLINE: "1",
    ...overrides,
  };
}

function emptyCleanupObservation(): CleanupProcessObservation {
  return {
    pids: [],
    piTuiPids: [],
    fixturePids: [],
    childPids: [],
    helperPids: [],
    panePids: [],
  };
}

function cleanupFixture(
  options: {
    readonly alive?: () => boolean;
    readonly onRemove?: () => void;
    readonly removeError?: boolean;
    readonly removeOutcomes?: readonly {
      readonly error: boolean;
      readonly gone: boolean;
    }[];
  } = {},
) {
  const root = `/tmp/weave-cleanup-test-${crypto.randomUUID()}`;
  const tracker = createCleanupResourceTracker(root);
  let rootPresent = true;
  let observeCount = 0;
  let removeCount = 0;
  let probeCount = 0;
  const processAlive = options.alive ?? (() => false);
  const hooks = {
    clock: { wait: async () => undefined },
    observeProcesses: async () => {
      observeCount += 1;
      const observation = emptyCleanupObservation();
      if (!processAlive()) return ok(observation);
      return ok({ ...observation, pids: [4242], piTuiPids: [4242] });
    },
    observeLease: async () => ok(true),
    removeRoot: async () => {
      removeCount += 1;
      options.onRemove?.();
      const outcome = options.removeOutcomes?.[removeCount - 1];
      const removeError = outcome?.error ?? options.removeError ?? false;
      if (outcome?.gone === true || (outcome === undefined && !removeError))
        rootPresent = false;
      if (removeError) return err("root-remove-failed" as const);
      return ok(undefined);
    },
    pathExists: async () => {
      probeCount += 1;
      return ok(rootPresent);
    },
  };
  return {
    root,
    tracker,
    hooks,
    get observeCount() {
      return observeCount;
    },
    get removeCount() {
      return removeCount;
    },
    get probeCount() {
      return probeCount;
    },
  };
}

function trackedFakeProcess(input: {
  readonly tracker: ReturnType<typeof createCleanupResourceTracker>;
  readonly exitOn: "SIGTERM" | "SIGKILL" | "never";
}) {
  const signals: string[] = [];
  let resolveExit: ((code: number) => void) | undefined;
  let alive = true;
  const exited = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });
  const unregister = input.tracker.registerProcess({
    id: "fake-pi:4242",
    kind: "pi-tui",
    pid: 4242,
    exited,
    terminate: (signal) => {
      signals.push(signal);
      if (input.exitOn === signal) {
        alive = false;
        resolveExit?.(signal === "SIGTERM" ? 0 : 137);
      }
    },
  });
  return {
    signals,
    isAlive: () => alive,
    unregister,
  };
}

describe("Pi model-fallback release smoke", () => {
  it("constructs the exact direct Pi command and bounded expect driver", () => {
    expect(
      buildPiLaunchCommand({ bunCli: "/bun", piCli: "/pi/cli.js" }),
    ).toEqual(["/bun", "/pi/cli.js", "--offline"]);
    expect(
      buildPiLaunchCommand({
        bunCli: "/bun",
        piCli: "/pi/cli.js",
        launcher: "/tmp/pi/bin/pi",
      }),
    ).toEqual(["/tmp/pi/bin/pi", "--offline"]);
    const driver = buildExpectDriver({
      command: ["/tmp/pi/bin/pi", "--offline"],
      doneMarker: "DONE_MARKER",
      task: "TASK",
      timeoutSeconds: 3,
    });
    expect(driver).toContain("set timeout 3");
    expect(driver).toContain("DONE_MARKER");
    expect(driver).toContain('send "/quit\\r"');

    const fallbackDriver = buildExpectDriver({
      command: ["/tmp/pi/bin/pi", "--offline"],
      doneMarker: "DONE_MARKER",
      task: "FALLBACK_TASK",
      timeoutSeconds: 3,
    });
    const fallbackReady = fallbackDriver.indexOf(
      `-re "${ADAPTER_READY_MARKER}"`,
    );
    const fallbackTask = fallbackDriver.indexOf('send "FALLBACK_TASK\\r"');
    expect(fallbackReady).toBeGreaterThanOrEqual(0);
    expect(fallbackTask).toBeGreaterThan(fallbackReady);
  });

  it("keeps the optional-surface shim isolated from host mutation", () => {
    const source = __testing.rollbackShimSource();
    expect(validateRollbackShimSource(source).isOk()).toBe(true);
    for (const mutation of [
      "globalThis.pi = undefined;",
      'process.env.PI_MODEL_SMOKE_CASE = "rollback";',
      'Bun.env.PI_MODEL_SMOKE_CASE = "rollback";',
      "Bun.env = {};",
      'Object.defineProperty(pi, "sendMessage", { value: undefined });',
      'Reflect.set(pi, "sendMessage", undefined);',
      "pi.sendMessage = undefined;",
      "delete pi.sendMessage;",
    ]) {
      const result = validateRollbackShimSource(`${source}\n${mutation}`);
      expect(result.isErr()).toBe(true);
      if (result.isErr())
        expect(result.error.type).toBe("FixtureBoundaryViolation");
    }
    expect(source).not.toContain("Object.defineProperty");
    expect(source).not.toContain("Reflect.set(");
    expect(source).not.toMatch(/\bpi\.sendMessage\s*=(?!=)/u);
  });

  it("waits for the real Weave startup surface before requesting rollback health", () => {
    const driver = buildExpectDriver({
      command: ["/tmp/pi/bin/pi", "--offline"],
      doneMarker: "DONE_MARKER",
      readyMarker: ADAPTER_READY_MARKER,
      healthCommand: "/weave:health",
      healthMarker: "Weave adapter mode: (ready|health-only)",
      task: "TASK",
      timeoutSeconds: 3,
    });
    const startup = driver.indexOf(`-re "${ADAPTER_READY_MARKER}"`);
    const health = driver.indexOf('send "/weave:health\\r"');
    const task = driver.indexOf('send "TASK\\r"');
    expect(startup).toBeGreaterThanOrEqual(0);
    expect(health).toBeGreaterThan(startup);
    expect(task).toBeGreaterThan(health);
  });

  it("pins child PATH to the owned launcher and rejects launcher aliases", () => {
    const root = `/tmp/weave-launcher-path-${crypto.randomUUID()}`;
    const paths: ScenarioPaths = {
      root,
      home: `${root}/home`,
      piHome: `${root}/pi`,
      configHome: `${root}/config`,
      dataHome: `${root}/data`,
      cacheHome: `${root}/cache`,
      stateHome: `${root}/state`,
      sessionDir: `${root}/sessions`,
      project: `${root}/project`,
      capture: `${root}/capture`,
      packagePath: `${root}/pi/npm/node_modules/@weaveio/weave-adapter-pi`,
      fixturePath: `${root}/pi/npm/node_modules/fixture`,
      piCli: `${root}/pi/npm/node_modules/@earendil-works/pi-coding-agent/dist/cli.js`,
      piCliPackageRoot: `${root}/pi/npm/node_modules/@earendil-works/pi-coding-agent`,
      piCliPackageVersion: "0.84.2",
      bunCli: "/usr/bin/bun",
      expectCli: "/usr/bin/expect",
    };
    const environment = isolatedEnvironment(paths, {
      path: "/tmp/adapter.tgz",
      sha256: "b".repeat(64),
      packageVersion: "0.0.1",
      extensionSha256: "a".repeat(64),
      entries: [],
    });
    expect(environment.isOk()).toBe(true);
    if (environment.isOk()) {
      const pathEntries = environment.value.PATH.split(":");
      expect(pathEntries[0]).toBe(`${root}/bin`);
      expect(pathEntries.at(-1)).toBe("/sbin");
    }
    expect(scenarioLauncherPath(root)).toBe(`${root}/bin/pi`);
    expect(
      validateScenarioLauncher(root, `${root}/bin/../bin/pi`).isErr(),
    ).toBe(true);
    expect(validateScenarioLauncher(root, "/usr/bin/pi").isErr()).toBe(true);
  });

  it("parses a wrapped real Pi health capability gap", () => {
    const output = [
      "Weave adapter mode: ready",
      "health-only: false",
      "host surface gap: capability: runtime-model-fallback; host version: 0.84.2",
      "(supported >=0.81.1, no maximum); contract: optional runtime fallback;",
      "runtime model fallback: public surfaces; probe:",
      "unavailable:callable-send-message-unsupported; mode: feature-unavailable;",
      "remediation: retain legacy settlement",
      "child inspection: native-overlay",
    ].join("\n");
    const result = parseHealthFacts(output);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.source).toBe("real-pi-tui");
      expect(result.value.runtimeModelFallback?.probe).toBe(
        "unavailable:callable-send-message-unsupported",
      );
    }
  });

  it("requires exact Pi 0.84.2 and rejects an altered expected version", () => {
    expect(validatePiVersion("0.84.2\n")).toEqual(ok("0.84.2"));
    const wrongObserved = validatePiVersion("0.84.1\n");
    expect(wrongObserved.isErr()).toBe(true);
    if (wrongObserved.isErr())
      expect(wrongObserved.error.type).toBe("WrongPiVersion");
    const wrongExpected = validateExpectedPiVersion("0.84.1");
    expect(wrongExpected.isErr()).toBe(true);
    if (wrongExpected.isErr())
      expect(wrongExpected.error.type).toBe("WrongExpectedPiVersion");
  });

  it("rejects lifecycle injection at the provider-fixture boundary", () => {
    const provider = __testing.fixtureSource();
    expect(validateFixtureSourceBoundary(provider).isOk()).toBe(true);
    for (const injection of [
      'pi.on("context", () => ({ messages: [] }));',
      'pi.on("agent_settled", () => undefined);',
      'pi.sendMessage({ role: "custom" });',
      "context.messages = [];",
      'sessionManager.appendCustomMessageEntry("marker", "x");',
    ]) {
      const result = validateFixtureSourceBoundary(`${provider}\n${injection}`);
      expect(result.isErr()).toBe(true);
      if (result.isErr())
        expect(result.error.type).toBe("FixtureBoundaryViolation");
    }
    const observer = __testing.controlObserverSource();
    expect(validateControlObserverSource(observer).isOk()).toBe(true);
    const injectedObserver = validateControlObserverSource(
      `${observer}\npi.on("context", () => ({ messages: [] }));`,
    );
    expect(injectedObserver.isErr()).toBe(true);
    if (injectedObserver.isErr())
      expect(injectedObserver.error.type).toBe("FixtureBoundaryViolation");
  });

  it("parses only a bounded ephemeral report invocation", () => {
    const parsed = parseSmokeArgs([
      "--artifact",
      "/tmp/adapter.tgz",
      "--artifact-sha256",
      "a".repeat(64),
      "--case",
      "fallback",
      "--report",
      "/tmp/pi-model-fallback-report.json",
      "--timeout-ms",
      "1000",
    ]);
    expect(parsed.isOk()).toBe(true);
    if (parsed.isOk()) {
      expect(parsed.value.expectedPiVersion).toBe("0.84.2");
      expect(parsed.value.timeoutMs).toBe(1000);
    }
    expect(validateEphemeralReportPath("/Users/jose/report.json").isErr()).toBe(
      true,
    );
  });

  it("times out, force-terminates, and reports bounded command cleanup", async () => {
    const signals: string[] = [];
    const tracker = createCleanupResourceTracker(
      `/tmp/weave-command-cleanup-${crypto.randomUUID()}`,
    );
    let resolveExit: ((code: number) => void) | undefined;
    const exited = new Promise<number>((resolve) => {
      resolveExit = resolve;
    });
    const child: SpawnedProcessLike = {
      stdout: closedStream(),
      stderr: closedStream(),
      exited,
      kill(signal = "SIGTERM") {
        signals.push(signal);
        if (signal === "SIGKILL") resolveExit?.(137);
      },
    };
    const result = await runBoundedCommand(["fake"], {
      cwd: ".",
      env: { PATH: "/usr/bin:/bin" },
      timeoutMs: 5,
      spawn: () => child,
      resources: tracker,
      clock: { wait: async () => undefined },
    });
    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.type).toBe("CommandTimeout");
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(tracker.activeResourceCount).toBe(0);
  });

  it("runs cleanup for success, expected failure, and rejected action paths", async () => {
    let cleanupCount = 0;
    const cleanup = async () => {
      cleanupCount += 1;
      return ok(undefined);
    };
    const success = await runWithCleanup({
      action: async () => ok("done"),
      cleanup,
    });
    const failure = await runWithCleanup({
      action: async () => err("expected"),
      cleanup,
    });
    const rejected = await runWithCleanup({
      action: async () => {
        throw new Error("unexpected action rejection");
      },
      cleanup,
    });
    expect(success).toEqual(ok("done"));
    expect(failure).toEqual(err("expected"));
    expect(rejected.isErr()).toBe(true);
    expect(cleanupCount).toBe(3);
  });

  it("keeps cleanup budgets bounded and retries idempotently", () => {
    expect(CLEANUP_ROOT_TIMEOUT_MS).toBeLessThanOrEqual(30_000);
    expect(CLEANUP_ROOT_TIMEOUT_MS).toBeGreaterThan(0);
    expect(CLEANUP_ROOT_MAX_ATTEMPTS).toBe(3);
    expect(CLEANUP_PROBE_TIMEOUT_MS).toBeLessThanOrEqual(2_000);
    expect(CLEANUP_PROBE_TIMEOUT_MS).toBeGreaterThan(0);
  });

  it("cleans a gracefully exiting Pi process with a fake clock", async () => {
    const fixture = cleanupFixture();
    const process = trackedFakeProcess({
      tracker: fixture.tracker,
      exitOn: "SIGTERM",
    });
    const result = await __testing.cleanupRoot(
      fixture.root,
      ".",
      { PATH: "/usr/bin:/bin" },
      100,
      { tracker: fixture.tracker, hooks: fixture.hooks },
    );
    expect(result.isOk()).toBe(true);
    const repeated = await __testing.cleanupRoot(
      fixture.root,
      ".",
      { PATH: "/usr/bin:/bin" },
      100,
      { tracker: fixture.tracker, hooks: fixture.hooks },
    );
    expect(repeated).toEqual(result);
    expect(process.signals).toEqual(["SIGTERM"]);
    expect(fixture.removeCount).toBe(1);
  });

  it("force-terminates a non-cooperative process within two bounded windows", async () => {
    const fixture = cleanupFixture({ alive: () => process.isAlive() });
    const process = trackedFakeProcess({
      tracker: fixture.tracker,
      exitOn: "SIGKILL",
    });
    const result = await __testing.cleanupRoot(
      fixture.root,
      ".",
      { PATH: "/usr/bin:/bin" },
      100,
      { tracker: fixture.tracker, hooks: fixture.hooks },
    );
    expect(result.isOk()).toBe(true);
    expect(process.signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(fixture.removeCount).toBe(1);
  });

  it("accepts a timed-out root removal when the independent probe sees it gone", async () => {
    const fixture = cleanupFixture({
      removeOutcomes: [{ error: true, gone: true }],
    });
    const result = await __testing.cleanupRoot(
      fixture.root,
      ".",
      { PATH: "/usr/bin:/bin" },
      100,
      { tracker: fixture.tracker, hooks: fixture.hooks },
    );
    expect(result.isOk()).toBe(true);
    expect(fixture.removeCount).toBe(1);
    expect(fixture.probeCount).toBeGreaterThanOrEqual(1);
  });

  it("retries a partial root removal and succeeds on the next attempt", async () => {
    const fixture = cleanupFixture({
      removeOutcomes: [
        { error: true, gone: false },
        { error: false, gone: true },
      ],
    });
    const result = await __testing.cleanupRoot(
      fixture.root,
      ".",
      { PATH: "/usr/bin:/bin" },
      100,
      { tracker: fixture.tracker, hooks: fixture.hooks },
    );
    expect(result.isOk()).toBe(true);
    expect(fixture.removeCount).toBe(2);
    expect(fixture.probeCount).toBeGreaterThanOrEqual(2);
  });

  it("fails closed when a process survives forced termination", async () => {
    const fixture = cleanupFixture({ alive: () => process.isAlive() });
    const process = trackedFakeProcess({
      tracker: fixture.tracker,
      exitOn: "never",
    });
    const result = await __testing.cleanupRoot(
      fixture.root,
      ".",
      { PATH: "/usr/bin:/bin" },
      100,
      { tracker: fixture.tracker, hooks: fixture.hooks },
    );
    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.detail).toBe("process-survivor");
    expect(process.signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(fixture.removeCount).toBe(0);
  });

  it("fails closed after three persistent root-removal attempts", async () => {
    const fixture = cleanupFixture({ removeError: true });
    const result = await __testing.cleanupRoot(
      fixture.root,
      ".",
      { PATH: "/usr/bin:/bin" },
      100,
      { tracker: fixture.tracker, hooks: fixture.hooks },
    );
    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.detail).toBe("root-still-present");
    expect(fixture.removeCount).toBe(CLEANUP_ROOT_MAX_ATTEMPTS);
    expect(fixture.probeCount).toBeGreaterThanOrEqual(
      CLEANUP_ROOT_MAX_ATTEMPTS,
    );
  });

  it("cleans startup errors, scenario timeouts, assertion errors, and report validation errors", async () => {
    const errors = [
      "startup-error",
      "scenario-timeout",
      "assertion-failure",
      "report-validation-failure",
    ] as const;
    for (const error of errors) {
      const fixture = cleanupFixture();
      const result = await runWithCleanup({
        action: async () => err(error),
        cleanup: async () =>
          __testing.cleanupRoot(
            fixture.root,
            ".",
            { PATH: "/usr/bin:/bin" },
            100,
            { tracker: fixture.tracker, hooks: fixture.hooks },
          ),
      });
      expect(result).toEqual(err(error));
      expect(fixture.removeCount).toBe(1);
    }
  });

  it("runs cleanup for a signal path and invokes it only once", async () => {
    let handler: (() => void) | undefined;
    let cleanupCount = 0;
    const result = await runWithCleanup({
      signals: {
        on: (_signal, next) => {
          handler = next;
          return () => {
            handler = undefined;
          };
        },
      },
      action: async () => {
        handler?.();
        handler?.();
        return err("signal");
      },
      cleanup: async () => {
        cleanupCount += 1;
        return ok(undefined);
      },
    });
    expect(result).toEqual(err("signal"));
    expect(cleanupCount).toBe(1);
  });

  it("reports partial temp-root cleanup failure and remains safe to repeat", async () => {
    const fixture = cleanupFixture({ removeError: true });
    const first = await __testing.cleanupRoot(
      fixture.root,
      ".",
      { PATH: "/usr/bin:/bin" },
      100,
      { tracker: fixture.tracker, hooks: fixture.hooks },
    );
    const second = await __testing.cleanupRoot(
      fixture.root,
      ".",
      { PATH: "/usr/bin:/bin" },
      100,
      { tracker: fixture.tracker, hooks: fixture.hooks },
    );
    expect(first.isErr()).toBe(true);
    expect(second).toEqual(first);
    expect(fixture.removeCount).toBe(CLEANUP_ROOT_MAX_ATTEMPTS);
    expect(fixture.probeCount).toBeGreaterThanOrEqual(
      CLEANUP_ROOT_MAX_ATTEMPTS,
    );
  });

  it("redacts credential-shaped diagnostics and bounds serialized reports", () => {
    const diagnostic = redactDiagnostic(
      "token=secret-value authorization: Bearer abc /Users/jose/private.txt",
    );
    expect(diagnostic).not.toContain("secret-value");
    expect(diagnostic).not.toContain("Bearer");
    expect(diagnostic).not.toContain("/Users/jose");
    expect(containsForbiddenContent(diagnostic, ["secret-value"])).toBe(false);
    expect(
      validateReportSafety({
        message: "x".repeat(MAX_REPORT_BYTES + 1),
      }).isErr(),
    ).toBe(true);
    expect(
      validateReportSafety({ message: PROVIDER_FAILURE_MARKER }).isErr(),
    ).toBe(true);
    expect(serializeSmokeReport(validRollbackReport()).isOk()).toBe(true);
  });

  it("projects one bounded fallback report into closed safe outcomes", () => {
    const projected = projectSanitizedSmokeReport(validFallbackReport());
    expect(projected.isOk()).toBe(true);
    if (projected.isErr()) return;
    expect(projected.value.fallback?.outcome).toBe("fallback-confirmed");
    expect(projected.value.fallback?.nativeLine).toBe("model-fallback");
    expect(projected.value.artifact.packageVersion).toBe("0.0.1");
    expect(serializeSmokeReport(projected.value).isOk()).toBe(true);
    const encoded = serializeSmokeReport(validFallbackReport());
    expect(encoded.isOk()).toBe(true);
    if (encoded.isOk()) {
      expect(
        new TextEncoder().encode(encoded.value).byteLength,
      ).toBeLessThanOrEqual(MAX_REPORT_BYTES);
      expect(encoded.value).not.toContain(PROVIDER_FAILURE_MARKER);
      expect(encoded.value).not.toContain("messages");
    }
  });

  it("rejects extra keys, accessors, proxies, unsupported values, and malformed fields", () => {
    const valid = validRollbackReport();
    expect(validateReportSafety({ ...valid, extra: true }).isErr()).toBe(true);
    const accessor = validRollbackReport() as unknown as Record<
      string,
      unknown
    >;
    Object.defineProperty(accessor, "extra", {
      enumerable: true,
      get: () => {
        throw new Error("accessor must not run");
      },
    });
    expect(validateReportSafety(accessor).isErr()).toBe(true);
    expect(validateReportSafety(new Proxy(valid, {})).isErr()).toBe(true);
    for (const unsupported of [
      new Date(),
      new Map<string, string>(),
      () => undefined,
      Symbol("unsupported"),
      1n,
      undefined,
    ]) {
      expect(validateReportSafety({ ...valid, unsupported }).isErr()).toBe(
        true,
      );
    }
    expect(
      validateReportSafety({
        ...valid,
        artifact: { ...valid.artifact, sha256: "not-a-hash" },
      }).isErr(),
    ).toBe(true);
    expect(
      validateReportSafety({
        ...valid,
        pi: { expectedVersion: "0.84.1", observedVersion: "0.84.2" },
      }).isErr(),
    ).toBe(true);
    expect(
      validateReportSafety({
        ...valid,
        diagnostics: ["not-an-allowlisted-code"],
      }).isErr(),
    ).toBe(true);
    expect(
      validateReportSafety({
        ...valid,
        artifact: {
          ...valid.artifact,
          packageVersion: "x".repeat(MAX_REPORT_STRING_LENGTH + 1),
        },
      }).isErr(),
    ).toBe(true);
    const fallback = validFallbackReport();
    expect(
      validateReportSafety({
        ...fallback,
        fallback: {
          ...fallback.fallback,
          processIdentityStable: false,
        },
      }).isErr(),
    ).toBe(true);
    expect(
      validateReportSafety({
        ...fallback,
        fallback: {
          ...fallback.fallback,
          visibleEventCount: 2,
        },
      }).isErr(),
    ).toBe(true);
  });

  it("rejects unsafe counts, false cleanup facts, and unsafe report size", () => {
    const valid = validRollbackReport();
    const rollback = valid.rollback;
    if (rollback === undefined) return;
    for (const count of [
      Number.MAX_SAFE_INTEGER,
      Number.MAX_SAFE_INTEGER + 1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      1.5,
      -1,
    ]) {
      expect(
        validateReportSafety({
          ...valid,
          rollback: { ...rollback, legacySettlementCount: count },
        }).isErr(),
      ).toBe(true);
    }
    expect(
      validateReportSafety({
        ...valid,
        rollback: {
          ...rollback,
          cleanup: { ...rollback.cleanup, temporaryRootRemoved: false },
        },
      }).isErr(),
    ).toBe(true);
    const fallback = validFallbackReport();
    if (fallback.fallback === undefined) return;
    expect(
      validateReportSafety({
        ...fallback,
        fallback: {
          ...fallback.fallback,
          cleanup: { ...fallback.fallback.cleanup, noChildProcess: false },
        },
      }).isErr(),
    ).toBe(true);
    const providerDescriptors = Array.from({ length: 64 }, (_, index) =>
      fixtureDescriptorForFact("original-user", index),
    );
    const historyDescriptors = Array.from({ length: 256 }, (_, index) =>
      fixtureHistoryDescriptorForFact("original-user", index, index + 1),
    );
    const oversized = {
      ...fallback,
      fallback: {
        ...fallback.fallback,
        providerRequest: {
          ...fallback.fallback.providerRequest,
          descriptors: providerDescriptors,
        },
        durableHistory: {
          ...fallback.fallback.durableHistory,
          descriptors: historyDescriptors,
        },
      },
    };
    const encoded = serializeSmokeReport(oversized);
    expect(encoded.isErr()).toBe(true);
    if (encoded.isErr()) expect(encoded.error.type).toBe("ReportTooLarge");
  });

  it("refuses every sensitive leak class before projection", () => {
    const valid = validRollbackReport();
    const leaks = [
      ["markerToken", "550e8400-e29b-41d4-a716-446655440000"],
      [
        "markerDetails",
        { schemaVersion: 1, token: "550e8400-e29b-41d4-a716-446655440000" },
      ],
      ["markerType", "weave.model-fallback.recovery-marker"],
      ["fixtureApiKey", "pi-model-fallback-fixture-key"],
      ["providerBody", '{"messages":[{"role":"user","content":"private"}]}'],
      ["assistantText", "assistant private text"],
      ["userText", "user private text"],
      ["toolOutput", "tool private output"],
      ["rawProviderError", "503 Service Unavailable"],
      ["credentials", "Authorization: Bearer secret"],
      ["tempPath", "/private/tmp/weave-proof/report.json"],
      ["homePath", "/Users/jose/.pi/agent"],
      ["artifactPath", "/tmp/weave-adapter.tgz"],
      ["controlPayload", "child-control envelope"],
      ["cleanupCommandOutput", "rm -rf /private/tmp/weave-proof"],
    ] as const;
    for (const [key, value] of leaks) {
      expect(
        validateReportSafety({ ...valid, [key]: value }).isErr(),
        key,
      ).toBe(true);
    }
  });

  it("rejects unsafe paths and never defaults the report inside the repository", () => {
    expect(validateEphemeralReportPath("").isErr()).toBe(true);
    expect(validateEphemeralReportPath(".release/report.json").isErr()).toBe(
      true,
    );
    expect(validateEphemeralReportPath("/tmp/report\n.json").isErr()).toBe(
      true,
    );
    expect(
      parseSmokeArgs([
        "--artifact",
        "/tmp/adapter.tgz",
        "--artifact-sha256",
        "a".repeat(64),
        "--case",
        "rollback",
      ]).isErr(),
    ).toBe(true);
  });

  it("writes a valid report atomically with restrictive permissions and preserves the old file on validation failure", async () => {
    const root = `/tmp/weave-report-boundary-${crypto.randomUUID()}`;
    const target = `${root}/report.json`;
    await Bun.$`mkdir -p ${root}`;
    await Bun.write(target, "old-report\n");
    const invalid = await writeSmokeReportAtomically(target, {
      ...validRollbackReport(),
      leaked: PROVIDER_FAILURE_MARKER,
    });
    expect(invalid.isErr()).toBe(true);
    expect(await Bun.file(target).text()).toBe("old-report\n");
    const valid = await writeSmokeReportAtomically(
      target,
      validRollbackReport(),
    );
    expect(valid.isOk()).toBe(true);
    expect(JSON.parse(await Bun.file(target).text()).rollback.outcome).toBe(
      "legacy-settlement",
    );
    const stats = await Bun.file(target).stat();
    expect(stats.mode & 0o777).toBe(0o600);
    await Bun.$`rm -rf ${root}`;
  });

  it("rejects report paths that escape through a symlinked temporary parent", async () => {
    const root = `/tmp/weave-report-symlink-${crypto.randomUUID()}`;
    const outside = `/tmp/weave-report-symlink-target-${crypto.randomUUID()}`;
    const escaped = `${root}/escape/report.json`;
    await Bun.$`mkdir -p ${root} ${outside}`;
    await Bun.$`ln -s ${outside} ${root}/escape`;
    const result = await writeSmokeReportAtomically(
      escaped,
      validRollbackReport(),
    );
    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.type).toBe("InvalidReportPath");
    expect(await Bun.file(`${outside}/report.json`).exists()).toBe(false);
    await Bun.$`rm -rf ${root} ${outside}`;
  });

  it("rejects encoded reports beyond the fixed cap without invoking accessors", () => {
    const valid = validRollbackReport();
    let invoked = false;
    const accessor = Object.defineProperty({ ...valid }, "bad", {
      enumerable: true,
      get: () => {
        invoked = true;
        return "bad";
      },
    });
    expect(validateReportSafety(accessor).isErr()).toBe(true);
    expect(invoked).toBe(false);
  });

  it("rejects unpacked source and altered packed artifacts before Pi starts", async () => {
    const source = await inspectPackedArtifact(
      "/tmp/unpacked/dist/extension.js",
      "a".repeat(64),
    );
    expect(source.isErr()).toBe(true);
    if (source.isErr())
      expect(source.error.type).toBe("ArtifactSourceRejected");
    const altered = verifyArtifactDigest("a".repeat(64), "b".repeat(64));
    expect(altered.isErr()).toBe(true);
    if (altered.isErr())
      expect(altered.error.type).toBe("ArtifactDigestMismatch");
  });

  it("requires a caller hash and accepts only an unchanged packed artifact", async () => {
    await withPackedArtifact(async (artifact) => {
      const inspected = await inspectPackedArtifact(
        artifact.archive,
        artifact.sha256,
      );
      expect(inspected.isOk()).toBe(true);
      if (inspected.isErr()) return;
      expect(inspected.value.extensionSha256).toBe(artifact.extensionSha256);

      const missingHash = parseSmokeArgs([
        "--artifact",
        artifact.archive,
        "--case",
        "rollback",
        "--report",
        "/tmp/pi-model-provenance-report.json",
      ]);
      expect(missingHash.isErr()).toBe(true);
      const relativeArtifact = parseSmokeArgs([
        "--artifact",
        "adapter.tgz",
        "--artifact-sha256",
        artifact.sha256,
        "--case",
        "rollback",
        "--report",
        "/tmp/pi-model-provenance-report.json",
      ]);
      expect(relativeArtifact.isErr()).toBe(true);
      const wrongHash = await inspectPackedArtifact(
        artifact.archive,
        "b".repeat(64),
      );
      expect(wrongHash.isErr()).toBe(true);
      if (wrongHash.isErr())
        expect(wrongHash.error.type).toBe("ArtifactDigestMismatch");

      const unchanged = await verifyArtifactFileUnchanged(
        artifact.archive,
        artifact.sha256,
      );
      expect(unchanged.isOk()).toBe(true);
      const changedBytes = await Bun.file(artifact.archive).bytes();
      await Bun.write(artifact.archive, Uint8Array.from([...changedBytes, 0]));
      const changed = await verifyArtifactFileUnchanged(
        artifact.archive,
        artifact.sha256,
      );
      expect(changed.isErr()).toBe(true);
      if (changed.isErr())
        expect(changed.error.type).toBe("ArtifactDigestMismatch");
    });
  });

  it("rejects directories, unpacked source, and symlink escape artifacts", async () => {
    await withPackedArtifact(async (artifact) => {
      const directory = `${artifact.root}/directory.tgz`;
      await Bun.$`mkdir ${directory}`;
      const directoryResult = await inspectPackedArtifact(
        directory,
        artifact.sha256,
      );
      expect(directoryResult.isErr()).toBe(true);
      if (directoryResult.isErr())
        expect(directoryResult.error.type).toBe("ArtifactSourceRejected");

      const unpacked = `${artifact.root}/source-checkout.tgz`;
      await Bun.write(unpacked, "export default function source() {}\n");
      const unpackedDigest = artifactDigest(await Bun.file(unpacked).bytes());
      const unpackedResult = await inspectPackedArtifact(
        unpacked,
        unpackedDigest,
      );
      expect(unpackedResult.isErr()).toBe(true);
      if (unpackedResult.isErr())
        expect(unpackedResult.error.type).toBe("ArtifactMalformed");

      const escaped = `${artifact.root}/escaped.tgz`;
      await Bun.$`ln -s /etc/hosts ${escaped}`;
      const escapedResult = await inspectPackedArtifact(
        escaped,
        artifact.sha256,
      );
      expect(escapedResult.isErr()).toBe(true);
      if (escapedResult.isErr())
        expect(escapedResult.error.type).toBe("ArtifactSourceRejected");

      const parentLink = `${artifact.root}/parent-link`;
      await Bun.$`ln -s ${artifact.root} ${parentLink}`;
      const parentEscape = await inspectPackedArtifact(
        `${parentLink}/adapter.tgz`,
        artifact.sha256,
      );
      expect(parentEscape.isErr()).toBe(true);
      if (parentEscape.isErr())
        expect(parentEscape.error.type).toBe("ArtifactSourceRejected");
    });
  });

  it("requires Pi 0.84.2 from the installed package root", async () => {
    const root = `/tmp/weave-pi-provenance-${crypto.randomUUID()}`;
    const packageRoot = `${root}/pi-coding-agent`;
    const cli = `${packageRoot}/dist/cli.js`;
    try {
      await Bun.$`mkdir -p ${packageRoot}/dist`;
      await Bun.write(
        `${packageRoot}/package.json`,
        `${JSON.stringify({
          name: "@earendil-works/pi-coding-agent",
          version: "0.84.1",
        })}\n`,
      );
      await Bun.write(cli, 'console.log("0.84.1");\n');
      const wrong = await inspectPiCliProvenance(cli);
      expect(wrong.isErr()).toBe(true);
      if (wrong.isErr()) expect(wrong.error.type).toBe("WrongPiVersion");

      const alias = `${root}/alias`;
      await Bun.$`ln -s ${packageRoot} ${alias}`;
      const aliased = await inspectPiCliProvenance(`${alias}/dist/cli.js`);
      expect(aliased.isErr()).toBe(true);
      if (aliased.isErr())
        expect(aliased.error.type).toBe("StrictProvenanceViolation");
    } finally {
      await Bun.$`rm -rf ${root}`;
    }
  });

  it("rejects inherited credentials, sessions, and aliased isolated paths", async () => {
    const inheritedKeys = [
      ["PI_SESSION_ID", "inherited-session"],
      ["PI_SESSION_FILE", "/tmp/inherited-session.json"],
      ["WEAVE_CONFIG_PATH", "/tmp/inherited-config.weave"],
      ["WEAVE_CHILD_ID", "inherited-child"],
      ["WEAVE_PI_UNSAFE_DISABLE_COMMAND_PROVENANCE", "1"],
      ["OPENAI_API_KEY", "inherited-secret"],
    ] as const;
    for (const [key, value] of inheritedKeys) {
      const result = validateStrictProvenanceEnvironment(
        strictProvenanceEnvironment({ [key]: value }),
      );
      expect(result.isErr(), key).toBe(true);
      if (result.isErr())
        expect(result.error.type).toBe("StrictProvenanceViolation");
    }

    const missingHash = strictProvenanceEnvironment();
    delete missingHash.PI_MODEL_SMOKE_EXPECTED_EXTENSION_SHA256;
    expect(validateStrictProvenanceEnvironment(missingHash).isErr()).toBe(true);
    const wrongHash = validateStrictProvenanceEnvironment(
      strictProvenanceEnvironment({
        PI_MODEL_SMOKE_EXPECTED_EXTENSION_SHA256: "not-a-sha256",
      }),
    );
    expect(wrongHash.isErr()).toBe(true);

    const aliasedEnvironment = strictProvenanceEnvironment();
    aliasedEnvironment.XDG_DATA_HOME = aliasedEnvironment.HOME;
    const aliasedEnvironmentResult =
      validateStrictProvenanceEnvironment(aliasedEnvironment);
    expect(aliasedEnvironmentResult.isErr()).toBe(true);
    if (aliasedEnvironmentResult.isErr())
      expect(aliasedEnvironmentResult.error.type).toBe(
        "PathIsolationViolation",
      );

    const root = `/tmp/weave-isolated-path-${crypto.randomUUID()}`;
    const forbidden = Bun.env.HOME ?? "/Users/jose";
    const lexicalAlias = validateIsolatedPathPolicy({
      root,
      paths: { home: forbidden },
      forbiddenPaths: [forbidden],
    });
    expect(lexicalAlias.isErr()).toBe(true);
    if (lexicalAlias.isErr())
      expect(lexicalAlias.error.type).toBe("PathIsolationViolation");

    const sourceParent = `${root}/source-parent`;
    const duplicate = validateIsolatedPathPolicy({
      root,
      paths: {
        home: `${root}/home`,
        data: `${root}/home`,
      },
      forbiddenPaths: [sourceParent],
    });
    expect(duplicate.isErr()).toBe(true);
    if (duplicate.isErr())
      expect(duplicate.error.type).toBe("PathIsolationViolation");

    const outside = `${root}-outside`;
    try {
      await Bun.$`mkdir -p ${root} ${outside}`;
      await Bun.$`ln -s ${outside} ${root}/home`;
      const symlinkEscape = await validateCreatedIsolatedPathPolicy({
        root,
        paths: { home: `${root}/home` },
      });
      expect(symlinkEscape.isErr()).toBe(true);
      if (symlinkEscape.isErr())
        expect(symlinkEscape.error.type).toBe("PathIsolationViolation");
    } finally {
      await Bun.$`rm -rf ${root} ${outside}`;
    }
  });

  it("rejects source-workspace adapter loads and accepts packed isolated provenance", async () => {
    const input = successfulFallbackInput();
    const sourceControl = {
      ...controlCapture(input.child),
      adapterPackageVersion: "0.0.1",
      adapterExtensionSha256: "a".repeat(64),
      adapterPackageSourceProven: false,
      adapterPackageRootMatched: false,
      adapterExtensionHashMatched: false,
    };
    const sourceResult = validateLoadedAdapterProvenance({
      controls: [sourceControl],
      expectedPackageVersion: "0.0.1",
      expectedExtensionSha256: "a".repeat(64),
    });
    expect(sourceResult.isErr()).toBe(true);
    if (sourceResult.isErr())
      expect(sourceResult.error.type).toBe("StrictProvenanceViolation");
    const mismatchedLoaded = validateLoadedAdapterProvenance({
      controls: [
        {
          ...controlCapture(input.child),
          adapterPackageVersion: "0.0.1",
          adapterExtensionSha256: "a".repeat(64),
          adapterPackageSourceProven: true,
          adapterPackageRootMatched: true,
          adapterExtensionHashMatched: true,
        },
      ],
      expectedPackageVersion: "0.0.1",
      expectedExtensionSha256: "b".repeat(64),
    });
    expect(mismatchedLoaded.isErr()).toBe(true);

    await withPackedArtifact(async (artifact) => {
      const installedRoot = `${artifact.root}/installed-adapter`;
      await Bun.$`mkdir -p ${installedRoot}`;
      await Bun.$`tar -xzf ${artifact.archive} -C ${installedRoot} --strip-components=1`;
      const installed = await verifyInstalledAdapterPackage({
        packageRoot: installedRoot,
        expectedPackageRoot: installedRoot,
        expectedPackageName: "@weaveio/weave-adapter-pi",
        expectedPackageVersion: "0.0.1",
        expectedExtensionSha256: artifact.extensionSha256,
      });
      expect(installed.isOk()).toBe(true);
      if (installed.isErr()) return;
      expect(installed.value.packageRootMatched).toBe(true);
      expect(installed.value.extensionHashMatched).toBe(true);
      const mismatchedInstalled = await verifyInstalledAdapterPackage({
        packageRoot: installedRoot,
        expectedPackageRoot: installedRoot,
        expectedPackageName: "@weaveio/weave-adapter-pi",
        expectedPackageVersion: "0.0.1",
        expectedExtensionSha256: "b".repeat(64),
      });
      expect(mismatchedInstalled.isErr()).toBe(true);

      const loaded = validateLoadedAdapterProvenance({
        controls: [
          {
            ...controlCapture(input.child),
            adapterPackageVersion: installed.value.packageVersion,
            adapterExtensionSha256: installed.value.extensionSha256,
            adapterPackageSourceProven: true,
            adapterPackageRootMatched: installed.value.packageRootMatched,
            adapterExtensionHashMatched: installed.value.extensionHashMatched,
          },
        ],
        expectedPackageVersion: "0.0.1",
        expectedExtensionSha256: artifact.extensionSha256,
      });
      expect(loaded.isOk()).toBe(true);
      if (loaded.isErr()) return;
      expect(loaded.value.extensionSha256).toBe(artifact.extensionSha256);

      const report = {
        ...validRollbackReport(),
        provenance: {
          artifactUnchanged: true,
          installedPackageVersion: installed.value.packageVersion,
          installedExtensionSha256: installed.value.extensionSha256,
          loadedAdapterPackageVersion: loaded.value.packageVersion,
          loadedAdapterExtensionSha256: loaded.value.extensionSha256,
          packageSourceProven: loaded.value.packageSourceProven,
          packageRootMatched: loaded.value.packageRootMatched,
          loadedExtensionHashMatched: loaded.value.extensionHashMatched,
          piPackageVersion: "0.84.2" as const,
        },
      };
      const safe = validateReportSafety(report);
      expect(safe.isOk()).toBe(true);
      const serialized = serializeSmokeReport(report);
      expect(serialized.isOk()).toBe(true);
      if (serialized.isOk())
        expect(serialized.value).not.toContain(artifact.root);
    });
  });

  it("rejects unexpected provider event counts and leaked fixture content", () => {
    const input = successfulFallbackInput();
    const tooManyChild = {
      ...input.child,
      requests: [...input.child.requests, request(4, "second")],
    };
    const tooMany = {
      ...input,
      child: tooManyChild,
      observation: {
        ...input.observation,
        captures: [tooManyChild, input.parent],
        providerCaptures: [
          providerCapture(tooManyChild),
          providerCapture(input.parent),
        ],
      },
    };
    const count = validateFallbackFacts(tooMany);
    expect(count.isErr()).toBe(true);
    if (count.isErr()) expect(count.error.type).toBe("UnexpectedEventCount");
    const leaked = validateReportSafety({ safe: RECOVERY_MARKER });
    expect(leaked.isErr()).toBe(true);
    const providerLeak = validateReportSafety({ safe: FALLBACK_SUCCESS });
    expect(providerLeak.isErr()).toBe(true);
    const visible = validateFallbackFacts({
      ...input,
      observation: {
        ...input.observation,
        output: `${input.observation.output} ${PARENT_TASK}`,
      },
    });
    expect(visible.isErr()).toBe(true);
    if (visible.isErr()) expect(visible.error.type).toBe("LeakedContent");
  });

  it("accepts the bounded fallback facts only when provider and native history differ correctly", () => {
    const result = validateFallbackFacts(successfulFallbackInput());
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.visibleEventCount).toBe(
        EXPECTED_FALLBACK_VISIBLE_EVENT_COUNT,
      );
      expect(result.value.cardAppliedIdentity).toEqual({
        provider: "smoke",
        id: "second",
      });
      expect(result.value.nativeLine).toBe(EXPECTED_NATIVE_LINE);
      expect(result.value.cleanup.temporaryRootRemoved).toBe(true);
    }
    const alteredLine = successfulFallbackInput();
    const altered = validateFallbackFacts({
      ...alteredLine,
      observation: {
        ...alteredLine.observation,
        output: "MODEL FALLBACK\\nmodel fallback smoke/second",
      },
    });
    expect(altered.isErr()).toBe(true);
    if (altered.isErr())
      expect(altered.error.type).toBe("UnexpectedEventCount");
  });

  it("fails closed for missing, reordered, duplicate, and wrong real context descriptors", () => {
    const input = successfulFallbackInput();
    const fallback = input.child.requests[2];
    if (fallback === undefined || input.child.history === undefined) {
      throw new Error("test setup: exact fallback input is incomplete");
    }
    const history = input.child.history;
    if (history.markerCorrelation === undefined) {
      throw new Error("test setup: marker correlation is missing");
    }
    const markerCorrelation = history.markerCorrelation;
    const rebuildChild = (
      descriptors: readonly FixtureMessageDescriptor[],
    ): FixtureSnapshot => ({
      ...input.child,
      requests: [
        input.child.requests[0],
        input.child.requests[1],
        request(3, "second", { descriptors }),
      ],
    });
    const rebuildHistory = (
      descriptors: readonly FixtureHistoryDescriptor[],
    ): FixtureSnapshot => ({
      ...input.child,
      history: {
        ...history,
        descriptors,
        ...descriptorCounts(descriptors),
        entryCount: descriptors.length,
      },
    });
    const cases: readonly {
      readonly name: string;
      readonly child: FixtureSnapshot;
      readonly controls?: FixtureControlFacts[];
    }[] = [
      {
        name: "missing real entry",
        child: rebuildChild(
          fallback.descriptors.filter((_, index) => index !== 1),
        ),
      },
      {
        name: "reordered real entry",
        child: rebuildChild([
          fallback.descriptors[0],
          fallback.descriptors[2],
          fallback.descriptors[1],
          ...fallback.descriptors.slice(3),
        ]),
      },
      {
        name: "duplicate marker",
        child: rebuildHistory([
          ...history.descriptors,
          history.descriptors[8] as FixtureHistoryDescriptor,
        ]),
      },
      {
        name: "wrong marker token",
        child: rebuildHistory(
          history.descriptors.map((descriptor, index) =>
            index === 8
              ? { ...descriptor, correlationHash: "0".repeat(64) }
              : descriptor,
          ),
        ),
      },
      {
        name: "marker token disagrees with message_start",
        child: {
          ...input.child,
          history: {
            ...history,
            markerTokenHash: "0".repeat(64),
            markerCorrelation: {
              ...markerCorrelation,
              markerTokenHash: "0".repeat(64),
            },
            descriptors: history.descriptors.map((descriptor, index) =>
              index === 8
                ? { ...descriptor, correlationHash: "0".repeat(64) }
                : descriptor,
            ),
          },
        },
        controls: [controlCapture(input.child), controlCapture(input.parent)],
      },
      {
        name: "wrong marker custom type",
        child: rebuildHistory(
          history.descriptors.map((descriptor, index) =>
            index === 8
              ? { ...descriptor, customTypeHash: "0".repeat(64) }
              : descriptor,
          ),
        ),
      },
    ];
    for (const { name, child, controls } of cases) {
      const result = validateFallbackFacts(
        rebuildFallbackInput(input, child, input.parent, {
          ...(controls === undefined ? {} : { controls }),
        }),
      );
      expect(result.isErr(), name).toBe(true);
      if (result.isErr())
        expect(result.error.type, name).toBe("ProviderContextViolation");
    }
  });

  it("fails closed when the failed assistant remains in fallback provider input", () => {
    const input = successfulFallbackInput();
    const fallback = input.child.requests[2];
    if (fallback === undefined)
      throw new Error("test setup: fallback request is missing");
    const failed = fixtureDescriptorForFact(
      "failed-assistant",
      fallback.descriptors.length,
    );
    const child: FixtureSnapshot = {
      ...input.child,
      requests: [
        input.child.requests[0],
        input.child.requests[1],
        request(3, "second", {
          descriptors: [...fallback.descriptors, failed],
        }),
      ],
    };
    const result = validateFallbackFacts(
      rebuildFallbackInput(input, child, input.parent),
    );
    expect(result.isErr()).toBe(true);
    if (result.isErr())
      expect(result.error.type).toBe("ProviderContextViolation");
  });

  it("fails closed when the failed and fallback provider prefixes differ", () => {
    const input = successfulFallbackInput();
    const failedRequest = input.child.requests[1];
    if (failedRequest === undefined)
      throw new Error("test setup: failed provider request is missing");
    const alteredFailedRequest: FixtureMessageFacts = {
      ...failedRequest,
      descriptors: failedRequest.descriptors.map((descriptor, index) =>
        index === 0
          ? { ...descriptor, contentShapeHash: "0".repeat(64) }
          : descriptor,
      ),
    };
    const child: FixtureSnapshot = {
      ...input.child,
      requests: [
        input.child.requests[0],
        alteredFailedRequest,
        input.child.requests[2],
      ],
    };
    const result = validateFallbackFacts(
      rebuildFallbackInput(input, child, input.parent),
    );
    expect(result.isErr()).toBe(true);
    if (result.isErr())
      expect(result.error.type).toBe("ProviderContextViolation");
  });

  it("fails closed when durable native history loses a required entry", () => {
    const input = successfulFallbackInput();
    if (input.child.history === undefined)
      throw new Error("test setup: history is missing");
    const descriptors = input.child.history.descriptors.filter(
      (_, index) => index !== 7,
    );
    const child: FixtureSnapshot = {
      ...input.child,
      history: {
        ...input.child.history,
        descriptors,
        ...descriptorCounts(descriptors),
        entryCount: descriptors.length,
      },
    };
    const result = validateFallbackFacts(
      rebuildFallbackInput(input, child, input.parent),
    );
    expect(result.isErr()).toBe(true);
    if (result.isErr())
      expect(result.error.type).toBe("ProviderContextViolation");
  });

  it("fails closed when a synthetic provider user is added", () => {
    const input = successfulFallbackInput();
    const fallback = input.child.requests[2];
    if (fallback === undefined)
      throw new Error("test setup: fallback request is missing");
    const syntheticUser = fixtureDescriptorForFact(
      "original-user",
      fallback.descriptors.length,
      { correlationHash: "0".repeat(64) },
    );
    const child: FixtureSnapshot = {
      ...input.child,
      requests: [
        input.child.requests[0],
        input.child.requests[1],
        request(3, "second", {
          descriptors: [...fallback.descriptors, syntheticUser],
        }),
      ],
    };
    const result = validateFallbackFacts(
      rebuildFallbackInput(input, child, input.parent),
    );
    expect(result.isErr()).toBe(true);
    if (result.isErr())
      expect(result.error.type).toBe("ProviderContextViolation");
  });

  it("keeps raw bodies, tokens, and fixture text out of structural test snapshots", () => {
    const serialized = JSON.stringify(successfulFallbackInput());
    for (const forbidden of [
      PROVIDER_FAILURE_MARKER,
      RECOVERY_MARKER,
      PARENT_TASK,
      FALLBACK_SUCCESS,
      "PI_MODEL_FAILOVER_SMOKE_ORIGINAL_USER_31a7",
      "PI_MODEL_FAILOVER_SMOKE_STEERING_USER_4c2b",
      "PI_MODEL_FAILOVER_SMOKE_FOLLOW_UP_USER_8e19",
      "PI_MODEL_FAILOVER_SMOKE_QUEUED_USER_6d44",
      "trusted-extension.note",
      "weave.model-fallback.recovery-marker",
      markerToken,
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
    expect(serialized).not.toMatch(
      /"(?:body|content|messages|text|token)"\s*:/u,
    );
    expect(FIXTURE_CONTEXT_FACTS).toContain("recovery-marker");
  });

  it("fails closed when a required identity observation is missing", () => {
    const input = successfulFallbackInput();
    const missing = rebuildFallbackInput(
      input,
      {
        ...input.child,
        sessionIdBeforeHash: undefined,
      },
      input.parent,
    );
    const result = validateFallbackFacts(missing);
    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.type).toBe("CaptureMalformed");
  });

  it("accepts equal independently observed child and thread identities", () => {
    const input = successfulFallbackInput();
    const childIdHash = input.child.childIdHash;
    const childNative = input.observation.nativeSessions.find(
      (session) => session.role === "child",
    );
    const parentNative = input.observation.nativeSessions.find(
      (session) => session.role === "parent",
    );
    if (
      childIdHash === undefined ||
      childNative === undefined ||
      parentNative === undefined
    )
      throw new Error("test setup: child identity observations are missing");
    const equalChild = {
      ...input.child,
      threadIdHash: childIdHash,
      threadIdBeforeHash: childIdHash,
      threadIdAfterHash: childIdHash,
    };
    const equal = {
      child: equalChild,
      parent: input.parent,
      observation: {
        ...input.observation,
        captures: [equalChild, input.parent],
        nativeSessions: [
          {
            ...childNative,
            threadIdHash: childIdHash,
            threadIdBeforeHash: childIdHash,
            threadIdAfterHash: childIdHash,
          },
          parentNative,
        ],
      },
    };
    const result = validateFallbackFacts(equal);
    expect(result.isOk()).toBe(true);
  });

  it("accepts distinct independently observed child and thread identities", () => {
    const input = successfulFallbackInput();
    const childIdHash = input.child.childIdHash;
    const threadIdHash = input.child.threadIdHash;
    const childControl = input.observation.controls.find(
      (capture) => capture.role === "child",
    );
    const childNative = input.observation.nativeSessions.find(
      (session) => session.role === "child",
    );
    if (
      childIdHash === undefined ||
      threadIdHash === undefined ||
      childControl === undefined ||
      childNative === undefined
    )
      throw new Error("test setup: child identity observations are missing");
    expect(childControl.childIdHash).toBe(childIdHash);
    expect(childNative.threadIdHash).toBe(threadIdHash);
    expect(childIdHash).not.toBe(threadIdHash);
    const result = validateObservedSources({
      observation: input.observation,
      snapshots: [input.child, input.parent],
      smokeCase: "fallback",
    });
    expect(result.isOk()).toBe(true);
  });

  it("fails closed when child or native thread metadata is missing", () => {
    const input = successfulFallbackInput();
    const missing = [
      {
        name: "child",
        snapshot: {
          ...input.child,
          childIdHash: undefined,
          childIdBeforeHash: undefined,
          childIdAfterHash: undefined,
        },
      },
      {
        name: "thread",
        snapshot: {
          ...input.child,
          threadIdHash: undefined,
          threadIdBeforeHash: undefined,
          threadIdAfterHash: undefined,
        },
      },
    ] as const;
    for (const candidate of missing) {
      const result = validateFallbackFacts(
        rebuildFallbackInput(input, candidate.snapshot, input.parent),
      );
      expect(result.isErr(), candidate.name).toBe(true);
      if (result.isErr())
        expect(result.error.type, candidate.name).toBe("CaptureMalformed");
    }
  });

  it("rejects a native observer that derives thread identity from child identity", () => {
    const input = successfulFallbackInput();
    const childNative = input.observation.nativeSessions.find(
      (session) => session.role === "child",
    );
    const parentNative = input.observation.nativeSessions.find(
      (session) => session.role === "parent",
    );
    if (childNative === undefined || parentNative === undefined)
      throw new Error("test setup: native observations are missing");
    const derived = input.child.childIdHash;
    if (derived === undefined)
      throw new Error("test setup: child identity is missing");
    const result = validateObservedSources({
      observation: {
        ...input.observation,
        nativeSessions: [
          {
            ...childNative,
            threadIdHash: derived,
            threadIdBeforeHash: derived,
            threadIdAfterHash: derived,
          },
          parentNative,
        ],
      },
      snapshots: [input.child, input.parent],
      smokeCase: "fallback",
    });
    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.type).toBe("CaptureMalformed");
  });

  it("fails closed when child or thread identity changes between observations", () => {
    const input = successfulFallbackInput();
    const changed = [
      {
        name: "child",
        snapshot: {
          ...input.child,
          childIdBeforeHash: "9".repeat(64),
        },
      },
      {
        name: "thread",
        snapshot: {
          ...input.child,
          threadIdBeforeHash: "9".repeat(64),
        },
      },
    ] as const;
    for (const candidate of changed) {
      const result = validateFallbackFacts(
        rebuildFallbackInput(input, candidate.snapshot, input.parent),
      );
      expect(result.isErr(), candidate.name).toBe(true);
      if (result.isErr())
        expect(result.error.type, candidate.name).toBe("CaptureMalformed");
    }
  });

  it("fails closed when an independently observed identity changes", () => {
    const input = successfulFallbackInput();
    const conflicting = rebuildFallbackInput(
      input,
      {
        ...input.child,
        processIdBeforeHash: "9".repeat(64),
        processIdAfterHash: input.child.processIdAfterHash,
      },
      input.parent,
    );
    const result = validateFallbackFacts(conflicting);
    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.type).toBe("CaptureMalformed");
  });

  it("retains session, process, and tool identity alias rejection", () => {
    const input = successfulFallbackInput();
    const childIdHash = input.child.childIdHash;
    const threadIdHash = input.child.threadIdHash;
    if (childIdHash === undefined || threadIdHash === undefined)
      throw new Error("test setup: child identities are missing");
    const aliases = [
      {
        name: "session and thread",
        child: {
          ...input.child,
          sessionIdHash: threadIdHash,
          sessionIdBeforeHash: threadIdHash,
          sessionIdAfterHash: threadIdHash,
        },
        parent: input.parent,
      },
      {
        name: "process and child",
        child: {
          ...input.child,
          processIdHash: childIdHash,
          processIdBeforeHash: childIdHash,
          processIdAfterHash: childIdHash,
        },
        parent: input.parent,
      },
      {
        name: "tool and child",
        child: input.child,
        parent: {
          ...input.parent,
          parentToolCallIdHash: childIdHash,
          parentToolEndCallIdHash: childIdHash,
        },
      },
    ] as const;
    for (const alias of aliases) {
      const result = validateFallbackFacts(
        rebuildFallbackInput(input, alias.child, alias.parent),
      );
      expect(result.isErr(), alias.name).toBe(true);
      if (result.isErr())
        expect(result.error.type, alias.name).toBe("CaptureMalformed");
    }
  });

  it("fails closed on duplicate marker event evidence", () => {
    const input = successfulFallbackInput();
    const duplicateLifecycle = lifecycle({
      ...input.child.lifecycle,
      messageStartCount: 2,
      markerMessageStartCount: 2,
      recoveryMarkerCount: 2,
      markerMessageStartTimesMs: [1_400, 1_401],
    });
    const duplicate = rebuildFallbackInput(
      input,
      {
        ...input.child,
        lifecycle: duplicateLifecycle,
      },
      input.parent,
    );
    const result = validateFallbackFacts(duplicate);
    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.type).toBe("UnexpectedEventCount");
  });

  it("accepts only a valid stable observation assembled from distinct sources", () => {
    const input = successfulFallbackInput();
    const result = validateObservedSources({
      observation: input.observation,
      snapshots: [input.child, input.parent],
      smokeCase: "fallback",
    });
    expect(result.isOk()).toBe(true);
    const facts = validateFallbackFacts(input);
    expect(facts.isOk()).toBe(true);
    if (facts.isOk()) {
      expect(facts.value.processIdentityStable).toBe(true);
      expect(facts.value.nativeSessionIdentityStable).toBe(true);
      expect(facts.value.threadIdentityStable).toBe(true);
      expect(facts.value.parentToolCallIdentityStable).toBe(true);
    }
    const before = input.observation.nativeSessions;
    const after = before.map((session) => ({
      ...session,
      history: { ...session.history, historyHash: "0".repeat(64) },
    }));
    const unstable = __testing.mergeNativeSessionObservations(before, after);
    expect(unstable.isErr()).toBe(true);
    if (unstable.isErr()) expect(unstable.error.type).toBe("CaptureMalformed");
  });

  it("binds the native fallback model timeline by identity and order", () => {
    const input = successfulFallbackInput();
    const first = { provider: "smoke", id: "first" } as const;
    const second = { provider: "smoke", id: "second" } as const;
    const third = { provider: "smoke", id: "third" } as const;
    const childNative = input.observation.nativeSessions.find(
      (session) => session.role === "child",
    );
    const parentNative = input.observation.nativeSessions.find(
      (session) => session.role === "parent",
    );
    if (childNative === undefined || parentNative === undefined) {
      throw new Error("test setup: native observations are missing");
    }
    expect(childNative.modelTransitionIdentities).toEqual([
      first,
      first,
      second,
    ]);
    expect(childNative.modelTransitions).toBe(3);
    expect(parentNative.modelTransitionIdentities).toEqual([first, first]);
    expect(parentNative.modelTransitions).toBe(2);
    expect(input.parent.lifecycle.modelSelectCount).toBe(0);

    const observeChildTimeline = (
      identities: readonly { provider: string; id: string }[],
      times: readonly number[],
      appliedIdentity:
        | { provider: string; id: string }
        | undefined = identities.at(-1),
      lifecycleOverrides: Partial<FixtureLifecycleFacts> = {},
    ) => {
      const child = {
        ...input.child,
        lifecycle: { ...input.child.lifecycle, ...lifecycleOverrides },
      };
      const native = nativeObservation(child, {
        modelTransitions: identities.length,
        modelTransitionTimesMs: times,
        modelTransitionIdentities: identities,
      });
      const observedNative =
        appliedIdentity === undefined
          ? (() => {
              const { appliedIdentity: _appliedIdentity, ...withoutApplied } =
                native;
              return withoutApplied;
            })()
          : { ...native, appliedIdentity };
      return validateObservedSources({
        observation: {
          ...input.observation,
          nativeSessions: [observedNative, parentNative],
          controls: [controlCapture(child), controlCapture(input.parent)],
        },
        snapshots: [child, input.parent],
        smokeCase: "fallback",
      });
    };

    expect(
      observeChildTimeline(
        [first, first, second],
        [1_000, 1_100, 1_300],
      ).isOk(),
    ).toBe(true);
    // Pi appends native model_change before the public model_select event.
    expect(
      observeChildTimeline(
        [first, first, second],
        [1_000, 1_100, 1_199],
      ).isOk(),
    ).toBe(true);
    // Native and public records can share a millisecond timestamp.
    expect(
      observeChildTimeline(
        [first, first, second],
        [1_000, 1_100, 1_200],
      ).isOk(),
    ).toBe(true);
    // The initial failed attempt settles before fallback selection; the
    // applied control select must still precede recovery and final settlement.
    expect(
      observeChildTimeline(
        [first, first, second],
        [1_000, 1_100, 1_199],
        second,
        { settlementTimesMs: [1_100, 1_301] },
      ).isOk(),
    ).toBe(true);
    const rejectedTimelines: readonly {
      readonly name: string;
      readonly identities: readonly { provider: string; id: string }[];
      readonly times: readonly number[];
      readonly appliedIdentity?: { provider: string; id: string };
    }[] = [
      {
        name: "missing destination",
        identities: [first, first],
        times: [1_000, 1_100],
      },
      {
        name: "duplicate destination",
        identities: [first, second, second],
        times: [1_000, 1_100, 1_300],
      },
      {
        name: "wrong third identity",
        identities: [first, third, second],
        times: [1_000, 1_100, 1_300],
      },
      {
        name: "origin after destination",
        identities: [first, second, first],
        times: [1_000, 1_100, 1_300],
        appliedIdentity: first,
      },
      {
        name: "nonmonotonic native timestamps",
        identities: [first, first, second],
        times: [1_000, 1_300, 1_200],
      },
      {
        name: "empty timeline",
        identities: [],
        times: [],
      },
      {
        name: "too many initial origin entries",
        identities: [first, first, first, second],
        times: [1_000, 1_050, 1_100, 1_300],
      },
      {
        name: "timeline bound exceeded",
        identities: [
          ...Array.from(
            { length: MAX_NATIVE_MODEL_TIMELINE_ENTRIES },
            () => first,
          ),
          second,
        ],
        times: [1_000, 1_050, 1_100, 1_150, 1_300],
      },
      {
        name: "control/native applied mismatch",
        identities: [first, first, second],
        times: [1_000, 1_100, 1_300],
        appliedIdentity: first,
      },
    ];
    for (const timeline of rejectedTimelines) {
      expect(
        observeChildTimeline(
          timeline.identities,
          timeline.times,
          timeline.appliedIdentity,
        ).isErr(),
        timeline.name,
      ).toBe(true);
    }
    expect(
      observeChildTimeline(
        [first, first, second],
        [1_000, 1_100, 1_199],
        second,
        { modelSelectTimesMs: [1_500] },
      ).isErr(),
    ).toBe(true);
    expect(
      observeChildTimeline([first, first], [1_000, 1_100], first, {
        modelSelectCount: 0,
        modelSelectTimesMs: [],
        appliedIdentity: undefined,
      }).isErr(),
    ).toBe(true);
    expect(MAX_NATIVE_INITIAL_MODEL_ENTRIES).toBe(2);
    expect(MAX_NATIVE_MODEL_TIMELINE_ENTRIES).toBe(3);
  });

  it("accepts real ready health and legacy rollback facts only with both shim phases", () => {
    const input = rollbackInput();
    const health = parseHealthFacts(ROLLBACK_HEALTH_OUTPUT);
    expect(health.isOk()).toBe(true);
    if (health.isOk()) {
      expect(health.value.runtimeModelFallback?.capability).toBe(
        "runtime-model-fallback",
      );
      expect(health.value.runtimeModelFallback?.mode).toBe(
        "feature-unavailable",
      );
    }
    const result = validateRollbackFacts(input);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.healthReady).toBe(true);
      expect(result.value.healthOnly).toBe(false);
      expect(result.value.legacySettlementCount).toBe(1);
    }
  });

  it("fails closed when the rollback boundary is missing, widened, or disables delegation", () => {
    const input = rollbackInput();
    const missing = validateRollbackFacts({
      parent: input.parent,
      observation: { ...input.observation, shims: [] },
    });
    expect(missing.isErr()).toBe(true);
    if (missing.isErr()) expect(missing.error.type).toBe("CaptureMalformed");

    const widenedShims = input.observation.shims?.map((shim) => ({
      ...shim,
      disabledSurface:
        "callable-set-model-unsupported" as typeof ROLLBACK_DISABLED_SURFACE,
    }));
    const widened = validateRollbackFacts({
      parent: input.parent,
      observation: { ...input.observation, shims: widenedShims },
    });
    expect(widened.isErr()).toBe(true);
    if (widened.isErr())
      expect(widened.error.type).toBe("FixtureBoundaryViolation");

    const delegationDisabled = input.observation.shims?.map((shim) => ({
      ...shim,
      requiredDelegationSurfacesIntact: false as true,
    }));
    const delegation = validateRollbackFacts({
      parent: input.parent,
      observation: { ...input.observation, shims: delegationDisabled },
    });
    expect(delegation.isErr()).toBe(true);
    if (delegation.isErr())
      expect(delegation.error.type).toBe("FixtureBoundaryViolation");

    const originalSurfaceLost = input.observation.shims?.map((shim) => ({
      ...shim,
      originalSurfacePresent: false as true,
    }));
    const lost = validateRollbackFacts({
      parent: input.parent,
      observation: { ...input.observation, shims: originalSurfaceLost },
    });
    expect(lost.isErr()).toBe(true);
    if (lost.isErr()) expect(lost.error.type).toBe("FixtureBoundaryViolation");

    const disabledAfterInitialization = input.observation.shims?.map(
      (shim) => ({
        ...shim,
        disabledBeforeAdapterInitialization: false as true,
      }),
    );
    const restored = validateRollbackFacts({
      parent: input.parent,
      observation: {
        ...input.observation,
        shims: disabledAfterInitialization,
      },
    });
    expect(restored.isErr()).toBe(true);
    if (restored.isErr())
      expect(restored.error.type).toBe("FixtureBoundaryViolation");
  });

  it("fails closed when rollback health omits or broadens the optional capability gap", () => {
    const input = rollbackInput();
    const withoutGap = validateRollbackFacts({
      parent: input.parent,
      observation: {
        ...input.observation,
        health: {
          source: "real-pi-tui",
          ready: true,
          healthOnly: false,
        },
      },
    });
    expect(withoutGap.isErr()).toBe(true);
    if (withoutGap.isErr())
      expect(withoutGap.error.type).toBe("ProviderContextViolation");

    const broadProbe = {
      capability: "runtime-model-fallback",
      probe: "unavailable:made-up-probe",
      mode: "feature-unavailable" as const,
    };
    const broadened = validateRollbackFacts({
      parent: input.parent,
      observation: {
        ...input.observation,
        health: {
          source: "real-pi-tui",
          ready: true,
          healthOnly: false,
          hostSurfaceGaps: [broadProbe],
          runtimeModelFallback: broadProbe,
        },
      },
    });
    expect(broadened.isErr()).toBe(true);
    if (broadened.isErr())
      expect(broadened.error.type).toBe("ProviderContextViolation");
  });

  it("fails closed on fallback artifacts, model transitions, and extra settlements", () => {
    const input = rollbackInput();
    const baseHistory = input.parent.history;
    if (baseHistory === undefined)
      throw new Error("test setup: rollback history is missing");
    const fallbackHistory: FixtureSnapshot = {
      ...input.parent,
      history: { ...baseHistory, successfulAssistantPresent: true },
    };
    const historyResult = validateRollbackFacts({
      parent: fallbackHistory,
      observation: {
        ...input.observation,
        captures: [fallbackHistory],
        providerCaptures: [providerCapture(fallbackHistory)],
        nativeSessions: [rollbackNativeObservation(fallbackHistory)],
        controls: [controlCapture(fallbackHistory)],
      },
    });
    expect(historyResult.isErr()).toBe(true);
    if (historyResult.isErr())
      expect(historyResult.error.type).toBe("ProviderContextViolation");

    const transitionedLifecycle = lifecycle({
      ...input.parent.lifecycle,
      modelSelectCount: 1,
      modelSelectTimesMs: [1_200],
      appliedIdentity: { provider: "smoke", id: "second" },
    });
    const transitioned = {
      ...input.parent,
      lifecycle: transitionedLifecycle,
    };
    const transitionResult = validateRollbackFacts({
      parent: transitioned,
      observation: {
        ...input.observation,
        captures: [transitioned],
        providerCaptures: [providerCapture(transitioned)],
        nativeSessions: [nativeObservation(transitioned)],
        controls: [controlCapture(transitioned)],
      },
    });
    expect(transitionResult.isErr()).toBe(true);
    if (transitionResult.isErr())
      expect(transitionResult.error.type).toBe("ProviderContextViolation");

    const extraSettlementLifecycle = lifecycle({
      ...input.parent.lifecycle,
      settlementCount: 2,
      settlementTimesMs: [1_300, 1_301],
    });
    const extraSettlement = {
      ...input.parent,
      lifecycle: extraSettlementLifecycle,
    };
    const settlementResult = validateRollbackFacts({
      parent: extraSettlement,
      observation: {
        ...input.observation,
        captures: [extraSettlement],
        providerCaptures: [providerCapture(extraSettlement)],
        nativeSessions: [rollbackNativeObservation(extraSettlement)],
        controls: [controlCapture(extraSettlement)],
      },
    });
    expect(settlementResult.isErr()).toBe(true);
    if (settlementResult.isErr())
      expect(settlementResult.error.type).toBe("UnexpectedEventCount");

    const visibleFallback = validateRollbackFacts({
      parent: input.parent,
      observation: {
        ...input.observation,
        output: `${input.observation.output}\nMODEL FALLBACK\\nmodel fallback · smoke/second`,
        visibleEventCount: 1,
      },
    });
    expect(visibleFallback.isErr()).toBe(true);
    if (visibleFallback.isErr())
      expect(visibleFallback.error.type).toBe("UnexpectedEventCount");
  });

  it("rejects rollback when the real health observation is missing", () => {
    const parent: FixtureSnapshot = {
      schemaVersion: 1,
      role: "parent",
      processIdHash: "a".repeat(64),
      processIdBeforeHash: "a".repeat(64),
      processIdAfterHash: "a".repeat(64),
      sessionIdHash: "c".repeat(64),
      sessionIdBeforeHash: "c".repeat(64),
      sessionIdAfterHash: "c".repeat(64),
      requestCount: 1,
      requests: [request(1, "first")],
      lifecycle: lifecycle({ settlementCount: 1 }),
      optionalSurfaceDisabled: true,
    };
    const result = validateRollbackFacts({
      parent,
      observation: {
        output: "ready legacy settlement",
        visibleEventCount: 0,
        captures: [parent],
        providerCaptures: [providerCapture(parent)],
        nativeSessions: [nativeObservation(parent)],
        controls: [controlCapture(parent)],
        cleanup: VERIFIED_CLEANUP,
        temporaryRootRemoved: true,
      },
    });
    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.type).toBe("CaptureMalformed");
  });

  it("rejects malformed health output", () => {
    const malformed = parseHealthFacts("Weave adapter mode: maybe\\n");
    expect(malformed.isErr()).toBe(true);
    if (malformed.isErr())
      expect(malformed.error.type).toBe("CaptureMalformed");
  });

  it("fails closed when health facts are not parsed from the real Pi TUI", () => {
    const input = rollbackInput();
    const health = input.observation.health;
    if (health === undefined) throw new Error("test setup: health is missing");
    const result = validateRollbackFacts({
      parent: input.parent,
      observation: {
        ...input.observation,
        health: { ...health, source: undefined },
      },
    });
    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.type).toBe("CaptureMalformed");
  });

  it("rejects rollback health-only observations", () => {
    const input = rollbackInput();
    const result = validateRollbackFacts({
      parent: input.parent,
      observation: {
        ...input.observation,
        health: {
          source: "real-pi-tui",
          ready: false,
          healthOnly: true,
        },
      },
    });
    expect(result.isErr()).toBe(true);
    if (result.isErr())
      expect(result.error.type).toBe("ProviderContextViolation");
  });

  it("does not put provider bodies, markers, or task text in a report", () => {
    const report = validRollbackReport();
    expect(validateReportSafety(report).isOk()).toBe(true);
    expect(validateReportSafety(report, ["bounded-timeout"]).isErr()).toBe(
      true,
    );
    for (const forbidden of [
      PROVIDER_FAILURE_MARKER,
      RECOVERY_MARKER,
      PARENT_TASK,
      FALLBACK_SUCCESS,
    ]) {
      expect(validateReportSafety({ ...report, forbidden }).isErr()).toBe(true);
    }
  });
});
