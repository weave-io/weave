/**
 * Pi OpenAI Codex subscription fast mode: the bounded response-evidence
 * sniffer.
 *
 * Rule 10 of the normative mapping in
 * `docs/specs/fast-provider-acceleration-contract.md` says a fast request may
 * only be reported as `applied` when the *same attempt's* response proves it,
 * and the only proof the ChatGPT backend exposes is `service_tier` on the SSE
 * `response.*` objects. Reading that value must not change what the caller
 * receives, must not delay the first token, and must not let a hostile or
 * broken stream cost unbounded memory or time.
 *
 * This module is the whole of that reading. It is a passthrough
 * `TransformStream`: every chunk is enqueued downstream *before* it is looked
 * at, so the native stream keeps its exact bytes, order, and timing. Scanning
 * stops for good at the first conclusive answer or at
 * `CODEX_EVIDENCE_SCAN_BUDGET_BYTES`, whichever comes first; after that the
 * transform is pure passthrough with no retained text.
 *
 * Deliberate properties:
 *
 * - **Bounded by construction.** At most one budget's worth of decoded text is
 *   ever retained, in one carry buffer that is dropped the moment scanning
 *   ends. The full response is never buffered and the body is never cloned,
 *   which is what keeps a long generation and a hostile single-event stream
 *   equally cheap.
 * - **Never disturbs the stream.** Every scan step runs inside a `Result`
 *   boundary. A decode failure, a parse failure, a hostile frame, or a
 *   throwing consumer callback ends the scan with a bounded outcome; it never
 *   propagates into the passthrough path.
 * - **Bounded output.** The only thing that leaves this module is one
 *   `CodexFastEvidenceOutcome` token. No response text, header, id, or parse
 *   diagnostic is ever emitted.
 */

import { Result } from "neverthrow";
import type { CodexFastEvidenceOutcome } from "./attempt.js";
import { CODEX_PRIORITY_SERVICE_TIER } from "./routing.js";

/**
 * The scan ceiling, in bytes of response body. 64 KiB comfortably covers the
 * `response.created` and `response.completed` objects of a Codex responses
 * stream while staying far below any stream worth buffering. Bytes past the
 * ceiling are forwarded downstream untouched and never inspected.
 */
export const CODEX_EVIDENCE_SCAN_BUDGET_BYTES = 65_536;

/** The documented standard-speed value; negative evidence, not a failure. */
export const CODEX_STANDARD_SERVICE_TIER = "default";

/** The two event types that may carry conclusive evidence. */
export const CODEX_EVIDENCE_EVENT_CREATED = "response.created";
export const CODEX_EVIDENCE_EVENT_COMPLETED = "response.completed";

/** The SSE terminator this transport uses for a finished stream. */
const SSE_DONE_PAYLOAD = "[DONE]";

/** The only construction failure: the host has no usable `TransformStream`. */
export type CodexEvidenceSnifferError = {
  readonly kind: "sniffer-unavailable";
};

export type CodexEvidenceSnifferInput = {
  /**
   * Receives exactly one outcome per sniffer, at the first conclusive event,
   * at budget exhaustion, at end of stream, or at the first internal trouble.
   * A throwing callback is absorbed.
   */
  readonly onOutcome: (outcome: CodexFastEvidenceOutcome) => void;
  /** Test seam. Defaults to `CODEX_EVIDENCE_SCAN_BUDGET_BYTES`. */
  readonly budgetBytes?: number;
};

/** JSON objects only: the sniffer inspects nothing it did not parse itself. */
function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray(value) === false
  );
}

type TierReading = {
  /** Whether a `service_tier` key existed at all. */
  readonly present: boolean;
  /** Its value when that value is a string; `undefined` otherwise. */
  readonly tier: string | undefined;
};

const TIER_ABSENT: TierReading = Object.freeze({
  present: false,
  tier: undefined,
} as const);

/**
 * Read `service_tier` from an event. The Codex responses stream nests the
 * response object under `response`; the flat shape is accepted too, because
 * both have been observed on this transport and neither costs anything to
 * check.
 */
function readServiceTier(event: Record<string, unknown>): TierReading {
  const nested = event.response;
  if (isJsonRecord(nested) && "service_tier" in nested) {
    const value = nested.service_tier;
    return Object.freeze({
      present: true,
      tier: typeof value === "string" ? value : undefined,
    } as const);
  }
  if ("service_tier" in event) {
    const value = event.service_tier;
    return Object.freeze({
      present: true,
      tier: typeof value === "string" ? value : undefined,
    } as const);
  }
  return TIER_ABSENT;
}

/**
 * Create the passthrough sniffer for one outgoing attempt's response body.
 *
 * Resolution order, which is the honest reading of what the backend sends:
 *
 * - `"priority"` on a `response.created` or `response.completed` object is the
 *   only positive proof, and it resolves immediately as `confirmed`.
 * - `"default"` is documented negative evidence and resolves as `standard`.
 * - `response.completed` always resolves: an unknown value is `ambiguous`, a
 *   missing key is `absent`. Waiting past the terminal event would be waiting
 *   for something that cannot arrive.
 * - `response.created` carrying anything else (the backend has been observed
 *   to send a placeholder there) does *not* resolve. It only remembers that
 *   the answer so far is inconclusive, so a later `response.completed` can
 *   still speak.
 * - End of stream resolves with that remembered answer.
 * - Budget exhaustion resolves the same way, except that having read nothing
 *   relevant is reported as `ambiguous` rather than `absent`: the field was not
 *   proven missing, it was simply never reached.
 */
