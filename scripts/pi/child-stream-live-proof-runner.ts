import { errAsync, okAsync, Result, ResultAsync } from "neverthrow";
import {
  LIVE_PROOF_COMMAND,
  LIVE_PROOF_FAILURE_CODES,
  LIVE_PROOF_LANE_NAMES,
  LIVE_PROOF_REPORT_BOUNDS,
  type LiveProofArgs,
  type LiveProofCleanupStatus,
  type LiveProofDiagnosticStatus,
  type LiveProofFailureCode,
  type LiveProofIdentityCurrentResult,
  type LiveProofIdentityFreshResult,
  type LiveProofIsolationStatus,
  type LiveProofLaneName,
  type LiveProofLaneObservation,
  type LiveProofLaneStatus,
  type LiveProofRegistryStatus,
  type LiveProofReport,
  type LiveProofReportValidationFailure,
  type LiveProofSettlementStatus,
  MAX_LIVE_PROOF_COUNTER,
  saturatingIncrement,
  validateLiveProofReport,
} from "./child-stream-live-proof-contract.js";

// ---------------------------------------------------------------------------
// Injectable live-proof boundary
// ---------------------------------------------------------------------------

/**
 * A port failure is intentionally smaller than a normal application error.
 * The live runner never receives a host message, path, child id, or exception
 * from a port. The adapter at the port boundary must collapse those values to
 * this closed code first.
 */
export interface LiveProofPortFailure {
  readonly code: LiveProofFailureCode;
}

export type LiveProofPortResult<T> = ResultAsync<T, LiveProofPortFailure>;

/** Opaque resource handles never enter the report or any diagnostic state. */
export type LiveProofParentHandle = object;
export type LiveProofChildHandle = object;
export type LiveProofInspectorHandle = object;

export interface LiveProofResourceContext {
  readonly parent?: LiveProofParentHandle;
  readonly child?: LiveProofChildHandle;
  readonly inspector?: LiveProofInspectorHandle;
}

/**
 * The current identity port has already read and compared all runtime output
 * digests. These two booleans are deliberately separate from `currentBuild`:
 * a caller cannot turn an incomplete or unloaded artifact into current proof by
 * returning the enum alone.
 */
export interface LiveProofCurrentIdentityObservation {
  readonly currentBuild: LiveProofIdentityCurrentResult;
  readonly runtimeLoaded: boolean;
  readonly artifactComplete: boolean;
}

/**
 * Fresh-parent evidence is returned by the launch port, not inferred from the
 * current process or from a reload operation. The artifact facts are repeated
 * at this boundary so a pre-build parent cannot be accepted as fresh.
 */
export interface LiveProofFreshParentLaunch {
  readonly parent: LiveProofParentHandle;
  readonly freshParent: LiveProofIdentityFreshResult;
  readonly runtimeLoaded: boolean;
  readonly artifactComplete: boolean;
}

/** Fixed, content-free child request used by this proof. */
export interface LiveProofDeterministicChildRequest {
  readonly kind: "deterministic-child";
  readonly expectedToolTerminals: 1;
}

export const LIVE_PROOF_DETERMINISTIC_CHILD_REQUEST = Object.freeze({
  kind: "deterministic-child",
  expectedToolTerminals: 1,
} satisfies LiveProofDeterministicChildRequest);

/**
 * A lane reader has already classified its source. In particular, the runner
 * never receives the reasoning prefix, assistant text, tool data, or a raw
 * event. The booleans are structural facts only.
 */
export interface LiveProofLaneSignal {
  readonly status: LiveProofLaneStatus;
  readonly prefixObserved: boolean;
  readonly nonBlankObserved: boolean;
  readonly growthObserved: boolean;
  readonly observationCount: number;
  readonly events: number;
  readonly dropped: number;
  readonly repaints: number;
}

/**
 * The settlement reader reports only lifecycle cardinalities. One child, one
 * tool terminal, and one settlement are required for the deterministic run.
 */
