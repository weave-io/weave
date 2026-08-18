import { Result, type ResultAsync } from "neverthrow";
import type {
  PiModelInfo,
  PiModelInfoWithContextWindow,
  PiOrderedModelResolution,
} from "./model-resolution.js";

/** The complete, closed set of provider failures the failover coordinator may observe. */
export const PI_FAILOVER_FAILURE_CLASSES = Object.freeze([
  "authentication_failed",
  "authorization_failed",
  "rate_limited",
  "provider_unavailable",
  "timeout",
  "context_overflow_unrecovered",
  "unknown_provider_failure",
] as const);

export type PiFailoverFailureClass =
  (typeof PI_FAILOVER_FAILURE_CLASSES)[number];

/**
 * The classifier never returns provider text. It returns only this closed
 * class and a small, saturated count captured from the hook payload.
 */
export interface PiFailureClassification {
  readonly failureClass: PiFailoverFailureClass;
  readonly observedAttemptCount: number;
}

/** Maximum provider-message bytes inspected by the classifier. */
export const MAX_PI_ERROR_MESSAGE_PREFIX_LENGTH = 256;

/** Maximum retry count exposed by the classifier. */
export const MAX_PI_OBSERVED_ATTEMPT_COUNT = 32;

/** The bounded portion of the Task 1 hook payload used by this module. */
export interface PiRecoveryExhaustedFailureInput {
  readonly message: unknown;
  readonly nativeRetryAttempts?: unknown;
  readonly overflowRecoveryAttempted?: unknown;
}

/** Optional bounded metadata for direct message classification. */
export interface PiFailureClassificationOptions {
  readonly nativeRetryAttempts?: unknown;
  readonly overflowRecoveryAttempted?: unknown;
}

type ReadState = "missing" | "data" | "accessor" | "unreadable";

interface OwnDataRead {
  readonly state: ReadState;
  readonly value?: unknown;
}

const getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const hasOwnPropertyFn = Object.prototype.hasOwnProperty;
const stringSlice = String.prototype.slice;
const stringToLowerCase = String.prototype.toLowerCase;

/** Read exactly one own enumerable data property without invoking accessors. */
function readOwnEnumerableData(target: unknown, key: PropertyKey): OwnDataRead {
  if (
    target === null ||
    (typeof target !== "object" && typeof target !== "function")
  ) {
    return { state: "missing" };
  }

  return Result.fromThrowable(
    () => getOwnPropertyDescriptor(target, key),
    (): ReadState => "unreadable",
  )().match(
    (descriptor) => {
      if (descriptor === undefined || descriptor.enumerable !== true) {
        return { state: "missing" };
      }
      if (!hasOwnPropertyFn.call(descriptor, "value")) {
        return { state: "accessor" };
      }
      return { state: "data", value: descriptor.value };
    },
    (state) => ({ state }),
  );
}

function boundedAttemptCount(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    return 0;
  }
  return Math.min(value, MAX_PI_OBSERVED_ATTEMPT_COUNT);
}

function ownNumericStatus(message: unknown): number | undefined {
  for (const key of [
    "statusCode",
    "httpStatus",
    "status",
    "responseStatus",
  ] as const) {
    const value = readOwnEnumerableData(message, key);
    if (
      value.state === "data" &&
      typeof value.value === "number" &&
      Number.isSafeInteger(value.value) &&
      value.value >= 100 &&
      value.value <= 599
    ) {
      return value.value;
    }
  }
  return undefined;
}

function boundedTextPrefix(
  value: unknown,
):
  | { readonly state: "usable"; readonly text: string }
  | { readonly state: "absent" | "hostile" } {
  if (typeof value !== "string") return { state: "absent" };

  // Reject rather than classify an oversized value. This keeps a marker just
  // beyond the inspected boundary from changing the class and makes the
  // bounded contract fail closed. Only the fixed prefix is copied.
  const prefix = stringSlice.call(value, 0, MAX_PI_ERROR_MESSAGE_PREFIX_LENGTH);
  if (value.length > MAX_PI_ERROR_MESSAGE_PREFIX_LENGTH) {
    return { state: "hostile" };
  }
  return {
    state: "usable",
    text: stringToLowerCase.call(prefix),
  };
}

