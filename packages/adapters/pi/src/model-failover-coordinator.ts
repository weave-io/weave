import {
  err,
  errAsync,
  ok,
  Result,
  ResultAsync,
  type ResultAsync as ResultAsyncType,
} from "neverthrow";
import type { TimerHandle, TimerPort } from "./child-timer.js";
import { SystemTimerPort } from "./child-timer.js";
import {
  type PiFailoverContextRepairError,
  repairPiFailoverContext,
} from "./model-failover-context.js";
import {
  consumePiFailureAdvance,
  createPiCandidateCursor,
  createPiModelFailoverMarker,
  isPiFailoverFailureClass,
  isPiModelFailoverMarker,
  isPiPayloadlessAgentSettledEvent,
  MAX_PI_FAILOVER_CANDIDATES,
  type PiAssistantFingerprint,
  type PiCandidateCursor,
  type PiCandidatePreflightError,
  type PiCandidatePreflightOutcome,
  type PiFailoverCandidate,
  type PiFailoverFailureClass,
  parsePiAssistantFingerprint,
  piCanonicalModelIdentity,
} from "./model-failover-contract.js";
import {
  createPiModelFailoverPreflight,
  mapPiCandidatePreflightOutcome,
  type PiFailoverPreflightError,
  type PiFailoverPreflightOutcome,
  type PiFailoverPreflightSession,
  type PiFailoverRuntimePreflightInput,
  type PiModelFailoverPreflightPort,
} from "./model-failover-preflight.js";
import type { PiModelInfo } from "./model-resolution.js";

/** The complete explicit coordinator state machine. */
export const PI_MODEL_FAILOVER_STATES = Object.freeze([
  "armed",
  "switching",
  "awaiting-marker-proof",
  "awaiting-context-repair",
  "recovering",
  "manually-overridden",
  "exhausted",
  "terminal",
] as const);

export type PiModelFailoverState = (typeof PI_MODEL_FAILOVER_STATES)[number];

/** Compatibility spelling used by adapter lifecycle code. */
export const PI_FAILOVER_STATES = PI_MODEL_FAILOVER_STATES;
export const MODEL_FAILOVER_STATES = PI_MODEL_FAILOVER_STATES;

export type PiModelFailoverStateTransitionError = {
  readonly type: "IllegalStateTransition";
  readonly from: PiModelFailoverState;
  readonly to: PiModelFailoverState;
};

/**
 * State transitions are explicit. Scope replacement and explicit activation
 * use a new coordinator epoch and do not count as lifecycle transitions.
 */
export const PI_MODEL_FAILOVER_TRANSITIONS: Readonly<
  Record<PiModelFailoverState, readonly PiModelFailoverState[]>
> = Object.freeze({
  armed: Object.freeze([
    "switching",
    "manually-overridden",
    "exhausted",
    "terminal",
  ]),
  switching: Object.freeze([
    "armed",
    "awaiting-marker-proof",
    "manually-overridden",
    "exhausted",
    "terminal",
  ]),
  "awaiting-marker-proof": Object.freeze([
    "awaiting-context-repair",
    "manually-overridden",
    "terminal",
  ]),
  "awaiting-context-repair": Object.freeze([
    "recovering",
    "manually-overridden",
    "terminal",
  ]),
  recovering: Object.freeze([
    "switching",
    "manually-overridden",
    "exhausted",
    "terminal",
  ]),
  "manually-overridden": Object.freeze(["terminal"]),
  exhausted: Object.freeze(["terminal", "manually-overridden"]),
  terminal: Object.freeze(["manually-overridden"]),
} as Record<PiModelFailoverState, readonly PiModelFailoverState[]>);

/** Check the public state table without mutating a coordinator. */
export function isPiModelFailoverTransitionLegal(
  from: PiModelFailoverState,
  to: PiModelFailoverState,
): boolean {
  return PI_MODEL_FAILOVER_TRANSITIONS[from]?.includes(to) ?? false;
}

export const canTransitionPiModelFailover = isPiModelFailoverTransitionLegal;
export const isLegalPiModelFailoverTransition =
  isPiModelFailoverTransitionLegal;

/** Apply one state-table transition as a typed value. */
export function transitionPiModelFailoverState(
  from: PiModelFailoverState,
  to: PiModelFailoverState,
): Result<PiModelFailoverState, PiModelFailoverStateTransitionError> {
  return isPiModelFailoverTransitionLegal(from, to)
    ? ok(to)
    : err({ type: "IllegalStateTransition", from, to });
}

export const transitionPiFailoverState = transitionPiModelFailoverState;

/** Public model identity used in bounded facts and callbacks. */
export interface PiAppliedModel {
  readonly provider: string;
  readonly id: string;
}

/** One immutable coordinator scope. */
export interface PiModelFailoverScope {
  readonly generationId: string;
  readonly nativeSessionId: string;
  readonly activationId: string;
  readonly candidates: readonly (PiFailoverCandidate | PiModelInfo)[];
  readonly currentModel?: PiModelInfo;
}

/** Event scope supplied by lifecycle adapters when they have one. */
export interface PiModelFailoverEventScope {
  readonly generationId?: string;
  readonly nativeSessionId?: string;
  readonly activationId?: string;
}

/** A retained failure contains no provider text or assistant content. */
export interface PiModelFailoverFailureInput {
  readonly failureClass: PiFailoverFailureClass;
  readonly failedModel?: PiModelInfo;
  readonly failedAssistantFingerprint?: PiAssistantFingerprint;
  readonly fingerprint?: PiAssistantFingerprint;
  readonly generationId?: string;
  readonly nativeSessionId?: string;
  readonly activationId?: string;
}

export type PiModelFailoverSettlementInput =
  | { readonly status: "success" }
  | {
      readonly status: "failure";
      readonly failure: PiModelFailoverFailureInput;
    }
  | { readonly status: "cancelled"; readonly authenticated?: boolean };

export type PiModelFailoverTerminalReason =
  | "unsupported-failure"
  | "unknown-failure-not-eligible"
  | "switch-call-failed"
  | "switch-rejected"
  | "switch-timeout"
  | "switch-indeterminate"
  | "marker-send-failed"
  | "marker-timeout"
  | "context-repair-failed"
  | "context-timeout"
  | "stale-scope"
  | "manual-override"
  | "cancelled"
  | "reset"
  | "reload"
  | "shutdown"
  | "operation-failed";

interface DecisionBase {
  readonly failureClass?: PiFailoverFailureClass;
  readonly appliedModel?: PiAppliedModel;
  readonly generationId: string;
  readonly nativeSessionId: string;
  readonly activationId: string;
}

export type PiModelFailoverTerminalDecision =
  | (DecisionBase & {
      readonly kind: "success";
      readonly status: "success";
    })
  | (DecisionBase & {
      readonly kind: "exhausted";
      readonly status: "exhausted";
      readonly cursorPosition: number;
    })
  | (DecisionBase & {
      readonly kind: "cancelled";
      readonly status: "cancelled";
      readonly authority: "authenticated-parent";
    })
  | (DecisionBase & {
      readonly kind: "failed";
      readonly status: "failed";
      readonly reason: PiModelFailoverTerminalReason;
    });

export interface PiModelFailoverAppliedEvent {
  readonly phase: "applied";
  readonly model: PiAppliedModel;
  readonly fromModel?: PiAppliedModel;
  readonly failureClass: PiFailoverFailureClass;
  readonly candidateIndex: number;
}

export interface PiModelFailoverRecoveryConfirmedEvent {
  readonly phase: "recovery-confirmed";
  readonly model: PiAppliedModel;
  readonly fromModel?: PiAppliedModel;
  readonly failureClass: PiFailoverFailureClass;
  readonly candidateIndex: number;
}