export interface LiveProofSettlementObservation {
  readonly status: LiveProofSettlementStatus;
  readonly childCount: number;
  readonly settlementCount: number;
  readonly toolTerminalCount: number;
  readonly events: number;
  readonly dropped: number;
  readonly repaints: number;
}

/** Every isolation dimension is a source-translated boolean. */
export interface LiveProofIsolationObservation {
  readonly parentIsolated: boolean;
  readonly cardIsolated: boolean;
  readonly modelIsolated: boolean;
  readonly durableIsolated: boolean;
  readonly prohibitedSinkDetected: boolean;
}

/** Registry scans carry counts only; zero is the only clean result. */
export interface LiveProofRegistryObservation {
  readonly cardEntries: number;
  readonly cardBytes: number;
  readonly inspectorEntries: number;
  readonly inspectorBytes: number;
  readonly registryEntries: number;
  readonly registryBytes: number;
}

/** Diagnostics are closed status plus a saturated count. */
export interface LiveProofDiagnosticsObservation {
  readonly status: LiveProofDiagnosticStatus;
  readonly count: number;
  readonly overflow: boolean;
}

/**
 * The adapter owns process, runtime, temporary workspace, and pane details.
 * Each cleanup method is separate so the runner can prove every attempt and
 * report one failure if any individual resource does not close.
 */
export interface LiveProofPort {
  readonly readCurrentIdentity: (input: {
    readonly pi: string;
    readonly requireCurrentBuild: true;
  }) => LiveProofPortResult<LiveProofCurrentIdentityObservation>;
  readonly launchFreshParent: (input: {
    readonly pi: string;
    readonly requireFreshParent: true;
    readonly requireCurrentBuild: true;
    readonly noScreenCapture: true;
  }) => LiveProofPortResult<LiveProofFreshParentLaunch>;
  readonly delegateDeterministicChild: (
    parent: LiveProofParentHandle,
    request: LiveProofDeterministicChildRequest,
  ) => LiveProofPortResult<LiveProofChildHandle>;
  readonly selectLiveInspector: (
    parent: LiveProofParentHandle,
    child: LiveProofChildHandle,
  ) => LiveProofPortResult<LiveProofInspectorHandle>;

  readonly observeParentRawReasoning: (
    parent: LiveProofParentHandle,
    child: LiveProofChildHandle,
  ) => LiveProofPortResult<LiveProofLaneSignal>;
  readonly observeInspectorRawReasoning: (
    parent: LiveProofParentHandle,
    child: LiveProofChildHandle,
    inspector: LiveProofInspectorHandle,
  ) => LiveProofPortResult<LiveProofLaneSignal>;
  readonly observeInspectorToolDetails: (
    parent: LiveProofParentHandle,
    child: LiveProofChildHandle,
    inspector: LiveProofInspectorHandle,
  ) => LiveProofPortResult<LiveProofLaneSignal>;
  readonly observeInspectorAssistantReply: (
    parent: LiveProofParentHandle,
    child: LiveProofChildHandle,
    inspector: LiveProofInspectorHandle,
  ) => LiveProofPortResult<LiveProofLaneSignal>;

  readonly readSettlement: (
    parent: LiveProofParentHandle,
    child: LiveProofChildHandle,
  ) => LiveProofPortResult<LiveProofSettlementObservation>;
  readonly readIsolation: (
    context: LiveProofResourceContext,
  ) => LiveProofPortResult<LiveProofIsolationObservation>;
  readonly readRegistry: (
    context: LiveProofResourceContext,
  ) => LiveProofPortResult<LiveProofRegistryObservation>;
  readonly readDiagnostics: (
    context: LiveProofResourceContext,
  ) => LiveProofPortResult<LiveProofDiagnosticsObservation>;

