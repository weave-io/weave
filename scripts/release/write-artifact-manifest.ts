import { logger } from "@weaveio/weave-engine";
import { errAsync, Result, ResultAsync } from "neverthrow";
import { RELEASE_INPUT_LIMITS } from "./constants.js";
import {
  ArtifactManifestSchema,
  FullShaSchema,
  packageArtifactFilename,
  ReleaseOperationSchema,
  StableTrainRecordSchema,
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
  stableTrainText = Bun.env.RELEASE_STABLE_TRAIN,
): ResultAsync<void, ManifestWriteError> {
  const parsedOperation = ReleaseOperationSchema.safeParse(operation);
  const parsedSubject = FullShaSchema.safeParse(subjectSha);
  if (!parsedOperation.success || !parsedSubject.success)
    return errAsync({ type: "InvalidInput" });
  const channel = parsedOperation.data === "nightly" ? "nightly" : "stable";
  const stableTrain =
    channel === "stable" ? parseStableTrain(stableTrainText) : undefined;
  if (channel === "stable" && stableTrain === undefined)
    return errAsync({ type: "InvalidInput" });
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
      ...(stableTrain === undefined ? {} : { stableTrain }),
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

function parseStableTrain(value: string | undefined): unknown | undefined {
  if (value === undefined) return undefined;
  const candidate = Result.fromThrowable(
    () => JSON.parse(value) as unknown,
    () => undefined,
  )();
  if (candidate.isErr()) return undefined;
  const result = StableTrainRecordSchema.safeParse(candidate.value);
  return result.success ? result.data : undefined;
}

async function discoverPackages(channel: "nightly" | "stable") {
  const stageGlob = new Bun.Glob(".release/validate-*/staging/*/package.json");
  const tarballGlob = new Bun.Glob(".release/validate-*/tarballs/*.tgz");
  // `.release` is intentionally hidden; opt into dot-directory traversal so
  // the control-plane layout can be consumed in a fresh checkout.
  const stages = await Array.fromAsync(stageGlob.scan({ dot: true }));
  const tarballs = await Array.fromAsync(tarballGlob.scan({ dot: true }));
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
      const packageStem = packageJson.name
        .replace("@", "")
        .replaceAll("/", "-");
      const tarball = tarballs.find((path) =>
        path.endsWith(`${packageStem}-${packageJson.version}.tgz`),
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
      // Control consumes a flat payload; preserve npm's emitted bytes under the
      // canonical packageArtifactFilename instead of relying on npm's filename.
      await Bun.write(`.release/${filename}`, bytes);
      await Bun.write(`.release/${filename}.sha256`, `${sha256}\n`);
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
