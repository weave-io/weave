import { err, ok, Result } from "neverthrow";
import {
  type LiveProofJsonFailure,
  type LiveProofJsonFailureReason,
  type LiveProofReport,
  type LiveProofSerializationFailure,
  type LiveProofSerializationFailureReason,
  MAX_LIVE_PROOF_REPORT_TOTAL_BYTES,
} from "./child-stream-live-proof-contract-report-schema.js";
import { validateLiveProofReport } from "./child-stream-live-proof-contract-report-validation.js";

// ---------------------------------------------------------------------------
// Safe content-free report serialization
// ---------------------------------------------------------------------------

const textEncoder = new TextEncoder();
const jsonStringify = JSON.stringify;
const jsonParse = JSON.parse;

function utf8ByteLength(value: string): number {
  return textEncoder.encode(value).byteLength;
}

function serializationFailure(
  reason: LiveProofSerializationFailureReason,
): LiveProofSerializationFailure {
  return { reason, evidence: "blocked" };
}

function jsonFailure(reason: LiveProofJsonFailureReason): LiveProofJsonFailure {
  return { reason, evidence: "blocked" };
}

/** Serialize only a validated, canonical report. No input object is stringified. */
export function serializeLiveProofReport(
  input: unknown,
): Result<string, LiveProofSerializationFailure> {
  const validated = validateLiveProofReport(input);
  if (validated.isErr()) return err(serializationFailure("invalid-report"));

  const serialized = Result.fromThrowable(
    () => jsonStringify(validated.value),
    (): LiveProofSerializationFailure =>
      serializationFailure("serialization-failed"),
  )();
  if (serialized.isErr()) return err(serialized.error);
  if (utf8ByteLength(serialized.value) > MAX_LIVE_PROOF_REPORT_TOTAL_BYTES) {
    return err(serializationFailure("report-too-large"));
  }
  return ok(serialized.value);
}

export const safeSerializeLiveProofReport = serializeLiveProofReport;

/** Parse JSON and then apply the same closed schema as the serializer. */
export function parseLiveProofReportJson(
  input: unknown,
): Result<LiveProofReport, LiveProofJsonFailure> {
  if (typeof input !== "string") return err(jsonFailure("not-string"));
  if (utf8ByteLength(input) > MAX_LIVE_PROOF_REPORT_TOTAL_BYTES) {
    return err(jsonFailure("json-too-large"));
  }
  const parsed = Result.fromThrowable(
    () => jsonParse(input) as unknown,
    (): LiveProofJsonFailure => jsonFailure("invalid-json"),
  )();
  if (parsed.isErr()) return err(parsed.error);
  const validated = validateLiveProofReport(parsed.value);
  if (validated.isErr()) return err(jsonFailure("invalid-report"));
  return ok(validated.value);
}

export const parseSerializedLiveProofReport = parseLiveProofReportJson;