  readonly cleanupRuntime: (
    context: LiveProofResourceContext,
  ) => LiveProofPortResult<void>;
  readonly cleanupProcess: (
    context: LiveProofResourceContext,
  ) => LiveProofPortResult<void>;
  readonly cleanupTemp: (
    context: LiveProofResourceContext,
  ) => LiveProofPortResult<void>;
  readonly cleanupPane: (
    context: LiveProofResourceContext,
  ) => LiveProofPortResult<void>;
}

export interface LiveProofRunnerInput {
  readonly args: LiveProofArgs;
  readonly port: LiveProofPort;
}

// ---------------------------------------------------------------------------
// Closed internal state and normalization
// ---------------------------------------------------------------------------

interface LiveProofCountersState {
  events: number;
  dropped: number;
  repaints: number;
  diagnostics: number;
  cleanupAttempts: number;
}

interface LiveProofRunState {
  currentBuild: LiveProofIdentityCurrentResult;
  freshParent: LiveProofIdentityFreshResult;
  readonly lanes: Map<LiveProofLaneName, LiveProofLaneObservation>;
  isolation: LiveProofIsolationStatus;
  settlement: LiveProofSettlementStatus;
  registry: LiveProofRegistryStatus;
  diagnostics: LiveProofDiagnosticStatus;
  cleanup: LiveProofCleanupStatus;
  readonly failures: Set<LiveProofFailureCode>;
  readonly counters: LiveProofCountersState;
  parent?: LiveProofParentHandle;
  child?: LiveProofChildHandle;
  inspector?: LiveProofInspectorHandle;
}

const CLEANUP_FAILURE_CODE: LiveProofFailureCode = "cleanup-failed";
const DEFAULT_FAILURE_CODE: LiveProofFailureCode = "spawn-failed";
const MAX_FAILURES = 8;

const isFailureCode = (value: unknown): value is LiveProofFailureCode =>
  typeof value === "string" &&
  (LIVE_PROOF_FAILURE_CODES as readonly string[]).includes(value);

function closedPortFailure(code: LiveProofFailureCode): LiveProofPortFailure {
  return { code };
}

function portFailureCode(
  failure: LiveProofPortFailure,
  fallback: LiveProofFailureCode,
): LiveProofFailureCode {
  return isFailureCode(failure.code) ? failure.code : fallback;
}

function addFailure(
  state: LiveProofRunState,
  code: LiveProofFailureCode,
): void {
  if (isFailureCode(code)) state.failures.add(code);
}

function counterShapeValid(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0);
}

function counterValue(value: number): number {
  if (!counterShapeValid(value) || value > MAX_LIVE_PROOF_COUNTER) {
    return MAX_LIVE_PROOF_COUNTER;
  }
  return value;
}

function addCounter(
  state: LiveProofRunState,
  key: keyof LiveProofCountersState,
  amount: number,
): void {
  state.counters[key] = saturatingIncrement(
    state.counters[key],
    counterValue(amount),
  );
}

function isIdentityCurrent(
  observation: LiveProofCurrentIdentityObservation,
): boolean {
  return (
    observation.currentBuild === "current" &&
    observation.runtimeLoaded === true &&
    observation.artifactComplete === true
  );
}

function normalizeCurrentBuild(
  observation: LiveProofCurrentIdentityObservation,
): LiveProofIdentityCurrentResult {
  if (
    observation.currentBuild === "stale-on-disk" ||
    observation.currentBuild === "manifest-mismatch"
  ) {
    return observation.currentBuild;
  }
  if (isIdentityCurrent(observation)) return "current";
  return "unverifiable";
}

function normalizeFreshParent(
  observation: LiveProofFreshParentLaunch,
): LiveProofIdentityFreshResult {
  if (observation.freshParent === "stale") return "stale";
  if (
    observation.freshParent === "fresh" &&
    observation.runtimeLoaded === true &&
    observation.artifactComplete === true
  ) {
    return "fresh";
  }
  return "unverifiable";
}

function emptyLane(
  name: LiveProofLaneName,
  reason: LiveProofFailureCode,
): LiveProofLaneObservation {
  return {
    name,
    status: "blocked",
    observationCount: 0,
    reason,
  };
}

