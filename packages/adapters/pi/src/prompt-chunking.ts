/**
 * Parent-to-child prompt chunking — a thin adapter over the shared bounded
 * transfer module (`child-transfer.ts`, spec 33 §3).
 *
 * Weave keeps generated prompt commands below the native record cap so they
 * remain cheap to frame and inspect. A larger logical prompt is split into an
 * acknowledged chunked transfer that only the private child extension
 * reassembles; ordinary prompts remain ordinary Pi records.
 *
 * This module exists only to keep the prompt call sites' wire shape (the
 * `weave-prompt-chunk` tag and the `/weave:__prompt_chunk__` command) stable.
 * All bounding — per-chunk decoded bytes, aggregate bytes, chunk count, and
 * concurrent transfers — lives in the shared module, so the prompt path can
 * no longer be the one that forgets a cap.
 */
import { err, ok, type Result } from "neverthrow";
import {
  ChunkTransferAssembler,
  encodeTransferChunks,
  type TransferChunk,
  type TransferRejectionReason,
} from "./child-transfer.js";
import { PI_TRANSPORT_LIMITS } from "./errors.js";
import { parseStrictJson, type JsonValue } from "./strict-json.js";

export const PROMPT_CHUNK_COMMAND = "/weave:__prompt_chunk__";
/** Largest native Pi record Weave will emit for a prompt. Not the transfer cap. */
export const MAX_OUTBOUND_PROMPT_RECORD_BYTES = 1024 * 1024;

export interface PromptChunk extends TransferChunk {
  readonly type: "weave-prompt-chunk";
}

export type PromptChunkError =
  | { readonly type: "InvalidChunk"; readonly reason: string }
  | { readonly type: "InvalidBase64" };

export type PromptTransferNackReason =
  | TransferRejectionReason
  | "malformed-chunk";

export function promptTransferNackReason(
  error: PromptChunkError,
): PromptTransferNackReason {
  if (error.type === "InvalidBase64") return "invalid-base64";
  switch (error.reason) {
    case "invalid-transfer-id":
    case "invalid-total":
    case "invalid-index":
    case "invalid-base64":
    case "duplicate-index":
    case "total-mismatch":
    case "chunk-too-large":
    case "aggregate-too-large":
    case "too-many-transfers":
    case "missing-index":
      return error.reason;
    default:
      return "malformed-chunk";
  }
}

/**
 * Splits `task` into tagged prompt chunks, bounded by every shared cap.
 *
 * An unsendable prompt surfaces here as a typed error rather than as a child
 * that silently receives nothing and later times out waiting to settle.
 */
export function encodePromptChunksBounded(
  task: string,
  transferId: string,
): Result<readonly PromptChunk[], PromptChunkError> {
  const encoded = encodeTransferChunks(task, transferId);
  if (encoded.isErr()) {
    return err({ type: "InvalidChunk", reason: encoded.error.type });
  }
  return ok(
    encoded.value.map(
      (chunk): PromptChunk => ({ type: "weave-prompt-chunk", ...chunk }),
    ),
  );
}

/**
 * Backward-compatible encoder for the existing prompt call sites, which
 * expect a plain array. An over-cap prompt yields an empty array; callers on
 * the acknowledged-transfer path use {@link encodePromptChunksBounded} so the
 * refusal carries its reason instead of vanishing.
 */
export function encodePromptChunks(
  task: string,
  transferId: string,
): readonly PromptChunk[] {
  const encoded = encodePromptChunksBounded(task, transferId);
  return encoded.isOk() ? encoded.value : [];
}

export function parsePromptChunk(raw: string): Result<PromptChunk, PromptChunkError> {
  const parsed = parseStrictJson(raw);
  if (
    parsed.isErr() ||
    typeof parsed.value !== "object" ||
    parsed.value === null
  ) {
    return err({ type: "InvalidChunk", reason: "not an object" });
  }
  const value = parsed.value as Record<string, JsonValue>;
  if (
    value.type !== "weave-prompt-chunk" ||
    typeof value.transferId !== "string" ||
    value.transferId.length < 1 ||
    typeof value.index !== "number" ||
    !Number.isInteger(value.index) ||
    typeof value.total !== "number" ||
    !Number.isInteger(value.total) ||
    value.total < 1 ||
    value.total > PI_TRANSPORT_LIMITS.transferMaxChunks ||
    value.index < 0 ||
    value.index >= value.total ||
    typeof value.data !== "string"
  ) {
    return err({ type: "InvalidChunk", reason: "invalid fields" });
  }
  return ok(value as unknown as PromptChunk);
}

/**
 * Reassembles prompt chunks. Delegates every cap to the shared assembler and
 * translates its closed rejection reasons into this module's error shape.
 */
export class PromptChunkAssembler {
  private readonly inner = new ChunkTransferAssembler();

  accept(chunk: PromptChunk): Result<string | undefined, PromptChunkError> {
    const accepted = this.inner.accept(chunk);
    if (accepted.isErr()) {
      if (accepted.error.reason === "invalid-base64") {
        return err({ type: "InvalidBase64" });
      }
      return err({ type: "InvalidChunk", reason: accepted.error.reason });
    }
    return ok(accepted.value);
  }

  /** In-flight transfers, for the NACK path and for capacity assertions. */
  activeTransferCount(): number {
    return this.inner.activeTransferCount();
  }

  drop(transferId: string): void {
    this.inner.drop(transferId);
  }

  clear(): void {
    this.inner.clear();
  }
}
