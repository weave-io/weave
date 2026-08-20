import { dirname, isAbsolute, join, resolve } from "node:path";
import { err, ok, Result, ResultAsync } from "neverthrow";
import { type TarEntry, TarInspector } from "../tar-inspector.js";
import {
  artifactDigest,
  boundText,
  EXACT_PI_VERSION,
  type FixtureControlFacts,
  failure,
  type InstalledAdapterProvenance,
  PACKAGE_NAME,
  type PackedArtifact,
  SHA256,
  type SmokeFailure,
} from "./contract.js";
import {
  canonicalExistingPath,
  containsPathControlCharacter,
  hasSymlinkAncestor,
  pathIsSymlink,
  pathWithin,
  regularNonSymlinkFile,
  safeAbsolutePath,
  validateExpectedPiVersion,
} from "./environment.js";
export function verifyArtifactDigest(
  actual: string,
  expected: string,
): Result<string, SmokeFailure> {
  if (!SHA256.test(expected))
    return err(
      failure("ArtifactDigestMismatch", "expected digest is malformed"),
    );
  if (actual !== expected)
    return err(
      failure("ArtifactDigestMismatch", "packed artifact digest mismatch"),
    );
  return ok(actual);
}

export function validatePiVersion(
  output: string,
  expected: string = EXACT_PI_VERSION,
): Result<string, SmokeFailure> {
  const observed = output.trim();
  if (observed !== expected) {
    return err(
      failure(
        "WrongPiVersion",
        `expected ${boundText(expected, 64)}, observed ${boundText(observed || "empty", 64)}`,
      ),
    );
  }
  return ok(observed);
}

function parseManifest(
  entries: readonly TarEntry[],
): Result<{ readonly packageVersion: string }, SmokeFailure> {
  const manifestEntry = entries.find(
    (entry) => entry.path === "package/package.json",
  );
  const extension = entries.find(
    (entry) => entry.path === "package/dist/extension.js",
  );
  if (manifestEntry === undefined || extension === undefined)
    return err(
      failure("ArtifactMalformed", "packed adapter entrypoint is missing"),
    );
  const parsed = Result.fromThrowable(
    () =>
      JSON.parse(new TextDecoder().decode(manifestEntry.contents)) as unknown,
    () => failure("ArtifactMalformed", "package manifest is invalid"),
  )();
  if (parsed.isErr()) return err(parsed.error);
  if (
    typeof parsed.value !== "object" ||
    parsed.value === null ||
    (parsed.value as { readonly name?: unknown }).name !== PACKAGE_NAME ||
    typeof (parsed.value as { readonly version?: unknown }).version !== "string"
  ) {
    return err(
      failure("ArtifactMalformed", "packed package identity is invalid"),
    );
  }
  return ok({
    packageVersion: (parsed.value as { readonly version: string }).version,
  });
}

export async function verifyArtifactFileUnchanged(
  path: string,
  expectedSha256: string,
): Promise<Result<string, SmokeFailure>> {
  if (!isAbsolute(path) || containsPathControlCharacter(path))
    return err(
      failure("ArtifactSourceRejected", "artifact path must be absolute"),
    );
  if (!path.endsWith(".tgz"))
    return err(
      failure("ArtifactSourceRejected", "only a packed .tgz is accepted"),
    );
  const parentSymlink = await hasSymlinkAncestor(path);
  if (parentSymlink.isErr()) return err(parentSymlink.error);
  if (parentSymlink.value)
    return err(
      failure("ArtifactSourceRejected", "artifact path has a symlink parent"),
    );
  const regular = await regularNonSymlinkFile(path, "ArtifactMissing");
  if (regular.isErr()) return err(regular.error);
  const bytes = await ResultAsync.fromThrowable(
    () => Bun.file(path).bytes(),
    () => failure("ArtifactMissing", "packed artifact could not be read"),
  )();
  if (bytes.isErr()) return err(bytes.error);
  return verifyArtifactDigest(artifactDigest(bytes.value), expectedSha256);
}

