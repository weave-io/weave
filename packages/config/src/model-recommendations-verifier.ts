/**
 * Verifies published model recommendations (Spec 39): size, envelope shape,
 * Ed25519 signature, list schema and freshness, in that order.
 *
 * The signature is checked with WebCrypto (`crypto.subtle`, Ed25519) over the
 * exact UTF-8 bytes of the envelope's `payload`, so a reader never pairs a list
 * with a signature over different bytes. Keys and the clock are injected, so
 * tests use their own throwaway key pair and a fixed time.
 */

import type { ModelUpdatesChannel } from "@weaveio/weave-core";
import { err, errAsync, ok, okAsync, Result, ResultAsync } from "neverthrow";
import { BUILTIN_MODELS_ISSUED } from "./builtins.js";
import {
  formatModelRecommendationsIssues,
  MAX_MODEL_RECOMMENDATIONS_BYTES,
  MAX_MODEL_RECOMMENDATIONS_ISSUED_SKEW_MS,
  type ModelRecommendationsEnvelope,
  ModelRecommendationsEnvelopeSchema,
  type ModelRecommendationsError,
  type ModelRecommendationsFile,
  ModelRecommendationsFileSchema,
} from "./model-recommendations.js";
import { MODEL_RECOMMENDATIONS_PUBLIC_KEYS } from "./model-recommendations-keys.js";

const ED25519 = { name: "Ed25519" } as const;
const ED25519_PUBLIC_KEY_BYTES = 32;
const ED25519_SIGNATURE_BYTES = 64;
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

/** What the client already knows when it checks a list. */
export interface ModelRecommendationsFreshnessContext {
  /** The channel the client asked for. Unset skips the channel check. */
  readonly channel?: ModelUpdatesChannel;
  /** `issued` of the list the client already applied. Unset: none applied. */
  readonly appliedIssued?: string;
  /**
   * The client's version, compared with `min_config_version`. Unset skips the
   * check (for example, `weave models check` on the publishing side).
   */
  readonly clientVersion?: string;
}

/** Injected dependencies. Defaults are the production keys and clock. */
export interface ModelRecommendationsVerifierDeps {
  /** Raw Ed25519 public keys, base64. Any one of them may sign. */
  readonly publicKeys?: readonly string[];
  /** The current time. */
  readonly now?: () => Date;
  /** The builtin models baseline; tests may move it. */
  readonly builtinModelsIssued?: string;
}

/** Decode strict base64 (no whitespace, correct padding) into bytes. */
export function decodeBase64(
  value: string,
): Result<Uint8Array<ArrayBuffer>, string> {
  if (value.length % 4 !== 0 || !BASE64_PATTERN.test(value))
    return err("not base64");
  const decode = Result.fromThrowable(
    () => Uint8Array.from(atob(value), (c) => c.charCodeAt(0)),
    () => "not base64",
  );
  return decode();
}

/** Encode bytes as base64. */
export function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function utf8(text: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(text) as Uint8Array<ArrayBuffer>;
}

function parseJson(text: string): Result<unknown, string> {
  const parse = Result.fromThrowable(
    (): unknown => JSON.parse(text),
    (cause) => (cause instanceof Error ? cause.message : "not JSON"),
  );
  return parse();
}

function sizeCheck(text: string): Result<string, ModelRecommendationsError> {
  const bytes = utf8(text).byteLength;
  if (bytes > MAX_MODEL_RECOMMENDATIONS_BYTES)
    return err({
      type: "TooLarge",
      bytes,
      limit: MAX_MODEL_RECOMMENDATIONS_BYTES,
    });
  return ok(text);
}

/**
 * Checks published model recommendations. Never throws: every failure is a
 * typed `ModelRecommendationsError`.
 */
export class ModelRecommendationsVerifier {
  private readonly publicKeys: readonly string[];
  private readonly now: () => Date;
  private readonly builtinModelsIssued: string;

  constructor(deps: ModelRecommendationsVerifierDeps = {}) {
    this.publicKeys = deps.publicKeys ?? MODEL_RECOMMENDATIONS_PUBLIC_KEYS;
    this.now = deps.now ?? (() => new Date());
    this.builtinModelsIssued =
      deps.builtinModelsIssued ?? BUILTIN_MODELS_ISSUED;
  }

