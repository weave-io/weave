import { err, ok, Result } from "neverthrow";

/**
 * Exact allowlist classifier and stateless request mutation for Pi
 * provider-fast activation.
 *
 * Classification never copies caller strings. Mutation copies only a bounded
 * own-data payload graph, or applies one planned Anthropic header write after
 * the full map validates. Diagnostics carry closed reason codes only.
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