function classifyText(text: string): PiFailoverFailureClass {
  if (
    /(?:^|\b)(?:401)(?:\b|\s|:)/u.test(text) ||
    /\bunauthori[sz]ed\b/u.test(text) ||
    /\bauthentication(?:\s+failed|\s+error)?\b/u.test(text) ||
    /\binvalid\s+(?:api|access)\s+key\b/u.test(text)
  ) {
    return "authentication_failed";
  }

  if (
    /(?:^|\b)(?:403)(?:\b|\s|:)/u.test(text) ||
    /\bforbidden\b/u.test(text) ||
    /\bpermission\s+denied\b/u.test(text) ||
    /\baccess\s+denied\b/u.test(text) ||
    /\bnot\s+authorized\b/u.test(text) ||
    /\bauthorization\s+failed\b/u.test(text)
  ) {
    return "authorization_failed";
  }

  if (
    /(?:^|\b)(?:429)(?:\b|\s|:)/u.test(text) ||
    /\brate[\s_-]*limit(?:ed|ing)?\b/u.test(text) ||
    /\btoo\s+many\s+requests\b/u.test(text) ||
    /\bthrottl(?:ed|e|ing)\b/u.test(text)
  ) {
    return "rate_limited";
  }

  if (
    /\bcontext\s+(?:window|length|limit|overflow)\b/u.test(text) ||
    /\bmaximum\s+context\b/u.test(text) ||
    /\bprompt\s+(?:is\s+)?too\s+long\b/u.test(text) ||
    /\binput\s+too\s+long\b/u.test(text) ||
    /\btoo\s+many\s+tokens\b/u.test(text) ||
    /\btoken\s+limit\b/u.test(text) ||
    /\b(?:exceeded|exceeds)\b[^\n]{0,64}\bcontext\b/u.test(text)
  ) {
    return "context_overflow_unrecovered";
  }

  if (
    /\b(?:timed?\s*out|timeout|deadline\s+exceeded)\b/u.test(text) ||
    /\betimedout\b/u.test(text)
  ) {
    return "timeout";
  }

  if (
    /(?:^|\b)5\d\d(?:\b|\s|:)/u.test(text) ||
    /\b(?:provider|service|upstream)\s+(?:unavailable|error)\b/u.test(text) ||
    /\bservice\s+unavailable\b/u.test(text) ||
    /\btemporarily\s+unavailable\b/u.test(text) ||
    /\bbad\s+gateway\b/u.test(text) ||
    /\binternal\s+server\s+error\b/u.test(text) ||
    /\b(?:provider|service)\s+overloaded\b/u.test(text)
  ) {
    return "provider_unavailable";
  }

  return "unknown_provider_failure";
}

