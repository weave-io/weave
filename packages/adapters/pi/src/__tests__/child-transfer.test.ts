import { describe, expect, it } from "bun:test";
import { PI_TRANSPORT_LIMITS } from "../errors.js";
import {
  ChunkTransferAssembler,
  encodeTransferChunks,
  type TransferChunk,
} from "../child-transfer.js";

/**
 * The single bounded transfer module (spec 33 §3) replaces the two
 * near-duplicate chunkers. These tests pin the four caps it enforces —
 * per-chunk decoded bytes, aggregate bytes, chunk count, and concurrent
 * transfers — at their exact boundaries, plus every rejection reason.
 */

const CHUNK_BYTES = PI_TRANSPORT_LIMITS.transferChunkPayloadBytes;

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Builds a chunk directly, bypassing the encoder, to drive rejection paths. */
function rawChunk(overrides: Partial<TransferChunk> = {}): TransferChunk {
  return {
    transferId: "t-1",
    index: 0,
    total: 1,
    data: encodeBase64(new TextEncoder().encode("payload")),
    ...overrides,
  };
}

describe("encodeTransferChunks (spec 33 §3)", () => {
  it("round-trips a payload that fits in exactly one chunk", () => {
    const payload = "x".repeat(CHUNK_BYTES);
    const encoded = encodeTransferChunks(payload, "t-round");
    expect(encoded.isOk()).toBe(true);
    if (encoded.isErr()) return;
    expect(encoded.value).toHaveLength(1);

    const target = new ChunkTransferAssembler();
    const settled = target.accept(encoded.value[0] as TransferChunk);
    expect(settled.isOk()).toBe(true);
    if (settled.isErr()) return;
    expect(settled.value).toBe(payload);
  });

  it("splits one byte past the chunk boundary into exactly two chunks", () => {
    const encoded = encodeTransferChunks("x".repeat(CHUNK_BYTES + 1), "t-split");
    expect(encoded.isOk()).toBe(true);
    if (encoded.isErr()) return;
    expect(encoded.value).toHaveLength(2);
  });

  it("round-trips a multi-chunk multi-byte UTF-8 payload exactly", () => {
    // A 3-byte code point straddling a chunk boundary must survive: chunking
    // is over bytes, and only the reassembled whole is decoded as text.
    const payload = "☃".repeat(CHUNK_BYTES);
    const encoded = encodeTransferChunks(payload, "t-utf8");
    expect(encoded.isOk()).toBe(true);
    if (encoded.isErr()) return;

    const target = new ChunkTransferAssembler();
    let settled: string | undefined;
    for (const chunk of encoded.value) {
      const result = target.accept(chunk);
      expect(result.isOk()).toBe(true);
      if (result.isErr()) return;
      if (result.value !== undefined) settled = result.value;
    }
    expect(settled).toBe(payload);
  });

  it("refuses an empty payload", () => {
    const encoded = encodeTransferChunks("", "t-empty");
    expect(encoded.isErr()).toBe(true);
    if (encoded.isOk()) return;
    expect(encoded.error.type).toBe("EmptyPayload");
  });

  it("refuses a payload above the aggregate transfer cap", () => {
    const encoded = encodeTransferChunks("x".repeat(64), "t-cap", {
      aggregateBytes: 63,
    });
    expect(encoded.isErr()).toBe(true);
    if (encoded.isOk()) return;
    expect(encoded.error.type).toBe("PayloadTooLarge");
  });

  it("accepts a payload at exactly the aggregate transfer cap", () => {
    const encoded = encodeTransferChunks("x".repeat(64), "t-exact", {
      aggregateBytes: 64,
    });
    expect(encoded.isOk()).toBe(true);
  });

  it("refuses a payload needing more than the chunk-count cap", () => {
    const encoded = encodeTransferChunks("x".repeat(40), "t-count", {
      chunkPayloadBytes: 10,
      maxChunks: 3,
    });
    expect(encoded.isErr()).toBe(true);
    if (encoded.isOk()) return;
    expect(encoded.error.type).toBe("TooManyChunks");
  });
});