function createState(): LiveProofRunState {
  const lanes = new Map<LiveProofLaneName, LiveProofLaneObservation>();
  for (const name of LIVE_PROOF_LANE_NAMES) {
    lanes.set(name, emptyLane(name, "identity-current-failed"));
  }
  return {
    currentBuild: "unverifiable",
    freshParent: "unverifiable",
    lanes,
    isolation: "unverified",
    settlement: "unverified",
    registry: "unverified",
    diagnostics: "unverified",
    cleanup: "unverified",
    failures: new Set<LiveProofFailureCode>(),
    counters: {
      events: 0,
      dropped: 0,
      repaints: 0,
      diagnostics: 0,
      cleanupAttempts: 0,
    },
  };
}

function setAllLanesBlocked(
  state: LiveProofRunState,
  reason: LiveProofFailureCode,
): void {
  for (const name of LIVE_PROOF_LANE_NAMES) {
    state.lanes.set(name, emptyLane(name, reason));
  }
}

function validLaneList(value: readonly LiveProofLaneName[]): boolean {
  if (!Array.isArray(value) || value.length !== LIVE_PROOF_LANE_NAMES.length) {
    return false;
  }
  const seen = new Set<string>();
  for (const lane of value) {
    if (
      typeof lane !== "string" ||
      !(LIVE_PROOF_LANE_NAMES as readonly string[]).includes(lane) ||
      seen.has(lane)
    ) {
      return false;
    }
    seen.add(lane);
  }
  return seen.size === LIVE_PROOF_LANE_NAMES.length;
}

function validRunnerArgs(args: LiveProofArgs): boolean {
  return (
    args !== null &&
    typeof args === "object" &&
    args.command === LIVE_PROOF_COMMAND &&
    typeof args.pi === "string" &&
    args.pi.length > 0 &&
    args.requireFreshParent === true &&
    args.requireCurrentBuild === true &&
    typeof args.contentFreeReport === "string" &&
    args.contentFreeReport.length > 0 &&
    args.noScreenCapture === true &&
    validLaneList(args.proofLanes)
  );
}

function isOpaqueHandle(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}

function settlementStatus(value: unknown): LiveProofSettlementStatus {
  if (value === "settled" || value === "unsettled" || value === "unverified") {
    return value;
  }
  return "unverified";
}

function diagnosticsStatus(value: unknown): LiveProofDiagnosticStatus {
  if (
    value === "clean" ||
    value === "loss-observed" ||
    value === "unverified"
  ) {
    return value;
  }
  return "unverified";
}

/**
 * Convert a port method call into a non-throwing ResultAsync. This catches a
 * method that throws before returning its ResultAsync and a ResultAsync whose
 * underlying promise rejects, without allowing host exception text to escape.
 */
function invokePort<T>(
  operation: () => LiveProofPortResult<T>,
  fallback: LiveProofFailureCode,
): LiveProofPortResult<T> {
  const invoked = Result.fromThrowable(
    operation,
    (): LiveProofPortFailure => closedPortFailure(fallback),
  )();
  if (invoked.isErr()) return errAsync(invoked.error);
  return ResultAsync.fromPromise(invoked.value, () =>
    closedPortFailure(fallback),
  ).andThen((result) =>
    result.isOk() ? okAsync(result.value) : errAsync(result.error),
  );
}

function normalizeLaneSignal(
  name: LiveProofLaneName,
  signal: LiveProofLaneSignal,
): LiveProofLaneObservation {
  const observationCount = counterValue(signal.observationCount);
  const structuralPass =
    signal.status === "pass" &&
    counterShapeValid(signal.observationCount) &&
    counterShapeValid(signal.events) &&
    counterShapeValid(signal.dropped) &&
    counterShapeValid(signal.repaints) &&
    signal.prefixObserved === true &&
    signal.nonBlankObserved === true &&
    signal.growthObserved === true &&
    observationCount > 0;

  if (structuralPass) {
    return { name, status: "pass", observationCount };
  }
  if (signal.status === "blocked") {
    return {
      name,
      status: "blocked",
      observationCount,
      reason: "lane-failed",
    };
  }
  return {
    name,
    status: "fail",
    observationCount,
    reason: "lane-failed",
  };
}