  /**
   * Verify a served envelope end to end: size, shape, signature, schema and
   * freshness. Returns the list only when every check passes.
   */
  verifyEnvelope(
    text: string,
    context: ModelRecommendationsFreshnessContext = {},
  ): ResultAsync<ModelRecommendationsFile, ModelRecommendationsError> {
    const envelope = this.parseEnvelope(text);
    if (envelope.isErr()) return errAsync(envelope.error);
    return this.verifySignature(envelope.value).andThen((payload) =>
      this.parseList(payload).andThen((file) =>
        this.checkFreshness(file, context),
      ),
    );
  }

  /** Validate an unsigned list: size, schema and freshness. No signature. */
  validateList(
    text: string,
    context: ModelRecommendationsFreshnessContext = {},
  ): Result<ModelRecommendationsFile, ModelRecommendationsError> {
    return this.parseList(text).andThen((file) =>
      this.checkFreshness(file, context),
    );
  }

  /** Size and shape of a served envelope. */
  parseEnvelope(
    text: string,
  ): Result<ModelRecommendationsEnvelope, ModelRecommendationsError> {
    return sizeCheck(text).andThen(
      (
        checked,
      ): Result<ModelRecommendationsEnvelope, ModelRecommendationsError> => {
        const json = parseJson(checked);
        if (json.isErr())
          return err({
            type: "EnvelopeInvalid",
            message: json.error,
          });
        const parsed = ModelRecommendationsEnvelopeSchema.safeParse(json.value);
        if (!parsed.success)
          return err({
            type: "EnvelopeInvalid",
            message: formatModelRecommendationsIssues(parsed.error).join("; "),
          });
        return ok(parsed.data);
      },
    );
  }

  /** Size, JSON and schema of a list. Freshness is separate. */
  parseList(
    text: string,
  ): Result<ModelRecommendationsFile, ModelRecommendationsError> {
    return sizeCheck(text).andThen(
      (
        checked,
      ): Result<ModelRecommendationsFile, ModelRecommendationsError> => {
        const json = parseJson(checked);
        if (json.isErr())
          return err({
            type: "SchemaInvalid",
            issues: [`not JSON: ${json.error}`],
          });
        const parsed = ModelRecommendationsFileSchema.safeParse(json.value);
        if (!parsed.success)
          return err({
            type: "SchemaInvalid",
            issues: formatModelRecommendationsIssues(parsed.error),
          });
        return ok(parsed.data);
      },
    );
  }

  /**
   * Verify `sig` over the exact UTF-8 bytes of `payload` against every known
   * key, and return the payload when one of them signed it.
   */
  verifySignature(
    envelope: ModelRecommendationsEnvelope,
  ): ResultAsync<string, ModelRecommendationsError> {
    const signature = decodeBase64(envelope.sig);
    if (
      signature.isErr() ||
      signature.value.byteLength !== ED25519_SIGNATURE_BYTES
    )
      return errAsync({
        type: "SignatureInvalid",
        message: "sig is not a base64 Ed25519 signature",
      });
    if (this.publicKeys.length === 0)
      return errAsync({ type: "KeyInvalid", message: "no public keys" });

    const bytes = utf8(envelope.payload);
    const sig = signature.value;
    let verified: ResultAsync<boolean, ModelRecommendationsError> =
      okAsync(false);
    for (const key of this.publicKeys) {
      verified = verified.andThen((found) =>
        found ? okAsync(true) : this.verifyWithKey(key, sig, bytes),
      );
    }
    return verified.andThen((found) => {
      if (!found)
        return errAsync<string, ModelRecommendationsError>({
          type: "SignatureInvalid",
          message: "no known key signed this payload",
        });
      return okAsync<string, ModelRecommendationsError>(envelope.payload);
    });
  }

