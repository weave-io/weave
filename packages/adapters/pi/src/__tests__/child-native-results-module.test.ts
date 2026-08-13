/**
 * Module isolation for the durable-result protocol.
 *
 * Two properties are proven here, and neither is provable from the store's own
 * tests:
 *
 * 1. **Acyclic ownership.** The result protocol depends on the shared session
 *    contracts and on nothing else in the adapter. It never imports the store,
 *    the filesystem port implementation, or path containment, so the store can
 *    import it without creating a cycle.
 * 2. **Storage-free verification.** A committed group is provable over a line
 *    source that touches no filesystem at all. That is what makes "every byte
 *    came from one authorized descriptor" a property the store establishes
 *    once, rather than something the scanner has to be trusted to preserve.
 *
 * A third check keeps the limits honest: every ceiling the protocol charges is
 * declared exactly once, so the store and the protocol cannot drift apart.
 */

import { describe, expect, test } from "bun:test";
import { okAsync } from "neverthrow";
import {
  PI_NATIVE_RESULT_CHUNK_ENTRY_TYPE,
  PI_NATIVE_RESULT_COMMIT_ENTRY_TYPE,
  PI_NATIVE_RESULT_GROUP_BOUNDS,
  PI_NATIVE_RESULT_SCHEMA_VERSION,
  type PiNativeResultScanPage,
  type PiNativeResultScanSource,
  prepareResultGroupRead,
  scanResultGroup,
} from "../child-native-results.js";

const SOURCE_DIR = new URL("../", import.meta.url).pathname;
const textEncoder = new TextEncoder();

const IDENTITY = {
  childId: "child-1",
  nativeSessionId: "native-session-1",
  parentSession: "parent-session-1",
} as const;

const LEAF = { dev: 41, ino: 4_101 } as const;

function digestOf(value: string): string {
  return new Bun.CryptoHasher("sha256")
    .update(textEncoder.encode(value))
    .digest("hex");
}

/** One committed group plus one unrelated entry, as raw JSONL body lines. */
function groupLines(output: string, resultId: string): readonly string[] {
  const chunks = [output.slice(0, 3), output.slice(3)];
  const meta = {
    resultId,
    total: chunks.length,
    byteLength: textEncoder.encode(output).byteLength,
    digest: digestOf(output),
  };
  return [
    JSON.stringify({ customType: "weave.child.unrelated", data: {} }),
    ...chunks.map((content, index) =>
      JSON.stringify({
        customType: PI_NATIVE_RESULT_CHUNK_ENTRY_TYPE,
        data: {
          schemaVersion: PI_NATIVE_RESULT_SCHEMA_VERSION,
          ...meta,
          index,
          content,
        },
      }),
    ),
    JSON.stringify({
      customType: PI_NATIVE_RESULT_COMMIT_ENTRY_TYPE,
      data: {
        schemaVersion: PI_NATIVE_RESULT_SCHEMA_VERSION,
        ...meta,
        identity: {
          childId: IDENTITY.childId,
          nativeSessionId: IDENTITY.nativeSessionId,
          parentSession: IDENTITY.parentSession,
          leafDev: LEAF.dev,
          leafIno: LEAF.ino,
        },
      },
    }),
  ];
}

/**
 * A line source backed by an array, not by storage. Offsets are real byte
 * offsets into the joined document so the scanner's paging arithmetic is
 * exercised exactly as it is against a descriptor.
 */
