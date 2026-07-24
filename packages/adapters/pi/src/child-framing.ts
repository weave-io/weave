/**
 * Strict LF-delimited JSON line framer for the private RPC child transport
 * (Spec 33 §11.4). Operates on raw bytes, never on strings or a generic
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
 * - Enforces the 1 MiB complete-record cap (including any CR and the LF
 *   itself) and rejects invalid UTF-8, both fatally: once a violation
 *   occurs the byte stream can no longer be trusted to be aligned on
 *   record boundaries, so the framer poisons itself and refuses further
 *   input rather than risk desynchronized parsing.
 * - Delegates JSON parsing to `strict-json.ts`, which rejects duplicate
 *   object keys structurally.
 */
import { err, ok, type Result } from "neverthrow";
import {
  type JsonValue,
  parseStrictJson,
  type StrictJsonParseError,
} from "./strict-json.js";

/** Complete record cap, inclusive of an optional trailing CR and the terminating LF (Spec 33 §11.4). */
export const MAX_FRAME_RECORD_BYTES = 1024 * 1024;
const MAX_CONTENT_BYTES = MAX_FRAME_RECORD_BYTES - 1; // reserve one byte for the terminating LF

export type FramingError =
  | { readonly type: "RecordTooLarge"; readonly byteLength: number }
  | { readonly type: "InvalidUtf8" }
  | { readonly type: "InvalidJson"; readonly error: StrictJsonParseError };

export interface ParsedFrame {
  readonly raw: string;
  readonly json: JsonValue;
}

const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

function decodeUtf8Strict(bytes: Uint8Array): Result<string, FramingError> {
  try {
    return ok(utf8Decoder.decode(bytes));
  } catch {
    return err({ type: "InvalidUtf8" });
  }
}

export class PiLineFramer {
  private pending: number[] = [];
  private poisoned: FramingError | undefined;

  /** Feeds one chunk of raw bytes, returning every complete record parsed from it. */
  push(chunk: Uint8Array): Result<ParsedFrame[], FramingError> {
    if (this.poisoned !== undefined) return err(this.poisoned);
    const frames: ParsedFrame[] = [];
    for (const byte of chunk) {
      if (byte === 0x0a) {
        const lineResult = this.flushLine();
        if (lineResult.isErr()) {
          this.poisoned = lineResult.error;
          return err(lineResult.error);
        }
        if (lineResult.value !== undefined) frames.push(lineResult.value);
        continue;
      }
      this.pending.push(byte);
      if (this.pending.length > MAX_CONTENT_BYTES) {
        const error: FramingError = {
          type: "RecordTooLarge",
          byteLength: this.pending.length + 1,
        };
        this.poisoned = error;
        return err(error);
      }
    }
    return ok(frames);
  }

  /** True once a fatal framing violation has occurred; the framer will not process further bytes. */
  isPoisoned(): boolean {
    return this.poisoned !== undefined;
  }

  private flushLine(): Result<ParsedFrame | undefined, FramingError> {
    let bytes = this.pending;
    this.pending = [];
    if (bytes.length > 0 && bytes[bytes.length - 1] === 0x0d) {
      bytes = bytes.slice(0, -1);
    }
    if (bytes.length === 0) return ok(undefined);
    const decoded = decodeUtf8Strict(Uint8Array.from(bytes));
    if (decoded.isErr()) return err(decoded.error);
    const parsed = parseStrictJson(decoded.value);
    if (parsed.isErr())
      return err({ type: "InvalidJson", error: parsed.error });
    return ok({ raw: decoded.value, json: parsed.value });
  }
}
