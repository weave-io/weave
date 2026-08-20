import {
  err,
  errAsync,
  ok,
  okAsync,
  Result,
  type ResultAsync as ResultAsyncType,
} from "neverthrow";
import {
  isPiCandidateContextEligible,
  isPiFailoverFailureClass,
  type PiCandidatePreflightError,
  type PiCandidatePreflightOutcome,
  type PiFailoverCandidate,
  type PiFailoverFailureClass,
  piCanonicalModelIdentity,
} from "./model-failover-contract.js";
import type { PiModelInfo } from "./model-resolution.js";

/** Maximum number of catalog entries inspected by one preflight. */
export const MAX_PI_FAILOVER_PREFLIGHT_CATALOG = 256;

/** Typed reasons that skip only the current candidate. */
export type PiFailoverPreflightSkipReason =
  | "not-idle"
  | "pending-input"
  | "pending-input-unknown"
  | "stale-generation"
  | "stale-session"
  | "cancelled"
  | "candidate-not-in-catalog"
  | "candidate-catalog-ambiguous"
  | "provider-credentials-unavailable"
  | "context-window-ineligible"
  | "catalog-unavailable"
  | "auth-probe-unavailable";

/** A candidate-local preflight result. It contains no host error text. */
export type PiFailoverPreflightOutcome =
  | { readonly status: "eligible" }
  | {
      readonly status: "skip";
      readonly reason: PiFailoverPreflightSkipReason;
    };

/** Preflight failures are bounded and safe to expose to a coordinator. */
export type PiFailoverPreflightError =
  | { readonly type: "CatalogReadFailed" }
  | { readonly type: "AuthProbeFailed" }
  | { readonly type: "SessionProbeFailed" }
  | { readonly type: "InvalidPreflightInput" };

/**
 * The minimum public session surface needed by failover preflight.
 *
 * `hasPendingMessages` is optional in the adapter port because old test and
 * host contexts may not expose it. The default policy fails closed by skipping
 * the candidate when the pending-input fact cannot be established.
 */
export interface PiFailoverPreflightSession {
  readonly isIdle: () => boolean;
  readonly hasPendingMessages?: () => boolean;
  readonly modelRegistry: {
    readonly getAvailable: () => readonly PiModelInfo[];
  };
}

/** Pure, already-observed facts consumed by the state machine. */
export interface PiFailoverPreflightInput {
  readonly candidate: PiFailoverCandidate | PiModelInfo;
  readonly failedModel: PiModelInfo | undefined;
  readonly failureClass: PiFailoverFailureClass;
  readonly expectedGenerationId: string;
  readonly currentGenerationId: string;
  readonly expectedSessionId: string;
  readonly currentSessionId: string;
  readonly idle: boolean;
  readonly pendingInput: boolean | undefined;
  readonly cancelled: boolean;
  readonly availableModels: readonly PiModelInfo[];
  /** Authenticated catalog entries are normally already auth-proved by Pi. */
  readonly authAvailable?: boolean;
}

/** Runtime host facts used by the safe preflight adapter. */
export interface PiFailoverRuntimePreflightInput
  extends Omit<
    PiFailoverPreflightInput,
    "idle" | "pendingInput" | "cancelled" | "availableModels" | "authAvailable"
  > {
  readonly session: PiFailoverPreflightSession;
  readonly isCancelled?: () => boolean;
  /** Optional public auth-availability probe. It must return only a boolean. */
  readonly isAuthenticated?: (model: PiModelInfo) => boolean;
}

/** Input accepted by a reusable preflight port. */
export interface PiModelFailoverPreflightRequest
  extends PiFailoverRuntimePreflightInput {}

function candidateModel(
  candidate: PiFailoverCandidate | PiModelInfo,
): PiModelInfo | undefined {
  if (candidate === null || typeof candidate !== "object") return undefined;
  if (
    "resolved" in candidate &&
    candidate.resolved === true &&
    "model" in candidate
  ) {
    return candidate.model;
  }
  return candidate as PiModelInfo;
}

function validIdentity(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256;
}

function safeBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

/**
 * Check all synchronous, candidate-local eligibility facts.
 *
 * The function deliberately reports catalog/auth/host gaps as skips instead of
 * turning them into a terminal model-truth error. The coordinator reserves
 * terminal recovery errors for an ambiguous `setModel` call.
 */