export interface PiModelFailoverStateEvent {
  readonly from: PiModelFailoverState;
  readonly to: PiModelFailoverState;
}

/** The public host calls used by this coordinator. */
export interface PiModelFailoverHost {
  setModel(
    model: PiModelInfo,
  ): boolean | undefined | Promise<boolean | undefined>;
  sendMessage(
    message: {
      readonly customType: string;
      readonly content: string;
      readonly details?: unknown;
      readonly display?: boolean;
    },
    options?: { readonly triggerTurn?: boolean },
  ): void | Promise<void>;
}

/** A small, host-independent timer budget. */
export const DEFAULT_PI_FAILOVER_SWITCH_TIMEOUT_MS = 15_000;
export const DEFAULT_PI_FAILOVER_MARKER_TIMEOUT_MS = 15_000;
export const DEFAULT_PI_FAILOVER_CONTEXT_TIMEOUT_MS = 15_000;

export type PiModelFailoverOperationError = {
  readonly type: "CoordinatorOperationFailed";
};

export type PiModelFailoverEventError =
  | { readonly type: "EventNotExpected" }
  | { readonly type: "EventScopeStale" }
  | { readonly type: "ModelSelectMalformed" }
  | { readonly type: "ModelSelectUnmatched" }
  | { readonly type: "ModelSelectDuplicate" }
  | { readonly type: "MarkerNotExpected" }
  | { readonly type: "MarkerMalformed" }
  | { readonly type: "ContextNotExpected" }
  | {
      readonly type: "ContextRepairFailed";
      readonly error: PiFailoverContextRepairError;
    };

export interface PiModelFailoverCoordinatorCallbacks {
  readonly onDecision?: (decision: PiModelFailoverTerminalDecision) => void;
  readonly onTerminal?: (decision: PiModelFailoverTerminalDecision) => void;
  readonly onAppliedModel?: (event: PiModelFailoverAppliedEvent) => void;
  readonly onRecoveryConfirmed?: (
    event: PiModelFailoverRecoveryConfirmedEvent,
  ) => void;
  readonly onStateChange?: (event: PiModelFailoverStateEvent) => void;
}

export interface PiModelFailoverCoordinatorOptions
  extends PiModelFailoverCoordinatorCallbacks {
  readonly host: PiModelFailoverHost;
  readonly scope?: PiModelFailoverScope;
  readonly generationId?: string;
  readonly nativeSessionId?: string;
  readonly activationId?: string;
  readonly candidates?: readonly (PiFailoverCandidate | PiModelInfo)[];
  readonly currentModel?: PiModelInfo;
  /** A fixed context or a getter for the current public Pi context. */
  readonly context?:
    | PiFailoverPreflightSession
    | (() => PiFailoverPreflightSession);
  readonly getGenerationId?: () => string;
  readonly getNativeSessionId?: () => string;
  readonly isGenerationCurrent?: (generationId: string) => boolean;
  readonly isSessionCurrent?: (nativeSessionId: string) => boolean;
  readonly isCancelled?: () => boolean;
  readonly isAuthenticated?: (model: PiModelInfo) => boolean;
  readonly preflight?:
    | PiModelFailoverPreflightPort
    | {
        readonly preflight: (
          candidate: PiFailoverCandidate,
        ) => ResultAsyncType<
          PiCandidatePreflightOutcome,
          PiCandidatePreflightError
        >;
      };
  readonly timer?: TimerPort;
  readonly switchTimeoutMs?: number;
  readonly markerTimeoutMs?: number;
  readonly contextTimeoutMs?: number;
}

export interface PiModelFailoverSnapshot {
  readonly state: PiModelFailoverState;
  readonly scope: PiModelFailoverScope;
  readonly currentModel?: PiAppliedModel;
  readonly retainedFailureClass?: PiFailoverFailureClass;
  readonly retainedFailureModel?: PiAppliedModel;
  readonly cursorPosition: number;
  readonly cursorAdvanced: number;
  readonly cursorCap: number;
  readonly unknownAdvancesUsed: number;
  readonly expectation:
    | {
        readonly candidate: PiAppliedModel;
        readonly eventSeen: boolean;
        readonly resultSeen: boolean;
      }
    | undefined;
  readonly markerPhase:
    | "none"
    | "awaiting-marker-proof"
    | "awaiting-context-repair";
  readonly manualOverrideLatched: boolean;
  readonly decision?: PiModelFailoverTerminalDecision;
}

interface RetainedFailure {
  readonly failureClass: PiFailoverFailureClass;
  readonly failedModel?: PiModelInfo;
  readonly fingerprint?: PiAssistantFingerprint;
}

interface ModelExpectation {
  readonly version: number;
  readonly candidate: PiFailoverCandidate | PiModelInfo;
  readonly eventModel?: PiAppliedModel;
  readonly eventSeen: boolean;
  readonly resultSeen: boolean;
}

interface ActiveMarker {
  readonly version: number;
  readonly token: string;
  readonly candidate: PiFailoverCandidate | PiModelInfo;
  readonly fingerprint: PiAssistantFingerprint;
}

function clonedModel(model: PiModelInfo): PiModelInfo {
  // Keep the authenticated catalog object. Pi's public setModel contract
  // accepts the full catalog entry, not a compact provider/id transport copy.
  return model;
}

/** Project model facts without exposing provider configuration or credentials. */
function publicModel(
  model: PiModelInfo | undefined,
): PiAppliedModel | undefined {
  if (model === undefined) return undefined;
  return Object.freeze({ provider: model.provider, id: model.id });
}

function modelFromCandidate(
  candidate: PiFailoverCandidate | PiModelInfo,
): PiModelInfo {
  if (
    typeof candidate === "object" &&
    candidate !== null &&
    "resolved" in candidate &&
    candidate.resolved === true &&
    "model" in candidate
  ) {
    return candidate.model;
  }
  return candidate as PiModelInfo;
}

function cloneCandidate(
  candidate: PiFailoverCandidate | PiModelInfo,
): PiFailoverCandidate | PiModelInfo {
  const model = clonedModel(modelFromCandidate(candidate));
  if (
    typeof candidate === "object" &&
    candidate !== null &&
    "resolved" in candidate &&
    candidate.resolved === true &&
    "model" in candidate
  ) {
    const resolution = candidate as PiFailoverCandidate;
    const copy: PiFailoverCandidate = {
      resolved: true,
      model,
      intentEntry: resolution.intentEntry,
      source: resolution.source,
      ...(resolution.thinkingLevel === undefined
        ? {}
        : { thinkingLevel: resolution.thinkingLevel }),
    };
    return Object.freeze(copy);
  }
  return model;
}

function asLegacyCandidate(
  candidate: PiFailoverCandidate | PiModelInfo,
): PiFailoverCandidate {
  if (
    typeof candidate === "object" &&
    candidate !== null &&
    "resolved" in candidate &&
    candidate.resolved === true &&
    "model" in candidate
  ) {
    return candidate as PiFailoverCandidate;
  }
  const model = candidate as PiModelInfo;
  return {
    resolved: true,
    model,
    intentEntry: `${model.provider}/${model.id}`,
    source: "canonical",
  };
}

