import { logger } from "@weaveio/weave-engine";
import { errAsync, ResultAsync } from "neverthrow";
import { z } from "zod";
import {
  PUBLIC_MANIFEST_FIELDS,
  RELEASE_INPUT_LIMITS,
  RUNTIME_DEPENDENCY_FIELDS,
} from "./constants.js";
import { parseJsonValue } from "./json.js";
import {
  ArtifactManifestSchema,
  FullShaSchema,
  PackageNameSchema,
  packageArtifactFilename,
  ReleaseOperationSchema,
  SemVerSchema,
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
};

const STAGED_PACKAGE_COLLECTION_LIMIT = 128;
const StagedManifestStringSchema = z
  .string()
  .max(RELEASE_INPUT_LIMITS.manifestBytes);
const StagedDependencyMapSchema = z
  .record(
    z.string().max(RELEASE_INPUT_LIMITS.identifierLength),
    StagedManifestStringSchema,
  )
  .superRefine((value, context) => {
    if (Object.keys(value).length > STAGED_PACKAGE_COLLECTION_LIMIT)
      context.addIssue({
        code: "custom",
        message: "manifest map has too many entries",
      });
    for (const name of Object.keys(value))
      if (name.startsWith("@weaveio/"))
        context.addIssue({
          code: "custom",
          message: "staged manifests cannot declare workspace dependencies",
        });
  });
const StagedPackageSchema = z
  .object({
    name: PackageNameSchema,
    version: SemVerSchema,
  })
  .catchall(z.json())
  .superRefine((value, context) => {
    for (const field of Object.keys(value))
      if (
        !PUBLIC_MANIFEST_FIELDS.some((allowed) => allowed === field) &&
        !RUNTIME_DEPENDENCY_FIELDS.some((allowed) => allowed === field)
      )
        context.addIssue({
          code: "custom",
          path: [field],
          message: "unknown staged manifest field",
        });
    for (const field of RUNTIME_DEPENDENCY_FIELDS) {
      const dependencies = value[field];
      if (dependencies === undefined) continue;
      if (!StagedDependencyMapSchema.safeParse(dependencies).success)
        context.addIssue({
          code: "custom",
          path: [field],
          message: "invalid staged dependency map",
        });
    }
  });

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
    stages.map(async (stage): Promise<DiscoveredPackage | null> => {
      const stagedBytes = await Bun.file(stage).bytes();
      if (stagedBytes.byteLength > RELEASE_INPUT_LIMITS.manifestBytes)
        throw new Error("staged package manifest exceeds size limit");
      const parsed = parseJsonValue(new TextDecoder().decode(stagedBytes));
      if (parsed.isErr()) throw new Error("invalid staged package manifest");
      const checked = StagedPackageSchema.safeParse(parsed.value);
      if (!checked.success) throw new Error("invalid staged package manifest");
      const packageJson = checked.data;
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