export async function inspectPackedArtifact(
  path: string,
  expectedSha256: string,
): Promise<Result<PackedArtifact, SmokeFailure>> {
  if (!isAbsolute(path) || containsPathControlCharacter(path))
    return err(
      failure(
        "ArtifactSourceRejected",
        "packed artifact path must be absolute",
      ),
    );
  const absolute = resolve(path);
  if (!absolute.endsWith(".tgz"))
    return err(
      failure("ArtifactSourceRejected", "only a packed .tgz is accepted"),
    );
  const parentSymlink = await hasSymlinkAncestor(absolute);
  if (parentSymlink.isErr()) return err(parentSymlink.error);
  if (parentSymlink.value)
    return err(
      failure("ArtifactSourceRejected", "artifact path has a symlink parent"),
    );
  const regular = await regularNonSymlinkFile(absolute, "ArtifactMissing");
  if (regular.isErr()) return err(regular.error);
  const bytesResult = await ResultAsync.fromThrowable(
    () => Bun.file(absolute).bytes(),
    () => failure("ArtifactMissing", "packed artifact could not be read"),
  )();
  if (bytesResult.isErr()) return err(bytesResult.error);
  const digest = artifactDigest(bytesResult.value);
  const verified = verifyArtifactDigest(digest, expectedSha256);
  if (verified.isErr()) return err(verified.error);
  const inspected = new TarInspector().inspect(bytesResult.value);
  if (inspected.isErr())
    return err(
      failure(
        "ArtifactMalformed",
        `tar inspection failed: ${inspected.error.type}`,
      ),
    );
  const manifest = parseManifest(inspected.value);
  if (manifest.isErr()) return err(manifest.error);
  const extension = inspected.value.find(
    (entry) => entry.path === "package/dist/extension.js",
  );
  if (extension === undefined)
    return err(
      failure("ArtifactMalformed", "packed extension entrypoint is missing"),
    );
  return ok({
    path: absolute,
    sha256: verified.value,
    packageVersion: manifest.value.packageVersion,
    extensionSha256: artifactDigest(extension.contents),
    entries: inspected.value,
  });
}

export interface VerifyInstalledAdapterInput {
  readonly packageRoot: string;
  readonly expectedPackageRoot: string;
  readonly expectedPackageName?: string;
  readonly expectedPackageVersion: string;
  readonly expectedExtensionSha256: string;
}

