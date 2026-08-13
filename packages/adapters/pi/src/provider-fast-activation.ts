import { err, ok, Result } from "neverthrow";

/**
 * Exact allowlist classifier, stateless request mutation, an instance-owned
 * attempt tracker, and a one-sequence coordinator for Pi provider-fast hooks.
 *
 * Classification never copies caller strings. Mutation copies only a bounded
 * own-data payload graph, or applies one planned Anthropic header write after
 * the full map validates. The tracker correlates request attempts with opaque
 * tokens and never reports `applied`. The coordinator maps host API strings
 * by a literal table, owns one active sequence, and exposes only sanitized
 * diagnostics.
 */

export const PROVIDER_FAST_INPUT_MAX_LENGTH = 128;

export const PROVIDER_FAST_PAYLOAD_MAX_DEPTH = 16;
export const PROVIDER_FAST_PAYLOAD_MAX_NODES = 1_024;
export const PROVIDER_FAST_PAYLOAD_MAX_PROPERTIES = 1_024;
export const PROVIDER_FAST_PAYLOAD_MAX_PROPERTIES_PER_OBJECT = 128;
export const PROVIDER_FAST_PAYLOAD_MAX_STRING_LENGTH = 16 * 1_024;
export const PROVIDER_FAST_PAYLOAD_MAX_ARRAY_LENGTH = 256;

export const PROVIDER_FAST_HEADER_MAX_COUNT = 64;
export const PROVIDER_FAST_HEADER_MAX_NAME_LENGTH = 256;
export const PROVIDER_FAST_HEADER_MAX_VALUE_LENGTH = 4_096;
export const PROVIDER_FAST_HEADER_MAX_BETA_TOKENS = 16;
export const PROVIDER_FAST_HEADER_MAX_BETA_TOKEN_LENGTH = 128;

export const PROVIDER_FAST_OPENAI_SERVICE_TIER = "fast";
export const PROVIDER_FAST_ANTHROPIC_SPEED = "fast";
export const PROVIDER_FAST_ANTHROPIC_BETA_HEADER = "anthropic-beta";
export const PROVIDER_FAST_ANTHROPIC_BETA_TOKEN = "fast-mode-2026-02-01";

export type ProviderFastApiFamily =
  | "openai-responses"
  | "openai-completions"
  | "anthropic-messages";

export type ProviderFastProviderFamily = "openai" | "anthropic";

export const PROVIDER_FAST_ALLOWLIST_RULE_IDS = [
  "openai-gpt-5-6-sol",
  "openai-gpt-5-6-terra",
  "openai-gpt-5-6-luna",
  "anthropic-claude-opus-5",
  "anthropic-claude-opus-4-8",
] as const;

export type ProviderFastAllowlistRuleId =
  (typeof PROVIDER_FAST_ALLOWLIST_RULE_IDS)[number];

export const PROVIDER_FAST_UNSUPPORTED_REASONS = [
  "input-blank",
  "input-oversized",
  "provider-not-allowed",
  "endpoint-not-allowed",
  "model-not-allowed",
] as const;

export type ProviderFastUnsupportedReason =
  (typeof PROVIDER_FAST_UNSUPPORTED_REASONS)[number];

export const PROVIDER_FAST_MUTATION_REASONS = [
  "request-collision",
  "payload-malformed",
  "payload-unsafe",
  "payload-oversized",
  "header-malformed",
  "header-unsafe",
  "header-duplicate",
] as const;

export type ProviderFastMutationReason =
  (typeof PROVIDER_FAST_MUTATION_REASONS)[number];

export type ProviderFastActivationInput = {
  readonly fast?: true;
  readonly provider: string;
  readonly apiFamily: ProviderFastApiFamily;
  readonly model: string;
};

export type ProviderFastNoIntent = {
  readonly kind: "no-intent";
};

export type ProviderFastSupported = {
  readonly kind: "supported";
  readonly providerFamily: ProviderFastProviderFamily;
  readonly allowlistRuleId: ProviderFastAllowlistRuleId;
};

export type ProviderFastUnsupported = {
  readonly kind: "unsupported";
  readonly reason: ProviderFastUnsupportedReason;
};

export type ProviderFastMutationUnsupported = {
  readonly kind: "unsupported";
  readonly reason: ProviderFastMutationReason;
};

export type ProviderFastActivationSuccess =
  | ProviderFastNoIntent
  | ProviderFastSupported;

export type ProviderFastActivationClassification =
  | ProviderFastActivationSuccess
  | ProviderFastUnsupported;

export type ProviderFastHeaderPlan =
  | { readonly action: "none" }
  | { readonly action: "preserve" }
  | { readonly action: "write" };

export const PROVIDER_FAST_ATTEMPT_PENDING_LIMIT = 32;
export const PROVIDER_FAST_ATTEMPT_SEQUENCE_MAX = Number.MAX_SAFE_INTEGER;

export const PROVIDER_FAST_ATTEMPT_STATES = [
  "declared",
  "requested",
  "not-confirmed",
  "unsupported",
] as const;

export type ProviderFastAttemptState =
  (typeof PROVIDER_FAST_ATTEMPT_STATES)[number];

export const PROVIDER_FAST_ATTEMPT_EVIDENCE_KINDS = [
  "none",
  "response-status",
] as const;

export type ProviderFastAttemptEvidenceKind =
  (typeof PROVIDER_FAST_ATTEMPT_EVIDENCE_KINDS)[number];

export const PROVIDER_FAST_ATTEMPT_EVIDENCE_OUTCOMES = [
  "none",
  "unavailable",
] as const;

export type ProviderFastAttemptEvidenceOutcome =
  (typeof PROVIDER_FAST_ATTEMPT_EVIDENCE_OUTCOMES)[number];

export const PROVIDER_FAST_ATTEMPT_REASONS = [
  "none",
  "response-body-evidence-unavailable",
  "cancelled",
  "expired",
  "generation-superseded",
  "reset",
  "session-replaced",
  "primary-switched",
  ...PROVIDER_FAST_UNSUPPORTED_REASONS,
  ...PROVIDER_FAST_MUTATION_REASONS,
] as const;

export type ProviderFastAttemptReason =
  (typeof PROVIDER_FAST_ATTEMPT_REASONS)[number];

export const PROVIDER_FAST_ATTEMPT_EXPIRE_REASONS = [
  "cancelled",
  "expired",
  "generation-superseded",
  "reset",
  "session-replaced",
  "primary-switched",
] as const;

export type ProviderFastAttemptExpireReason =
  (typeof PROVIDER_FAST_ATTEMPT_EXPIRE_REASONS)[number];

export const PROVIDER_FAST_ATTEMPT_ERROR_REASONS = [
  "forged-token",
  "stale-token",
  "duplicate-token",
  "out-of-order",
  "pending-capacity-exceeded",
  "sequence-overflow",
  "invalid-input",
  "invalid-status",
] as const;

export type ProviderFastAttemptErrorReason =
  (typeof PROVIDER_FAST_ATTEMPT_ERROR_REASONS)[number];

export type ProviderFastAttemptError =
  | {
      readonly type: "InvalidAttemptToken";
      readonly reason: "forged-token";
    }
  | {
      readonly type: "StaleAttemptToken";
      readonly reason: "stale-token";
    }
  | {
      readonly type: "DuplicateAttemptToken";
      readonly reason: "duplicate-token";
    }
  | {
      readonly type: "OutOfOrderAttempt";
      readonly reason: "out-of-order";
    }
  | {
      readonly type: "AttemptCapacityExceeded";
      readonly reason: "pending-capacity-exceeded";
    }
  | {
      readonly type: "AttemptSequenceOverflow";
      readonly reason: "sequence-overflow";
    }
  | {
      readonly type: "InvalidAttemptInput";
      readonly reason: "invalid-input";
    }
  | {
      readonly type: "InvalidResponseStatus";
      readonly reason: "invalid-status";
    };

export type ProviderFastAttemptRequestSnapshot = {
  readonly generation: number;
  readonly primaryName: string;
  readonly selectedModel?:
    | {
        readonly provider: string;
        readonly id: string;
        readonly name?: string;
      }
    | undefined;
  readonly fast?: true;
};