function checkPiFailoverPreflightUnsafe(
  input: PiFailoverPreflightInput,
): Result<PiFailoverPreflightOutcome, PiFailoverPreflightError> {
  const candidate = candidateModel(input.candidate);
  if (
    candidate === undefined ||
    !validIdentity(candidate.provider) ||
    !validIdentity(candidate.id) ||
    !isPiFailoverFailureClass(input.failureClass) ||
    (input.authAvailable !== undefined &&
      typeof input.authAvailable !== "boolean") ||
    !validIdentity(input.expectedGenerationId) ||
    !validIdentity(input.currentGenerationId) ||
    !validIdentity(input.expectedSessionId) ||
    !validIdentity(input.currentSessionId)
  ) {
    return err({ type: "InvalidPreflightInput" });
  }

  if (input.cancelled) return ok({ status: "skip", reason: "cancelled" });
  if (input.expectedGenerationId !== input.currentGenerationId) {
    return ok({ status: "skip", reason: "stale-generation" });
  }
  if (input.expectedSessionId !== input.currentSessionId) {
    return ok({ status: "skip", reason: "stale-session" });
  }
  if (!input.idle) return ok({ status: "skip", reason: "not-idle" });
  if (input.pendingInput !== false) {
    return ok({
      status: "skip",
      reason:
        input.pendingInput === undefined
          ? "pending-input-unknown"
          : "pending-input",
    });
  }

  if (!Array.isArray(input.availableModels)) {
    return err({ type: "InvalidPreflightInput" });
  }
  if (input.availableModels.length > MAX_PI_FAILOVER_PREFLIGHT_CATALOG) {
    return ok({ status: "skip", reason: "catalog-unavailable" });
  }

  const identity = piCanonicalModelIdentity(candidate);
  const matches = input.availableModels.filter(
    (model) =>
      validIdentity(model.provider) &&
      validIdentity(model.id) &&
      piCanonicalModelIdentity(model) === identity,
  );
  if (matches.length === 0) {
    return ok({ status: "skip", reason: "candidate-not-in-catalog" });
  }
  if (matches.length !== 1) {
    return ok({ status: "skip", reason: "candidate-catalog-ambiguous" });
  }

  if (input.authAvailable === false) {
    return ok({
      status: "skip",
      reason: "provider-credentials-unavailable",
    });
  }
  if (
    !isPiCandidateContextEligible(
      candidate,
      input.failedModel,
      input.failureClass,
    )
  ) {
    return ok({ status: "skip", reason: "context-window-ineligible" });
  }

  return ok({ status: "eligible" });
}

/**
 * Check preflight facts without allowing hostile host objects to escape as an
 * exception. A malformed descriptor is a typed preflight failure.
 */
export function checkPiFailoverPreflight(
  input: PiFailoverPreflightInput,
): Result<PiFailoverPreflightOutcome, PiFailoverPreflightError> {
  const checked = Result.fromThrowable(
    () => checkPiFailoverPreflightUnsafe(input),
    (): PiFailoverPreflightError => ({ type: "InvalidPreflightInput" }),
  )();
  return checked.andThen((outcome) => outcome);
}

/** Compatibility spelling for callers that use the model prefix. */
export const checkPiModelFailoverPreflight = checkPiFailoverPreflight;
export const evaluatePiFailoverPreflight = checkPiFailoverPreflight;

function mapContractError(
  error: PiFailoverPreflightError,
): PiCandidatePreflightError {
  switch (error.type) {
    case "CatalogReadFailed":
      return { type: "CandidatePreflightFailed" };
    case "AuthProbeFailed":
      return { type: "ProviderCredentialsUnavailable" };
    case "SessionProbeFailed":
      return { type: "PreflightHostSurfaceUnavailable" };
    case "InvalidPreflightInput":
      return { type: "CandidatePreflightFailed" };
  }
}