function classifyMessage(
  message: unknown,
  options: PiFailureClassificationOptions | undefined,
): PiFailureClassification | undefined {
  const stopReason = readOwnEnumerableData(message, "stopReason");
  const nativeRetryAttempts =
    options === undefined
      ? undefined
      : readOwnEnumerableData(options, "nativeRetryAttempts");
  const overflowRecoveryAttempted =
    options === undefined
      ? undefined
      : readOwnEnumerableData(options, "overflowRecoveryAttempted");
  const observedAttemptCount = boundedAttemptCount(
    nativeRetryAttempts?.state === "data"
      ? nativeRetryAttempts.value
      : undefined,
  );
  const overflowAttempted =
    overflowRecoveryAttempted?.state === "data" &&
    overflowRecoveryAttempted.value === true;

  // A missing or unreadable stop reason is not enough evidence to act. The
  // hook contract excludes aborted messages; this check keeps that invariant
  // true even when callers invoke the classifier defensively.
  if (stopReason.state !== "data" || typeof stopReason.value !== "string") {
    return {
      failureClass: "unknown_provider_failure",
      observedAttemptCount,
    };
  }
  if (stopReason.value === "aborted") return undefined;

  const isError = stopReason.value === "error";
  const isFailedOverflow =
    stopReason.value === "length" && overflowAttempted === true;
  if (!isError && !isFailedOverflow) {
    return {
      failureClass: "unknown_provider_failure",
      observedAttemptCount,
    };
  }

  const errorMessage = readOwnEnumerableData(message, "errorMessage");
  if (
    errorMessage.state === "accessor" ||
    errorMessage.state === "unreadable"
  ) {
    return {
      failureClass: "unknown_provider_failure",
      observedAttemptCount,
    };
  }

  // A failed overflow recovery is authoritative even when Pi supplies no
  // error text. It is still bounded and contains no provider-provided data.
  if (isFailedOverflow) {
    return {
      failureClass: "context_overflow_unrecovered",
      observedAttemptCount,
    };
  }

  const text = boundedTextPrefix(
    errorMessage.state === "data" ? errorMessage.value : undefined,
  );
  if (text.state !== "usable") {
    return {
      failureClass: "unknown_provider_failure",
      observedAttemptCount,
    };
  }

  const status = ownNumericStatus(message);
  let failureClass: PiFailoverFailureClass;
  if (status === 401) {
    failureClass = "authentication_failed";
  } else if (status === 403) {
    failureClass = "authorization_failed";
  } else if (status === 429) {
    failureClass = "rate_limited";
  } else if (status !== undefined && status >= 500) {
    failureClass = "provider_unavailable";
  } else if (status === 408) {
    failureClass = "timeout";
  } else if (text.state === "usable") {
    failureClass = classifyText(text.text);
  } else {
    failureClass = "unknown_provider_failure";
  }

  return { failureClass, observedAttemptCount };
}

/**
 * Classify one failed assistant message. The optional second argument may be
 * either a retry count or the bounded metadata from the recovery hook.
 *
 * A hook-shaped object (`{ message, nativeRetryAttempts, ... }`) is accepted
 * as a convenience too. The shape is inspected with the same descriptor-safe
 * rules as the message itself.
 */
export function classifyPiFailure(
  input: unknown,
  options?: number | PiFailureClassificationOptions,
): PiFailureClassification | undefined {
  return Result.fromThrowable(
    () => {
      const nestedMessage = readOwnEnumerableData(input, "message");
      const directStopReason = readOwnEnumerableData(input, "stopReason");
      const looksLikeHookEvent =
        nestedMessage.state === "data" &&
        (directStopReason.state !== "data" ||
          readOwnEnumerableData(input, "type").value ===
            "agent_recovery_exhausted" ||
          readOwnEnumerableData(input, "nativeRetryAttempts").state ===
            "data" ||
          readOwnEnumerableData(input, "overflowRecoveryAttempted").state ===
            "data");

      if (!looksLikeHookEvent) {
        const directOptions =
          typeof options === "number"
            ? {
                nativeRetryAttempts: options,
              }
            : options;
        return classifyMessage(input, directOptions);
      }

      const eventOptions: PiFailureClassificationOptions = {
        nativeRetryAttempts: readOwnEnumerableData(input, "nativeRetryAttempts")
          .value,
        overflowRecoveryAttempted: readOwnEnumerableData(
          input,
          "overflowRecoveryAttempted",
        ).value,
      };
      return classifyMessage(nestedMessage.value, eventOptions);
    },
    (): undefined => undefined,
  )().match(
    (value) => value,
    () => undefined,
  );
}

/** Explicit hook-payload spelling for callers that want no shape inference. */
export function classifyPiRecoveryFailure(
  input: unknown,
): PiFailureClassification | undefined {
  return Result.fromThrowable(
    () => {
      const message = readOwnEnumerableData(input, "message");
      if (message.state !== "data") return undefined;
      return classifyMessage(message.value, {
        nativeRetryAttempts: readOwnEnumerableData(input, "nativeRetryAttempts")
          .value,
        overflowRecoveryAttempted: readOwnEnumerableData(
          input,
          "overflowRecoveryAttempted",
        ).value,
      });
    },
    (): undefined => undefined,
  )().match(
    (value) => value,
    () => undefined,
  );
}