function frozenDistinctCandidates(
  candidates: readonly (PiFailoverCandidate | PiModelInfo)[],
): readonly (PiFailoverCandidate | PiModelInfo)[] {
  const seen = new Set<string>();
  const output: (PiFailoverCandidate | PiModelInfo)[] = [];
  for (const candidate of candidates) {
    const prepared = Result.fromThrowable(
      () => {
        const model = modelFromCandidate(candidate);
        const identity = piCanonicalModelIdentity(model);
        return { identity, candidate: cloneCandidate(candidate) };
      },
      (): undefined => undefined,
    )();
    if (prepared.isErr() || prepared.value === undefined) continue;
    if (seen.has(prepared.value.identity)) continue;
    seen.add(prepared.value.identity);
    output.push(prepared.value.candidate);
    if (output.length >= MAX_PI_FAILOVER_CANDIDATES) break;
  }
  return Object.freeze(output);
}

function normalizedScope(
  options: PiModelFailoverCoordinatorOptions,
): PiModelFailoverScope {
  if (options.scope !== undefined) {
    return Object.freeze({
      generationId: options.scope.generationId,
      nativeSessionId: options.scope.nativeSessionId,
      activationId: options.scope.activationId,
      candidates: frozenDistinctCandidates(options.scope.candidates),
      ...(options.scope.currentModel === undefined
        ? {}
        : { currentModel: clonedModel(options.scope.currentModel) }),
    });
  }
  return Object.freeze({
    generationId: options.generationId ?? "generation-unknown",
    nativeSessionId: options.nativeSessionId ?? "session-unknown",
    activationId: options.activationId ?? "activation-unknown",
    candidates: frozenDistinctCandidates(options.candidates ?? []),
    ...(options.currentModel === undefined
      ? {}
      : { currentModel: clonedModel(options.currentModel) }),
  });
}

function eventModel(value: unknown): PiAppliedModel | undefined {
  if (value === null || typeof value !== "object") return undefined;
  if (
    "type" in value &&
    (value as { readonly type?: unknown }).type !== "model_select"
  ) {
    return undefined;
  }
  const model =
    "model" in value ? (value as { readonly model?: unknown }).model : value;
  if (model === null || typeof model !== "object") return undefined;
  const provider = (model as { readonly provider?: unknown }).provider;
  const id = (model as { readonly id?: unknown }).id;
  if (typeof provider !== "string" || typeof id !== "string") return undefined;
  if (
    provider.length === 0 ||
    provider.length > 256 ||
    id.length === 0 ||
    id.length > 256
  )
    return undefined;
  return publicModel({ provider, id });
}

function eventMessage(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (
    "type" in value &&
    (value as { readonly type?: unknown }).type !== "message_start"
  ) {
    return undefined;
  }
  if ("message" in value) {
    return (value as { readonly message?: unknown }).message;
  }
  return value;
}

function safeScopeField(
  read: (() => string) | undefined,
  fallback: string,
): string | undefined {
  if (read === undefined) return fallback;
  return Result.fromThrowable(read, (): undefined => undefined)().match(
    (value) => (typeof value === "string" ? value : undefined),
    () => undefined,
  );
}

function safeCallback<T>(
  callback: ((value: T) => void) | undefined,
  value: T,
): void {
  if (callback === undefined) return;
  Result.fromThrowable(
    () => callback(value),
    (): undefined => undefined,
  )();
}

/**
 * One bounded public-lifecycle model fallback coordinator.
 *
 * The coordinator is deliberately adapter-local. It owns no Pi internals and
 * does not infer dispatch from a promise returned by `sendMessage`.
 */
export class PiModelFailoverCoordinator {
  private readonly options: PiModelFailoverCoordinatorOptions;
  private readonly timer: TimerPort;
  private readonly preflight: PiModelFailoverPreflightPort;
  private scopeValue: PiModelFailoverScope;
  private stateValue: PiModelFailoverState = "armed";
  private currentModelValue: PiModelInfo | undefined;
  private retainedFailureValue: RetainedFailure | undefined;
  private pendingFailureValue: RetainedFailure | undefined;
  private cursorValue:
    | PiCandidateCursor<PiFailoverCandidate | PiModelInfo>
    | undefined;
  private expectationValue: ModelExpectation | undefined;
  private markerValue: ActiveMarker | undefined;
  private switchTimer: TimerHandle | undefined;
  private switchTimeoutPromise: Promise<"timed-out"> | undefined;
  private switchTimeoutResolve: ((value: "timed-out") => void) | undefined;
  private markerTimer: TimerHandle | undefined;
  private contextTimer: TimerHandle | undefined;
  private contextClosed = false;
  private operationVersion = 0;
  private unknownAdvancesUsedValue = 0;
  private manualOverrideLatchedValue = false;
  private decisionValue: PiModelFailoverTerminalDecision | undefined;
  private decisionPublished = false;

  constructor(options: PiModelFailoverCoordinatorOptions) {
    this.options = options;
    this.timer = options.timer ?? new SystemTimerPort();
    this.preflight =
      options.preflight !== undefined && "check" in options.preflight
        ? options.preflight
        : createPiModelFailoverPreflight();
    this.scopeValue = normalizedScope(options);
    this.currentModelValue = this.scopeValue.currentModel;
  }

  get state(): PiModelFailoverState {
    return this.stateValue;
  }

  get currentModel(): PiAppliedModel | undefined {
    return publicModel(this.currentModelValue);
  }

  get terminalDecision(): PiModelFailoverTerminalDecision | undefined {
    return this.decisionValue;
  }

  get scope(): PiModelFailoverScope {
    return this.scopeValue;
  }

  isTerminal(): boolean {
    return this.stateValue === "terminal" || this.stateValue === "exhausted";
  }

  snapshot(): PiModelFailoverSnapshot {
    const cursor = this.cursorValue;
    const expectation = this.expectationValue;
    const expectedModel =
      expectation === undefined
        ? undefined
        : publicModel(modelFromCandidate(expectation.candidate));
    let markerPhase: PiModelFailoverSnapshot["markerPhase"] = "none";
    if (this.markerValue !== undefined) {
      markerPhase =
        this.stateValue === "awaiting-marker-proof"
          ? "awaiting-marker-proof"
          : "awaiting-context-repair";
    }
    return {
      state: this.stateValue,
      scope: this.scopeValue,
      currentModel: publicModel(this.currentModelValue),
      ...(this.retainedFailureValue === undefined
        ? {}
        : {
            retainedFailureClass: this.retainedFailureValue.failureClass,
            retainedFailureModel: publicModel(
              this.retainedFailureValue.failedModel,
            ),
          }),
      cursorPosition: cursor?.position ?? 0,
      cursorAdvanced: cursor?.advanced ?? 0,
      cursorCap: cursor?.cap ?? this.scopeValue.candidates.length,
      unknownAdvancesUsed: this.unknownAdvancesUsedValue,
      expectation:
        expectation === undefined || expectedModel === undefined
          ? undefined
          : {
              candidate: expectedModel,
              eventSeen: expectation.eventSeen,
              resultSeen: expectation.resultSeen,
            },
      markerPhase,
      manualOverrideLatched: this.manualOverrideLatchedValue,
      ...(this.decisionValue === undefined
        ? {}
        : { decision: this.decisionValue }),
    };
  }

  /** Alias used by event adapters. */
  diagnostics(): PiModelFailoverSnapshot {
    return this.snapshot();
  }

  /** Reset into a new explicit Weave activation and frozen candidate scope. */
  explicitActivate(scope: PiModelFailoverScope): Result<void, never> {
    this.invalidateEpoch();
    this.scopeValue = normalizedScope({ ...this.options, scope });
    this.currentModelValue = this.scopeValue.currentModel;
    this.retainedFailureValue = undefined;
    this.pendingFailureValue = undefined;
    this.cursorValue = undefined;
    this.unknownAdvancesUsedValue = 0;
    this.manualOverrideLatchedValue = false;
    this.decisionValue = undefined;
    this.decisionPublished = false;
    this.contextClosed = false;
    this.forceState("armed");
    return ok(undefined);
  }