  /**
   * The checks that depend on what the client knows: channel, client version,
   * expiry, a mis-dated `issued`, the builtin baseline and rollback.
   */
  checkFreshness(
    file: ModelRecommendationsFile,
    context: ModelRecommendationsFreshnessContext = {},
  ): Result<ModelRecommendationsFile, ModelRecommendationsError> {
    if (context.channel !== undefined && file.channel !== context.channel)
      return err({
        type: "ChannelMismatch",
        expected: context.channel,
        actual: file.channel,
      });
    const required = file.min_config_version;
    if (
      required !== undefined &&
      context.clientVersion !== undefined &&
      Bun.semver.order(context.clientVersion, required) < 0
    )
      return err({
        type: "ClientTooOld",
        required,
        actual: context.clientVersion,
      });

    const now = this.now();
    const nowMs = now.getTime();
    const issuedMs = Date.parse(file.issued);
    if (Date.parse(file.expires) <= nowMs)
      return err({
        type: "Expired",
        expires: file.expires,
        now: now.toISOString(),
      });
    if (issuedMs - nowMs > MAX_MODEL_RECOMMENDATIONS_ISSUED_SKEW_MS)
      return err({
        type: "IssuedInFuture",
        issued: file.issued,
        now: now.toISOString(),
      });
    if (issuedMs < Date.parse(this.builtinModelsIssued))
      return err({
        type: "OlderThanBuiltins",
        issued: file.issued,
        builtinsIssued: this.builtinModelsIssued,
      });
    const applied = context.appliedIssued;
    if (applied !== undefined && issuedMs <= Date.parse(applied))
      return err({
        type: "NotNewer",
        issued: file.issued,
        appliedIssued: applied,
      });
    return ok(file);
  }

  private verifyWithKey(
    key: string,
    signature: Uint8Array<ArrayBuffer>,
    bytes: Uint8Array<ArrayBuffer>,
  ): ResultAsync<boolean, ModelRecommendationsError> {
    const raw = decodeBase64(key);
    if (raw.isErr() || raw.value.byteLength !== ED25519_PUBLIC_KEY_BYTES)
      return errAsync({
        type: "KeyInvalid",
        message: "a public key is not a base64 raw Ed25519 key",
      });
    return ResultAsync.fromPromise(
      crypto.subtle.importKey("raw", raw.value, ED25519, false, ["verify"]),
      (): ModelRecommendationsError => ({
        type: "KeyInvalid",
        message: "a public key could not be imported",
      }),
    ).andThen((publicKey) =>
      ResultAsync.fromPromise(
        crypto.subtle.verify(ED25519, publicKey, signature, bytes),
        (): ModelRecommendationsError => ({
          type: "SignatureInvalid",
          message: "verification failed",
        }),
      ),
    );
  }
}

/** Why an envelope could not be signed. */
export type ModelRecommendationsSignError =
  | { readonly type: "PrivateKeyInvalid"; readonly message: string }
  | { readonly type: "SignFailed"; readonly message: string };

/**
 * Build a signed envelope for `payload`, the exact list text, with an Ed25519
 * private key in PKCS #8 form, base64. Used by `scripts/models/sign.ts` and by
 * tests with a throwaway key. Returns the envelope's JSON text.
 */
export function signModelRecommendations(
  payload: string,
  privateKeyPkcs8: string,
): ResultAsync<string, ModelRecommendationsSignError> {
  const raw = decodeBase64(privateKeyPkcs8.trim());
  if (raw.isErr())
    return errAsync({
      type: "PrivateKeyInvalid",
      message: "the private key is not base64",
    });
  return ResultAsync.fromPromise(
    crypto.subtle.importKey("pkcs8", raw.value, ED25519, false, ["sign"]),
    (): ModelRecommendationsSignError => ({
      type: "PrivateKeyInvalid",
      message: "the private key is not a PKCS #8 Ed25519 key",
    }),
  )
    .andThen((privateKey) =>
      ResultAsync.fromPromise(
        crypto.subtle.sign(ED25519, privateKey, utf8(payload)),
        (cause): ModelRecommendationsSignError => ({
          type: "SignFailed",
          message: cause instanceof Error ? cause.message : "signing failed",
        }),
      ),
    )
    .map((signature) =>
      JSON.stringify({
        payload,
        sig: encodeBase64(new Uint8Array(signature)),
      }),
    );
}