export type ProviderFastAttemptClassification =
  | ProviderFastActivationClassification
  | ProviderFastMutationUnsupported;

export type ProviderFastAttemptBeginInput = {
  readonly snapshot: ProviderFastAttemptRequestSnapshot;
  readonly apiFamily: ProviderFastApiFamily | "none";
  readonly classification: ProviderFastAttemptClassification;
};

export type ProviderFastAttemptToken = {
  readonly sequence: number;
};

export type ProviderFastAttemptPublicSnapshot = {
  readonly sequence: number;
  readonly pendingCount: number;
  readonly providerFamily: ProviderFastProviderFamily | "none";
  readonly apiFamily: ProviderFastApiFamily | "none";
  readonly allowlistRuleId: ProviderFastAllowlistRuleId | "none";
  readonly collision: boolean;
  readonly state: ProviderFastAttemptState;
  readonly evidenceKind: ProviderFastAttemptEvidenceKind;
  readonly evidenceOutcome: ProviderFastAttemptEvidenceOutcome;
  readonly reason: ProviderFastAttemptReason;
};

export type ProviderFastAttemptBeginResult =
  | {
      readonly kind: "no-state";
      readonly pendingCount: number;
    }
  | {
      readonly kind: "unsupported";
      readonly snapshot: ProviderFastAttemptPublicSnapshot;
    }
  | {
      readonly kind: "pending";
      readonly token: ProviderFastAttemptToken;
      readonly snapshot: ProviderFastAttemptPublicSnapshot;
    };

export type ProviderFastAttemptTrackerOptions = {
  readonly pendingLimit?: number;
  readonly sequenceMax?: number;
};

type PayloadCopyBudget = {
  nodes: number;
  properties: number;
};

type CopiedPayloadRecord = Record<string, unknown>;

type HeaderSnapshot = {
  readonly entries: readonly HeaderEntry[];
};

type HeaderEntry = {
  readonly name: string;
  readonly value: string;
};

type ResolvedHeaderPlan =
  | { readonly kind: "none" }
  | { readonly kind: "preserve" }
  | {
      readonly kind: "write";
      readonly name: string;
      readonly value: string;
    };

const NO_INTENT: ProviderFastNoIntent = Object.freeze({ kind: "no-intent" });

const OPENAI_SERVICE_TIER_FIELD = "service_tier";
const ANTHROPIC_SPEED_FIELD = "speed";
const ANTHROPIC_BETA_HEADER_LOWER = "anthropic-beta";
const ANTHROPIC_FAST_BETA_PREFIX = "fast-mode-";

const API_FAMILIES: ReadonlySet<ProviderFastApiFamily> = new Set([
  "openai-responses",
  "openai-completions",
  "anthropic-messages",
]);

const OPENAI_API_FAMILIES: ReadonlySet<ProviderFastApiFamily> = new Set([
  "openai-responses",
  "openai-completions",
]);

const OPENAI_MODEL_RULES: ReadonlyMap<string, ProviderFastAllowlistRuleId> =
  new Map([
    ["gpt-5.6-sol", "openai-gpt-5-6-sol"],
    ["gpt-5.6-terra", "openai-gpt-5-6-terra"],
    ["gpt-5.6-luna", "openai-gpt-5-6-luna"],
  ]);

const ANTHROPIC_MODEL_RULES: ReadonlyMap<string, ProviderFastAllowlistRuleId> =
  new Map([
    ["claude-opus-5", "anthropic-claude-opus-5"],
    ["claude-opus-4-8", "anthropic-claude-opus-4-8"],
  ]);

const CREDENTIAL_HEADER_NAMES: ReadonlySet<string> = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "api-key",
  "anthropic-api-key",
  "openai-api-key",
  "x-openai-api-key",
  "x-auth-token",
  "auth-token",
  "access-token",
  "x-access-token",
]);

const BETA_TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function unsupported(
  reason: ProviderFastUnsupportedReason,
): ProviderFastUnsupported {
  return Object.freeze({ kind: "unsupported", reason });
}

function mutationUnsupported(
  reason: ProviderFastMutationReason,
): ProviderFastMutationUnsupported {
  return Object.freeze({ kind: "unsupported", reason });
}

function classifyBoundedToken(
  value: unknown,
): Result<string, ProviderFastUnsupported> {
  if (typeof value !== "string" || value.length === 0) {
    return err(unsupported("input-blank"));
  }
  if (value.length > PROVIDER_FAST_INPUT_MAX_LENGTH) {
    return err(unsupported("input-oversized"));
  }
  return ok(value);
}

function classifySupported(
  providerFamily: ProviderFastProviderFamily,
  allowlistRuleId: ProviderFastAllowlistRuleId,
): Result<ProviderFastSupported, ProviderFastUnsupported> {
  return ok(
    Object.freeze({
      kind: "supported",
      providerFamily,
      allowlistRuleId,
    }),
  );
}

/**
 * Classify exact `fast true` intent against the frozen provider allowlist.
 * Omission is no-intent. Every other miss is unsupported with a fixed reason.
 */
export function classifyProviderFastActivation(
  input: ProviderFastActivationInput,
): Result<ProviderFastActivationSuccess, ProviderFastUnsupported> {
  if (input.fast !== true) {
    return ok(NO_INTENT);
  }

  const providerResult = classifyBoundedToken(input.provider);
  if (providerResult.isErr()) {
    return err(providerResult.error);
  }

  const apiFamilyResult = classifyBoundedToken(input.apiFamily);
  if (apiFamilyResult.isErr()) {
    return err(apiFamilyResult.error);
  }
  if (!API_FAMILIES.has(apiFamilyResult.value as ProviderFastApiFamily)) {
    return err(unsupported("endpoint-not-allowed"));
  }

  const modelResult = classifyBoundedToken(input.model);
  if (modelResult.isErr()) {
    return err(modelResult.error);
  }

  const provider = providerResult.value;
  const apiFamily = apiFamilyResult.value as ProviderFastApiFamily;
  const model = modelResult.value;

  if (provider === "openai") {
    if (!OPENAI_API_FAMILIES.has(apiFamily)) {
      return err(unsupported("endpoint-not-allowed"));
    }
    const allowlistRuleId = OPENAI_MODEL_RULES.get(model);
    if (allowlistRuleId === undefined) {
      return err(unsupported("model-not-allowed"));
    }
    return classifySupported("openai", allowlistRuleId);
  }

  if (provider === "anthropic") {
    if (apiFamily !== "anthropic-messages") {
      return err(unsupported("endpoint-not-allowed"));
    }
    const allowlistRuleId = ANTHROPIC_MODEL_RULES.get(model);
    if (allowlistRuleId === undefined) {
      return err(unsupported("model-not-allowed"));
    }
    return classifySupported("anthropic", allowlistRuleId);
  }

  return err(unsupported("provider-not-allowed"));
}

function shouldLeaveRequestUnchanged(
  classification: ProviderFastActivationClassification,
): boolean {
  return (
    classification.kind === "no-intent" || classification.kind === "unsupported"
  );
}

function isSupportedFamily(
  classification: ProviderFastActivationClassification,
  providerFamily: ProviderFastProviderFamily,
): classification is ProviderFastSupported {
  return (
    classification.kind === "supported" &&
    classification.providerFamily === providerFamily
  );
}

function defineOwn(
  target: CopiedPayloadRecord,
  key: string,
  value: unknown,
): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