  /** Compatibility aliases for the explicit activation boundary. */
  activate(scope: PiModelFailoverScope): Result<void, never> {
    return this.explicitActivate(scope);
  }

  arm(scope?: PiModelFailoverScope): Result<void, never> {
    if (scope !== undefined) return this.explicitActivate(scope);
    // Ordinary turns never clear a manual override. A no-argument arm is
    // therefore intentionally a no-op unless the caller supplies a new
    // explicit activation scope.
    return ok(undefined);
  }

  /**
   * Record a terminal provider failure without starting a switch. This models
   * Pi's payloadless `agent_settled` ordering: the lifecycle may call this at
   * `message_end`, then call `handleAgentSettled` after native recovery.
   */
  observeFailure(
    input: PiModelFailoverFailureInput,
    eventScope?: PiModelFailoverEventScope,
  ): Result<void, PiModelFailoverEventError> {
    const scopeResult = this.validateEventScope(eventScope);
    if (scopeResult.isErr()) return scopeResult;
    const failureScope = this.validateFailureInputScope(input);
    if (failureScope.isErr()) return failureScope;
    const retained = this.normalizeFailure(input);
    if (retained.isErr()) {
      this.failClosed("unsupported-failure");
      return err({ type: "EventNotExpected" });
    }

    if (this.stateValue === "terminal" || this.stateValue === "exhausted") {
      return ok(undefined);
    }
    if (
      this.stateValue === "switching" ||
      this.stateValue === "awaiting-marker-proof" ||
      this.stateValue === "awaiting-context-repair"
    ) {
      this.failClosed("stale-scope");
      return err({ type: "EventNotExpected" });
    }
    this.pendingFailureValue = retained.value;
    if (this.stateValue === "armed") this.retainedFailureValue = retained.value;
    return ok(undefined);
  }

  /** Start a bounded fallback attempt for one retained failure. */
  handleFailure(
    input: PiModelFailoverFailureInput,
    eventScope?: PiModelFailoverEventScope,
  ): ResultAsyncType<void, PiModelFailoverOperationError> {
    return ResultAsync.fromPromise(
      Promise.resolve()
        .then(() => this.observeFailure(input, eventScope))
        .then((observed) => {
          if (observed.isErr()) return;
          if (this.stateValue === "armed" || this.stateValue === "recovering") {
            return this.beginRecordedFailure(input);
          }
        }),
      (): PiModelFailoverOperationError => ({
        type: "CoordinatorOperationFailed",
      }),
    );
  }

  startFailure(
    input: PiModelFailoverFailureInput,
    eventScope?: PiModelFailoverEventScope,
  ): ResultAsyncType<void, PiModelFailoverOperationError> {
    return this.handleFailure(input, eventScope);
  }

  beginFailure(
    input: PiModelFailoverFailureInput,
    eventScope?: PiModelFailoverEventScope,
  ): ResultAsyncType<void, PiModelFailoverOperationError> {
    return this.handleFailure(input, eventScope);
  }

  onFailure(
    input: PiModelFailoverFailureInput,
    eventScope?: PiModelFailoverEventScope,
  ): ResultAsyncType<void, PiModelFailoverOperationError> {
    return this.handleFailure(input, eventScope);
  }

  onModelFailure(
    input: PiModelFailoverFailureInput,
    eventScope?: PiModelFailoverEventScope,
  ): ResultAsyncType<void, PiModelFailoverOperationError> {
    return this.handleFailure(input, eventScope);
  }

  /** Consume the public payloadless settlement event. */
  handleAgentSettled(
    input: PiModelFailoverSettlementInput | unknown = { status: "success" },
    eventScope?: PiModelFailoverEventScope,
  ): ResultAsyncType<void, PiModelFailoverOperationError> {
    return ResultAsync.fromPromise(
      Promise.resolve().then(() => {
        const scopeResult = this.validateEventScope(eventScope);
        if (scopeResult.isErr()) return;
        const settlement = Result.fromThrowable(
          () => this.normalizeSettlement(input),
          (): undefined => undefined,
        )().match(
          (value) => value,
          () => undefined,
        );
        if (settlement === undefined) return;
        if (settlement.status === "cancelled") {
          this.cancel({
            authority:
              settlement.authenticated === true
                ? "authenticated-parent"
                : "recovery-local",
          });
          return;
        }
        if (settlement.status === "failure") {
          const failureScope = this.validateFailureInputScope(
            settlement.failure,
          );
          if (failureScope.isErr()) return;
          return this.beginRecordedFailure(settlement.failure);
        }
        if (this.pendingFailureValue !== undefined) {
          const pending = this.pendingFailureValue;
          this.pendingFailureValue = undefined;
          return this.beginRecordedFailure(pending);
        }
        if (this.stateValue === "recovering" || this.stateValue === "armed") {
          this.finishSuccess();
          return;
        }
        if (
          this.stateValue === "awaiting-marker-proof" ||
          this.stateValue === "awaiting-context-repair"
        ) {
          this.failClosed(
            this.stateValue === "awaiting-marker-proof"
              ? "marker-timeout"
              : "context-timeout",
          );
        }
      }),
      (): PiModelFailoverOperationError => ({
        type: "CoordinatorOperationFailed",
      }),
    );
  }

  onAgentSettled(
    input: PiModelFailoverSettlementInput | unknown = { status: "success" },
    eventScope?: PiModelFailoverEventScope,
  ): ResultAsyncType<void, PiModelFailoverOperationError> {
    return this.handleAgentSettled(input, eventScope);
  }

  onRecoverySettled(
    input: PiModelFailoverSettlementInput | unknown = { status: "success" },
    eventScope?: PiModelFailoverEventScope,
  ): ResultAsyncType<void, PiModelFailoverOperationError> {
    return this.handleAgentSettled(input, eventScope);
  }

  settle(
    input: PiModelFailoverSettlementInput | unknown = { status: "success" },
    eventScope?: PiModelFailoverEventScope,
  ): ResultAsyncType<void, PiModelFailoverOperationError> {
    return this.handleAgentSettled(input, eventScope);
  }

  /** Capture a later fallback failure and advance only after its settlement. */
  observeLaterFailure(
    input: PiModelFailoverFailureInput,
    eventScope?: PiModelFailoverEventScope,
  ): Result<void, PiModelFailoverEventError> {
    if (this.stateValue !== "recovering") {
      return this.observeFailure(input, eventScope);
    }
    const scopeResult = this.validateEventScope(eventScope);
    if (scopeResult.isErr()) return scopeResult;
    const failureScope = this.validateFailureInputScope(input);
    if (failureScope.isErr()) return failureScope;
    const normalized = this.normalizeFailure(input);
    if (normalized.isErr()) {
      this.failClosed("unsupported-failure");
      return err({ type: "EventNotExpected" });
    }
    this.pendingFailureValue = normalized.value;
    return ok(undefined);
  }

