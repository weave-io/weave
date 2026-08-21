/**
 * Strict LF-delimited JSON line framer for the private RPC child transport
 * (Pi adapter contract). Operates on raw bytes, never on strings or a generic
 * Unicode line reader:
 *
 * - Splits records on ASCII LF (`0x0a`) only, so a record containing
 *   U+2028/U+2029 (multi-byte UTF-8 sequences that never contain the byte
 *   `0x0a`) is never mistaken for two records - the defect Pi's own docs
 *   call out in Node's `readline`.
 * - Buffers raw bytes across chunk boundaries, so a multi-byte UTF-8
 *   sequence split across two `push()` calls is decoded correctly instead
 *   of being corrupted at the split point.
 * - Accepts an optional trailing CR before the LF and strips it.
 * - Enforces the bounded native-record cap (8 MiB, including any CR and
 *   the LF itself) and rejects invalid UTF-8, both fatally: once a violation
 *   occurs the byte stream can no longer be trusted to be aligned on
 *   record boundaries, so the framer poisons itself and refuses further
 *   input rather than risk desynchronized parsing.
 * - Delegates JSON parsing to `strict-json.ts`, which rejects duplicate
 *   object keys structurally.
 */
import { err, ok, Result, type Result as ResultType } from "neverthrow";
import {
  type JsonValue,
  parseStrictJson,
  type StrictJsonParseError,
} from "./strict-json.js";

export type FramingError =
  | { readonly type: "RecordTooLarge"; readonly byteLength: number }
  | { readonly type: "InvalidUtf8" }
  | { readonly type: "InvalidJson"; readonly error: StrictJsonParseError };

/**
 * Maximum native Pi JSONL record size, inclusive of an optional trailing CR
 * and the terminating LF. Native records are separate from authenticated
 * control-envelope bodies, which remain capped at 64 KiB.
 */
export const MAX_NATIVE_RECORD_BYTES = 8 * 1024 * 1024;

/** @deprecated Use MAX_NATIVE_RECORD_BYTES for native JSONL records. */
export const MAX_FRAME_RECORD_BYTES = MAX_NATIVE_RECORD_BYTES;
const MAX_CONTENT_BYTES = MAX_NATIVE_RECORD_BYTES - 1;

export interface ParsedFrame {
  readonly raw: string;
  readonly json: JsonValue;
}

const NO_PARSED_FRAME: ParsedFrame | undefined = undefined;
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

function decodeUtf8Strict(bytes: Uint8Array): ResultType<string, FramingError> {
  return Result.fromThrowable(
    () => utf8Decoder.decode(bytes),
    (): FramingError => ({ type: "InvalidUtf8" }),
  )();
}

export class PiLineFramer {
  private pendingSegments: Uint8Array[] = [];
  private pendingByteLength = 0;
  private poisoned: FramingError | undefined;

  /** Feeds one chunk of raw bytes, returning every complete record parsed from it. */
  push(chunk: Uint8Array): ResultType<ParsedFrame[], FramingError> {
    if (this.poisoned !== undefined) return err(this.poisoned);
    const frames: ParsedFrame[] = [];
    let recordStart = 0;

    for (let index = 0; index < chunk.byteLength; index += 1) {
      if (chunk[index] !== 0x0a) continue;
      const appendResult = this.appendSegment(
        chunk.subarray(recordStart, index),
      );
      if (appendResult.isErr()) {
        this.poisoned = appendResult.error;
        return err(appendResult.error);
      }
      const lineResult = this.flushLine();
      if (lineResult.isErr()) {
        this.poisoned = lineResult.error;
        return err(lineResult.error);
      }
      if (lineResult.value !== undefined) frames.push(lineResult.value);
      recordStart = index + 1;
    }
    const appendResult = this.appendSegment(chunk.subarray(recordStart));
    if (appendResult.isErr()) {
      this.poisoned = appendResult.error;
      return err(appendResult.error);
    }
    return ok(frames);
  }

  /** True once a fatal framing violation has occurred; the framer will not process further bytes. */
  isPoisoned(): boolean {
    return this.poisoned !== undefined;
  }

  private appendSegment(segment: Uint8Array): ResultType<void, FramingError> {
    if (segment.byteLength === 0) return ok();
    const nextByteLength = this.pendingByteLength + segment.byteLength;
    if (nextByteLength > MAX_CONTENT_BYTES) {
      return err({
        type: "RecordTooLarge",
        byteLength: nextByteLength + 1,
      });
    }
    this.pendingSegments.push(segment);
    this.pendingByteLength = nextByteLength;
    return ok();
  }

  private flushLine(): ResultType<ParsedFrame | undefined, FramingError> {
    const record = new Uint8Array(this.pendingByteLength);
    let offset = 0;
    for (const segment of this.pendingSegments) {
      record.set(segment, offset);
      offset += segment.byteLength;
    }
    this.pendingSegments = [];
    this.pendingByteLength = 0;

    let bytes = record;
    if (bytes.length > 0 && bytes[bytes.length - 1] === 0x0d) {
      bytes = bytes.subarray(0, -1);
    }
    if (bytes.length === 0) return ok(NO_PARSED_FRAME);
    const decoded = decodeUtf8Strict(bytes);
    if (decoded.isErr()) return err(decoded.error);
    const parsed = parseStrictJson(decoded.value);
    if (parsed.isErr()) {
      return err({ type: "InvalidJson", error: parsed.error });
    }
    return ok({ raw: decoded.value, json: parsed.value });
  }
}