function copyPayloadArray(
  source: unknown[],
  active: WeakSet<object>,
  budget: PayloadCopyBudget,
  depth: number,
): Result<unknown[], ProviderFastMutationUnsupported> {
  const lengthDescriptor = Object.getOwnPropertyDescriptor(source, "length");
  if (
    lengthDescriptor === undefined ||
    !("value" in lengthDescriptor) ||
    typeof lengthDescriptor.value !== "number" ||
    !Number.isSafeInteger(lengthDescriptor.value) ||
    lengthDescriptor.value < 0 ||
    lengthDescriptor.enumerable !== false
  ) {
    return err(mutationUnsupported("payload-unsafe"));
  }
  const length = lengthDescriptor.value;
  if (length > PROVIDER_FAST_PAYLOAD_MAX_ARRAY_LENGTH) {
    return err(mutationUnsupported("payload-oversized"));
  }
  const ownKeys = Reflect.ownKeys(source);
  if (ownKeys.length !== length + 1) {
    return err(mutationUnsupported("payload-unsafe"));
  }
  budget.properties += ownKeys.length;
  if (budget.properties > PROVIDER_FAST_PAYLOAD_MAX_PROPERTIES) {
    return err(mutationUnsupported("payload-oversized"));
  }

  const copy: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const key = String(index);
    if (ownKeys[index] !== key) {
      return err(mutationUnsupported("payload-unsafe"));
    }
    const descriptor = Object.getOwnPropertyDescriptor(source, key);
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      descriptor.enumerable !== true
    ) {
      return err(mutationUnsupported("payload-unsafe"));
    }
    const copiedValue = copyPayloadGraph(
      descriptor.value,
      active,
      budget,
      depth + 1,
    );
    if (copiedValue.isErr()) {
      return err(copiedValue.error);
    }
    copy.push(copiedValue.value);
  }
  if (ownKeys[length] !== "length") {
    return err(mutationUnsupported("payload-unsafe"));
  }
  return ok(copy);
}

function copyPayloadRecord(
  source: object,
  active: WeakSet<object>,
  budget: PayloadCopyBudget,
  depth: number,
): Result<CopiedPayloadRecord, ProviderFastMutationUnsupported> {
  const ownKeys = Reflect.ownKeys(source);
  if (ownKeys.length > PROVIDER_FAST_PAYLOAD_MAX_PROPERTIES_PER_OBJECT) {
    return err(mutationUnsupported("payload-oversized"));
  }
  budget.properties += ownKeys.length;
  if (budget.properties > PROVIDER_FAST_PAYLOAD_MAX_PROPERTIES) {
    return err(mutationUnsupported("payload-oversized"));
  }

  const copy = Object.create(null) as CopiedPayloadRecord;
  for (const key of ownKeys) {
    if (typeof key === "symbol") {
      return err(mutationUnsupported("payload-unsafe"));
    }
    if (key.length > PROVIDER_FAST_PAYLOAD_MAX_STRING_LENGTH) {
      return err(mutationUnsupported("payload-oversized"));
    }
    const descriptor = Object.getOwnPropertyDescriptor(source, key);
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      descriptor.enumerable !== true
    ) {
      return err(mutationUnsupported("payload-unsafe"));
    }
    const copiedValue = copyPayloadGraph(
      descriptor.value,
      active,
      budget,
      depth + 1,
    );
    if (copiedValue.isErr()) {
      return err(copiedValue.error);
    }
    defineOwn(copy, key, copiedValue.value);
  }
  return ok(copy);
}

function copyPayloadGraph(
  value: unknown,
  active: WeakSet<object>,
  budget: PayloadCopyBudget,
  depth: number,
): Result<unknown, ProviderFastMutationUnsupported> {
  if (depth > PROVIDER_FAST_PAYLOAD_MAX_DEPTH) {
    return err(mutationUnsupported("payload-oversized"));
  }
  budget.nodes += 1;
  if (budget.nodes > PROVIDER_FAST_PAYLOAD_MAX_NODES) {
    return err(mutationUnsupported("payload-oversized"));
  }

  if (typeof value === "function") {
    return err(mutationUnsupported("payload-unsafe"));
  }
  if (typeof value === "string") {
    if (value.length > PROVIDER_FAST_PAYLOAD_MAX_STRING_LENGTH) {
      return err(mutationUnsupported("payload-oversized"));
    }
    return ok(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      return err(mutationUnsupported("payload-malformed"));
    }
    return ok(value);
  }
  if (typeof value === "boolean" || value === null) {
    return ok(value);
  }
  if (
    value === undefined ||
    typeof value === "symbol" ||
    typeof value === "bigint"
  ) {
    return err(mutationUnsupported("payload-unsafe"));
  }
  if (typeof value !== "object") {
    return err(mutationUnsupported("payload-unsafe"));
  }
  if (active.has(value)) {
    return err(mutationUnsupported("payload-unsafe"));
  }

  const isArray = Array.isArray(value);
  const prototype = Object.getPrototypeOf(value);
  if (
    isArray
      ? prototype !== Array.prototype
      : prototype !== Object.prototype && prototype !== null
  ) {
    return err(mutationUnsupported("payload-unsafe"));
  }

  active.add(value);
  const copied = isArray
    ? copyPayloadArray(value, active, budget, depth)
    : copyPayloadRecord(value, active, budget, depth);
  active.delete(value);
  return copied;
}

const copyBoundedPayloadGraph = Result.fromThrowable(
  (value: unknown) =>
    copyPayloadGraph(
      value,
      new WeakSet<object>(),
      { nodes: 0, properties: 0 },
      0,
    ),
  () => mutationUnsupported("payload-unsafe"),
);

function copyPayloadObject(
  payload: unknown,
): Result<CopiedPayloadRecord, ProviderFastMutationUnsupported> {
  if (typeof payload === "function") {
    return err(mutationUnsupported("payload-unsafe"));
  }
  if (
    payload === null ||
    typeof payload !== "object" ||
    Array.isArray(payload)
  ) {
    return err(mutationUnsupported("payload-malformed"));
  }
  return copyBoundedPayloadGraph(payload).andThen((copied) => {
    if (copied.isErr()) {
      return err(copied.error);
    }
    if (
      copied.value === null ||
      typeof copied.value !== "object" ||
      Array.isArray(copied.value)
    ) {
      return err(mutationUnsupported("payload-malformed"));
    }
    return ok(copied.value as CopiedPayloadRecord);
  });
}

function applyExactPayloadField(
  payload: unknown,
  fieldName: string,
  requiredValue: string,
): Result<CopiedPayloadRecord, ProviderFastMutationUnsupported> {
  const copied = copyPayloadObject(payload);
  if (copied.isErr()) {
    return err(copied.error);
  }
  const record = copied.value;
  const existing = Object.getOwnPropertyDescriptor(record, fieldName);
  if (existing === undefined) {
    defineOwn(record, fieldName, requiredValue);
    return ok(record);
  }
  if (!("value" in existing) || typeof existing.value !== "string") {
    return err(mutationUnsupported("payload-malformed"));
  }
  if (existing.value !== requiredValue) {
    return err(mutationUnsupported("request-collision"));
  }
  return ok(record);
}

/**
 * Copy an allowlisted OpenAI payload and add only `service_tier: "fast"`.
 * No-intent and unsupported classifications return the original reference.
 */
export function applyOpenAiProviderFastPayload(
  classification: ProviderFastActivationClassification,
  payload: unknown,
): Result<unknown, ProviderFastMutationUnsupported> {
  if (shouldLeaveRequestUnchanged(classification)) {
    return ok(payload);
  }
  if (!isSupportedFamily(classification, "openai")) {
    return err(mutationUnsupported("payload-malformed"));
  }
  return applyExactPayloadField(
    payload,
    OPENAI_SERVICE_TIER_FIELD,
    PROVIDER_FAST_OPENAI_SERVICE_TIER,
  );
}

/**
 * Copy an allowlisted Anthropic payload and add only `speed: "fast"`.
 * No-intent and unsupported classifications return the original reference.
 */
export function applyAnthropicProviderFastPayload(
  classification: ProviderFastActivationClassification,
  payload: unknown,
): Result<unknown, ProviderFastMutationUnsupported> {
  if (shouldLeaveRequestUnchanged(classification)) {
    return ok(payload);
  }
  if (!isSupportedFamily(classification, "anthropic")) {
    return err(mutationUnsupported("payload-malformed"));
  }
  return applyExactPayloadField(
    payload,
    ANTHROPIC_SPEED_FIELD,
    PROVIDER_FAST_ANTHROPIC_SPEED,
  );
}

function isCredentialHeaderName(name: string): boolean {
  return CREDENTIAL_HEADER_NAMES.has(name.toLowerCase());
}