function addLaneCounters(
  state: LiveProofRunState,
  signal: LiveProofLaneSignal,
): void {
  addCounter(state, "events", signal.events);
  addCounter(state, "dropped", signal.dropped);
  addCounter(state, "repaints", signal.repaints);
}

function recordLaneFailure(
  state: LiveProofRunState,
  name: LiveProofLaneName,
  result: Result<LiveProofLaneSignal, LiveProofPortFailure>,
): void {
  if (result.isErr() || !isOpaqueHandle(result.value)) {
    state.lanes.set(name, emptyLane(name, "lane-failed"));
    addFailure(state, "lane-failed");
    return;
  }
  addLaneCounters(state, result.value);
  const lane = normalizeLaneSignal(name, result.value);
  state.lanes.set(name, lane);
  if (lane.status !== "pass") addFailure(state, "lane-failed");
}

function aggregateFailures(
  failures: ReadonlySet<LiveProofFailureCode>,
): readonly LiveProofFailureCode[] {
  const values = [...failures];
  if (values.length <= MAX_FAILURES) return values;
  if (!failures.has(CLEANUP_FAILURE_CODE)) return values.slice(0, MAX_FAILURES);
  const withoutCleanup = values.filter(
    (value) => value !== CLEANUP_FAILURE_CODE,
  );
  return [...withoutCleanup.slice(0, MAX_FAILURES - 1), CLEANUP_FAILURE_CODE];
}

function reportFromState(state: LiveProofRunState): LiveProofReport {
  const lanes = LIVE_PROOF_LANE_NAMES.map((name) => {
    const lane = state.lanes.get(name);
    return lane ?? emptyLane(name, DEFAULT_FAILURE_CODE);
  });
  const report: LiveProofReport = {
    schemaVersion: 1,
    identity: {
      currentBuild: state.currentBuild,
      freshParent: state.freshParent,
    },
    lanes,
    isolation: state.isolation,
    settlement: state.settlement,
    registry: state.registry,
    diagnostics: state.diagnostics,
    cleanup: state.cleanup,
    failures: aggregateFailures(state.failures),
    counters: {
      events: counterValue(state.counters.events),
      dropped: counterValue(state.counters.dropped),
      repaints: counterValue(state.counters.repaints),
      diagnostics: counterValue(state.counters.diagnostics),
      cleanupAttempts: counterValue(state.counters.cleanupAttempts),
    },
    bounds: LIVE_PROOF_REPORT_BOUNDS,
  };
  const validated = validateLiveProofReport(report);
  if (validated.isOk()) return validated.value;
  return fallbackReport(validated.error);
}

/** Build a valid closed report if an internal invariant ever fails. */
function fallbackReport(
  _failure: LiveProofReportValidationFailure,
): LiveProofReport {
  const lanes = LIVE_PROOF_LANE_NAMES.map((name) =>
    emptyLane(name, "report-invalid"),
  );
  return {
    schemaVersion: 1,
    identity: { currentBuild: "unverifiable", freshParent: "unverifiable" },
    lanes,
    isolation: "unverified",
    settlement: "unverified",
    registry: "unverified",
    diagnostics: "unverified",
    cleanup: "incomplete",
    failures: ["report-invalid"],
    counters: {
      events: 0,
      dropped: 0,
      repaints: 0,
      diagnostics: 0,
      cleanupAttempts: 0,
    },
    bounds: LIVE_PROOF_REPORT_BOUNDS,
  };
}

