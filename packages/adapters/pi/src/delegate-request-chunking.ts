/**
 * Delegate-request chunking — a thin adapter over the shared bounded transfer
 * module (`child-transfer.ts`, spec 33 §3).
 *
 * A delegate request travels inside signed control envelopes, so each chunk
 * must fit the 64 KiB signed control-body cap. That cap is a security bound
 * on what one signature covers and is never raised to fit a payload: a larger
 * task becomes more chunks, never a larger body.
 *
 * This module keeps the `agentName` field that the delegate-request wire
 * shape carries, and pins it across every chunk of a transfer so a peer
 * cannot splice chunks from two different agents into one task.
 */
import { err, ok, type Result } from "neverthrow";
import {
  ChunkTransferAssembler,
  encodeTransferChunks,
} from "./child-transfer.js";
import { PI_TRANSPORT_LIMITS } from "./errors.js";

/** Keeps each signed delegate-request chunk well below the 64 KiB envelope cap. */
export const DELEGATE_REQUEST_CHUNK_BYTES =
  PI_TRANSPORT_LIMITS.transferChunkPayloadBytes;
/** Defensive metadata bound above Bun's practical maximum string size. */
export const MAX_DELEGATE_REQUEST_CHUNKS = PI_TRANSPORT_LIMITS.transferMaxChunks;
export const MAX_ACTIVE_DELEGATE_REQUEST_TRANSFERS =
  PI_TRANSPORT_LIMITS.maxConcurrentTransfers;

export interface PiDelegateRequestChunk {
  readonly [key: string]: string | number;
  readonly agentName: string;
  readonly transferId: string;
  readonly index: number;
  readonly total: number;
  readonly data: string;
}

export type DelegateRequestChunkError =
  | { readonly type: "EmptyTask" }
  | { readonly type: "InvalidChunk"; readonly reason: string }
  | { readonly type: "TooManyTransfers" };

export function encodeDelegateRequestChunks(
  task: string,
  transferId: string,
  agentName: string,
): Result<readonly PiDelegateRequestChunk[], DelegateRequestChunkError> {
  const encoded = encodeTransferChunks(task, transferId);
  if (encoded.isErr()) {
    if (encoded.error.type === "EmptyPayload") return err({ type: "EmptyTask" });
    return err({ type: "InvalidChunk", reason: encoded.error.type });
  }
  return ok(
    encoded.value.map(
      (chunk): PiDelegateRequestChunk => ({ agentName, ...chunk }),
    ),
  );
}

/**
 * Reassembles delegate-request chunks. All four caps come from the shared
 * assembler; this wrapper adds only the agent-name pinning that the shared
 * module has no reason to know about.
 */
export class DelegateRequestAssembler {
  private readonly inner = new ChunkTransferAssembler();
  private readonly agents = new Map<string, string>();

  accept(
    chunk: PiDelegateRequestChunk,
  ): Result<string | undefined, DelegateRequestChunkError> {
    const pinned = this.agents.get(chunk.transferId);
    if (pinned !== undefined && pinned !== chunk.agentName) {
      return err({ type: "InvalidChunk", reason: "agent-mismatch" });
    }

    const accepted = this.inner.accept(chunk);
    if (accepted.isErr()) {
      if (accepted.error.reason === "too-many-transfers") {
        return err({ type: "TooManyTransfers" });
      }
      return err({ type: "InvalidChunk", reason: accepted.error.reason });
    }

    if (accepted.value === undefined) {
      this.agents.set(chunk.transferId, chunk.agentName);
      return ok(undefined);
    }
    this.agents.delete(chunk.transferId);
    return ok(accepted.value);
  }

  /** In-flight transfers, for the NACK path and for capacity assertions. */
  activeTransferCount(): number {
    return this.inner.activeTransferCount();
  }

  drop(transferId: string): void {
    this.agents.delete(transferId);
    this.inner.drop(transferId);
  }

  clear(): void {
    this.agents.clear();
    this.inner.clear();
  }
}