export async function verifyInstalledAdapterPackage(
  input: VerifyInstalledAdapterInput,
): Promise<Result<InstalledAdapterProvenance, SmokeFailure>> {
  if (
    !safeAbsolutePath(input.packageRoot) ||
    !safeAbsolutePath(input.expectedPackageRoot)
  )
    return err(
      failure(
        "StrictProvenanceViolation",
        "installed package root must be absolute",
      ),
    );
  const packageRoot = resolve(input.packageRoot);
  const expectedRoot = resolve(input.expectedPackageRoot);
  const rootSymlink = await pathIsSymlink(packageRoot);
  if (rootSymlink.isErr()) return err(rootSymlink.error);
  if (rootSymlink.value)
    return err(
      failure(
        "StrictProvenanceViolation",
        "installed package root is a symlink",
      ),
    );
  const rootStats = await ResultAsync.fromThrowable(
    () => Bun.file(packageRoot).stat(),
    () =>
      failure("StrictProvenanceViolation", "installed package root is missing"),
  )();
  if (rootStats.isErr()) return err(rootStats.error);
  if (!rootStats.value.isDirectory())
    return err(
      failure(
        "StrictProvenanceViolation",
        "installed package root is not a directory",
      ),
    );
  const canonicalRoot = await canonicalExistingPath(packageRoot);
  const canonicalExpectedRoot = await canonicalExistingPath(expectedRoot);
  if (canonicalRoot.isErr() || canonicalExpectedRoot.isErr())
    return err(
      failure(
        "StrictProvenanceViolation",
        "installed package root could not be canonicalized",
      ),
    );
  if (canonicalRoot.value !== canonicalExpectedRoot.value)
    return err(
      failure(
        "StrictProvenanceViolation",
        "installed package root resolves to an alias",
      ),
    );
  const manifestPath = join(packageRoot, "package.json");
  const extensionPath = join(packageRoot, "dist/extension.js");
  const manifestBytes = await ResultAsync.fromThrowable(
    () => Bun.file(manifestPath).bytes(),
    () =>
      failure(
        "StrictProvenanceViolation",
        "installed package manifest is missing",
      ),
  )();
  if (manifestBytes.isErr()) return err(manifestBytes.error);
  const manifest = Result.fromThrowable(
    () => JSON.parse(new TextDecoder().decode(manifestBytes.value)) as unknown,
    () =>
      failure(
        "StrictProvenanceViolation",
        "installed package manifest is invalid",
      ),
  )();
  if (manifest.isErr()) return err(manifest.error);
  if (
    typeof manifest.value !== "object" ||
    manifest.value === null ||
    (manifest.value as { readonly name?: unknown }).name !==
      (input.expectedPackageName ?? PACKAGE_NAME) ||
    (manifest.value as { readonly version?: unknown }).version !==
      input.expectedPackageVersion
  )
    return err(
      failure(
        "StrictProvenanceViolation",
        "installed package identity is invalid",
      ),
    );
  const extensionRegular = await regularNonSymlinkFile(
    extensionPath,
    "StrictProvenanceViolation",
    "StrictProvenanceViolation",
  );
  if (extensionRegular.isErr()) return err(extensionRegular.error);
  const canonicalExtension = await canonicalExistingPath(extensionPath);
  if (canonicalExtension.isErr())
    return err(
      failure(
        "StrictProvenanceViolation",
        "installed extension could not be canonicalized",
      ),
    );
  if (
    canonicalExtension.value !== join(canonicalRoot.value, "dist/extension.js")
  )
    return err(
      failure(
        "StrictProvenanceViolation",
        "installed extension resolves outside the package",
      ),
    );
  const extensionBytes = await ResultAsync.fromThrowable(
    () => Bun.file(extensionPath).bytes(),
    () =>
      failure("StrictProvenanceViolation", "installed extension is unreadable"),
  )();
  if (extensionBytes.isErr()) return err(extensionBytes.error);
  const extensionSha256 = artifactDigest(extensionBytes.value);
  if (!SHA256.test(input.expectedExtensionSha256))
    return err(
      failure(
        "StrictProvenanceViolation",
        "expected extension digest is invalid",
      ),
    );
  if (packageRoot !== expectedRoot)
    return err(
      failure(
        "StrictProvenanceViolation",
        "installed package root does not match the isolated root",
      ),
    );
  if (extensionSha256 !== input.expectedExtensionSha256)
    return err(
      failure(
        "StrictProvenanceViolation",
        "installed extension digest does not match the packed artifact",
      ),
    );
  return ok({
    packageVersion: input.expectedPackageVersion,
    extensionSha256,
    packageRootMatched: true,
    extensionHashMatched: true,
  });
}

export interface PiCliProvenance {
  readonly packageRoot: string;
  readonly packageVersion: typeof EXACT_PI_VERSION;
}