function contextOf(state: LiveProofRunState): LiveProofResourceContext {
  return {
    ...(state.parent === undefined ? {} : { parent: state.parent }),
    ...(state.child === undefined ? {} : { child: state.child }),
    ...(state.inspector === undefined ? {} : { inspector: state.inspector }),
  };
}

// ---------------------------------------------------------------------------
// Orchestration stages
// ---------------------------------------------------------------------------

async function runIdentityStage(
  input: LiveProofRunnerInput,
  state: LiveProofRunState,
): Promise<boolean> {
  const result = await invokePort(
    () =>
      input.port.readCurrentIdentity({
        pi: input.args.pi,
        requireCurrentBuild: true,
      }),
    "identity-current-failed",
  );
  if (result.isErr() || !isOpaqueHandle(result.value)) {
    state.currentBuild = "unverifiable";
    setAllLanesBlocked(state, "identity-current-failed");
    addFailure(state, "identity-current-failed");
    return false;
  }
  state.currentBuild = normalizeCurrentBuild(result.value);
  if (!isIdentityCurrent(result.value)) {
    setAllLanesBlocked(state, "identity-current-failed");
    addFailure(state, "identity-current-failed");
    return false;
  }
  return true;
}

async function runParentStage(
  input: LiveProofRunnerInput,
  state: LiveProofRunState,
): Promise<boolean> {
  const result = await invokePort(
    () =>
      input.port.launchFreshParent({
        pi: input.args.pi,
        requireFreshParent: true,
        requireCurrentBuild: true,
        noScreenCapture: true,
      }),
    "fresh-parent-failed",
  );
  if (result.isErr() || !isOpaqueHandle(result.value)) {
    setAllLanesBlocked(state, "fresh-parent-failed");
    addFailure(state, "fresh-parent-failed");
    return false;
  }
  state.freshParent = normalizeFreshParent(result.value);
  if (isOpaqueHandle(result.value.parent)) {
    state.parent = result.value.parent;
  }
  if (
    state.parent === undefined ||
    state.freshParent !== "fresh" ||
    result.value.runtimeLoaded !== true ||
    result.value.artifactComplete !== true
  ) {
    setAllLanesBlocked(state, "fresh-parent-failed");
    addFailure(state, "fresh-parent-failed");
    return false;
  }
  return true;
}

async function runChildAndInspectorStages(
  input: LiveProofRunnerInput,
  state: LiveProofRunState,
): Promise<void> {
  const parent = state.parent;
  if (parent === undefined) {
    setAllLanesBlocked(state, "fresh-parent-failed");
    return;
  }

  const childResult = await invokePort(
    () =>
      input.port.delegateDeterministicChild(
        parent,
        LIVE_PROOF_DETERMINISTIC_CHILD_REQUEST,
      ),
    "spawn-failed",
  );
  if (childResult.isErr() || !isOpaqueHandle(childResult.value)) {
    setAllLanesBlocked(state, "spawn-failed");
    addFailure(
      state,
      childResult.isErr()
        ? portFailureCode(childResult.error, "spawn-failed")
        : "spawn-failed",
    );
    return;
  }
  state.child = childResult.value;

  const inspectorResult = await invokePort(
    () => input.port.selectLiveInspector(parent, childResult.value),
    "spawn-failed",
  );
  if (inspectorResult.isErr() || !isOpaqueHandle(inspectorResult.value)) {
    if (inspectorResult.isErr()) {
      addFailure(state, portFailureCode(inspectorResult.error, "spawn-failed"));
    } else {
      addFailure(state, "spawn-failed");
    }
    // The parent lane is still independently observable. Inspector lanes are
    // blocked below, rather than allowing one selection failure to hide it.
    return;
  }
  state.inspector = inspectorResult.value;
}

