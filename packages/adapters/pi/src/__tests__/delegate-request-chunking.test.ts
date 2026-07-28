import { describe, expect, it } from "bun:test";
import { canonicalizeToBytes } from "../strict-json.js";
import { MAX_CONTROL_BODY_BYTES } from "../child-envelope.js";
import {
  DELEGATE_REQUEST_CHUNK_BYTES,
  DelegateRequestAssembler,
  encodeDelegateRequestChunks,
} from "../delegate-request-chunking.js";

const task = "nested task: " + "x".repeat(1_100_000);

describe("nested delegate-request chunking", () => {
  it("reassembles a task over 1 MiB without exceeding the control cap", () => {
    const chunks = encodeDelegateRequestChunks(task, "transfer-1", "shuttle");
    expect(chunks.isOk()).toBe(true);
    if (chunks.isErr()) return;

    const assembler = new DelegateRequestAssembler();
    let result: string | undefined;
    for (const chunk of chunks.value) {
      const body = canonicalizeToBytes(chunk);
      expect(body.isOk()).toBe(true);
      if (body.isOk()) expect(body.value.byteLength).toBeLessThanOrEqual(MAX_CONTROL_BODY_BYTES);
      const accepted = assembler.accept(chunk);
      expect(accepted.isOk()).toBe(true);
      if (accepted.isOk() && accepted.value !== undefined) result = accepted.value;
    }
    expect(result).toBe(task);
  });

  it("rejects empty tasks and duplicate chunks", () => {
    const empty = encodeDelegateRequestChunks("", "transfer-2", "shuttle");
    expect(empty.isErr()).toBe(true);
    const encoded = encodeDelegateRequestChunks(
      "x".repeat(DELEGATE_REQUEST_CHUNK_BYTES + 1),
      "transfer-2",
      "shuttle",
    );
    expect(encoded.isOk()).toBe(true);
    if (encoded.isErr()) return;
    const assembler = new DelegateRequestAssembler();
    const first = assembler.accept(encoded.value[0]);
    expect(first.isOk()).toBe(true);
    if (first.isErr()) return;
    const duplicate = assembler.accept(encoded.value[0]);
    expect(duplicate.isErr()).toBe(true);
  });
});