function snapshotHeaderMap(
  headers: unknown,
): Result<HeaderSnapshot, ProviderFastMutationUnsupported> {
  if (
    headers === null ||
    typeof headers !== "object" ||
    Array.isArray(headers)
  ) {
    return err(mutationUnsupported("header-malformed"));
  }
  if (typeof headers === "function") {
    return err(mutationUnsupported("header-unsafe"));
  }
  if (!Object.isExtensible(headers) || Object.isFrozen(headers)) {
    return err(mutationUnsupported("header-unsafe"));
  }

  const prototype = Object.getPrototypeOf(headers);
  if (prototype !== Object.prototype && prototype !== null) {
    return err(mutationUnsupported("header-unsafe"));
  }

  const ownKeys = Reflect.ownKeys(headers);
  if (ownKeys.length > PROVIDER_FAST_HEADER_MAX_COUNT) {
    return err(mutationUnsupported("header-malformed"));
  }

  const seenLower = new Set<string>();
  const entries: HeaderEntry[] = [];
  for (const key of ownKeys) {
    if (typeof key === "symbol") {
      return err(mutationUnsupported("header-unsafe"));
    }
    if (key.length === 0 || key.length > PROVIDER_FAST_HEADER_MAX_NAME_LENGTH) {
      return err(mutationUnsupported("header-malformed"));
    }
    const lower = key.toLowerCase();
    if (seenLower.has(lower)) {
      return err(mutationUnsupported("header-duplicate"));
    }
    seenLower.add(lower);

    const descriptor = Object.getOwnPropertyDescriptor(headers, key);
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      descriptor.enumerable !== true ||
      descriptor.configurable !== true ||
      descriptor.writable !== true
    ) {
      return err(mutationUnsupported("header-unsafe"));
    }
    if (typeof descriptor.value !== "string") {
      return err(mutationUnsupported("header-malformed"));
    }
    if (descriptor.value.length > PROVIDER_FAST_HEADER_MAX_VALUE_LENGTH) {
      return err(mutationUnsupported("header-malformed"));
    }
    entries.push({ name: key, value: descriptor.value });
  }

  return ok({ entries });
}

function parseBetaTokens(
  value: string,
): Result<readonly string[], ProviderFastMutationUnsupported> {
  if (value.length === 0) {
    return err(mutationUnsupported("header-malformed"));
  }
  const rawTokens = value.split(",");
  if (rawTokens.length > PROVIDER_FAST_HEADER_MAX_BETA_TOKENS) {
    return err(mutationUnsupported("header-malformed"));
  }
  const tokens: string[] = [];
  for (const rawToken of rawTokens) {
    const token = rawToken.trim();
    if (
      token.length === 0 ||
      token.length > PROVIDER_FAST_HEADER_MAX_BETA_TOKEN_LENGTH ||
      !BETA_TOKEN_PATTERN.test(token)
    ) {
      return err(mutationUnsupported("header-malformed"));
    }
    if (
      token.startsWith(ANTHROPIC_FAST_BETA_PREFIX) &&
      token !== PROVIDER_FAST_ANTHROPIC_BETA_TOKEN
    ) {
      return err(mutationUnsupported("request-collision"));
    }
    tokens.push(token);
  }
  return ok(tokens);
}

function resolveAnthropicHeaderPlan(
  classification: ProviderFastActivationClassification,
  headers: unknown,
): Result<ResolvedHeaderPlan, ProviderFastMutationUnsupported> {
  if (
    shouldLeaveRequestUnchanged(classification) ||
    !isSupportedFamily(classification, "anthropic")
  ) {
    return ok({ kind: "none" });
  }

  const snapshot = snapshotHeaderMap(headers);
  if (snapshot.isErr()) {
    return err(snapshot.error);
  }

  let betaEntry: HeaderEntry | undefined;
  for (const entry of snapshot.value.entries) {
    if (entry.name.toLowerCase() === ANTHROPIC_BETA_HEADER_LOWER) {
      betaEntry = entry;
      break;
    }
  }

  if (betaEntry === undefined) {
    return ok({
      kind: "write",
      name: PROVIDER_FAST_ANTHROPIC_BETA_HEADER,
      value: PROVIDER_FAST_ANTHROPIC_BETA_TOKEN,
    });
  }
  if (isCredentialHeaderName(betaEntry.name)) {
    return err(mutationUnsupported("header-unsafe"));
  }

  const tokens = parseBetaTokens(betaEntry.value);
  if (tokens.isErr()) {
    return err(tokens.error);
  }
  if (tokens.value.includes(PROVIDER_FAST_ANTHROPIC_BETA_TOKEN)) {
    return ok({ kind: "preserve" });
  }
  if (tokens.value.length + 1 > PROVIDER_FAST_HEADER_MAX_BETA_TOKENS) {
    return err(mutationUnsupported("header-malformed"));
  }
  return ok({
    kind: "write",
    name: betaEntry.name,
    value: `${betaEntry.value}, ${PROVIDER_FAST_ANTHROPIC_BETA_TOKEN}`,
  });
}

const inspectHeaderPlan = Result.fromThrowable(
  (classification: ProviderFastActivationClassification, headers: unknown) =>
    resolveAnthropicHeaderPlan(classification, headers),
  () => mutationUnsupported("header-unsafe"),
);

/**
 * Pure planned Anthropic header update. Validates the full map first and
 * never writes. OpenAI, no-intent, and unsupported outcomes plan no change.
 */
export function planAnthropicProviderFastHeaders(
  classification: ProviderFastActivationClassification,
  headers: unknown,
): Result<ProviderFastHeaderPlan, ProviderFastMutationUnsupported> {
  return inspectHeaderPlan(classification, headers).andThen((resolved) => {
    if (resolved.isErr()) {
      return err(resolved.error);
    }
    if (resolved.value.kind === "write") {
      return ok({ action: "write" } as const);
    }
    if (resolved.value.kind === "preserve") {
      return ok({ action: "preserve" } as const);
    }
    return ok({ action: "none" } as const);
  });
}