async function runLaneStages(
  input: LiveProofRunnerInput,
  state: LiveProofRunState,
): Promise<void> {
  const parent = state.parent;
  const child = state.child;
  if (parent === undefined || child === undefined) return;

  const parentLane = await invokePort(
    () => input.port.observeParentRawReasoning(parent, child),
    "lane-failed",
  );
  recordLaneFailure(state, "parent-raw-reasoning-live", parentLane);

  const inspector = state.inspector;
  if (inspector === undefined) {
    for (const name of [
      "inspector-raw-reasoning-live",
      "inspector-tool-details",
      "inspector-assistant-reply-live",
    ] as const) {
      state.lanes.set(name, emptyLane(name, "spawn-failed"));
    }
    return;
  }

  const inspectorReasoning = await invokePort(
    () => input.port.observeInspectorRawReasoning(parent, child, inspector),
    "lane-failed",
  );
  recordLaneFailure(state, "inspector-raw-reasoning-live", inspectorReasoning);

  const toolDetails = await invokePort(
    () => input.port.observeInspectorToolDetails(parent, child, inspector),
    "lane-failed",
  );
  recordLaneFailure(state, "inspector-tool-details", toolDetails);

  const assistantReply = await invokePort(
    () => input.port.observeInspectorAssistantReply(parent, child, inspector),
    "lane-failed",
  );
  recordLaneFailure(state, "inspector-assistant-reply-live", assistantReply);
}

async function runSettlementStage(
  input: LiveProofRunnerInput,
  state: LiveProofRunState,
): Promise<void> {
  const parent = state.parent;
  const child = state.child;
  if (parent === undefined || child === undefined) return;

  const result = await invokePort(
    () => input.port.readSettlement(parent, child),
    "settlement-failed",
  );
  if (result.isErr() || !isOpaqueHandle(result.value)) {
    state.settlement = "unverified";
    addFailure(state, "settlement-failed");
    return;
  }
  addCounter(state, "events", result.value.events);
  addCounter(state, "dropped", result.value.dropped);
  addCounter(state, "repaints", result.value.repaints);

  const exactLifecycle =
    counterShapeValid(result.value.childCount) &&
    counterShapeValid(result.value.settlementCount) &&
    counterShapeValid(result.value.toolTerminalCount) &&
    counterShapeValid(result.value.events) &&
    counterShapeValid(result.value.dropped) &&
    counterShapeValid(result.value.repaints) &&
    counterValue(result.value.childCount) === 1 &&
    counterValue(result.value.settlementCount) === 1 &&
    counterValue(result.value.toolTerminalCount) === 1;
  const status = settlementStatus(result.value.status);
  if (status === "settled" && exactLifecycle) {
    state.settlement = "settled";
    return;
  }
  state.settlement = status === "unverified" ? "unverified" : "unsettled";
  addFailure(state, "settlement-failed");
}

async function runIsolationStage(
  input: LiveProofRunnerInput,
  state: LiveProofRunState,
): Promise<void> {
  if (state.parent === undefined || state.child === undefined) return;
  const result = await invokePort(
    () => input.port.readIsolation(contextOf(state)),
    "isolation-failed",
  );
  if (result.isErr() || !isOpaqueHandle(result.value)) {
    state.isolation = "unverified";
    addFailure(state, "isolation-failed");
    return;
  }
  const isolated =
    result.value.parentIsolated === true &&
    result.value.cardIsolated === true &&
    result.value.modelIsolated === true &&
    result.value.durableIsolated === true &&
    result.value.prohibitedSinkDetected === false;
  state.isolation = isolated ? "isolated" : "violated";
  if (!isolated) addFailure(state, "isolation-failed");
}

async function runRegistryStage(
  input: LiveProofRunnerInput,
  state: LiveProofRunState,
): Promise<void> {
  if (state.parent === undefined || state.child === undefined) return;
  const result = await invokePort(
    () => input.port.readRegistry(contextOf(state)),
    "registry-leaked",
  );
  if (result.isErr() || !isOpaqueHandle(result.value)) {
    state.registry = "unverified";
    addFailure(state, "registry-leaked");
    return;
  }
  const values = [
    result.value.cardEntries,
    result.value.cardBytes,
    result.value.inspectorEntries,
    result.value.inspectorBytes,
    result.value.registryEntries,
    result.value.registryBytes,
  ];
  const empty = values.every((value) => counterValue(value) === 0);
  state.registry = empty ? "empty" : "leaked";
  if (!empty) addFailure(state, "registry-leaked");
}