describe("ChunkTransferAssembler rejection reasons (spec 33 §3)", () => {
  it("rejects a duplicate index", () => {
    const target = new ChunkTransferAssembler();
    const first = target.accept(rawChunk({ total: 2, index: 0 }));
    expect(first.isOk()).toBe(true);
    const duplicate = target.accept(rawChunk({ total: 2, index: 0 }));
    expect(duplicate.isErr()).toBe(true);
    if (duplicate.isOk()) return;
    expect(duplicate.error.reason).toBe("duplicate-index");
  });

  it("rejects an index outside [0, total)", () => {
    const target = new ChunkTransferAssembler();
    const high = target.accept(rawChunk({ total: 2, index: 2 }));
    expect(high.isErr()).toBe(true);
    if (high.isOk()) return;
    expect(high.error.reason).toBe("invalid-index");

    const negative = new ChunkTransferAssembler().accept(
      rawChunk({ total: 2, index: -1 }),
    );
    expect(negative.isErr()).toBe(true);
    if (negative.isOk()) return;
    expect(negative.error.reason).toBe("invalid-index");
  });

  it("rejects a total inconsistent with the transfer in flight", () => {
    const target = new ChunkTransferAssembler();
    expect(target.accept(rawChunk({ total: 3, index: 0 })).isOk()).toBe(true);
    const mismatch = target.accept(rawChunk({ total: 4, index: 1 }));
    expect(mismatch.isErr()).toBe(true);
    if (mismatch.isOk()) return;
    expect(mismatch.error.reason).toBe("total-mismatch");
  });

  it("rejects a total outside the chunk-count cap", () => {
    const target = new ChunkTransferAssembler();
    const zero = target.accept(rawChunk({ total: 0, index: 0 }));
    expect(zero.isErr()).toBe(true);
    if (zero.isOk()) return;
    expect(zero.error.reason).toBe("invalid-total");
  });

  it("rejects a malformed transfer id", () => {
    const target = new ChunkTransferAssembler();
    const empty = target.accept(rawChunk({ transferId: "" }));
    expect(empty.isErr()).toBe(true);
    if (empty.isOk()) return;
    expect(empty.error.reason).toBe("invalid-transfer-id");
  });

  it("rejects data that is not valid base64", () => {
    const target = new ChunkTransferAssembler();
    const bad = target.accept(rawChunk({ data: "!!!not-base64!!!" }));
    expect(bad.isErr()).toBe(true);
    if (bad.isOk()) return;
    expect(bad.error.reason).toBe("invalid-base64");
  });

  it("accepts a chunk at exactly the per-chunk cap and rejects one byte over", () => {
    const exact = new ChunkTransferAssembler({ chunkPayloadBytes: 8 }).accept(
      rawChunk({ data: encodeBase64(new Uint8Array(8)) }),
    );
    expect(exact.isOk()).toBe(true);

    const over = new ChunkTransferAssembler({ chunkPayloadBytes: 8 }).accept(
      rawChunk({ data: encodeBase64(new Uint8Array(9)) }),
    );
    expect(over.isErr()).toBe(true);
    if (over.isOk()) return;
    expect(over.error.reason).toBe("chunk-too-large");
  });

  it("rejects a transfer whose running total passes the aggregate cap", () => {
    const target = new ChunkTransferAssembler({
      chunkPayloadBytes: 8,
      aggregateBytes: 12,
    });
    expect(
      target
        .accept(
          rawChunk({ total: 2, index: 0, data: encodeBase64(new Uint8Array(8)) }),
        )
        .isOk(),
    ).toBe(true);
    const over = target.accept(
      rawChunk({ total: 2, index: 1, data: encodeBase64(new Uint8Array(8)) }),
    );
    expect(over.isErr()).toBe(true);
    if (over.isOk()) return;
    expect(over.error.reason).toBe("aggregate-too-large");
  });

  it("rejects a new transfer past the concurrency cap rather than evicting", () => {
    const target = new ChunkTransferAssembler({ maxConcurrentTransfers: 2 });
    expect(
      target.accept(rawChunk({ transferId: "a", total: 2, index: 0 })).isOk(),
    ).toBe(true);
    expect(
      target.accept(rawChunk({ transferId: "b", total: 2, index: 0 })).isOk(),
    ).toBe(true);
    const third = target.accept(
      rawChunk({ transferId: "c", total: 2, index: 0 }),
    );
    expect(third.isErr()).toBe(true);
    if (third.isOk()) return;
    expect(third.error.reason).toBe("too-many-transfers");

    // The two in-flight transfers survive: nothing was evicted silently.
    expect(target.activeTransferCount()).toBe(2);
  });
});

