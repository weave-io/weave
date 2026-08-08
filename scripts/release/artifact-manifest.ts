import { err, ok, type Result } from "neverthrow";
import {
  type ArtifactBindingRecord,
  ArtifactBindingRecordSchema,
  type ArtifactManifest,
  ArtifactManifestSchema,
} from "./model.js";

export type ArtifactManifestError = {
  type: "InvalidArtifactManifest";
  issues: readonly string[];
};

/** Task 9 binds this validated shape to GitHub artifact identity and attestation. */
export function validateArtifactManifest(
  input: unknown,
): Result<ArtifactManifest, ArtifactManifestError> {
  const parsed = ArtifactManifestSchema.safeParse(input);
  if (!parsed.success)
    return err({
      type: "InvalidArtifactManifest",
      issues: parsed.error.issues.map((issue) => issue.message),
    });
  return ok(parsed.data);
}

/** Task 9 extension point: validates a server-bound, content-addressed manifest. */
export function validateArtifactBindingRecord(
  input: unknown,
): Result<ArtifactBindingRecord, ArtifactManifestError> {
  const parsed = ArtifactBindingRecordSchema.safeParse(input);
  if (!parsed.success)
    return err({
      type: "InvalidArtifactManifest",
      issues: parsed.error.issues.map((issue) => issue.message),
    });
  return ok(parsed.data);
}