async function runDiagnosticsStage(
  input: LiveProofRunnerInput,
  state: LiveProofRunState,
): Promise<void> {
  if (state.parent === undefined || state.child === undefined) return;
  const result = await invokePort(
    () => input.port.readDiagnostics(contextOf(state)),
    "diagnostics-failed",
  );
  if (result.isErr() || !isOpaqueHandle(result.value)) {
    state.diagnostics = "unverified";
    state.counters.diagnostics = MAX_LIVE_PROOF_COUNTER;
    addFailure(state, "diagnostics-failed");
    return;
  }
  state.counters.diagnostics = counterValue(result.value.count);
  if (
    !counterShapeValid(result.value.count) ||
    result.value.overflow === true
  ) {
    state.diagnostics = "unverified";
    addFailure(state, "diagnostics-failed");
    return;
  }
  state.diagnostics = diagnosticsStatus(result.value.status);
  if (state.diagnostics !== "clean") {
    addFailure(state, "diagnostics-failed");
  }
}

async function runCleanupStage(
  input: LiveProofRunnerInput,
  state: LiveProofRunState,
): Promise<void> {
  const context = contextOf(state);
  const cleanupOperations = [
    () => input.port.cleanupRuntime(context),
    () => input.port.cleanupProcess(context),
    () => input.port.cleanupTemp(context),
    () => input.port.cleanupPane(context),
  ] as const;
  let failed = false;
  for (const operation of cleanupOperations) {
    state.counters.cleanupAttempts = saturatingIncrement(
      state.counters.cleanupAttempts,
    );
    const result = await invokePort(operation, CLEANUP_FAILURE_CODE);
    if (result.isErr()) failed = true;
  }
  state.cleanup = failed ? "incomplete" : "complete";
  if (failed) addFailure(state, CLEANUP_FAILURE_CODE);
}

async function runStages(
  input: LiveProofRunnerInput,
  state: LiveProofRunState,
): Promise<void> {
  if (!validRunnerArgs(input.args)) {
    setAllLanesBlocked(state, "invalid-args");
    addFailure(state, "invalid-args");
    return;
  }
  if (!(await runIdentityStage(input, state))) return;
  if (!(await runParentStage(input, state))) return;
  await runChildAndInspectorStages(input, state);
  await runLaneStages(input, state);
  await runSettlementStage(input, state);
  await runIsolationStage(input, state);
  await runRegistryStage(input, state);
  await runDiagnosticsStage(input, state);
}

async function runWithCleanup(
  input: LiveProofRunnerInput,
  state: LiveProofRunState,
): Promise<LiveProofReport> {
  try {
    await runStages(input, state);
  } finally {
    await runCleanupStage(input, state);
  }
  return reportFromState(state);
}

/**
 * Run one injectable live proof. Every expected failure is converted to a
 * content-free report, so callers never receive a second unbounded error
 * surface. Cleanup is attempted even when identity or launch fails.
 */
export function runLiveProof(
  input: LiveProofRunnerInput,
): ResultAsync<LiveProofReport, never> {
  const state = createState();
  const execution = ResultAsync.fromPromise(
    runWithCleanup(input, state),
    (): LiveProofPortFailure => closedPortFailure(DEFAULT_FAILURE_CODE),
  );
  return execution.orElse(() => {
    addFailure(state, DEFAULT_FAILURE_CODE);
    if (state.cleanup === "unverified") state.cleanup = "incomplete";
    return okAsync(reportFromState(state));
  });
}

/** Explicit alias used by the future verifier command entry point. */
export const runChildStreamLiveProof = runLiveProof;
export const runLiveChildStreamProof = runLiveProof;
