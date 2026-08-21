import { describe, expect, it } from "bun:test";
import {
  encodePromptChunks,
  parsePromptChunk,
  PromptChunkAssembler,
} from "../prompt-chunking.js";

describe("prompt chunking", () => {
  it("round-trips a task larger than one RPC frame", () => {
    const task = "header-🙂\n" + "x".repeat(1_100_000);
    const chunks = encodePromptChunks(task, "transfer-1");
    expect(chunks.length).toBeGreaterThan(1);

    const assembler = new PromptChunkAssembler();
    let result: string | undefined;
    for (const chunk of chunks) {
      const parsed = parsePromptChunk(JSON.stringify(chunk));
      expect(parsed.isOk()).toBe(true);
      if (parsed.isOk()) result = assembler.accept(parsed.value)._unsafeUnwrap();
    }
    expect(result).toBe(task);
  });

  it("rejects duplicate chunk positions", () => {
    const chunks = encodePromptChunks("x".repeat(100_000), "transfer-2");
    const assembler = new PromptChunkAssembler();
    const first = assembler.accept(chunks[0]!);
    expect(first.isOk()).toBe(true);
    const duplicate = assembler.accept(chunks[0]!);
    expect(duplicate.isErr()).toBe(true);
  });
});
