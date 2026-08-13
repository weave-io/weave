/**
 * Builders for durable result-group fixtures.
 *
 * A committed result group is only acceptable when its commit record still
 * names the child identity *and* the storage leaf it was written into. A
 * fixture therefore cannot be a static array of lines: the commit has to be
 * written after the leaf exists, so it can carry that leaf's `{dev,ino}`.
 *
 * `seedResultGroupSession` does exactly that in two phases, and every override
 * it accepts corresponds to a specific way a real group can go wrong.
 */

import type {
  PiNativeResultCommitIdentity,
  PiNativeResultIdentity,
} from "../../child-native-sessions.js";
import {
  PI_NATIVE_RESULT_CHUNK_ENTRY_TYPE,
  PI_NATIVE_RESULT_COMMIT_ENTRY_TYPE,
  PI_NATIVE_RESULT_SCHEMA_VERSION,
} from "../../child-native-sessions.js";
import type { MemoryPiNativeSessionFs } from "../../native-session-fs.js";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/** Mirrors the production chunk size the writer splits output into. */
export const RESULT_FIXTURE_CHUNK_BYTES = 48 * 1_024;

export interface ResultGroupFixtureOptions {
  /** Result id shared by every entry of the group. */
  readonly resultId?: string;
  /** Overrides the digest recorded in every entry. */
  readonly digest?: string;
  /** Writes chunks but never the commit that makes them acceptable. */
  readonly omitCommit?: boolean;
  /** Overrides the identity the commit is bound to. */
  readonly commitIdentity?: Partial<PiNativeResultCommitIdentity>;
  /** Extra JSONL lines appended after the commit. */
  readonly trailingLines?: readonly string[];
}

export interface SeededResultGroup {
  /** Exact output the group encodes. */
  readonly output: string;
  readonly resultId: string;
  readonly digest: string;
  readonly total: number;
  readonly byteLength: number;
  /** Storage identity of the leaf the commit was bound to. */
  readonly leaf: { readonly dev: number; readonly ino: number };
}

/** Splits output on UTF-8 code-point boundaries exactly as the writer does. */
export function splitResultFixtureChunks(output: string): readonly string[] {
  const bytes = textEncoder.encode(output);
  const parts: string[] = [];
  for (let start = 0; start < bytes.byteLength; ) {
    let stop = Math.min(start + RESULT_FIXTURE_CHUNK_BYTES, bytes.byteLength);
    while (stop > start && ((bytes[stop] ?? 0) & 0b1100_0000) === 0b1000_0000) {
      stop -= 1;
    }
    parts.push(textDecoder.decode(bytes.slice(start, stop)));
    start = stop;
  }
  if (parts.length === 0) parts.push("");
  return parts;
}

export function resultChunkLines(
  output: string,
  resultId: string,
  digest: string,
): readonly string[] {
  const parts = splitResultFixtureChunks(output);
  const byteLength = textEncoder.encode(output).byteLength;
  return parts.map((content, index) =>
    JSON.stringify({
      type: "custom",
      customType: PI_NATIVE_RESULT_CHUNK_ENTRY_TYPE,
      data: {
        schemaVersion: PI_NATIVE_RESULT_SCHEMA_VERSION,
        resultId,
        index,
        total: parts.length,
        byteLength,
        digest,
        content,
      },
    }),
  );
}

export function resultCommitLine(input: {
  readonly resultId: string;
  readonly digest: string;
  readonly total: number;
  readonly byteLength: number;
  readonly identity: PiNativeResultCommitIdentity;
}): string {
  return JSON.stringify({
    type: "custom",
    customType: PI_NATIVE_RESULT_COMMIT_ENTRY_TYPE,
    data: {
      schemaVersion: PI_NATIVE_RESULT_SCHEMA_VERSION,
      resultId: input.resultId,
      total: input.total,
      byteLength: input.byteLength,
      digest: input.digest,
      identity: input.identity,
    },
  });
}

/**
 * Seeds one session file whose commit is bound to the leaf it actually lives
 * in: header and chunks are written first, the leaf is stat'd, and only then
 * is the commit appended with that leaf's `{dev,ino}`.
 */
export async function seedResultGroupSession(input: {
  readonly fs: MemoryPiNativeSessionFs;
  readonly directory: string;
  readonly fileName: string;
  readonly headerLine: string;
  readonly identity: PiNativeResultIdentity;
  readonly output: string;
  /** Lines written between the header and the group's first chunk. */
  readonly leadingLines?: readonly string[];
  readonly options?: ResultGroupFixtureOptions;
}): Promise<SeededResultGroup> {
  const options = input.options ?? {};
  const bytes = textEncoder.encode(input.output);
  const digest =
    options.digest ??
    new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  const resultId = options.resultId ?? "44444444-4444-4444-8444-444444444444";
  const chunks = resultChunkLines(input.output, resultId, digest);

  const opened = await input.fs.openDirectory(input.directory, true);
  const directory = opened._unsafeUnwrap();
  const head = [
    input.headerLine,
    ...(input.leadingLines ?? []),
    ...chunks,
  ].join("\n");
  (
    await directory.appendFile(
      input.fileName,
      textEncoder.encode(`${head}\n`),
      0o600,
    )
  )._unsafeUnwrap();

  const stat = (await directory.statFile(input.fileName))._unsafeUnwrap();
  if (stat === undefined) throw new Error("seeded leaf is missing");
  const leaf = { dev: stat.dev, ino: stat.ino };

  const tail: string[] = [];
  if (options.omitCommit !== true) {
    tail.push(
      resultCommitLine({
        resultId,
        digest,
        total: chunks.length,
        byteLength: bytes.byteLength,
        identity: {
          childId: input.identity.childId,
          nativeSessionId: input.identity.nativeSessionId,
          parentSession: input.identity.parentSession,
          leafDev: leaf.dev,
          leafIno: leaf.ino,
          ...(options.commitIdentity ?? {}),
        },
      }),
    );
  }
  tail.push(...(options.trailingLines ?? []));
  if (tail.length > 0) {
    (
      await directory.appendFile(
        input.fileName,
        textEncoder.encode(`${tail.join("\n")}\n`),
        0o600,
      )
    )._unsafeUnwrap();
  }
  directory.close();

  return {
    output: input.output,
    resultId,
    digest,
    total: chunks.length,
    byteLength: bytes.byteLength,
    leaf,
  };
}
