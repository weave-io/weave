/**
 * The single bounded chunked-transfer module for the Pi child protocol
 * (spec 33 §3).
 *
 * Both directions of the private child protocol need to move a payload that
 * does not fit one signed control body: parent-to-child prompts and
 * delegate requests, and child-to-parent final output. This module is the
 * one implementation, parameterized by caps, that all of them share.
 *
 * Four caps are enforced, and the assembler never silently drops anything:
 *
 * - **per-chunk decoded bytes** — a chunk that decodes larger than the cap is
 *   rejected, so a peer cannot inflate memory with one oversized chunk;
 * - **aggregate bytes** — the running reassembled total is checked on every
 *   chunk, so a transfer cannot grow past the logical transfer cap by
 *   arriving in many small pieces;
 * - **chunk count** — bounds `total` and therefore the pending-index map;
 * - **concurrent transfers** — a new transfer past the cap is a typed
 *   rejection, never an eviction of an in-flight transfer.
 *
 * Every rejection carries a closed, fixed reason string. These strings travel
 * in a NACK and land in a failure's correlation field, so they must never
 * contain payload-derived or host-derived text.
 *
 * Chunking is over **bytes**, not code points. A multi-byte UTF-8 sequence
 * may straddle a chunk boundary; only the fully reassembled byte sequence is
 * decoded back to text.
 */
import { err, ok, Result } from "neverthrow";
import { z } from "zod";
import { PI_TRANSPORT_LIMITS } from "./errors.js";

/** The closed set of reasons a transfer chunk can be refused. */
export type TransferRejectionReason =
  | "invalid-transfer-id"
  | "invalid-total"
  | "invalid-index"
  | "invalid-base64"
  | "duplicate-index"
  | "total-mismatch"
  | "chunk-too-large"
  | "aggregate-too-large"
  | "too-many-transfers"
  | "missing-index";

export type TransferEncodeError =
  | { readonly type: "EmptyPayload" }
  | { readonly type: "PayloadTooLarge"; readonly byteLength: number }
  | { readonly type: "TooManyChunks"; readonly required: number };

export interface TransferRejection {
  readonly type: "ChunkRejected";
  readonly reason: TransferRejectionReason;
}

/** One chunk on the wire. Kept index-signature-free so callers may extend it. */
export interface TransferChunk {
  readonly transferId: string;
  readonly index: number;
  readonly total: number;
  readonly data: string;
}

/** The four caps, each independently overridable so tests can drive exact boundaries. */
export interface TransferLimits {
  readonly chunkPayloadBytes: number;
  readonly aggregateBytes: number;
  readonly maxChunks: number;
  readonly maxConcurrentTransfers: number;
}

export const DEFAULT_TRANSFER_LIMITS: TransferLimits = {
  chunkPayloadBytes: PI_TRANSPORT_LIMITS.transferChunkPayloadBytes,
  aggregateBytes: PI_TRANSPORT_LIMITS.transferAggregateBytes,
  maxChunks: PI_TRANSPORT_LIMITS.transferMaxChunks,
  maxConcurrentTransfers: PI_TRANSPORT_LIMITS.maxConcurrentTransfers,
};

function resolveLimits(overrides?: Partial<TransferLimits>): TransferLimits {
  return { ...DEFAULT_TRANSFER_LIMITS, ...overrides };
}

/** Printable ASCII, 1..256 chars — the same shape the envelope's identifier schema accepts. */
const TRANSFER_ID_PATTERN = /^[\x20-\x7e]{1,256}$/;
const TRANSFER_ID_SCHEMA = z.string().regex(TRANSFER_ID_PATTERN);

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decodeBase64(data: string): Result<Uint8Array, TransferRejection> {
  return Result.fromThrowable(
    () => {
      const binary = atob(data);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
      }
      return bytes;
    },
    (): TransferRejection => ({
      type: "ChunkRejected",
      reason: "invalid-base64",
    }),
  )();
}

function reject(reason: TransferRejectionReason): TransferRejection {
  return { type: "ChunkRejected", reason };
}

const NO_COMPLETED_TRANSFER: string | undefined = void 0;

/**
 * Splits `payload` into acknowledged-transfer chunks, refusing up front any
 * payload that cannot legally be sent. Failing here — rather than part-way
 * through a write loop — is what lets the sender report a precise
 * `ChildTransferTooLarge` instead of stalling until a settlement timeout.
 */