export function createCodexServiceTierSniffer(
  input: CodexEvidenceSnifferInput,
): Result<TransformStream<Uint8Array, Uint8Array>, CodexEvidenceSnifferError> {
  const budget =
    typeof input.budgetBytes === "number" &&
    Number.isInteger(input.budgetBytes) &&
    input.budgetBytes >= 0
      ? Math.min(input.budgetBytes, CODEX_EVIDENCE_SCAN_BUDGET_BYTES)
      : CODEX_EVIDENCE_SCAN_BUDGET_BYTES;

  let scanning = budget > 0;
  let resolved = false;
  let scannedBytes = 0;
  let carry = "";
  /** The best answer so far when nothing conclusive has been seen. */
  let pending: CodexFastEvidenceOutcome = "absent";

  /** Running out of budget is not proof that the field was missing. */
  function budgetOutcome(): CodexFastEvidenceOutcome {
    return pending === "absent" ? "ambiguous" : pending;
  }
  const decoder = new TextDecoder("utf-8", { fatal: false });

  /** Emit once. A throwing consumer must never reach the stream. */
  function resolve(outcome: CodexFastEvidenceOutcome): void {
    if (resolved) {
      return;
    }
    resolved = true;
    scanning = false;
    carry = "";
    Result.fromThrowable(
      () => {
        input.onOutcome(outcome);
      },
      () => undefined,
    )();
  }

  function inspect(event: unknown): void {
    if (!isJsonRecord(event)) {
      pending = "ambiguous";
      return;
    }
    const type = event.type;
    const created = type === CODEX_EVIDENCE_EVENT_CREATED;
    const completed = type === CODEX_EVIDENCE_EVENT_COMPLETED;
    if (!created && !completed) {
      return;
    }
    const reading = readServiceTier(event);
    if (reading.tier === CODEX_PRIORITY_SERVICE_TIER) {
      resolve("confirmed");
      return;
    }
    if (reading.tier === CODEX_STANDARD_SERVICE_TIER) {
      resolve("standard");
      return;
    }
    if (completed) {
      resolve(reading.present ? "ambiguous" : "absent");
      return;
    }
    if (reading.present) {
      pending = "ambiguous";
    }
  }

  /** One `\n\n`-delimited SSE frame. Only `data:` lines matter here. */
  function handleFrame(frame: string): void {
    const dataLines: string[] = [];
    for (const line of frame.split("\n")) {
      if (!line.startsWith("data:")) {
        continue;
      }
      const value = line.slice(5);
      dataLines.push(value.startsWith(" ") ? value.slice(1) : value);
    }
    if (dataLines.length === 0) {
      return;
    }
    const data = dataLines.join("\n");
    if (data.length === 0 || data === SSE_DONE_PAYLOAD) {
      return;
    }
    const parsed = Result.fromThrowable(
      () => JSON.parse(data) as unknown,
      () => undefined,
    )();
    if (parsed.isErr()) {
      // Unparseable framing is inconclusive, never fatal.
      pending = "ambiguous";
      return;
    }
    inspect(parsed.value);
  }

  function scan(chunk: Uint8Array): void {
    const remaining = budget - scannedBytes;
    if (remaining <= 0) {
      resolve(budgetOutcome());
      return;
    }
    const usable =
      chunk.byteLength > remaining ? chunk.subarray(0, remaining) : chunk;
    scannedBytes += usable.byteLength;
    // Carriage returns are removed so `\n\n` is the single frame delimiter for
    // every line ending this transport may use.
    carry += decoder.decode(usable, { stream: true }).replaceAll("\r", "");
    let boundary = carry.indexOf("\n\n");
    while (boundary !== -1) {
      const frame = carry.slice(0, boundary);
      carry = carry.slice(boundary + 2);
      handleFrame(frame);
      if (resolved) {
        return;
      }
      boundary = carry.indexOf("\n\n");
    }
    if (scannedBytes >= budget) {
      // A single event larger than the whole budget is exactly the hostile
      // case this ceiling exists for: the retained carry is dropped and the
      // rest of the body is never inspected.
      resolve(budgetOutcome());
    }
  }

  const safeScan = Result.fromThrowable(scan, () => undefined);

  return Result.fromThrowable(
    () =>
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          // Passthrough first, always. Nothing below can delay or drop it.
          controller.enqueue(chunk);
          if (!scanning) {
            return;
          }
          if (safeScan(chunk).isErr()) {
            resolve("ambiguous");
          }
        },
        flush() {
          resolve(pending);
        },
      }),
    (): CodexEvidenceSnifferError => ({ kind: "sniffer-unavailable" }),
  )();
}
