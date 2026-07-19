import { logger } from "@weaveio/weave-engine";
import { errAsync, ResultAsync } from "neverthrow";
import { RELEASE_INPUT_LIMITS } from "./constants.js";
import {
  ArtifactManifestSchema,
  FullShaSchema,
  packageArtifactFilename,
  ReleaseOperationSchema,
} from "./model.js";

const log = logger.child({ module: "release-artifact-manifest" });

type ManifestWriteError =
  | { type: "InvalidInput" }
  | { type: "ArtifactDiscovery"; message: string }
  | { type: "InvalidManifest"; issues: readonly string[] };

/** Builds the payload manifest from the exact tarballs emitted by release validation. */
export function writeArtifactManifest(
  operation: string | undefined,
  subjectSha: string | undefined,
): ResultAsync<void, ManifestWriteError> {
  const parsedOperation = ReleaseOperationSchema.safeParse(operation);
  const parsedSubject = FullShaSchema.safeParse(subjectSha);
  if (!parsedOperation.success || !parsedSubject.success)
    return errAsync({ type: "InvalidInput" });
  const channel = parsedOperation.data === "nightly" ? "nightly" : "stable";
  return ResultAsync.fromPromise(discoverPackages(channel), (cause) => ({
    type: "ArtifactDiscovery" as const,
    message: String(cause),
  })).andThen((packages) => {
    const manifest = {
      schemaVersion: 1 as const,
      releaseSubjectSha: parsedSubject.data,
      channel,
      packages: packages.map((entry) => entry.name),
      versions: Object.fromEntries(
        packages.map((entry) => [entry.name, entry.version]),
      ),
      artifacts: packages.map((entry) => entry.artifact),
    };
    const validated = ArtifactManifestSchema.safeParse(manifest);
    if (!validated.success)
      return errAsync({
        type: "InvalidManifest" as const,
        issues: validated.error.issues.map((issue) => issue.message),
      });
    return ResultAsync.fromPromise(
      Bun.write(
        ".release/manifest.json",
        `${JSON.stringify(validated.data)}\n`,
      ).then(() => undefined),
      (cause) => ({
        type: "ArtifactDiscovery" as const,
        message: String(cause),
      }),
    );
  });
}

async function discoverPackages(channel: "nightly" | "stable") {
  const stageGlob = new Bun.Glob(".release/validate-*/staging/*/package.json");
  const tarballGlob = new Bun.Glob(".release/validate-*/tarballs/*.tgz");
  const stages = await Array.fromAsync(stageGlob.scan());
  const tarballs = await Array.fromAsync(tarballGlob.scan());
  if (stages.length === 0 || tarballs.length === 0)
    throw new Error(
      "release validation did not produce staged packages and tarballs",
    );
  const packages = await Promise.all(
    stages.map(async (stage) => {
      const packageJson = (await Bun.file(stage).json()) as {
        name?: unknown;
        version?: unknown;
      };
      if (
        typeof packageJson.name !== "string" ||
        typeof packageJson.version !== "string"
      )
        throw new Error(`invalid staged package manifest: ${stage}`);
      if (
        channel === "stable" &&
        packageJson.name === "@weaveio/weave-adapter-claude-code"
      )
        return undefined;
      const tarball = tarballs.find((path) =>
        path.endsWith(`-${packageJson.version}.tgz`),
      );
      if (tarball === undefined)
        throw new Error(`missing tarball for ${packageJson.name}`);
      const bytes = await Bun.file(tarball).bytes();
      if (bytes.length > RELEASE_INPUT_LIMITS.artifactBytes)
        throw new Error(`tarball exceeds size limit: ${tarball}`);
      const filename = packageArtifactFilename(
        packageJson.name,
        packageJson.version,
      );
      const sha256 = `sha256:${new Bun.CryptoHasher("sha256").update(bytes).digest("hex")}`;
      return {
        name: packageJson.name,
        version: packageJson.version,
        artifact: {
          filename,
          checksumFilename: `${filename}.sha256`,
          sizeBytes: bytes.length,
          sha256,
        },
      };
    }),
  );
  return packages.filter(
    (entry): entry is NonNullable<typeof entry> => entry !== undefined,
  );
}

if (import.meta.main) {
  const result = await writeArtifactManifest(
    Bun.env.RELEASE_OPERATION,
    Bun.env.RELEASE_SUBJECT_SHA,
  );
  if (result.isErr()) {
    log.error(
      { error: result.error },
      "failed to write release artifact manifest",
    );
    process.exitCode = 1;
  }
}