/** Alias used by adapter call sites that name the provider boundary. */
export const classifyPiProviderFailure = classifyPiFailure;

/**
 * Whether a classified failure may consume another candidate. Unknown
 * provider failures are deliberately one-shot per prompt cycle; every known
 * class remains eligible after Pi's native recovery has already exhausted.
 */
export function isPiFailureAdvanceEligible(
  failureClass: PiFailoverFailureClass,
  unknownAdvancesUsed = 0,
): boolean {
  if (failureClass === "unknown_provider_failure") {
    return (
      Number.isSafeInteger(unknownAdvancesUsed) &&
      unknownAdvancesUsed >= 0 &&
      unknownAdvancesUsed < 1
    );
  }
  return PI_FAILOVER_FAILURE_CLASSES.includes(failureClass);
}

/** Compatibility spelling for coordinator policy call sites. */
export const canAdvancePiFailover = isPiFailureAdvanceEligible;

export interface PiFailoverAdvanceState {
  readonly advance: boolean;
  readonly unknownAdvancesUsed: number;
}

/** Consume the bounded unknown-failure allowance without retaining text. */
export function consumePiFailureAdvance(
  failureClass: PiFailoverFailureClass,
  unknownAdvancesUsed = 0,
): PiFailoverAdvanceState {
  const prior =
    Number.isSafeInteger(unknownAdvancesUsed) && unknownAdvancesUsed >= 0
      ? Math.min(unknownAdvancesUsed, 1)
      : 0;
  const advance = isPiFailureAdvanceEligible(failureClass, prior);
  return {
    advance,
    unknownAdvancesUsed:
      failureClass === "unknown_provider_failure" && advance
        ? prior + 1
        : prior,
  };
}

/** One resolver-produced candidate used by the coordinator and preflight port. */
export type PiFailoverCandidate = PiOrderedModelResolution;

/** Cursor entries may be resolver results or bare model facts in unit seams. */
export type PiCandidateCursorEntry =
  | PiModelInfoWithContextWindow
  | PiOrderedModelResolution;

type CandidateModel = PiModelInfo | PiOrderedModelResolution;

function candidateModel(candidate: CandidateModel): PiModelInfo {
  if (
    typeof candidate === "object" &&
    candidate !== null &&
    "resolved" in candidate
  ) {
    return candidate.model;
  }
  return candidate;
}

function canonicalIdentity(
  model: Pick<PiModelInfo, "provider" | "id">,
): string {
  return `${model.provider}/${model.id}`;
}

/** Mutable, bounded cursor over the suffix after the failed model. */
export interface PiCandidateCursor<
  T extends PiCandidateCursorEntry = PiFailoverCandidate,
> {
  /** Index of the next candidate in the ordered list. */
  readonly position: number;
  /** Number of candidates returned so far. Never exceeds `cap`. */
  readonly advanced: number;
  /** Hard cap, equal to the input list length. */
  readonly cap: number;
  readonly exhausted: boolean;
  next(): T | undefined;
}

class BoundedPiCandidateCursor<T extends PiCandidateCursorEntry>
  implements PiCandidateCursor<T>
{
  private nextIndex: number;
  private advancedCount = 0;

  constructor(
    private readonly candidates: readonly T[],
    failedModel: Pick<PiModelInfo, "provider" | "id"> | string | undefined,
  ) {
    let failedIdentity: string | undefined;
    if (typeof failedModel === "string") {
      failedIdentity = failedModel;
    } else if (failedModel !== undefined) {
      failedIdentity = canonicalIdentity(failedModel);
    }
    const failedIndex =
      failedIdentity === undefined
        ? -1
        : candidates.findIndex(
            (candidate) =>
              canonicalIdentity(candidateModel(candidate)) === failedIdentity,
          );
    this.nextIndex = Math.min(candidates.length, Math.max(0, failedIndex + 1));
  }

  get position(): number {
    return this.nextIndex;
  }

  get advanced(): number {
    return this.advancedCount;
  }

  get cap(): number {
    return this.candidates.length;
  }

  get exhausted(): boolean {
    return this.nextIndex >= this.candidates.length;
  }

  next(): T | undefined {
    if (this.exhausted || this.advancedCount >= this.cap) return undefined;
    const candidate = this.candidates[this.nextIndex];
    this.nextIndex = Math.min(this.cap, this.nextIndex + 1);
    this.advancedCount = Math.min(this.cap, this.advancedCount + 1);
    return candidate;
  }
}

