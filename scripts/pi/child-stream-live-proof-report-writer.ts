import { errAsync, okAsync, type ResultAsync } from "neverthrow";
import {
  type LiveProofFailureCode,
  MAX_LIVE_PROOF_REPORT_TOTAL_BYTES,
  serializeLiveProofReport,
} from "./child-stream-live-proof-contract.js";
import type { LiveProofSystem } from "./child-stream-live-proof-system.js";

export interface LiveProofWriteFailure {
  readonly code: LiveProofFailureCode;
}

function writeFailure(code: LiveProofFailureCode): LiveProofWriteFailure {
  return { code };
}

function serializationCode(
  reason: "invalid-report" | "report-too-large" | "serialization-failed",
): LiveProofFailureCode {
  if (reason === "report-too-large") return "report-too-large";
  if (reason === "serialization-failed") return "serialization-failed";
  return "report-invalid";
}

function directoryOf(target: string): string {
  const index = target.lastIndexOf("/");
  return index <= 0 ? "." : target.slice(0, index);
}

/**
 * Write one validated content-free report.
 *
 * The value is validated and serialized before any filesystem effect, so an
 * unbounded or content-bearing object never reaches a descriptor. The target
 * must be missing or an ordinary file: a symlink, directory, device, or any
 * other kind is refused rather than followed. The bytes land in an
 * owner-only temporary file created with `O_EXCL` in the target's own
 * directory and are then renamed over the target, so a reader never observes
 * a partial report. Every failure after creation removes the temporary file.
 */
export function writeLiveProofReport(input: {
  readonly system: LiveProofSystem;
  readonly target: string;
  readonly report: unknown;
}): ResultAsync<number, LiveProofWriteFailure> {
  const serialized = serializeLiveProofReport(input.report);
  if (serialized.isErr()) {
    return errAsync(writeFailure(serializationCode(serialized.error.reason)));
  }
  const bytes = new TextEncoder().encode(`${serialized.value}\n`);
  if (bytes.byteLength > MAX_LIVE_PROOF_REPORT_TOTAL_BYTES) {
    return errAsync(writeFailure("report-too-large"));
  }

  const system = input.system;
  const target = input.target;
  const temporary = `${target}.${system.uniqueToken()}.tmp`;

  const removeTemporary = (): ResultAsync<void, LiveProofWriteFailure> =>
    system.removePath(temporary).mapErr(() => writeFailure("report-invalid"));

  return system
    .pathKind(target)
    .mapErr(() => writeFailure("report-invalid"))
    .andThen((kind) =>
      kind === "missing" || kind === "file"
        ? okAsync(undefined)
        : errAsync(writeFailure("unsafe-report-target")),
    )
    .andThen(() =>
      system
        .makeDirectory(directoryOf(target))
        .mapErr(() => writeFailure("report-invalid")),
    )
    .andThen(() =>
      system.pathKind(temporary).mapErr(() => writeFailure("report-invalid")),
    )
    .andThen((kind) =>
      kind === "missing"
        ? okAsync(undefined)
        : errAsync(writeFailure("unsafe-report-target")),
    )
    .andThen(() =>
      system
        .createPrivateFile(temporary)
        .mapErr(() => writeFailure("report-invalid")),
    )
    .andThen(() =>
      system
        .writeBytes(temporary, bytes)
        .mapErr(() => writeFailure("report-invalid"))
        .orElse((failure) => removeTemporary().andThen(() => errAsync(failure)))
        .andThen(() =>
          system
            .renamePath(temporary, target)
            .mapErr(() => writeFailure("report-invalid"))
            .orElse((failure) =>
              removeTemporary().andThen(() => errAsync(failure)),
            ),
        ),
    )
    .map(() => bytes.byteLength);
}