  /** Handle the exact public `model_select` proof. */
  onModelSelect(
    event: unknown,
    eventScope?: PiModelFailoverEventScope,
  ): Result<boolean, PiModelFailoverEventError> {
    const scopeResult = this.validateEventScope(eventScope);
    if (scopeResult.isErr()) return scopeResult.andThen(() => ok(false));
    const selected = Result.fromThrowable(
      () => eventModel(event),
      (): undefined => undefined,
    )().match(
      (value) => value,
      () => undefined,
    );
    if (selected === undefined) {
      this.latchManualOverride("malformed");
      return err({ type: "ModelSelectMalformed" });
    }
    const expectation = this.expectationValue;
    if (
      this.stateValue !== "switching" ||
      expectation === undefined ||
      expectation.version !== this.operationVersion
    ) {
      this.latchManualOverride("delayed");
      return err({ type: "ModelSelectUnmatched" });
    }
    if (expectation.eventSeen) {
      this.latchManualOverride("duplicate");
      return err({ type: "ModelSelectDuplicate" });
    }
    if (!this.isScopeCurrent(expectation.version)) {
      return err({ type: "EventScopeStale" });
    }
    const expected = modelFromCandidate(expectation.candidate);
    if (
      piCanonicalModelIdentity(expected) !== piCanonicalModelIdentity(selected)
    ) {
      this.latchManualOverride("unmatched");
      return err({ type: "ModelSelectUnmatched" });
    }
    this.expectationValue = {
      ...expectation,
      eventModel: selected,
      eventSeen: true,
    };
    this.completeModelProofIfReady();
    return ok(true);
  }

  handleModelSelect(
    event: unknown,
    eventScope?: PiModelFailoverEventScope,
  ): Result<boolean, PiModelFailoverEventError> {
    return this.onModelSelect(event, eventScope);
  }

  /** Handle exact custom-marker `message_start`; a bare turn never qualifies. */
  onMessageStart(
    event: unknown,
    eventScope?: PiModelFailoverEventScope,
  ): Result<boolean, PiModelFailoverEventError> {
    const scopeResult = this.validateEventScope(eventScope);
    if (scopeResult.isErr()) return scopeResult.andThen(() => ok(false));
    if (this.stateValue !== "awaiting-marker-proof") {
      return err({ type: "MarkerNotExpected" });
    }
    const active = this.markerValue;
    if (active === undefined || active.version !== this.operationVersion) {
      return err({ type: "MarkerNotExpected" });
    }
    if (!this.isScopeCurrent(active.version)) {
      return err({ type: "EventScopeStale" });
    }
    const message = Result.fromThrowable(
      () => eventMessage(event),
      (): undefined => undefined,
    )().match(
      (value) => value,
      () => undefined,
    );
    if (
      message === undefined ||
      !isPiModelFailoverMarker(message, active.token)
    ) {
      return ok(false);
    }

    this.clearMarkerTimer();
    this.setState("awaiting-context-repair");
    this.armContextTimer(active.version);
    return ok(true);
  }

  handleMessageStart(
    event: unknown,
    eventScope?: PiModelFailoverEventScope,
  ): Result<boolean, PiModelFailoverEventError> {
    return this.onMessageStart(event, eventScope);
  }

  /**
   * Repair the provider-only context clone. Inactive calls return the original
   * list untouched; an active call returns exactly Task 1's replacement list.
   */
  onContext(
    messages: readonly unknown[],
    eventScope?: PiModelFailoverEventScope,
  ): Result<
    readonly unknown[],
    PiModelFailoverEventError | PiFailoverContextRepairError
  > {
    const scopeResult = this.validateEventScope(eventScope);
    if (scopeResult.isErr()) return err(scopeResult.error);
    if (this.stateValue !== "awaiting-context-repair") {
      return this.contextClosed
        ? err({ type: "ContextNotExpected" })
        : ok(messages);
    }
    const active = this.markerValue;
    const retained = this.retainedFailureValue;
    if (active !== undefined && !this.isScopeCurrent(active.version)) {
      return err({ type: "EventScopeStale" });
    }
    if (active === undefined || retained?.fingerprint === undefined) {
      this.failClosed("context-repair-failed");
      return err({ type: "ContextNotExpected" });
    }
    const repaired = repairPiFailoverContext({
      messages,
      token: active.token,
      fingerprint: retained.fingerprint,
    });
    if (repaired.isErr()) {
      this.failClosed("context-repair-failed");
      return err(repaired.error);
    }

    this.clearContextTimer();
    this.markerValue = undefined;
    this.setState("recovering");
    const event = this.recoveryEvent("recovery-confirmed");
    if (event !== undefined)
      safeCallback(this.options.onRecoveryConfirmed, event);
    return ok(repaired.value);
  }

  repairContext(
    messages: readonly unknown[],
    eventScope?: PiModelFailoverEventScope,
  ): Result<
    readonly unknown[],
    PiModelFailoverEventError | PiFailoverContextRepairError
  > {
    return this.onContext(messages, eventScope);
  }

  handleContext(
    messages: readonly unknown[],
    eventScope?: PiModelFailoverEventScope,
  ): Result<
    readonly unknown[],
    PiModelFailoverEventError | PiFailoverContextRepairError
  > {
    return this.onContext(messages, eventScope);
  }

  /** Parent/user cancellation has terminal authority; local cancellation fails closed. */
  cancel(
    input: { readonly authority: "authenticated-parent" | "recovery-local" } = {
      authority: "recovery-local",
    },
  ): Result<void, never> {
    if (input.authority === "authenticated-parent") {
      this.finishCancelled();
    } else {
      this.failClosed("cancelled");
    }
    return ok(undefined);
  }

  cancelRecovery(): Result<void, never> {
    return this.cancel({ authority: "recovery-local" });
  }

  /** Invalidate timers and publish the retained failure once, if any. */
  reset(): Result<void, never> {
    this.resetWithReason("reset");
    return ok(undefined);
  }

  reload(): Result<void, never> {
    this.resetWithReason("reload");
    return ok(undefined);
  }

  shutdown(): Result<void, never> {
    this.resetWithReason("shutdown");
    return ok(undefined);
  }

  onReset(): Result<void, never> {
    return this.reset();
  }

  onReload(): Result<void, never> {
    return this.reload();
  }

  onShutdown(): Result<void, never> {
    return this.shutdown();
  }

  private normalizeSettlement(
    input: PiModelFailoverSettlementInput | unknown,
  ): PiModelFailoverSettlementInput | undefined {
    if (input === undefined || input === null) return { status: "success" };
    if (isPiPayloadlessAgentSettledEvent(input)) return { status: "success" };
    if (typeof input !== "object") return undefined;
    const status = (input as { readonly status?: unknown }).status;
    if (status === "success") return { status: "success" };
    if (status === "failure") {
      const failure = (input as { readonly failure?: unknown }).failure;
      return failure === undefined
        ? undefined
        : ({ status: "failure", failure } as PiModelFailoverSettlementInput);
    }
    if (status === "cancelled") {
      return {
        status: "cancelled",
        authenticated:
          (input as { readonly authenticated?: unknown }).authenticated ===
          true,
      };
    }
    return undefined;
  }

  private normalizeFailure(
    input: PiModelFailoverFailureInput,
  ): Result<RetainedFailure, PiModelFailoverEventError> {
    const normalized = Result.fromThrowable(
      () => {
        if (
          input === null ||
          typeof input !== "object" ||
          !isPiFailoverFailureClass(input.failureClass)
        ) {
          return undefined;
        }
        const fingerprint =
          input.fingerprint ?? input.failedAssistantFingerprint;
        let parsedFingerprint: PiAssistantFingerprint | undefined;
        if (fingerprint !== undefined) {
          const parsed = parsePiAssistantFingerprint(fingerprint);
          if (parsed.isErr()) return undefined;
          parsedFingerprint = parsed.value;
        }
        const model = input.failedModel ?? this.currentModelValue;
        return {
          failureClass: input.failureClass,
          ...(model === undefined ? {} : { failedModel: clonedModel(model) }),
          ...(parsedFingerprint === undefined
            ? {}
            : { fingerprint: parsedFingerprint }),
        } satisfies RetainedFailure;
      },
      (): RetainedFailure | undefined => undefined,
    )();
    if (normalized.isErr() || normalized.value === undefined) {
      return err({ type: "EventNotExpected" });
    }
    return ok(normalized.value);
  }

