import { logger } from "@weaveio/weave-engine";
import { errAsync, Result, ResultAsync } from "neverthrow";
import { z } from "zod";
import { RELEASE_INPUT_LIMITS } from "./constants.js";
import {
  ArtifactManifestSchema,
  FullShaSchema,
  packageArtifactFilename,
  ReleaseOperationSchema,
  type StableTrainRecord,
  StableTrainRecordSchema,
} from "./model.js";

const log = logger.child({ module: "release-artifact-manifest" });

type ManifestWriteError =
  | { type: "InvalidInput" }
  | { type: "ArtifactDiscovery"; message: string }
  | { type: "InvalidManifest"; issues: readonly string[] };

type DiscoveredPackage = {
  name: string;
  version: string;
  artifact: {
    filename: string;
    checksumFilename: string;
    sizeBytes: number;
    sha256: string;
  };
};

type ManifestDraft = {
  schemaVersion: 1;
  releaseSubjectSha: string;
  channel: "nightly" | "stable";
  packages: string[];
  versions: Record<string, string>;
  artifacts: DiscoveredPackage["artifact"][];
  stableTrain?: StableTrainRecord;
};

const StagedPackageSchema = z
  .object({
    name: z.string().min(1).max(128),
    version: z.string().min(1).max(128),
  })
  .strict();

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
  let stableTrain: StableTrainRecord | undefined;
  if (channel === "stable") stableTrain = parseStableTrain(stableTrainText);
  if (channel === "stable" && stableTrain === undefined)
    return errAsync({ type: "InvalidInput" });
  return ResultAsync.fromPromise(discoverPackages(channel), () => ({
    type: "ArtifactDiscovery" as const,
    message: "artifact discovery failed",
  })).andThen((packages) => {
    const manifest: ManifestDraft = {
      schemaVersion: 1,
      releaseSubjectSha: parsedSubject.data,
      channel,
      packages: packages.map((entry) => entry.name),
      versions: Object.fromEntries(
        packages.map((entry) => [entry.name, entry.version]),
      ),
      artifacts: packages.map((entry) => entry.artifact),
    };
    if (stableTrain !== undefined) manifest.stableTrain = stableTrain;
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
      ).then(() => Promise.resolve()),
      () => ({
        type: "ArtifactDiscovery" as const,
        message: "artifact manifest write failed",
      }),
    );
  });
}

function parseStableTrain(
  value: string | undefined,
): StableTrainRecord | undefined {
  if (value === undefined) return;
  const candidate = Result.fromThrowable(
    () => JSON.parse(value),
    () => "invalid stable train JSON",
  )();
  if (candidate.isErr()) return;
  const result = StableTrainRecordSchema.safeParse(candidate.value);
  return result.success ? result.data : undefined;
}

async function discoverPackages(
  channel: "nightly" | "stable",
): Promise<readonly DiscoveredPackage[]> {
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
    stages.map(async (stage): Promise<DiscoveredPackage | null> => {
      const packageJson = StagedPackageSchema.parse(
        await Bun.file(stage).json(),
      );
      if (
        channel === "stable" &&
        packageJson.name === "@weaveio/weave-adapter-claude-code"
      )
        return null;
      const packageStem = packageJson.name
        .replace("@", "")
        .replaceAll("/", "-");
      const tarball = tarballs.find((path) =>
        path.endsWith(`${packageStem}-${packageJson.version}.tgz`),
      );
      if (tarball === undefined) throw new Error("missing release tarball");
      const bytes = await Bun.file(tarball).bytes();
      if (bytes.length > RELEASE_INPUT_LIMITS.artifactBytes)
        throw new Error("release tarball exceeds size limit");
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
  return packages.filter((entry): entry is DiscoveredPackage => entry !== null);
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