describe("ChunkTransferAssembler interleaving and eviction (spec 33 §3)", () => {
  it("assembles two interleaved transfers independently", () => {
    const target = new ChunkTransferAssembler({ chunkPayloadBytes: 4 });
    const left = encodeTransferChunks("LEFTLEFT", "left", {
      chunkPayloadBytes: 4,
    });
    const right = encodeTransferChunks("RIGHTRIG", "right", {
      chunkPayloadBytes: 4,
    });
    expect(left.isOk() && right.isOk()).toBe(true);
    if (left.isErr() || right.isErr()) return;

    // Interleave: left[0], right[0], right[1], left[1].
    expect(target.accept(left.value[0] as TransferChunk).isOk()).toBe(true);
    expect(target.accept(right.value[0] as TransferChunk).isOk()).toBe(true);

    const rightDone = target.accept(right.value[1] as TransferChunk);
    expect(rightDone.isOk()).toBe(true);
    if (rightDone.isErr()) return;
    expect(rightDone.value).toBe("RIGHTRIG");

    const leftDone = target.accept(left.value[1] as TransferChunk);
    expect(leftDone.isOk()).toBe(true);
    if (leftDone.isErr()) return;
    expect(leftDone.value).toBe("LEFTLEFT");
  });

  it("holds a gapped transfer open and completes it when the gap is filled", () => {
    const target = new ChunkTransferAssembler({ chunkPayloadBytes: 4 });
    const encoded = encodeTransferChunks("ABCDEFGHIJKL", "gap", {
      chunkPayloadBytes: 4,
    });
    expect(encoded.isOk()).toBe(true);
    if (encoded.isErr()) return;

    // Deliver 0 and 2, skipping 1: the transfer must stay pending, not settle.
    expect(target.accept(encoded.value[0] as TransferChunk).isOk()).toBe(true);
    const gapped = target.accept(encoded.value[2] as TransferChunk);
    expect(gapped.isOk()).toBe(true);
    if (gapped.isErr()) return;
    expect(gapped.value).toBeUndefined();
    expect(target.activeTransferCount()).toBe(1);

    const filled = target.accept(encoded.value[1] as TransferChunk);
    expect(filled.isOk()).toBe(true);
    if (filled.isErr()) return;
    expect(filled.value).toBe("ABCDEFGHIJKL");
  });

  it("evicts a completed transfer so its id can be reused", () => {
    const target = new ChunkTransferAssembler();
    const settled = target.accept(rawChunk({ transferId: "reuse" }));
    expect(settled.isOk()).toBe(true);
    expect(target.activeTransferCount()).toBe(0);

    const again = target.accept(rawChunk({ transferId: "reuse" }));
    expect(again.isOk()).toBe(true);
  });

  it("drops one transfer on demand without disturbing the others", () => {
    const target = new ChunkTransferAssembler();
    expect(
      target.accept(rawChunk({ transferId: "keep", total: 2, index: 0 })).isOk(),
    ).toBe(true);
    expect(
      target.accept(rawChunk({ transferId: "drop", total: 2, index: 0 })).isOk(),
    ).toBe(true);
    expect(target.activeTransferCount()).toBe(2);

    target.drop("drop");
    expect(target.activeTransferCount()).toBe(1);

    target.clear();
    expect(target.activeTransferCount()).toBe(0);
  });
});