  private beginRecordedFailure(
    input: PiModelFailoverFailureInput | RetainedFailure,
  ): Promise<void> {
    const normalized =
      "failureClass" in input &&
      (input as PiModelFailoverFailureInput).failureClass !== undefined
        ? this.normalizeFailure(input as PiModelFailoverFailureInput)
        : ok(input as RetainedFailure);
    if (normalized.isErr()) {
      this.failClosed("unsupported-failure");
      return Promise.resolve();
    }
    const failure = normalized.value;
    if (this.stateValue === "armed") {
      this.retainedFailureValue = failure;
      this.pendingFailureValue = undefined;
      if (this.cursorValue === undefined) {
        this.cursorValue = createPiCandidateCursor(
          this.scopeValue.candidates,
          failure.failedModel ?? this.scopeValue.currentModel,
        );
      }
    } else if (this.stateValue === "recovering") {
      this.retainedFailureValue = failure;
      this.pendingFailureValue = undefined;
    } else {
      return Promise.resolve();
    }

    const allowance = consumePiFailureAdvance(
      failure.failureClass,
      this.unknownAdvancesUsedValue,
    );
    if (!allowance.advance) {
      this.unknownAdvancesUsedValue = allowance.unknownAdvancesUsed;
      this.failClosed("unknown-failure-not-eligible");
      return Promise.resolve();
    }
    this.unknownAdvancesUsedValue = allowance.unknownAdvancesUsed;
    this.setState("switching");
    const version = this.operationVersion;
    return this.advanceCandidates(version).then(
      () => undefined,
      () => {
        if (version === this.operationVersion)
          this.failClosed("operation-failed");
      },
    );
  }

  private async advanceCandidates(version: number): Promise<void> {
    while (this.stateValue === "switching") {
      if (!this.isScopeCurrent(version)) return;
      const cursor = this.cursorValue;
      if (cursor === undefined) {
        this.enterExhausted();
        return;
      }
      const candidate = cursor.next();
      if (candidate === undefined) {
        this.enterExhausted();
        return;
      }
      const preflight = await this.runPreflight(candidate);
      if (!this.isScopeCurrent(version)) return;
      if (this.stateValue !== "switching") return;
      if (preflight.isErr()) continue;
      if (preflight.value.status === "skip") {
        if (preflight.value.reason === "cancelled") {
          this.failClosed("cancelled");
          return;
        }
        if (
          preflight.value.reason === "stale-generation" ||
          preflight.value.reason === "stale-session"
        ) {
          this.failClosed("stale-scope");
          return;
        }
        continue;
      }
      if (this.retainedFailureValue?.fingerprint === undefined) {
        this.failClosed("context-repair-failed");
        return;
      }
      this.armModelExpectation(candidate, version);
      await this.applyCandidate(candidate, version);
      return;
    }
  }

  private runPreflight(
    candidate: PiFailoverCandidate | PiModelInfo,
  ): ResultAsyncType<
    PiFailoverPreflightOutcome,
    PiFailoverPreflightError | PiCandidatePreflightError
  > {
    const context = this.readContext();
    const currentGenerationId = safeScopeField(
      this.options.getGenerationId,
      this.scopeValue.generationId,
    );
    const currentSessionId = safeScopeField(
      this.options.getNativeSessionId,
      this.scopeValue.nativeSessionId,
    );
    if (
      context === undefined ||
      currentGenerationId === undefined ||
      currentSessionId === undefined
    ) {
      return errAsync({ type: "SessionProbeFailed" });
    }
    const runtimeInput: PiFailoverRuntimePreflightInput = {
      candidate: candidate as PiFailoverCandidate | PiModelInfo,
      failedModel: this.retainedFailureValue?.failedModel,
      failureClass:
        this.retainedFailureValue?.failureClass ?? "unknown_provider_failure",
      expectedGenerationId: this.scopeValue.generationId,
      currentGenerationId,
      expectedSessionId: this.scopeValue.nativeSessionId,
      currentSessionId,
      session: context,
      ...(this.options.isCancelled === undefined
        ? {}
        : { isCancelled: this.options.isCancelled }),
      ...(this.options.isAuthenticated === undefined
        ? {}
        : { isAuthenticated: this.options.isAuthenticated }),
    };

    const configuredPreflight = this.options.preflight;
    if (
      configuredPreflight !== undefined &&
      !isRichPreflightPort(configuredPreflight)
    ) {
      const invoked = ResultAsync.fromPromise(
        (async () =>
          await configuredPreflight.preflight(asLegacyCandidate(candidate)))(),
        (): PiCandidatePreflightError => ({ type: "CandidatePreflightFailed" }),
      );
      return invoked.andThen((result) =>
        result.isOk()
          ? ok(mapPiCandidatePreflightOutcome(result.value))
          : err<PiFailoverPreflightOutcome, PiCandidatePreflightError>({
              type: "CandidatePreflightFailed",
            }),
      );
    }
    const invoked = ResultAsync.fromPromise(
      (async () => await this.preflight.preflight(runtimeInput))(),
      (): PiFailoverPreflightError => ({ type: "SessionProbeFailed" }),
    );
    return invoked.andThen((result) => result);
  }

  private readContext(): PiFailoverPreflightSession | undefined {
    if (this.options.context === undefined) return undefined;
    return Result.fromThrowable(
      () =>
        typeof this.options.context === "function"
          ? this.options.context()
          : this.options.context,
      (): undefined => undefined,
    )().match(
      (value) => value,
      () => undefined,
    );
  }

  private armModelExpectation(
    candidate: PiFailoverCandidate | PiModelInfo,
    version: number,
  ): void {
    this.clearSwitchTimer();
    this.expectationValue = {
      version,
      candidate,
      eventSeen: false,
      resultSeen: false,
    };
    this.switchTimeoutPromise = new Promise((resolve) => {
      this.switchTimeoutResolve = resolve;
    });
    this.switchTimer = this.timer.schedule(() => {
      if (version !== this.operationVersion) return;
      if (this.stateValue !== "switching") return;
      this.switchTimeoutResolve?.("timed-out");
      this.failClosed("switch-timeout");
    }, this.options.switchTimeoutMs ?? DEFAULT_PI_FAILOVER_SWITCH_TIMEOUT_MS);
  }

  private async applyCandidate(
    candidate: PiFailoverCandidate | PiModelInfo,
    version: number,
  ): Promise<void> {
    const expected = this.expectationValue;
    if (expected === undefined || expected.version !== version) return;
    const call = ResultAsync.fromThrowable(
      async () =>
        await this.options.host.setModel(modelFromCandidate(candidate)),
      (): "set-model-failed" => "set-model-failed",
    )();
    type SetModelResult = Result<boolean | undefined, "set-model-failed">;
    const timeoutPromise =
      this.switchTimeoutPromise ??
      new Promise<"timed-out">(() => {
        // The expectation always installs a timeout. This fallback only keeps
        // the type total if a hostile callback clears it during the call.
      });
    const resultOrTimeout: SetModelResult | "timed-out" = await Promise.race([
      Promise.resolve(call) as PromiseLike<SetModelResult>,
      timeoutPromise,
    ]);
    if (resultOrTimeout === "timed-out") return;
    const result: SetModelResult = resultOrTimeout;
    this.switchTimeoutPromise = undefined;
    this.switchTimeoutResolve = undefined;
    if (!this.isScopeCurrent(version)) return;
    if (this.stateValue !== "switching" || this.expectationValue === undefined)
      return;
    if (result.isErr()) {
      this.failClosed("switch-call-failed");
      return;
    }
    if (result.value === false) {
      if (this.expectationValue.eventSeen) {
        this.latchManualOverride("ambiguous");
        return;
      }
      this.clearSwitchTimer();
      this.expectationValue = undefined;
      await this.advanceCandidates(version);
      return;
    }
    if (result.value !== true) {
      this.failClosed("switch-indeterminate");
      return;
    }
    this.expectationValue = {
      ...this.expectationValue,
      resultSeen: true,
    };
    this.completeModelProofIfReady();
  }