const writeHeaderValue = Result.fromThrowable(
  (headers: object, name: string, value: string) => {
    Object.defineProperty(headers, name, {
      value,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  },
  () => mutationUnsupported("header-unsafe"),
);

/**
 * Atomically apply a planned Anthropic beta-header write. On any failure the
 * original map is left untouched. Credential headers are never written.
 */
export function applyAnthropicProviderFastHeaders(
  classification: ProviderFastActivationClassification,
  headers: object,
): Result<object, ProviderFastMutationUnsupported> {
  const planned = inspectHeaderPlan(classification, headers);
  if (planned.isErr()) {
    return err(planned.error);
  }
  const resolved = planned.value;
  if (resolved.isErr()) {
    return err(resolved.error);
  }
  if (resolved.value.kind !== "write") {
    return ok(headers);
  }
  if (isCredentialHeaderName(resolved.value.name)) {
    return err(mutationUnsupported("header-unsafe"));
  }
  const written = writeHeaderValue(
    headers,
    resolved.value.name,
    resolved.value.value,
  );
  if (written.isErr()) {
    return err(written.error);
  }
  return ok(headers);
}

type InternalAttemptLifecycle = "declared" | "requested";

type InternalAttemptRecord = {
  readonly sequence: number;
  readonly generation: number;
  readonly primaryName: string;
  readonly provider: string;
  readonly model: string;
  readonly apiFamily: ProviderFastApiFamily;
  readonly providerFamily: ProviderFastProviderFamily;
  readonly allowlistRuleId: ProviderFastAllowlistRuleId;
  readonly collision: boolean;
  readonly reason: ProviderFastAttemptReason;
  lifecycle: InternalAttemptLifecycle;
};

function attemptError(
  type: ProviderFastAttemptError["type"],
  reason: ProviderFastAttemptErrorReason,
): ProviderFastAttemptError {
  return Object.freeze({ type, reason }) as ProviderFastAttemptError;
}

function copyPublicSnapshot(
  snapshot: ProviderFastAttemptPublicSnapshot,
): ProviderFastAttemptPublicSnapshot {
  return Object.freeze({
    sequence: snapshot.sequence,
    pendingCount: snapshot.pendingCount,
    providerFamily: snapshot.providerFamily,
    apiFamily: snapshot.apiFamily,
    allowlistRuleId: snapshot.allowlistRuleId,
    collision: snapshot.collision,
    state: snapshot.state,
    evidenceKind: snapshot.evidenceKind,
    evidenceOutcome: snapshot.evidenceOutcome,
    reason: snapshot.reason,
  });
}

function copyAttemptToken(
  token: ProviderFastAttemptToken,
): ProviderFastAttemptToken {
  return Object.freeze({ sequence: token.sequence });
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function resolvePositiveBound(
  value: number | undefined,
  fallback: number,
): number {
  if (value === undefined || !isSafeInteger(value) || value < 1) {
    return fallback;
  }
  return value;
}

function isExactApiFamily(value: unknown): value is ProviderFastApiFamily {
  return (
    typeof value === "string" &&
    API_FAMILIES.has(value as ProviderFastApiFamily)
  );
}

function isBeginApiFamily(
  value: unknown,
): value is ProviderFastApiFamily | "none" {
  return value === "none" || isExactApiFamily(value);
}

function isCollisionReason(reason: string): boolean {
  return reason === "request-collision";
}

function readAttemptToken(
  token: unknown,
): Result<number, ProviderFastAttemptError> {
  if (typeof token !== "object" || token === null || Array.isArray(token)) {
    return err(attemptError("InvalidAttemptToken", "forged-token"));
  }
  const prototype = Object.getPrototypeOf(token);
  if (prototype !== Object.prototype && prototype !== null) {
    return err(attemptError("InvalidAttemptToken", "forged-token"));
  }
  const ownKeys = Reflect.ownKeys(token);
  if (ownKeys.length !== 1 || ownKeys[0] !== "sequence") {
    return err(attemptError("InvalidAttemptToken", "forged-token"));
  }
  const descriptor = Object.getOwnPropertyDescriptor(token, "sequence");
  if (
    descriptor === undefined ||
    !("value" in descriptor) ||
    !isSafeInteger(descriptor.value) ||
    descriptor.value < 1
  ) {
    return err(attemptError("InvalidAttemptToken", "forged-token"));
  }
  return ok(descriptor.value);
}

const inspectAttemptToken = Result.fromThrowable(
  (token: unknown) => readAttemptToken(token),
  () => attemptError("InvalidAttemptToken", "forged-token"),
);

function inspectExpireReason(
  reason: unknown,
): Result<ProviderFastAttemptExpireReason, ProviderFastAttemptError> {
  if (
    reason === "cancelled" ||
    reason === "expired" ||
    reason === "generation-superseded" ||
    reason === "reset" ||
    reason === "session-replaced" ||
    reason === "primary-switched"
  ) {
    return ok(reason);
  }
  return err(attemptError("InvalidAttemptInput", "invalid-input"));
}

function inspectGeneration(
  generation: unknown,
): Result<number, ProviderFastAttemptError> {
  if (!isSafeInteger(generation) || generation < 1) {
    return err(attemptError("InvalidAttemptInput", "invalid-input"));
  }
  return ok(generation);
}

type InspectedBeginInput = {
  readonly snapshot: {
    readonly generation: number;
    readonly primaryName: string;
    readonly provider: string;
    readonly model: string;
    readonly fast: true | undefined;
  };
  readonly apiFamily: ProviderFastApiFamily | "none";
  readonly classification: ProviderFastAttemptClassification;
};

function readBeginInput(
  input: unknown,
): Result<InspectedBeginInput, ProviderFastAttemptError> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return err(attemptError("InvalidAttemptInput", "invalid-input"));
  }

  const snapshotValue = Reflect.get(input, "snapshot");
  const apiFamilyValue = Reflect.get(input, "apiFamily");
  const classificationValue = Reflect.get(input, "classification");
  if (!isBeginApiFamily(apiFamilyValue)) {
    return err(attemptError("InvalidAttemptInput", "invalid-input"));
  }
  if (
    typeof snapshotValue !== "object" ||
    snapshotValue === null ||
    Array.isArray(snapshotValue)
  ) {
    return err(attemptError("InvalidAttemptInput", "invalid-input"));
  }
  if (
    typeof classificationValue !== "object" ||
    classificationValue === null ||
    Array.isArray(classificationValue)
  ) {
    return err(attemptError("InvalidAttemptInput", "invalid-input"));
  }

  const generation = Reflect.get(snapshotValue, "generation");
  const primaryName = Reflect.get(snapshotValue, "primaryName");
  const selectedModel = Reflect.get(snapshotValue, "selectedModel");
  const fast = Object.hasOwn(snapshotValue, "fast")
    ? Reflect.get(snapshotValue, "fast")
    : undefined;
  if (!isSafeInteger(generation) || generation < 1) {
    return err(attemptError("InvalidAttemptInput", "invalid-input"));
  }
  if (typeof primaryName !== "string" || primaryName.length === 0) {
    return err(attemptError("InvalidAttemptInput", "invalid-input"));
  }
  if (fast !== undefined && fast !== true) {
    return err(attemptError("InvalidAttemptInput", "invalid-input"));
  }

  let provider = "";
  let model = "";
  if (selectedModel !== undefined) {
    if (
      typeof selectedModel !== "object" ||
      selectedModel === null ||
      Array.isArray(selectedModel)
    ) {
      return err(attemptError("InvalidAttemptInput", "invalid-input"));
    }
    const selectedProvider = Reflect.get(selectedModel, "provider");
    const selectedId = Reflect.get(selectedModel, "id");
    if (typeof selectedProvider !== "string" || selectedProvider.length === 0) {
      return err(attemptError("InvalidAttemptInput", "invalid-input"));
    }
    if (typeof selectedId !== "string" || selectedId.length === 0) {
      return err(attemptError("InvalidAttemptInput", "invalid-input"));
    }
    provider = selectedProvider;
    model = selectedId;
  }

  const kind = Reflect.get(classificationValue, "kind");
  if (kind === "no-intent") {
    return ok({
      snapshot: { generation, primaryName, provider, model, fast },
      apiFamily: apiFamilyValue,
      classification: Object.freeze({ kind: "no-intent" }),
    });
  }
  if (kind === "supported") {
    const providerFamily = Reflect.get(classificationValue, "providerFamily");
    const allowlistRuleId = Reflect.get(classificationValue, "allowlistRuleId");
    if (
      (providerFamily !== "openai" && providerFamily !== "anthropic") ||
      typeof allowlistRuleId !== "string" ||
      !PROVIDER_FAST_ALLOWLIST_RULE_IDS.includes(
        allowlistRuleId as ProviderFastAllowlistRuleId,
      )
    ) {
      return err(attemptError("InvalidAttemptInput", "invalid-input"));
    }
    return ok({
      snapshot: { generation, primaryName, provider, model, fast },
      apiFamily: apiFamilyValue,
      classification: Object.freeze({
        kind: "supported",
        providerFamily,
        allowlistRuleId: allowlistRuleId as ProviderFastAllowlistRuleId,
      }),
    });
  }
  if (kind === "unsupported") {
    const reason = Reflect.get(classificationValue, "reason");
    if (
      typeof reason !== "string" ||
      (!PROVIDER_FAST_UNSUPPORTED_REASONS.includes(
        reason as ProviderFastUnsupportedReason,
      ) &&
        !PROVIDER_FAST_MUTATION_REASONS.includes(
          reason as ProviderFastMutationReason,
        ))
    ) {
      return err(attemptError("InvalidAttemptInput", "invalid-input"));
    }
    return ok({
      snapshot: { generation, primaryName, provider, model, fast },
      apiFamily: apiFamilyValue,
      classification: Object.freeze({
        kind: "unsupported",
        reason: reason as
          | ProviderFastUnsupportedReason
          | ProviderFastMutationReason,
      }),
    });
  }
  return err(attemptError("InvalidAttemptInput", "invalid-input"));
}

const inspectBeginInput = Result.fromThrowable(
  (input: unknown) => readBeginInput(input),
  () => attemptError("InvalidAttemptInput", "invalid-input"),
);

function readResponseStatus(
  observation: unknown,
): Result<number, ProviderFastAttemptError> {
  if (typeof observation !== "object" || observation === null) {
    return err(attemptError("InvalidResponseStatus", "invalid-status"));
  }
  const ownKeys = Reflect.ownKeys(observation);
  if (ownKeys.length !== 1 || ownKeys[0] !== "status") {
    return err(attemptError("InvalidResponseStatus", "invalid-status"));
  }
  const descriptor = Object.getOwnPropertyDescriptor(observation, "status");
  if (
    descriptor === undefined ||
    !("value" in descriptor) ||
    typeof descriptor.value !== "number" ||
    !Number.isInteger(descriptor.value)
  ) {
    return err(attemptError("InvalidResponseStatus", "invalid-status"));
  }
  return ok(descriptor.value);
}

const inspectResponseStatus = Result.fromThrowable(
  (observation: unknown) => readResponseStatus(observation),
  () => attemptError("InvalidResponseStatus", "invalid-status"),
);

/**
 * Instance-owned tracker for one Pi session's provider-fast attempts.
 * Public snapshots never include raw primary, provider, or model strings.
 * Response observation can only settle `not-confirmed`.
 */
export class ProviderFastAttemptTracker {
  private readonly pending = new Map<number, InternalAttemptRecord>();
  private readonly pendingLimit: number;
  private readonly sequenceMax: number;
  private nextSequence = 1;

  constructor(options: ProviderFastAttemptTrackerOptions = {}) {
    this.pendingLimit = resolvePositiveBound(
      options.pendingLimit,
      PROVIDER_FAST_ATTEMPT_PENDING_LIMIT,
    );
    this.sequenceMax = resolvePositiveBound(
      options.sequenceMax,
      PROVIDER_FAST_ATTEMPT_SEQUENCE_MAX,
    );
  }

  begin(
    input: ProviderFastAttemptBeginInput,
  ): Result<ProviderFastAttemptBeginResult, ProviderFastAttemptError> {
    const inspected = inspectBeginInput(input);
    if (inspected.isErr()) {
      return err(inspected.error);
    }
    if (inspected.value.isErr()) {
      return err(inspected.value.error);
    }

    const { snapshot, apiFamily, classification } = inspected.value.value;
    if (classification.kind === "no-intent" || snapshot.fast !== true) {
      return ok(
        Object.freeze({
          kind: "no-state",
          pendingCount: this.pending.size,
        }),
      );
    }

    if (this.nextSequence > this.sequenceMax) {
      return err(attemptError("AttemptSequenceOverflow", "sequence-overflow"));
    }

    const sequence = this.nextSequence;
    this.nextSequence += 1;

    if (classification.kind === "unsupported") {
      return ok(
        Object.freeze({
          kind: "unsupported",
          snapshot: this.publicSnapshot({
            sequence,
            providerFamily: "none",
            apiFamily,
            allowlistRuleId: "none",
            collision: isCollisionReason(classification.reason),
            state: "unsupported",
            evidenceKind: "none",
            evidenceOutcome: "none",
            reason: classification.reason,
          }),
        }),
      );
    }

    if (!isExactApiFamily(apiFamily)) {
      this.nextSequence -= 1;
      return err(attemptError("InvalidAttemptInput", "invalid-input"));
    }

    if (this.pending.size >= this.pendingLimit) {
      this.nextSequence -= 1;
      return err(
        attemptError("AttemptCapacityExceeded", "pending-capacity-exceeded"),
      );
    }

    const record: InternalAttemptRecord = {
      sequence,
      generation: snapshot.generation,
      primaryName: snapshot.primaryName,
      provider: snapshot.provider,
      model: snapshot.model,
      apiFamily,
      providerFamily: classification.providerFamily,
      allowlistRuleId: classification.allowlistRuleId,
      collision: false,
      reason: "none",
      lifecycle: "declared",
    };
    this.pending.set(sequence, record);
    return ok(
      Object.freeze({
        kind: "pending",
        token: copyAttemptToken({ sequence }),
        snapshot: this.snapshotFromRecord(record, "declared"),
      }),
    );
  }

  markRequested(
    token: ProviderFastAttemptToken,
  ): Result<ProviderFastAttemptPublicSnapshot, ProviderFastAttemptError> {
    const recordResult = this.requirePending(token);
    if (recordResult.isErr()) {
      return err(recordResult.error);
    }
    const record = recordResult.value;
    if (record.lifecycle !== "declared") {
      return err(
        record.lifecycle === "requested"
          ? attemptError("DuplicateAttemptToken", "duplicate-token")
          : attemptError("OutOfOrderAttempt", "out-of-order"),
      );
    }
    record.lifecycle = "requested";
    return ok(this.snapshotFromRecord(record, "requested"));
  }

  observeResponse(
    token: ProviderFastAttemptToken,
    observation: { readonly status: number },
  ): Result<ProviderFastAttemptPublicSnapshot, ProviderFastAttemptError> {
    const status = inspectResponseStatus(observation);
    if (status.isErr()) {
      return err(status.error);
    }
    if (status.value.isErr()) {
      return err(status.value.error);
    }
    const recordResult = this.requirePending(token);
    if (recordResult.isErr()) {
      return err(recordResult.error);
    }
    const record = recordResult.value;
    if (record.lifecycle !== "requested") {
      return err(attemptError("OutOfOrderAttempt", "out-of-order"));
    }
    this.pending.delete(record.sequence);
    return ok(
      this.snapshotFromRecord(record, "not-confirmed", {
        evidenceKind: "response-status",
        evidenceOutcome: "unavailable",
        reason: "response-body-evidence-unavailable",
      }),
    );
  }

  cancel(
    token: ProviderFastAttemptToken,
    reason: ProviderFastAttemptExpireReason,
  ): Result<ProviderFastAttemptPublicSnapshot, ProviderFastAttemptError> {
    return this.expire(token, reason);
  }

  expire(
    token: ProviderFastAttemptToken,
    reason: ProviderFastAttemptExpireReason,
  ): Result<ProviderFastAttemptPublicSnapshot, ProviderFastAttemptError> {
    const expireReason = inspectExpireReason(reason);
    if (expireReason.isErr()) {
      return err(expireReason.error);
    }
    const recordResult = this.requirePending(token);
    if (recordResult.isErr()) {
      return err(recordResult.error);
    }
    const record = recordResult.value;
    this.pending.delete(record.sequence);
    return ok(
      this.snapshotFromRecord(record, record.lifecycle, {
        reason: expireReason.value,
      }),
    );
  }

  expireGeneration(
    generation: number,
  ): Result<{ readonly expiredCount: number }, ProviderFastAttemptError> {
    const inspected = inspectGeneration(generation);
    if (inspected.isErr()) {
      return err(inspected.error);
    }
    let expiredCount = 0;
    for (const [sequence, record] of this.pending) {
      if (record.generation === inspected.value) {
        this.pending.delete(sequence);
        expiredCount += 1;
      }
    }
    return ok(Object.freeze({ expiredCount }));
  }

  reset(): Result<{ readonly expiredCount: number }, never> {
    const expiredCount = this.pending.size;
    this.pending.clear();
    return ok(Object.freeze({ expiredCount }));
  }

  pendingCount(): number {
    return this.pending.size;
  }

  private requirePending(
    token: unknown,
  ): Result<InternalAttemptRecord, ProviderFastAttemptError> {
    const sequence = inspectAttemptToken(token);
    if (sequence.isErr()) {
      return err(sequence.error);
    }
    if (sequence.value.isErr()) {
      return err(sequence.value.error);
    }
    const record = this.pending.get(sequence.value.value);
    if (record === undefined) {
      if (sequence.value.value >= this.nextSequence) {
        return err(attemptError("InvalidAttemptToken", "forged-token"));
      }
      return err(attemptError("StaleAttemptToken", "stale-token"));
    }
    return ok(record);
  }

  private snapshotFromRecord(
    record: InternalAttemptRecord,
    state: ProviderFastAttemptState,
    extras: {
      readonly evidenceKind?: ProviderFastAttemptEvidenceKind;
      readonly evidenceOutcome?: ProviderFastAttemptEvidenceOutcome;
      readonly reason?: ProviderFastAttemptReason;
    } = {},
  ): ProviderFastAttemptPublicSnapshot {
    return this.publicSnapshot({
      sequence: record.sequence,
      providerFamily: record.providerFamily,
      apiFamily: record.apiFamily,
      allowlistRuleId: record.allowlistRuleId,
      collision: record.collision,
      state,
      evidenceKind: extras.evidenceKind ?? "none",
      evidenceOutcome: extras.evidenceOutcome ?? "none",
      reason: extras.reason ?? record.reason,
    });
  }

  private publicSnapshot(
    snapshot: Omit<ProviderFastAttemptPublicSnapshot, "pendingCount">,
  ): ProviderFastAttemptPublicSnapshot {
    return copyPublicSnapshot({
      ...snapshot,
      pendingCount: this.pending.size,
    });
  }
}

export const PROVIDER_FAST_HOST_API_TABLE = Object.freeze({
  "openai-responses": "openai-responses",
  "openai-completions": "openai-completions",
  "anthropic-messages": "anthropic-messages",
} as const);

export type ProviderFastHostApi = keyof typeof PROVIDER_FAST_HOST_API_TABLE;

export type ProviderFastCoordinatorSnapshot = {
  readonly generation: number;
  readonly primaryName: string;
  readonly selectedModel?:
    | {
        readonly provider: string;
        readonly id: string;
        readonly name?: string;
        readonly api?: string;
      }
    | undefined;
  readonly fast?: true;
};

export type ProviderFastCoordinatorError =
  | ProviderFastAttemptError
  | {
      readonly type: "AmbiguousFastAttempt";
      readonly reason: "out-of-order";
    };

export type ProviderFastCoordinatorHeadersResult =
  | {
      readonly kind: "no-state";
    }
  | {
      readonly kind: "unsupported";
      readonly snapshot: ProviderFastAttemptPublicSnapshot;
    }
  | {
      readonly kind: "pending";
      readonly token: ProviderFastAttemptToken;
      readonly snapshot: ProviderFastAttemptPublicSnapshot;
    };

export type ProviderFastCoordinatorRequestResult = {
  readonly payload: unknown;
  readonly snapshot: ProviderFastAttemptPublicSnapshot;
};

type ActiveCoordinatorAttempt = {
  readonly token: ProviderFastAttemptToken;
  readonly snapshot: ProviderFastCoordinatorSnapshot;
};

const EMPTY_COORDINATOR_SNAPSHOT: ProviderFastAttemptPublicSnapshot =
  Object.freeze({
    sequence: 0,
    pendingCount: 0,
    providerFamily: "none",
    apiFamily: "none",
    allowlistRuleId: "none",
    collision: false,
    state: "unsupported",
    evidenceKind: "none",
    evidenceOutcome: "none",
    reason: "none",
  });

function coordinatorError(
  type: ProviderFastCoordinatorError["type"],
  reason: ProviderFastCoordinatorError["reason"],
): ProviderFastCoordinatorError {
  return Object.freeze({ type, reason }) as ProviderFastCoordinatorError;
}

function mapHostApiFamily(api: unknown): ProviderFastApiFamily | "none" {
  if (typeof api !== "string") {
    return "none";
  }
  if (Object.hasOwn(PROVIDER_FAST_HOST_API_TABLE, api)) {
    return PROVIDER_FAST_HOST_API_TABLE[api as ProviderFastHostApi];
  }
  return "none";
}

function copyCoordinatorSnapshot(
  snapshot: ProviderFastCoordinatorSnapshot,
): Result<ProviderFastCoordinatorSnapshot, ProviderFastCoordinatorError> {
  if (
    typeof snapshot !== "object" ||
    snapshot === null ||
    Array.isArray(snapshot)
  ) {
    return err(attemptError("InvalidAttemptInput", "invalid-input"));
  }
  const generation = Reflect.get(snapshot, "generation");
  const primaryName = Reflect.get(snapshot, "primaryName");
  if (!isSafeInteger(generation) || generation < 1) {
    return err(attemptError("InvalidAttemptInput", "invalid-input"));
  }
  if (typeof primaryName !== "string" || primaryName.length === 0) {
    return err(attemptError("InvalidAttemptInput", "invalid-input"));
  }
  const fast = Object.hasOwn(snapshot, "fast")
    ? Reflect.get(snapshot, "fast")
    : undefined;
  if (fast !== undefined && fast !== true) {
    return err(attemptError("InvalidAttemptInput", "invalid-input"));
  }

  const selectedModel = Object.hasOwn(snapshot, "selectedModel")
    ? Reflect.get(snapshot, "selectedModel")
    : undefined;
  if (selectedModel === undefined) {
    return ok(
      Object.freeze({
        generation,
        primaryName,
        ...(fast === true ? { fast: true as const } : {}),
      }),
    );
  }
  if (
    typeof selectedModel !== "object" ||
    selectedModel === null ||
    Array.isArray(selectedModel)
  ) {
    return err(attemptError("InvalidAttemptInput", "invalid-input"));
  }
  const provider = Reflect.get(selectedModel, "provider");
  const id = Reflect.get(selectedModel, "id");
  if (typeof provider !== "string" || provider.length === 0) {
    return err(attemptError("InvalidAttemptInput", "invalid-input"));
  }
  if (typeof id !== "string" || id.length === 0) {
    return err(attemptError("InvalidAttemptInput", "invalid-input"));
  }
  const name = Object.hasOwn(selectedModel, "name")
    ? Reflect.get(selectedModel, "name")
    : undefined;
  if (name !== undefined && typeof name !== "string") {
    return err(attemptError("InvalidAttemptInput", "invalid-input"));
  }
  const api = Object.hasOwn(selectedModel, "api")
    ? Reflect.get(selectedModel, "api")
    : undefined;
  if (api !== undefined && typeof api !== "string") {
    return err(attemptError("InvalidAttemptInput", "invalid-input"));
  }
  return ok(
    Object.freeze({
      generation,
      primaryName,
      selectedModel: Object.freeze({
        provider,
        id,
        ...(name === undefined ? {} : { name }),
        ...(api === undefined ? {} : { api }),
      }),
      ...(fast === true ? { fast: true as const } : {}),
    }),
  );
}

const inspectCoordinatorSnapshot = Result.fromThrowable(
  (snapshot: unknown) =>
    copyCoordinatorSnapshot(snapshot as ProviderFastCoordinatorSnapshot),
  () => attemptError("InvalidAttemptInput", "invalid-input"),
);

function coordinatorSnapshotsMatch(
  left: ProviderFastCoordinatorSnapshot,
  right: ProviderFastCoordinatorSnapshot,
): boolean {
  if (
    left.generation !== right.generation ||
    left.primaryName !== right.primaryName ||
    left.fast !== right.fast
  ) {
    return false;
  }
  const leftModel = left.selectedModel;
  const rightModel = right.selectedModel;
  if (leftModel === undefined || rightModel === undefined) {
    return leftModel === rightModel;
  }
  return (
    leftModel.provider === rightModel.provider &&
    leftModel.id === rightModel.id &&
    leftModel.name === rightModel.name &&
    leftModel.api === rightModel.api
  );
}

function classifyCoordinatorSnapshot(
  snapshot: ProviderFastCoordinatorSnapshot,
): Result<ProviderFastActivationSuccess, ProviderFastUnsupported> {
  if (snapshot.fast !== true) {
    return ok(NO_INTENT);
  }
  const selectedModel = snapshot.selectedModel;
  const apiFamily = mapHostApiFamily(selectedModel?.api);
  if (apiFamily === "none") {
    return err(unsupported("endpoint-not-allowed"));
  }
  return classifyProviderFastActivation({
    fast: true,
    provider: selectedModel?.provider ?? "",
    apiFamily,
    model: selectedModel?.id ?? "",
  });
}

function classificationFromResult(
  result: Result<ProviderFastActivationSuccess, ProviderFastUnsupported>,
): ProviderFastActivationClassification {
  return result.match(
    (value) => value,
    (error) => error,
  );
}

function toTrackerSnapshot(
  snapshot: ProviderFastCoordinatorSnapshot,
): ProviderFastAttemptRequestSnapshot {
  return {
    generation: snapshot.generation,
    primaryName: snapshot.primaryName,
    ...(snapshot.selectedModel === undefined
      ? {}
      : {
          selectedModel: {
            provider: snapshot.selectedModel.provider,
            id: snapshot.selectedModel.id,
            ...(snapshot.selectedModel.name === undefined
              ? {}
              : { name: snapshot.selectedModel.name }),
          },
        }),
    ...(snapshot.fast === true ? { fast: true as const } : {}),
  };
}

function applyCoordinatorHeaders(
  classification: ProviderFastActivationClassification,
  headers: object,
): Result<object, ProviderFastMutationUnsupported> {
  return applyAnthropicProviderFastHeaders(classification, headers);
}

function applyCoordinatorPayload(
  classification: ProviderFastActivationClassification,
  payload: unknown,
): Result<unknown, ProviderFastMutationUnsupported> {
  if (shouldLeaveRequestUnchanged(classification)) {
    return ok(payload);
  }
  if (isSupportedFamily(classification, "openai")) {
    return applyOpenAiProviderFastPayload(classification, payload);
  }
  if (isSupportedFamily(classification, "anthropic")) {
    return applyAnthropicProviderFastPayload(classification, payload);
  }
  return err(mutationUnsupported("payload-malformed"));
}

function beginClassificationForTracker(
  classification: ProviderFastActivationClassification,
  mutation?: ProviderFastMutationUnsupported,
): ProviderFastAttemptClassification {
  if (mutation !== undefined) {
    return mutation;
  }
  return classification;
}

/**
 * Instance-owned three-phase coordinator for one Pi session. Pi has no
 * request ID, so only one sequence may be active. Overlap, token mismatch,
 * snapshot mismatch, and generation/primary switches fail closed.
 */
export class ProviderFastCoordinator {
  private readonly tracker = new ProviderFastAttemptTracker({
    pendingLimit: 1,
  });
  private active: ActiveCoordinatorAttempt | undefined;
  private latestSnapshot: ProviderFastAttemptPublicSnapshot =
    EMPTY_COORDINATOR_SNAPSHOT;

  beginHeaders(
    snapshot: ProviderFastCoordinatorSnapshot,
    headers: object,
  ): Result<
    ProviderFastCoordinatorHeadersResult,
    ProviderFastCoordinatorError
  > {
    const inspected = inspectCoordinatorSnapshot(snapshot);
    if (inspected.isErr()) {
      return this.failClosed(inspected.error);
    }
    if (inspected.value.isErr()) {
      return this.failClosed(inspected.value.error);
    }
    const copied = inspected.value.value;
    if (this.active !== undefined) {
      return this.failClosed(
        coordinatorError("AmbiguousFastAttempt", "out-of-order"),
      );
    }

    const classified = classifyCoordinatorSnapshot(copied);
    const classification = classificationFromResult(classified);
    const headerResult = applyCoordinatorHeaders(classification, headers);
    const trackerClassification = beginClassificationForTracker(
      classification,
      headerResult.isErr() ? headerResult.error : undefined,
    );
    const begun = this.tracker.begin({
      snapshot: toTrackerSnapshot(copied),
      apiFamily: mapHostApiFamily(copied.selectedModel?.api),
      classification: trackerClassification,
    });
    if (begun.isErr()) {
      return this.failClosed(begun.error);
    }
    if (begun.value.kind === "no-state") {
      return ok(Object.freeze({ kind: "no-state" }));
    }
    if (begun.value.kind === "unsupported") {
      this.latestSnapshot = begun.value.snapshot;
      return ok(
        Object.freeze({
          kind: "unsupported",
          snapshot: begun.value.snapshot,
        }),
      );
    }
    this.active = {
      token: begun.value.token,
      snapshot: copied,
    };
    this.latestSnapshot = begun.value.snapshot;
    return ok(
      Object.freeze({
        kind: "pending",
        token: begun.value.token,
        snapshot: begun.value.snapshot,
      }),
    );
  }

  applyRequest(
    snapshot: ProviderFastCoordinatorSnapshot,
    token: ProviderFastAttemptToken,
    payload: unknown,
  ): Result<
    ProviderFastCoordinatorRequestResult,
    ProviderFastCoordinatorError
  > {
    const inspected = inspectCoordinatorSnapshot(snapshot);
    if (inspected.isErr()) {
      return this.failClosed(inspected.error);
    }
    if (inspected.value.isErr()) {
      return this.failClosed(inspected.value.error);
    }
    const copied = inspected.value.value;
    const active = this.active;
    if (active === undefined) {
      return this.failClosed(
        coordinatorError("AmbiguousFastAttempt", "out-of-order"),
      );
    }
    const sequence = inspectAttemptToken(token);
    if (sequence.isErr()) {
      return this.failClosed(sequence.error);
    }
    if (sequence.value.isErr()) {
      return this.failClosed(sequence.value.error);
    }
    if (sequence.value.value !== active.token.sequence) {
      return this.failClosed(
        sequence.value.value > active.token.sequence
          ? attemptError("InvalidAttemptToken", "forged-token")
          : attemptError("StaleAttemptToken", "stale-token"),
      );
    }
    if (!coordinatorSnapshotsMatch(copied, active.snapshot)) {
      let expireReason: ProviderFastAttemptExpireReason | undefined;
      if (copied.generation !== active.snapshot.generation) {
        expireReason = "generation-superseded";
      } else if (copied.primaryName !== active.snapshot.primaryName) {
        expireReason = "primary-switched";
      }
      if (expireReason !== undefined) {
        this.tracker.expire(active.token, expireReason);
      }
      return this.failClosed(
        coordinatorError("AmbiguousFastAttempt", "out-of-order"),
      );
    }

    const classified = classifyCoordinatorSnapshot(copied);
    const classification = classificationFromResult(classified);
    const mutated = applyCoordinatorPayload(classification, payload);
    if (mutated.isErr()) {
      this.tracker.expire(active.token, "cancelled");
      return this.failClosed(
        coordinatorError("AmbiguousFastAttempt", "out-of-order"),
      );
    }
    const requested = this.tracker.markRequested(active.token);
    if (requested.isErr()) {
      return this.failClosed(requested.error);
    }
    this.latestSnapshot = requested.value;
    return ok(
      Object.freeze({
        payload: mutated.value,
        snapshot: requested.value,
      }),
    );
  }

  observeResponse(
    token: ProviderFastAttemptToken,
    status: number,
  ): Result<ProviderFastAttemptPublicSnapshot, ProviderFastCoordinatorError> {
    const active = this.active;
    if (active === undefined) {
      return this.failClosed(
        coordinatorError("AmbiguousFastAttempt", "out-of-order"),
      );
    }
    const sequence = inspectAttemptToken(token);
    if (sequence.isErr()) {
      return this.failClosed(sequence.error);
    }
    if (sequence.value.isErr()) {
      return this.failClosed(sequence.value.error);
    }
    if (sequence.value.value !== active.token.sequence) {
      return this.failClosed(
        sequence.value.value > active.token.sequence
          ? attemptError("InvalidAttemptToken", "forged-token")
          : attemptError("StaleAttemptToken", "stale-token"),
      );
    }
    const observed = this.tracker.observeResponse(token, { status });
    if (observed.isErr()) {
      return this.failClosed(observed.error);
    }
    this.active = undefined;
    this.latestSnapshot = observed.value;
    return ok(observed.value);
  }

  reset(): Result<{ readonly expiredCount: number }, never> {
    const reset = this.tracker.reset();
    this.active = undefined;
    this.latestSnapshot = EMPTY_COORDINATOR_SNAPSHOT;
    return reset;
  }

  latest(): ProviderFastAttemptPublicSnapshot {
    return copyPublicSnapshot(this.latestSnapshot);
  }

  private failClosed(
    error: ProviderFastCoordinatorError,
  ): Result<never, ProviderFastCoordinatorError> {
    this.tracker.reset();
    this.active = undefined;
    this.latestSnapshot = EMPTY_COORDINATOR_SNAPSHOT;
    return err(error);
  }
}