export function encodeTransferChunks(
  payload: string,
  transferId: string,
  overrides?: Partial<TransferLimits>,
): Result<readonly TransferChunk[], TransferEncodeError> {
  const limits = resolveLimits(overrides);
  if (payload.length === 0) return err({ type: "EmptyPayload" });

  const bytes = new TextEncoder().encode(payload);
  if (bytes.byteLength > limits.aggregateBytes) {
    return err({ type: "PayloadTooLarge", byteLength: bytes.byteLength });
  }

  const total = Math.max(
    1,
    Math.ceil(bytes.byteLength / limits.chunkPayloadBytes),
  );
  if (total > limits.maxChunks) {
    return err({ type: "TooManyChunks", required: total });
  }

  const chunks: TransferChunk[] = [];
  for (let index = 0; index < total; index += 1) {
    const start = index * limits.chunkPayloadBytes;
    chunks.push({
      transferId,
      index,
      total,
      data: encodeBase64(bytes.slice(start, start + limits.chunkPayloadBytes)),
    });
  }
  return ok(chunks);
}

/**
 * Reassembles chunked transfers, holding several in flight at once.
 *
 * `accept` returns `ok(undefined)` while a transfer is still incomplete and
 * `ok(payload)` on the chunk that completes it, at which point the transfer
 * is evicted and its id becomes reusable. Any violation is an `err` carrying
 * one closed reason, which the caller turns into a NACK.
 */
export class ChunkTransferAssembler {
  private readonly limits: TransferLimits;
  private readonly transfers = new Map<
    string,
    {
      readonly total: number;
      readonly chunks: Map<number, Uint8Array>;
      byteLength: number;
    }
  >();

  constructor(overrides?: Partial<TransferLimits>) {
    this.limits = resolveLimits(overrides);
  }

  accept(chunk: TransferChunk): Result<string | undefined, TransferRejection> {
    const parsedTransferId = TRANSFER_ID_SCHEMA.safeParse(chunk.transferId);
    if (!parsedTransferId.success) {
      return err(reject("invalid-transfer-id"));
    }
    const transferId = parsedTransferId.data;
    if (
      !Number.isInteger(chunk.total) ||
      chunk.total < 1 ||
      chunk.total > this.limits.maxChunks
    ) {
      return err(reject("invalid-total"));
    }
    if (
      !Number.isInteger(chunk.index) ||
      chunk.index < 0 ||
      chunk.index >= chunk.total
    ) {
      return err(reject("invalid-index"));
    }

    const decoded = decodeBase64(chunk.data);
    if (decoded.isErr()) return err(decoded.error);
    if (decoded.value.byteLength > this.limits.chunkPayloadBytes) {
      return err(reject("chunk-too-large"));
    }

    let transfer = this.transfers.get(transferId);
    if (transfer === undefined) {
      // A new transfer past the concurrency cap is refused outright. Evicting
      // an in-flight transfer instead would let a peer silently destroy
      // another transfer's progress.
      if (this.transfers.size >= this.limits.maxConcurrentTransfers) {
        return err(reject("too-many-transfers"));
      }
      transfer = { total: chunk.total, chunks: new Map(), byteLength: 0 };
      this.transfers.set(transferId, transfer);
    }
    if (transfer.total !== chunk.total) return err(reject("total-mismatch"));
    if (transfer.chunks.has(chunk.index)) return err(reject("duplicate-index"));

    // Check the running total *before* retaining the bytes, so an oversized
    // transfer never occupies memory it was not entitled to.
    const projected = transfer.byteLength + decoded.value.byteLength;
    if (projected > this.limits.aggregateBytes) {
      return err(reject("aggregate-too-large"));
    }

    transfer.chunks.set(chunk.index, decoded.value);
    transfer.byteLength = projected;
    if (transfer.chunks.size !== transfer.total)
      return ok(NO_COMPLETED_TRANSFER);

    const bytes = new Uint8Array(transfer.byteLength);
    let offset = 0;
    for (let index = 0; index < transfer.total; index += 1) {
      const part = transfer.chunks.get(index);
      if (part === undefined) return err(reject("missing-index"));
      bytes.set(part, offset);
      offset += part.byteLength;
    }
    this.transfers.delete(transferId);
    return ok(new TextDecoder().decode(bytes));
  }

  /** In-flight (incomplete) transfers. Completed transfers are already evicted. */
  activeTransferCount(): number {
    return this.transfers.size;
  }

  /** Abandons one in-flight transfer, e.g. after NACKing it. */
  drop(transferId: string): void {
    this.transfers.delete(transferId);
  }

  clear(): void {
    this.transfers.clear();
  }
}
