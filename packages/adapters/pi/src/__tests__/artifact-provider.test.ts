import { describe, expect, it } from "bun:test";
import {
  createPiSanitizedChildIndex,
  FakePiArtifactProvider,
  MAX_SANITIZED_CHILD_EXPORT_BYTES,
  MAX_SANITIZED_CHILD_INDEX_ENTRIES,
  PiSanitizedChildIndexSchema,
} from "../artifact-provider.js";

const usage = {
  inputTokens: 1,
  outputTokens: 2,
  cacheReadTokens: 3,
  cacheWriteTokens: 4,
  cost: 0.5,
};

type TestChildInput = Parameters<typeof createPiSanitizedChildIndex>[0][number];

function child(overrides: Record<string, unknown> = {}) {
  return {
    id: "child-1",
    name: "worker",
    kind: "ordinary" as const,
    status: "completed" as const,
    currentTurn: 1,
    startedAtMs: 10,
    elapsedMs: 20,
    usage,
    interventionCount: 0,
    ...overrides,
  };
}

describe("PiSanitizedChildIndex", () => {
  it("round-trips only the versioned allowlist and drops forbidden fields", () => {
    const result = createPiSanitizedChildIndex([
      child({
        parentId: "parent-1",
        kind: "workflow-step",
        workflow: { workflow: "deploy", step: "verify" },
        sessionPath: "/private/session.jsonl",
        checkpointCursor: 12,
        transcript: "secret transcript",
        prompt: "do not export",
        toolCalls: [{ name: "secret-tool", args: "secret" }],
        rpcBody: { token: "secret" },
      }),
    ]);
    expect(result.isOk()).toBe(true);
    if (result.isErr()) return;
    const wire = JSON.stringify(result.value);
    const parsed = JSON.parse(wire) as Record<string, unknown>;
    expect(PiSanitizedChildIndexSchema.safeParse(parsed).success).toBe(true);
    expect(wire).not.toContain("sessionPath");
    expect(wire).not.toContain("checkpointCursor");
    expect(wire).not.toContain("transcript");
    expect(wire).not.toContain("secret");
    expect(result.value.children[0]).toEqual({
      id: "child-1",
      parentId: "parent-1",
      name: "worker",
      kind: "workflow-step",
      status: "completed",
      workflow: { workflow: "deploy", step: "verify" },
      currentTurn: 1,
      startedAtMs: 10,
      elapsedMs: 20,
      usage,
      interventionCount: 0,
    });
  });

  it("requires kind and a non-empty name", () => {
    expect(
      createPiSanitizedChildIndex([child({ kind: undefined })]).isErr(),
    ).toBe(true);
    expect(createPiSanitizedChildIndex([child({ name: "" })]).isErr()).toBe(
      true,
    );
  });

  it("rejects fractional, non-finite, and unsafe numeric values", () => {
    const numericFields = [
      "currentTurn",
      "startedAtMs",
      "elapsedMs",
      "interventionCount",
      "inputTokens",
      "outputTokens",
      "cacheReadTokens",
      "cacheWriteTokens",
    ];
    for (const field of numericFields) {
      const target =
        field in usage
          ? { usage: { ...usage, [field]: 1.5 } }
          : { [field]: 1.5 };
      expect(createPiSanitizedChildIndex([child(target)]).isErr()).toBe(true);
      for (const value of [
        Number.NaN,
        Number.POSITIVE_INFINITY,
        Number.MAX_SAFE_INTEGER + 1,
      ]) {
        const invalid =
          field in usage
            ? { usage: { ...usage, [field]: value } }
            : { [field]: value };
        expect(createPiSanitizedChildIndex([child(invalid)]).isErr()).toBe(
          true,
        );
      }
    }
    expect(
      createPiSanitizedChildIndex([
        child({ usage: { ...usage, cost: 1.5 } }),
      ]).isOk(),
    ).toBe(true);
  });

  it("enforces the UTF-8 byte cap for every identifier string", () => {
    const tooLong = "🙂".repeat(65);
    for (const field of ["id", "parentId", "name"]) {
      expect(
        createPiSanitizedChildIndex([child({ [field]: tooLong })]).isErr(),
      ).toBe(true);
    }
    for (const field of ["workflow", "step"]) {
      expect(
        createPiSanitizedChildIndex([
          child({ workflow: { [field]: tooLong } }),
        ]).isErr(),
      ).toBe(true);
    }
  });

  it("truncates terminal output at a valid UTF-8 boundary", () => {
    const result = createPiSanitizedChildIndex([
      child({ finalOutput: `${"a".repeat(4_095)}🙂` }),
    ]);
    expect(result.isOk()).toBe(true);
    if (result.isErr()) return;
    const output = result.value.children[0].finalOutput;
    expect(output).toBe("a".repeat(4_095));
    expect(
      new TextEncoder().encode(output as string).byteLength,
    ).toBeLessThanOrEqual(4_096);
    expect(output).not.toContain("�");
  });

  it("enforces exact entry and serialized-size bounds", () => {
    const entries1024 = Array.from(
      { length: MAX_SANITIZED_CHILD_INDEX_ENTRIES },
      (_, i) => child({ id: `child-${i}` }),
    );
    expect(createPiSanitizedChildIndex(entries1024).isOk()).toBe(true);
    expect(
      createPiSanitizedChildIndex([
        ...entries1024,
        child({ id: "child-over" }),
      ]).isErr(),
    ).toBe(true);

    let boundary: ReturnType<typeof createPiSanitizedChildIndex> | undefined;
    let boundaryEntries: TestChildInput[] | undefined;
    for (let nameLength = 1; nameLength <= 256; nameLength += 1) {
      const base = Array.from({ length: 1_024 }, (_, i) =>
        child({ id: `child-${i}`, name: "n".repeat(nameLength) }),
      );
      const last = base.at(-1);
      if (last === undefined) continue;
      const emptyOutput = createPiSanitizedChildIndex(base);
      if (emptyOutput.isErr()) continue;
      const withEmptyOutput = createPiSanitizedChildIndex([
        ...base.slice(0, -1),
        { ...last, finalOutput: "" },
      ]);
      if (withEmptyOutput.isOk()) {
        const remaining =
          MAX_SANITIZED_CHILD_EXPORT_BYTES -
          new TextEncoder().encode(JSON.stringify(withEmptyOutput.value))
            .byteLength;
        if (remaining <= 4_096) {
          const exact = createPiSanitizedChildIndex([
            ...base.slice(0, -1),
            { ...last, finalOutput: "x".repeat(remaining) },
          ]);
          boundary = exact;
          boundaryEntries = [
            ...base.slice(0, -1),
            { ...last, finalOutput: "x".repeat(remaining) },
          ];
          break;
        }
      }
    }
    expect(boundary?.isOk()).toBe(true);
    expect(boundaryEntries).toBeDefined();
    if (boundaryEntries !== undefined) {
      const lastBoundaryEntry = boundaryEntries.at(-1);
      if (lastBoundaryEntry !== undefined) {
        const overBoundary = createPiSanitizedChildIndex([
          ...boundaryEntries.slice(0, -1),
          {
            ...lastBoundaryEntry,
            finalOutput: `${lastBoundaryEntry.finalOutput ?? ""}x`,
          },
        ]);
        expect(overBoundary.isErr()).toBe(true);
        if (overBoundary.isErr())
          expect(overBoundary.error.type).toBe("child-export-too-large");
      }
    }
    expect(
      createPiSanitizedChildIndex([
        child({ finalOutput: "x".repeat(4_096) }),
      ]).isOk(),
    ).toBe(true);
  });
});

