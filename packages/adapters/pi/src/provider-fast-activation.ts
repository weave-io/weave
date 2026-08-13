import { err, ok, type Result } from "neverthrow";

/**
 * Exact allowlist classifier for Pi provider-fast activation.
 *
 * This module decides only whether a request may later receive an official
 * fast control. It does not mutate payloads or headers, and it never copies
 * caller strings into the result.
 */

export const PROVIDER_FAST_INPUT_MAX_LENGTH = 128;

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

export type ProviderFastActivationSuccess =
  | ProviderFastNoIntent
  | ProviderFastSupported;

export type ProviderFastActivationClassification =
  | ProviderFastActivationSuccess
  | ProviderFastUnsupported;

const NO_INTENT: ProviderFastNoIntent = Object.freeze({ kind: "no-intent" });

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

function unsupported(
  reason: ProviderFastUnsupportedReason,
): ProviderFastUnsupported {
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
