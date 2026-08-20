import { err, ok, Result } from "neverthrow";
import {
  MAX_REPORT_BYTES,
  PACKAGE_VERSION,
  type ReportDiagnosticCode,
  type SanitizedSmokeReport,
  type SmokeFailure,
  type SmokeReport,
} from "./contract.js";
import {
  DEFAULT_REPORT_FORBIDDEN_CONTENT,
  inspectReportGraph,
  reportMalformed,
  reportTooLarge,
  safeReportDataEntries,
  scanReportForForbiddenContent,
  validateReportShape,
} from "./report-safety.js";

function cloneReportData(value: unknown): unknown {
  if (Array.isArray(value)) {
    const result: unknown[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      result.push(cloneReportData(descriptor?.value));
    }
    return result;
  }
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    const entries = safeReportDataEntries(value);
    if (entries.isErr()) return result;
    for (const [key, child] of entries.value) {
      if (typeof key === "string") result[key] = cloneReportData(child);
    }
    return result;
  }
  return value;
}

function encodeSanitizedReport(
  report: SanitizedSmokeReport,
): Result<string, SmokeFailure> {
  const serialized = Result.fromThrowable(
    () => JSON.stringify(report),
    () => reportMalformed("sanitized report is not serializable"),
  )();
  if (serialized.isErr()) return err(serialized.error);
  const body = `${serialized.value}\n`;
  if (new TextEncoder().encode(body).byteLength > MAX_REPORT_BYTES)
    return err(reportTooLarge("encoded report exceeds the byte bound"));
  return ok(body);
}

/** Validate the input graph, then project it into the closed report schema. */
export function projectSanitizedSmokeReport(
  report: unknown,
  forbidden: readonly string[] = DEFAULT_REPORT_FORBIDDEN_CONTENT,
): Result<SanitizedSmokeReport, SmokeFailure> {
  const graph = inspectReportGraph(report);
  if (graph.isErr()) return err(graph.error);
  const leaks = scanReportForForbiddenContent(report, forbidden);
  if (leaks.isErr()) return err(leaks.error);
  const shape = validateReportShape(report);
  if (shape.isErr()) return err(shape.error);
  const cloned = cloneReportData(report) as SmokeReport;
  const projected: SanitizedSmokeReport = {
    schemaVersion: cloned.schemaVersion,
    checklistVersion: cloned.checklistVersion,
    artifact: {
      packageName: cloned.artifact.packageName,
      packageVersion: PACKAGE_VERSION,
      sha256: cloned.artifact.sha256,
    },
    pi: cloned.pi,
    ...(cloned.provenance === undefined
      ? {}
      : { provenance: cloned.provenance }),
    ...(cloned.fallback === undefined
      ? {}
      : {
          fallback: {
            ...cloned.fallback,
            nativeLine: "model-fallback" as const,
            outcome: "fallback-confirmed" as const,
          },
        }),
    ...(cloned.rollback === undefined
      ? {}
      : {
          rollback: {
            ...cloned.rollback,
            outcome: "legacy-settlement" as const,
          },
        }),
    diagnostics: cloned.diagnostics as readonly ReportDiagnosticCode[],
  };
  const encoded = encodeSanitizedReport(projected);
  return encoded.isErr() ? err(encoded.error) : ok(projected);
}

/** Compatibility name for callers that only need a safety verdict. */
export function validateReportSafety(
  report: unknown,
  forbidden: readonly string[] = DEFAULT_REPORT_FORBIDDEN_CONTENT,
): Result<SanitizedSmokeReport, SmokeFailure> {
  return projectSanitizedSmokeReport(report, forbidden);
}

export function serializeSmokeReport(
  report: unknown,
): Result<string, SmokeFailure> {
  const projected = projectSanitizedSmokeReport(report);
  if (projected.isErr()) return err(projected.error);
  return encodeSanitizedReport(projected.value);
}