describe("FakePiArtifactProvider", () => {
  it("computes a stable sha256 digest for known file bytes", async () => {
    const provider = new FakePiArtifactProvider(
      new Map([["report.md", new TextEncoder().encode("hello world")]]),
    );
    const result = await provider.readAndDigest({
      projectRoot: "/tmp/project",
      relativePath: "report.md",
    });
    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;
    expect(result.value.algorithm).toBe("sha256");
    expect(result.value.digest).toHaveLength(64);
    expect(result.value.digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects an absolute path", async () => {
    const provider = new FakePiArtifactProvider(new Map());
    const result = await provider.readAndDigest({
      projectRoot: "/tmp/project",
      relativePath: "/etc/passwd",
    });
    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.code).toBe("ArtifactReadFailed");
  });

  it("rejects a path that escapes the project root via ..", async () => {
    const provider = new FakePiArtifactProvider(new Map());
    const result = await provider.readAndDigest({
      projectRoot: "/tmp/project",
      relativePath: "../outside.md",
    });
    expect(result.isErr()).toBe(true);
  });

  it("fails closed for an unknown file", async () => {
    const provider = new FakePiArtifactProvider(new Map());
    const result = await provider.readAndDigest({
      projectRoot: "/tmp/project",
      relativePath: "missing.md",
    });
    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.code).toBe("ArtifactReadFailed");
  });

  it("produces different digests for different content, same digest for same content", async () => {
    const provider = new FakePiArtifactProvider(
      new Map([
        ["a.md", new TextEncoder().encode("content-a")],
        ["b.md", new TextEncoder().encode("content-b")],
      ]),
    );
    const a1 = await provider.readAndDigest({
      projectRoot: "/tmp",
      relativePath: "a.md",
    });
    const a2 = await provider.readAndDigest({
      projectRoot: "/tmp",
      relativePath: "a.md",
    });
    const b = await provider.readAndDigest({
      projectRoot: "/tmp",
      relativePath: "b.md",
    });
    if (!a1.isOk() || !a2.isOk() || !b.isOk()) throw new Error("unexpected");
    expect(a1.value.digest).toBe(a2.value.digest);
    expect(a1.value.digest).not.toBe(b.value.digest);
  });
});