  private completeModelProofIfReady(): void {
    const expectation = this.expectationValue;
    if (
      expectation === undefined ||
      !expectation.eventSeen ||
      !expectation.resultSeen ||
      this.stateValue !== "switching"
    ) {
      return;
    }
    const version = expectation.version;
    if (!this.isScopeCurrent(version)) return;
    const model = modelFromCandidate(expectation.candidate);
    this.clearSwitchTimer();
    this.expectationValue = undefined;
    this.currentModelValue = clonedModel(model);
    this.setState("awaiting-marker-proof");

    const applied = this.appliedEvent("applied");
    if (applied?.phase === "applied")
      safeCallback(this.options.onAppliedModel, applied);

    // A model can apply while the public session changes underneath the
    // proof. Report that applied truth, but never claim recovery until the
    // public preconditions still hold.
    if (!this.postProofPreconditionsHold(version)) return;

    const retained = this.retainedFailureValue;
    if (retained?.fingerprint === undefined) {
      this.failClosed("context-repair-failed");
      return;
    }
    const marker = createPiModelFailoverMarker();
    if (marker.isErr()) {
      this.failClosed("marker-send-failed");
      return;
    }
    this.markerValue = {
      version,
      token: marker.value.details.token,
      candidate: expectation.candidate,
      fingerprint: retained.fingerprint,
    };

    // `sendMessage` is intentionally fire-and-forget. Only invocation-time
    // throws affect the coordinator. A rejecting thenable is observed solely
    // to avoid an unhandled rejection and never acts as an acknowledgement.
    const sent = Result.fromThrowable(
      () =>
        this.options.host.sendMessage(marker.value, {
          triggerTurn: true,
        }),
      (): "send-message-failed" => "send-message-failed",
    )();
    if (sent.isErr()) {
      this.failClosed("marker-send-failed");
      return;
    }
    const returnsThenable = Result.fromThrowable(
      () =>
        sent.value !== undefined &&
        typeof (sent.value as { readonly then?: unknown }).then === "function",
      (): boolean => false,
    )().match(
      (value) => value,
      () => false,
    );
    if (returnsThenable) {
      void Promise.resolve(sent.value).catch(() => undefined);
    }
    if ((this.stateValue as PiModelFailoverState) === "awaiting-marker-proof") {
      this.armMarkerTimer(version);
    }
  }

  private postProofPreconditionsHold(version: number): boolean {
    if (!this.isScopeCurrent(version)) return false;

    const cancelled = Result.fromThrowable(
      () => this.options.isCancelled?.() === true,
      (): boolean => true,
    )();
    if (cancelled.isErr() || cancelled.value) {
      this.failClosed("cancelled");
      return false;
    }

    const context = this.readContext();
    if (context === undefined) {
      this.failClosed("operation-failed");
      return false;
    }
    const idle = Result.fromThrowable(
      () => context.isIdle(),
      (): boolean => false,
    )();
    if (idle.isErr() || idle.value !== true) {
      this.failClosed("operation-failed");
      return false;
    }
    const pending = Result.fromThrowable(
      () => {
        const probe = context.hasPendingMessages;
        return typeof probe === "function" ? probe.call(context) : undefined;
      },
      (): boolean | undefined => undefined,
    )();
    if (pending.isErr() || pending.value !== false) {
      this.failClosed("operation-failed");
      return false;
    }
    return true;
  }

  private armMarkerTimer(version: number): void {
    this.clearMarkerTimer();
    this.markerTimer = this.timer.schedule(() => {
      if (version !== this.operationVersion) return;
      if (this.stateValue !== "awaiting-marker-proof") return;
      this.failClosed("marker-timeout");
    }, this.options.markerTimeoutMs ?? DEFAULT_PI_FAILOVER_MARKER_TIMEOUT_MS);
  }

  private armContextTimer(version: number): void {
    this.clearContextTimer();
    this.contextTimer = this.timer.schedule(() => {
      if (version !== this.operationVersion) return;
      if (this.stateValue !== "awaiting-context-repair") return;
      this.failClosed("context-timeout");
    }, this.options.contextTimeoutMs ?? DEFAULT_PI_FAILOVER_CONTEXT_TIMEOUT_MS);
  }

  private clearSwitchTimer(): void {
    this.switchTimer?.cancel();
    this.switchTimer = undefined;
    this.switchTimeoutResolve?.("timed-out");
    this.switchTimeoutResolve = undefined;
    this.switchTimeoutPromise = undefined;
  }

  private clearMarkerTimer(): void {
    this.markerTimer?.cancel();
    this.markerTimer = undefined;
  }

  private clearContextTimer(): void {
    this.contextTimer?.cancel();
    this.contextTimer = undefined;
  }

  private clearTimers(): void {
    this.clearSwitchTimer();
    this.clearMarkerTimer();
    this.clearContextTimer();
  }

  private appliedEvent(
    phase: "applied" | "recovery-confirmed",
  ):
    | PiModelFailoverAppliedEvent
    | PiModelFailoverRecoveryConfirmedEvent
    | undefined {
    const failure = this.retainedFailureValue;
    const model = publicModel(this.currentModelValue);
    if (failure === undefined || model === undefined) return undefined;
    const index = this.cursorValue?.position ?? 0;
    const fromModel = publicModel(failure.failedModel);
    return phase === "applied"
      ? {
          phase,
          model,
          ...(fromModel === undefined ? {} : { fromModel }),
          failureClass: failure.failureClass,
          candidateIndex: Math.max(0, index - 1),
        }
      : {
          phase,
          model,
          ...(fromModel === undefined ? {} : { fromModel }),
          failureClass: failure.failureClass,
          candidateIndex: Math.max(0, index - 1),
        };
  }

  private recoveryEvent(
    phase: "recovery-confirmed",
  ): PiModelFailoverRecoveryConfirmedEvent | undefined {
    const event = this.appliedEvent(phase);
    return event?.phase === "recovery-confirmed" ? event : undefined;
  }

  private finishSuccess(): void {
    if (this.decisionPublished) return;
    this.clearTimers();
    this.expectationValue = undefined;
    this.markerValue = undefined;
    this.setState("terminal");
    this.publishDecision({
      kind: "success",
      status: "success",
      appliedModel: publicModel(this.currentModelValue),
      generationId: this.scopeValue.generationId,
      nativeSessionId: this.scopeValue.nativeSessionId,
      activationId: this.scopeValue.activationId,
    });
  }

  private finishCancelled(): void {
    if (this.decisionPublished) return;
    this.clearTimers();
    this.expectationValue = undefined;
    this.markerValue = undefined;
    this.setState("terminal");
    this.publishDecision({
      kind: "cancelled",
      status: "cancelled",
      authority: "authenticated-parent",
      failureClass: this.retainedFailureValue?.failureClass,
      appliedModel: publicModel(this.currentModelValue),
      generationId: this.scopeValue.generationId,
      nativeSessionId: this.scopeValue.nativeSessionId,
      activationId: this.scopeValue.activationId,
    });
  }