export function createPiCandidateCursor<T extends PiCandidateCursorEntry>(
  candidates: readonly T[],
  failedModel: Pick<PiModelInfo, "provider" | "id"> | string | undefined,
): PiCandidateCursor<T> {
  return new BoundedPiCandidateCursor([...candidates], failedModel);
}

/** Compatibility spelling for model-specific call sites. */
export const createPiModelCandidateCursor = createPiCandidateCursor;

function modelContextWindow(
  model: PiModelInfoWithContextWindow | undefined,
): number | undefined {
  if (model === undefined) return undefined;
  return typeof model.contextWindow === "number"
    ? model.contextWindow
    : undefined;
}

function modelFromCandidate(
  candidate: PiFailoverCandidate | PiModelInfo,
): PiModelInfoWithContextWindow | undefined {
  if (candidate === undefined || candidate === null) return undefined;
  if (
    typeof candidate === "object" &&
    "model" in candidate &&
    "resolved" in candidate &&
    candidate.resolved === true
  ) {
    return candidate.model;
  }
  return candidate as PiModelInfoWithContextWindow;
}

/**
 * Context-window policy is the only class-specific eligibility rule. Every
 * other closed class ignores context windows and is eligible for any candidate
 * that passes host preflight.
 */
export function isPiCandidateContextEligible(
  candidate: PiFailoverCandidate | PiModelInfo,
  failedModel: PiModelInfoWithContextWindow | undefined,
  failureClass: PiFailoverFailureClass,
): boolean {
  if (failureClass !== "context_overflow_unrecovered") return true;
  const candidateWindow = modelContextWindow(modelFromCandidate(candidate));
  const failedWindow = modelContextWindow(failedModel);
  return (
    candidateWindow !== undefined &&
    failedWindow !== undefined &&
    Number.isFinite(candidateWindow) &&
    Number.isFinite(failedWindow) &&
    candidateWindow > failedWindow
  );
}

/** Compatibility spelling for the coordinator's eligibility check. */
export const isPiCandidateEligible = isPiCandidateContextEligible;

export type PiCandidatePreflightSkipReason =
  | "not-in-authenticated-catalog"
  | "provider-credentials-unavailable"
  | "host-surface-unavailable"
  | "preflight-error";

export type PiCandidatePreflightOutcome =
  | { readonly status: "eligible" }
  | {
      readonly status: "skip";
      readonly reason: PiCandidatePreflightSkipReason;
    };

/** Typed preflight errors carry no provider credentials or host exception text. */
export type PiCandidatePreflightError =
  | { readonly type: "CandidateNotInAuthenticatedCatalog" }
  | { readonly type: "ProviderCredentialsUnavailable" }
  | { readonly type: "PreflightHostSurfaceUnavailable" }
  | { readonly type: "CandidatePreflightFailed" };

/**
 * Public host-only auth preflight seam. Implementations return a typed error
 * for an unavailable host surface; the coordinator treats every such error as
 * a candidate skip. No credential value is representable in this contract.
 */
export interface PiCandidatePreflightPort {
  preflight(
    candidate: PiFailoverCandidate,
  ): ResultAsync<PiCandidatePreflightOutcome, PiCandidatePreflightError>;
}

/** Canonical identity helper shared by cursor and coordinator callers. */
export function piCanonicalModelIdentity(
  model: Pick<PiModelInfo, "provider" | "id">,
): string {
  return canonicalIdentity(model);
}

/** Runtime guard for values crossing a typed control boundary. */
export function isPiFailoverFailureClass(
  value: unknown,
): value is PiFailoverFailureClass {
  return (
    typeof value === "string" &&
    (PI_FAILOVER_FAILURE_CLASSES as readonly string[]).includes(value)
  );
}