function candidateRequestFromContract(
  input: PiModelFailoverPreflightRequest,
): PiFailoverPreflightInput | undefined {
  const idle = Result.fromThrowable(
    () => input.session.isIdle(),
    (): undefined => undefined,
  )();
  const pendingProbe = Result.fromThrowable(
    () => input.session.hasPendingMessages,
    (): undefined => undefined,
  )();
  const pending = Result.fromThrowable(
    () => {
      const probe = pendingProbe.isOk() ? pendingProbe.value : undefined;
      return typeof probe === "function"
        ? probe.call(input.session)
        : undefined;
    },
    (): undefined => undefined,
  )();
  const catalog = Result.fromThrowable(
    () => input.session.modelRegistry.getAvailable(),
    (): undefined => undefined,
  )();
  if (
    idle.isErr() ||
    pendingProbe.isErr() ||
    pending.isErr() ||
    catalog.isErr()
  )
    return undefined;

  let authAvailable: boolean | undefined;
  if (input.isAuthenticated !== undefined) {
    const model = candidateModel(input.candidate);
    if (model === undefined) return undefined;
    const auth = Result.fromThrowable(
      () => input.isAuthenticated?.(model),
      (): undefined => undefined,
    )();
    if (auth.isErr() || typeof auth.value !== "boolean") return undefined;
    authAvailable = auth.value;
  }

  return {
    candidate: input.candidate,
    failedModel: input.failedModel,
    failureClass: input.failureClass,
    expectedGenerationId: input.expectedGenerationId,
    currentGenerationId: input.currentGenerationId,
    expectedSessionId: input.expectedSessionId,
    currentSessionId: input.currentSessionId,
    idle: idle.value === true,
    pendingInput:
      typeof pendingProbe.value === "function"
        ? safeBoolean(pending.value)
        : undefined,
    cancelled: Result.fromThrowable(
      () => input.isCancelled?.() === true,
      (): boolean => true,
    )().match(
      (value) => value,
      () => true,
    ),
    availableModels: catalog.value,
    ...(authAvailable === undefined ? {} : { authAvailable }),
  };
}

/**
 * Run the host-facing preflight while converting every host throw into a
 * credential-free typed result.
 */
export function preflightPiFailoverCandidate(
  input: PiModelFailoverPreflightRequest,
): ResultAsyncType<PiFailoverPreflightOutcome, PiFailoverPreflightError> {
  const request = Result.fromThrowable(
    () => candidateRequestFromContract(input),
    (): PiFailoverPreflightError => ({ type: "SessionProbeFailed" }),
  )();
  if (request.isErr() || request.value === undefined) {
    return errAsync(
      request.isErr() ? request.error : { type: "SessionProbeFailed" },
    );
  }
  return okAsync(checkPiFailoverPreflight(request.value)).andThen((result) =>
    result.isOk() ? okAsync(result.value) : errAsync(result.error),
  );
}

export const preflightPiModelFailoverCandidate = preflightPiFailoverCandidate;
export const runPiFailoverPreflight = preflightPiFailoverCandidate;

/** Reusable port implemented by the coordinator's default preflight. */
export interface PiModelFailoverPreflightPort {
  preflight(
    input: PiModelFailoverPreflightRequest,
  ): ResultAsyncType<PiFailoverPreflightOutcome, PiFailoverPreflightError>;
  check(
    input: PiFailoverPreflightInput,
  ): Result<PiFailoverPreflightOutcome, PiFailoverPreflightError>;
}

/** Construct a bounded public-surface preflight port. */
export function createPiModelFailoverPreflight(): PiModelFailoverPreflightPort {
  return {
    preflight: preflightPiFailoverCandidate,
    check: checkPiFailoverPreflight,
  };
}

export const createPiFailoverPreflight = createPiModelFailoverPreflight;
export const DefaultPiModelFailoverPreflight = createPiModelFailoverPreflight;

/**
 * Map the Task 1 candidate preflight vocabulary into this module's richer
 * reasons. This is useful while adapters migrate from the pure contract port.
 */
export function mapPiCandidatePreflightOutcome(
  outcome: PiCandidatePreflightOutcome,
): PiFailoverPreflightOutcome {
  if (outcome.status === "eligible") return outcome;
  let reason: PiFailoverPreflightSkipReason;
  if (outcome.reason === "not-in-authenticated-catalog") {
    reason = "candidate-not-in-catalog";
  } else if (outcome.reason === "provider-credentials-unavailable") {
    reason = "provider-credentials-unavailable";
  } else if (outcome.reason === "host-surface-unavailable") {
    reason = "auth-probe-unavailable";
  } else {
    reason = "catalog-unavailable";
  }
  return { status: "skip", reason };
}

/** Convert a richer skip into the original Task 1 typed vocabulary. */
export function mapPiFailoverPreflightError(
  error: PiFailoverPreflightError,
): PiCandidatePreflightError {
  return mapContractError(error);
}

export const asPiCandidatePreflightError = mapPiFailoverPreflightError;

/** A no-throw helper for callers that only need candidate eligibility. */
export function isPiFailoverCandidatePreflightEligible(
  input: PiFailoverPreflightInput,
): boolean {
  return checkPiFailoverPreflight(input).match(
    (outcome) => outcome.status === "eligible",
    () => false,
  );
}

/** Result alias kept explicit for generated declaration consumers. */
export type PiFailoverPreflightResult = Result<
  PiFailoverPreflightOutcome,
  PiFailoverPreflightError
>;
