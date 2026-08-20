import { dirname } from "node:path";
import { err, ok, type Result } from "neverthrow";
import { runBoundedCommand } from "./command-runner.js";
import { failure, SAFE_SYSTEM_PATH, type SmokeFailure } from "./contract.js";
import { validateReportTargetPath } from "./environment.js";
import { removeOwnedFile, writeText } from "./fixture-files.js";
import { serializeSmokeReport } from "./report-projection.js";

async function removeReportTemp(
  path: string,
): Promise<Result<void, SmokeFailure>> {
  return removeOwnedFile(path);
}

/**
 * Validate first, write a 0600 sibling, then rename it into place. The target
 * is never opened for writing, so a failed projection or failed write cannot
 * leave a truncated report behind.
 */
export async function writeSmokeReportAtomically(
  path: string,
  report: unknown,
): Promise<Result<void, SmokeFailure>> {
  const validatedPath = await validateReportTargetPath(path);
  if (validatedPath.isErr()) return err(validatedPath.error);
  const serialized = serializeSmokeReport(report);
  if (serialized.isErr()) return err(serialized.error);
  const target = validatedPath.value;
  const temporary = `${target}.tmp-${crypto.randomUUID()}`;
  const cwd = dirname(target);
  const env = { PATH: SAFE_SYSTEM_PATH };
  const written = await writeText(temporary, serialized.value);
  if (written.isErr()) {
    const removed = await removeReportTemp(temporary);
    return removed.isErr()
      ? err(removed.error)
      : err(
          failure("ReportWriteFailed", "could not write report staging file"),
        );
  }
  const restricted = await runBoundedCommand(["chmod", "600", temporary], {
    cwd,
    env,
    timeoutMs: 2_000,
  });
  if (restricted.isErr()) {
    const removed = await removeReportTemp(temporary);
    return removed.isErr()
      ? err(removed.error)
      : err(
          failure("ReportWriteFailed", "could not restrict report permissions"),
        );
  }
  const moved = await runBoundedCommand(["mv", "-f", temporary, target], {
    cwd,
    env,
    timeoutMs: 2_000,
  });
  if (moved.isErr()) {
    const removed = await removeReportTemp(temporary);
    return removed.isErr()
      ? err(removed.error)
      : err(
          failure("ReportWriteFailed", "could not atomically publish report"),
        );
  }
  return ok(undefined);
}