  private enterExhausted(): void {
    if (this.decisionPublished) return;
    this.clearTimers();
    this.expectationValue = undefined;
    this.markerValue = undefined;
    this.setState("exhausted");
    this.publishDecision({
      kind: "exhausted",
      status: "exhausted",
      failureClass: this.retainedFailureValue?.failureClass,
      cursorPosition:
        this.cursorValue?.position ?? this.scopeValue.candidates.length,
      appliedModel: publicModel(this.currentModelValue),
      generationId: this.scopeValue.generationId,
      nativeSessionId: this.scopeValue.nativeSessionId,
      activationId: this.scopeValue.activationId,
    });
  }

  private failClosed(reason: PiModelFailoverTerminalReason): void {
    if (this.decisionPublished && this.stateValue === "terminal") return;
    if (
      reason === "marker-timeout" ||
      reason === "context-timeout" ||
      reason === "context-repair-failed" ||
      reason === "marker-send-failed"
    ) {
      this.contextClosed = true;
    }
    this.clearTimers();
    this.expectationValue = undefined;
    this.markerValue = undefined;
    if (this.stateValue !== "manually-overridden") this.setState("terminal");
    this.publishDecision({
      kind: "failed",
      status: "failed",
      reason,
      failureClass: this.retainedFailureValue?.failureClass,
      appliedModel: publicModel(this.currentModelValue),
      generationId: this.scopeValue.generationId,
      nativeSessionId: this.scopeValue.nativeSessionId,
      activationId: this.scopeValue.activationId,
    });
  }

  private publishDecision(decision: PiModelFailoverTerminalDecision): void {
    if (this.decisionPublished) return;
    this.decisionPublished = true;
    const frozenDecision = Object.freeze(decision);
    this.decisionValue = frozenDecision;
    safeCallback(this.options.onDecision, frozenDecision);
    safeCallback(this.options.onTerminal, frozenDecision);
  }

  private latchManualOverride(
    _reason: "malformed" | "delayed" | "duplicate" | "unmatched" | "ambiguous",
  ): void {
    this.manualOverrideLatchedValue = true;
    this.clearTimers();
    this.expectationValue = undefined;
    this.markerValue = undefined;
    if (this.stateValue !== "manually-overridden") {
      this.setState("manually-overridden");
    }
    if (!this.decisionPublished && this.retainedFailureValue !== undefined) {
      this.publishDecision({
        kind: "failed",
        status: "failed",
        reason: "manual-override",
        failureClass: this.retainedFailureValue.failureClass,
        appliedModel: publicModel(this.currentModelValue),
        generationId: this.scopeValue.generationId,
        nativeSessionId: this.scopeValue.nativeSessionId,
        activationId: this.scopeValue.activationId,
      });
    }
  }

  private setState(next: PiModelFailoverState): void {
    if (this.stateValue === next) return;
    const transition = transitionPiModelFailoverState(this.stateValue, next);
    if (transition.isErr()) {
      // A state-table violation is an internal fail-closed condition. Keep the
      // manual latch if one already exists; otherwise terminate exactly once.
      if (this.stateValue !== "terminal" && this.stateValue !== "exhausted") {
        this.stateValue = "terminal";
        safeCallback(this.options.onStateChange, {
          from: transition.error.from,
          to: "terminal",
        });
      }
      return;
    }
    const previous = this.stateValue;
    this.stateValue = transition.value;
    safeCallback(this.options.onStateChange, { from: previous, to: next });
  }

  private forceState(next: PiModelFailoverState): void {
    const previous = this.stateValue;
    this.stateValue = next;
    if (previous !== next)
      safeCallback(this.options.onStateChange, { from: previous, to: next });
  }

  private validateFailureInputScope(
    input: PiModelFailoverFailureInput,
  ): Result<void, PiModelFailoverEventError> {
    const scope = Result.fromThrowable(
      () => ({
        generationId: input.generationId,
        nativeSessionId: input.nativeSessionId,
        activationId: input.activationId,
      }),
      (): PiModelFailoverEventError => ({ type: "EventNotExpected" }),
    )();
    return scope.andThen((eventScope) => this.validateEventScope(eventScope));
  }

  private validateEventScope(
    eventScope: PiModelFailoverEventScope | undefined,
  ): Result<void, PiModelFailoverEventError> {
    if (eventScope === undefined) return ok(undefined);
    if (
      (eventScope.generationId !== undefined &&
        eventScope.generationId !== this.scopeValue.generationId) ||
      (eventScope.nativeSessionId !== undefined &&
        eventScope.nativeSessionId !== this.scopeValue.nativeSessionId) ||
      (eventScope.activationId !== undefined &&
        eventScope.activationId !== this.scopeValue.activationId)
    ) {
      return err({ type: "EventScopeStale" });
    }
    return ok(undefined);
  }

  private isScopeCurrent(version: number): boolean {
    if (version !== this.operationVersion) return false;
    const generation = safeScopeField(
      this.options.getGenerationId,
      this.scopeValue.generationId,
    );
    const session = safeScopeField(
      this.options.getNativeSessionId,
      this.scopeValue.nativeSessionId,
    );
    if (
      generation === undefined ||
      session === undefined ||
      generation !== this.scopeValue.generationId ||
      session !== this.scopeValue.nativeSessionId ||
      this.generationAuthorityCurrent() === false ||
      this.sessionAuthorityCurrent() === false
    ) {
      if (version === this.operationVersion) this.failClosed("stale-scope");
      return false;
    }
    return true;
  }

  private generationAuthorityCurrent(): boolean {
    if (this.options.isGenerationCurrent === undefined) return true;
    return Result.fromThrowable(
      () =>
        this.options.isGenerationCurrent?.(this.scopeValue.generationId) ===
        true,
      (): boolean => false,
    )().match(
      (value) => value,
      () => false,
    );
  }

  private sessionAuthorityCurrent(): boolean {
    if (this.options.isSessionCurrent === undefined) return true;
    return Result.fromThrowable(
      () =>
        this.options.isSessionCurrent?.(this.scopeValue.nativeSessionId) ===
        true,
      (): boolean => false,
    )().match(
      (value) => value,
      () => false,
    );
  }

  private invalidateEpoch(): void {
    this.operationVersion += 1;
    this.clearTimers();
    this.expectationValue = undefined;
    this.markerValue = undefined;
  }

  private resetWithReason(reason: "reset" | "reload" | "shutdown"): void {
    if (!this.decisionPublished && this.retainedFailureValue !== undefined) {
      this.failClosed(reason);
    }
    this.invalidateEpoch();
    if (!this.decisionPublished && this.stateValue === "armed") {
      this.forceState("terminal");
    }
  }
}

/** Factory form for adapters that prefer dependency construction. */
export function createPiModelFailoverCoordinator(
  options: PiModelFailoverCoordinatorOptions,
): PiModelFailoverCoordinator {
  return new PiModelFailoverCoordinator(options);
}

export const createPiFailoverCoordinator = createPiModelFailoverCoordinator;
export const ModelFailoverCoordinator = PiModelFailoverCoordinator;

function isRichPreflightPort(
  value:
    | PiModelFailoverPreflightPort
    | {
        readonly preflight: (
          candidate: PiFailoverCandidate,
        ) => ResultAsyncType<
          PiCandidatePreflightOutcome,
          PiCandidatePreflightError
        >;
      },
): value is PiModelFailoverPreflightPort {
  return "check" in value && typeof value.check === "function";
}
