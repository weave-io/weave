import { errAsync, okAsync, type ResultAsync } from "neverthrow";
import { validateArtifactManifest } from "./artifact-manifest.js";
import type { Clock } from "./clock.js";
import type { ReleaseError } from "./errors.js";
import type { FileSystem } from "./filesystem.js";
import type { ReleaseInvocation } from "./input-validation.js";
import {
  type NightlyPlan,
  type NightlyPlanError,
  type NightlyPlanInput,
  NightlyPlanner,
} from "./nightly-plan.js";
import type { NpmRegistryClient } from "./npm-registry-client.js";
import { TarInspector } from "./tar-inspector.js";

export interface PublishRequest {
  invocation: ReleaseInvocation;
  manifest: unknown;
  artifactDirectory: string;
}
/** Composition root for npm publishing. GitHub/train workflows are added in Tasks 9/13/19/20. */
export class ReleaseOrchestrator {
  constructor(
    private readonly files: FileSystem,
    private readonly npm: NpmRegistryClient,
    private readonly clock: Clock,
    private readonly tarInspector = new TarInspector(),
  ) {}
  /** Plan-only nightly path; publication remains intentionally unavailable until Task 17. */
  planNightly(
    input: NightlyPlanInput,
  ): ResultAsync<NightlyPlan, NightlyPlanError> {
    return new NightlyPlanner(this.npm, this.clock).plan(input);
  }
  publish(request: PublishRequest): ResultAsync<void, ReleaseError> {
    if (request.invocation.eventName === "schedule")
      return errAsync({ type: "UnsupportedOperation", operation: "schedule" });
    if (
      request.invocation.operation !== "nightly" &&
      request.invocation.operation !== "stable-publish"
    )
      return errAsync({
        type: "UnsupportedOperation",
        operation: request.invocation.operation,
      });
    const manifest = validateArtifactManifest(request.manifest);
    if (manifest.isErr())
      return errAsync({
        type: "InvalidManifest",
        issues: manifest.error.issues,
      });
    const tag =
      request.invocation.operation === "nightly"
        ? "nightly"
        : ("next" as const);
    return manifest.value.artifacts.reduce<ResultAsync<void, ReleaseError>>(
      (chain, artifact) =>
        chain.andThen(() => {
          const path = `${request.artifactDirectory}/${artifact.filename}`;
          return this.files.readBytes(path).andThen((bytes) => {
            const digest = `sha256:${new Bun.CryptoHasher("sha256").update(bytes).digest("hex")}`;
            if (digest !== artifact.sha256)
              return errAsync({
                type: "DigestMismatch" as const,
                expected: artifact.sha256,
                actual: digest,
              });
            const inspected = this.tarInspector.inspect(bytes);
            if (inspected.isErr())
              return errAsync({
                type: "TarPreflightFailed" as const,
                reason: inspected.error.type,
              });
            return this.npm.publish(path, tag).andThen(() => {
              const packageName = manifest.value.packages.find((name) =>
                artifact.filename.includes(name.replace("/", "-")),
              );
              if (packageName === undefined)
                return errAsync({
                  type: "InvalidManifest" as const,
                  issues: ["artifact has no package"],
                });
              return this.npm.verifyPublished(
                packageName,
                manifest.value.versions[packageName],
                artifact.sha256,
              );
            });
          });
        }),
      okAsync(undefined),
    );
  }
}
