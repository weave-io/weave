import type { StableTrainRecord } from "./model.js";

/** Verifies that finalize advanced, rather than replaced, the bound stable train. */
export function hasProgressedLineage(
  original: StableTrainRecord,
  progressed: StableTrainRecord,
): boolean {
  if (original.trainRef !== progressed.trainRef) return false;
  if (original.subjectSha !== progressed.subjectSha) return false;
  if (
    original.cutAt !== progressed.cutAt ||
    original.expiresAt !== progressed.expiresAt
  )
    return false;
  if (JSON.stringify(original.packages) !== JSON.stringify(progressed.packages))
    return false;
  if (JSON.stringify(original.versions) !== JSON.stringify(progressed.versions))
    return false;
  return (
    original.state === "awaiting-promotion" && progressed.state === "promoted"
  );
}