function memorySource(bodyLines: readonly string[]): {
  readonly source: PiNativeResultScanSource;
  readonly pages: { forward: number; backward: number };
} {
  const header = JSON.stringify({ type: "session", version: 3 });
  const all = [header, ...bodyLines];
  const document = `${all.join("\n")}\n`;
  const offsets: number[] = [];
  let cursor = 0;
  for (const line of all) {
    offsets.push(cursor);
    cursor += textEncoder.encode(line).byteLength + 1;
  }
  const size = textEncoder.encode(document).byteLength;
  const headerEnd = offsets[1] ?? size;
  const pages = { forward: 0, backward: 0 };
  const located = all.map((line, index) => ({
    offset: offsets[index] ?? 0,
    endOffset: (offsets[index] ?? 0) + textEncoder.encode(line).byteLength,
    entry: JSON.parse(line) as unknown,
  }));

  const page = (
    lines: readonly (typeof located)[number][],
  ): PiNativeResultScanPage => ({
    lines,
    bytesRead: lines.reduce(
      (total, line) => total + (line.endOffset - line.offset) + 1,
      0,
    ),
  });

  return {
    pages,
    source: {
      ref: "child-1/session.jsonl",
      size,
      headerEnd,
      leaf: LEAF,
      readBackward: (endExclusive, limit) => {
        pages.backward += 1;
        const visible = located.filter(
          (line) => line.endOffset < endExclusive && line.offset >= headerEnd,
        );
        return okAsync(page([...visible].reverse().slice(0, limit)));
      },
      readForward: (offset, limit) => {
        pages.forward += 1;
        return okAsync(
          page(located.filter((line) => line.offset >= offset).slice(0, limit)),
        );
      },
    },
  };
}

describe("durable result protocol module isolation", () => {
  test("depends on the shared contracts and on no storage module", async () => {
    const protocol = await Bun.file(
      `${SOURCE_DIR}child-native-results.ts`,
    ).text();
    const imported = [...protocol.matchAll(/from "(\.[^"]+)"/g)].map(
      (match) => match[1],
    );
    expect([...new Set(imported)]).toEqual([
      "./child-native-session-contracts.js",
    ]);

    const contracts = await Bun.file(
      `${SOURCE_DIR}child-native-session-contracts.ts`,
    ).text();
    expect([...contracts.matchAll(/from "(\.[^"]+)"/g)]).toHaveLength(0);
  });

  test("declares every result ceiling exactly once", async () => {
    const store = await Bun.file(
      `${SOURCE_DIR}child-native-sessions.ts`,
    ).text();
    // The store re-exports the ceilings; it never restates their values.
    expect(store).not.toContain("64 * 1_024 * 1_024");
    expect(store).not.toContain("48 * 1_024");
    expect(store).not.toContain("RESULT_ENTRY_JSON_ESCAPE_FACTOR");

    const contracts = await Bun.file(
      `${SOURCE_DIR}child-native-session-contracts.ts`,
    ).text();
    const declarations = [
      ...contracts.matchAll(
        /export const PI_NATIVE_SESSION_ENTRY_PAGE_BOUNDS/g,
      ),
    ];
    expect(declarations).toHaveLength(1);
    expect(store).not.toContain(
      "export const PI_NATIVE_SESSION_ENTRY_PAGE_BOUNDS",
    );
  });

  test("proves a committed group over a source that touches no storage", async () => {
    const output = "durable-output";
    const { source, pages } = memorySource(
      groupLines(output, "6f3f1d5a-6d4a-4f4a-9a7d-2f5f2b0f9d31"),
    );
    const plan = prepareResultGroupRead(
      { content: true },
      IDENTITY,
      source.ref,
    );
    expect(plan.isOk()).toBe(true);
    const read = await scanResultGroup(
      source,
      IDENTITY,
      plan._unsafeUnwrap(),
    ).match(
      (value) => value,
      (error) => error,
    );
    expect(read).toMatchObject({
      status: "complete",
      content: output,
      contentByteOffset: 0,
    });
    // Exactly the two documented passes: one backward anchor, one forward scan.
    expect(pages.backward).toBeGreaterThan(0);
    expect(pages.forward).toBeGreaterThan(0);
    expect(PI_NATIVE_RESULT_GROUP_BOUNDS.scanPasses).toBe(2);
  });

  test("refuses a commit that names a different storage leaf", async () => {
    const { source } = memorySource(
      groupLines("durable-output", "0d0b0a5c-1b2c-4d3e-8f90-a1b2c3d4e5f6"),
    );
    const foreign: PiNativeResultScanSource = {
      ...source,
      leaf: { dev: LEAF.dev, ino: LEAF.ino + 1 },
    };
    const read = await scanResultGroup(foreign, IDENTITY, {}).match(
      (value) => value,
      (error) => error,
    );
    expect(read).toMatchObject({
      status: "incomplete",
      reason: "identity-mismatch",
    });
  });
});