export async function inspectPiCliProvenance(
  cliPath: string,
  options: {
    readonly expectedVersion?: string;
    readonly forbiddenPaths?: readonly string[];
  } = {},
): Promise<Result<PiCliProvenance, SmokeFailure>> {
  const expectedVersion = options.expectedVersion ?? EXACT_PI_VERSION;
  if (!safeAbsolutePath(cliPath) || cliPath.includes("$bunfs"))
    return err(
      failure("StrictProvenanceViolation", "Pi CLI path is not a file path"),
    );
  const absolute = resolve(cliPath);
  if (!absolute.endsWith("/dist/cli.js"))
    return err(
      failure(
        "StrictProvenanceViolation",
        "Pi CLI is not the package CLI entrypoint",
      ),
    );
  const parentSymlink = await hasSymlinkAncestor(absolute);
  if (parentSymlink.isErr())
    return err(
      failure(
        "StrictProvenanceViolation",
        "Pi CLI path could not be inspected",
      ),
    );
  if (parentSymlink.value)
    return err(
      failure("StrictProvenanceViolation", "Pi CLI path has a symlink parent"),
    );
  for (const forbidden of options.forbiddenPaths ?? []) {
    if (safeAbsolutePath(forbidden) && pathWithin(absolute, forbidden))
      return err(
        failure(
          "StrictProvenanceViolation",
          "Pi CLI resolves to a forbidden source path",
        ),
      );
  }
  const cliRegular = await regularNonSymlinkFile(
    absolute,
    "StrictProvenanceViolation",
    "StrictProvenanceViolation",
  );
  if (cliRegular.isErr()) return err(cliRegular.error);
  const packageRoot = resolve(dirname(dirname(absolute)));
  const packageRootSymlink = await pathIsSymlink(packageRoot);
  if (packageRootSymlink.isErr()) return err(packageRootSymlink.error);
  if (packageRootSymlink.value)
    return err(
      failure("StrictProvenanceViolation", "Pi package root is a symlink"),
    );
  const manifestBytes = await ResultAsync.fromThrowable(
    () => Bun.file(join(packageRoot, "package.json")).bytes(),
    () =>
      failure("StrictProvenanceViolation", "Pi package manifest is missing"),
  )();
  if (manifestBytes.isErr()) return err(manifestBytes.error);
  const parsed = Result.fromThrowable(
    () => JSON.parse(new TextDecoder().decode(manifestBytes.value)) as unknown,
    () =>
      failure("StrictProvenanceViolation", "Pi package manifest is invalid"),
  )();
  if (parsed.isErr()) return err(parsed.error);
  if (
    typeof parsed.value !== "object" ||
    parsed.value === null ||
    (parsed.value as { readonly name?: unknown }).name !==
      "@earendil-works/pi-coding-agent" ||
    (parsed.value as { readonly version?: unknown }).version !== expectedVersion
  )
    return err(failure("WrongPiVersion", "Pi package identity is not exact"));
  const version = validateExpectedPiVersion(expectedVersion);
  if (version.isErr()) return err(version.error);
  return ok({ packageRoot, packageVersion: version.value });
}

export function validateLoadedAdapterProvenance(input: {
  readonly controls: readonly FixtureControlFacts[];
  readonly expectedPackageVersion: string;
  readonly expectedExtensionSha256: string;
}): Result<
  {
    readonly packageVersion: string;
    readonly extensionSha256: string;
    readonly packageSourceProven: boolean;
    readonly packageRootMatched: boolean;
    readonly extensionHashMatched: boolean;
  },
  SmokeFailure
> {
  if (input.controls.length === 0)
    return err(
      failure("StrictProvenanceViolation", "Pi emitted no adapter provenance"),
    );
  const first = input.controls[0];
  if (first === undefined)
    return err(
      failure("StrictProvenanceViolation", "Pi adapter provenance is missing"),
    );
  const values = input.controls;
  for (const control of values) {
    if (
      control.adapterPackageVersion !== input.expectedPackageVersion ||
      control.adapterExtensionSha256 === undefined ||
      !SHA256.test(control.adapterExtensionSha256) ||
      control.adapterPackageSourceProven !== true ||
      control.adapterPackageRootMatched !== true ||
      control.adapterExtensionHashMatched !== true
    )
      return err(
        failure(
          "StrictProvenanceViolation",
          "loaded adapter provenance is not exact",
        ),
      );
    if (control.adapterExtensionSha256 !== first.adapterExtensionSha256)
      return err(
        failure("StrictProvenanceViolation", "loaded adapter hashes disagree"),
      );
  }
  const extensionSha256 = first.adapterExtensionSha256;
  if (extensionSha256 === undefined)
    return err(
      failure("StrictProvenanceViolation", "loaded adapter hash is missing"),
    );
  if (extensionSha256 !== input.expectedExtensionSha256)
    return err(
      failure(
        "StrictProvenanceViolation",
        "loaded adapter digest does not match the packed artifact",
      ),
    );
  return ok({
    packageVersion: input.expectedPackageVersion,
    extensionSha256,
    packageSourceProven: true,
    packageRootMatched: true,
    extensionHashMatched: true,
  });
}
