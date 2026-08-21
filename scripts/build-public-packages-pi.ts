import { basename, join } from "node:path";
import { errAsync, okAsync, type ResultAsync } from "neverthrow";
import {
  computeExtensionBuildBinding,
  createExtensionBuildManifest,
  EXTENSION_BUILD_BINDING_PLACEHOLDER,
  EXTENSION_BUILD_MANIFEST_FILENAME,
  EXTENSION_RUNTIME_OUTPUT_NAMES,
  renderExtensionBuildManifest,
  sha256Hex,
} from "../packages/adapters/pi/src/extension-build-identity.js";
import { readGitBuildIdentity } from "./build-public-packages-git.js";
import type {
  PublicPackageBuildError,
  PublicPackageFileSystem,
} from "./build-public-packages-shared.js";
import { PUBLIC_PACKAGE_BUILDS } from "./release/constants.js";

export const PI_EXTENSION_IDENTITY_SOURCE =
  "packages/adapters/pi/src/extension-build-identity.ts";
export const PI_EXTENSION_IDENTITY_OUTPUT =
  "packages/adapters/pi/dist/extension-build-identity.js";
export const PI_EXTENSION_IDENTITY_MANIFEST = join(
  "packages/adapters/pi/dist",
  EXTENSION_BUILD_MANIFEST_FILENAME,
);
const PI_BUILD = PUBLIC_PACKAGE_BUILDS["@weaveio/weave-adapter-pi"];
export const PI_BUILD_OUTPUT_PATHS = [
  ...PI_BUILD.entries.map((entry) => entry.output),
  ...PI_BUILD.declarations.map((declaration) => declaration.output),
] as const;

export function piOutputName(path: string): string {
  const name = basename(path);
  if (name.endsWith(".d.ts")) return `${name.slice(0, -5)}-declarations`;
  if (name.endsWith(".js")) return name.slice(0, -3);
  return name;
}

/** Logical output names and relative paths hashed into the sidecar. */
export function piIdentityOutputFiles(): readonly {
  readonly name: string;
  readonly relativePath: string;
}[] {
  return PI_BUILD_OUTPUT_PATHS.map((relativePath) => ({
    name: piOutputName(relativePath),
    relativePath,
  }));
}

/**
 * Render and write the sidecar only after every hashed output exists.
 * The sidecar itself is never one of those outputs.
 */
export function writePiExtensionBuildIdentityManifest(input: {
  readonly fileSystem: PublicPackageFileSystem;
  readonly subject: string;
  readonly dirty: boolean;
  readonly inputDigests: readonly string[];
  readonly buildBinding: string;
  readonly outputs: readonly {
    readonly name: string;
    readonly sha256: string;
  }[];
  readonly buildCompletedAt?: string;
}): ResultAsync<void, PublicPackageBuildError> {
  const manifest = createExtensionBuildManifest({
    subject: input.subject,
    dirty: input.dirty,
    buildBinding: input.buildBinding,
    buildInputs: input.inputDigests,
    outputs: input.outputs,
    buildCompletedAt: input.buildCompletedAt,
  });
  if (manifest.isErr()) {
    return errAsync({
      type: "BuildIdentity",
      reason: "manifest-invalid",
    });
  }
  const rendered = renderExtensionBuildManifest(manifest.value);
  if (rendered.isErr()) {
    return errAsync({
      type: "BuildIdentity",
      reason: "manifest-invalid",
    });
  }
  return input.fileSystem
    .ensureDirectory(join(PI_EXTENSION_IDENTITY_MANIFEST, ".."))
    .andThen(() =>
      input.fileSystem.writeText(
        PI_EXTENSION_IDENTITY_MANIFEST,
        rendered.value,
      ),
    );
}

type PiBuildGitIdentity = {
  readonly subject: string;
  readonly dirty: boolean;
};

type PiIdentityEntryBuilder = () => ResultAsync<void, PublicPackageBuildError>;

/** Build, bind, and attest the Pi runtime outputs after the package build. */
export function emitPiBuildIdentityArtifacts(input: {
  readonly fileSystem: PublicPackageFileSystem;
  readonly bundleIdentityEntry: PiIdentityEntryBuilder;
  readonly readGitIdentity?: () => ResultAsync<
    PiBuildGitIdentity,
    PublicPackageBuildError
  >;
}): ResultAsync<void, PublicPackageBuildError> {
  const readGit = input.readGitIdentity ?? (() => readGitBuildIdentity());
  return input
    .bundleIdentityEntry()
    .andThen(() => readGit())
    .andThen((git) =>
      readPiBuildInputs(input.fileSystem).map((buildInputs) => ({
        git,
        buildInputs,
      })),
    )
    .andThen(({ git, buildInputs }) =>
      hashPiBuildInputs(input.fileSystem, buildInputs).map((inputDigests) => ({
        git,
        inputDigests,
      })),
    )
    .andThen(({ git, inputDigests }) =>
      hashPiBuildOutputs(input.fileSystem).map((outputs) => ({
        git,
        inputDigests,
        outputs,
      })),
    )
    .andThen(({ git, inputDigests, outputs }) => {
      const buildCompletedAt = new Date().toISOString();
      const runtimeOutputs = outputs.filter((output) =>
        EXTENSION_RUNTIME_OUTPUT_NAMES.includes(
          output.name as (typeof EXTENSION_RUNTIME_OUTPUT_NAMES)[number],
        ),
      );
      const binding = computeExtensionBuildBinding({
        subject: git.subject,
        dirty: git.dirty,
        buildInputs: inputDigests,
        runtimeOutputs,
        buildCompletedAt,
      });
      if (binding.isErr()) {
        return errAsync({
          type: "BuildIdentity" as const,
          reason: "manifest-invalid" as const,
        });
      }
      return bindPiExtensionEntry(input.fileSystem, binding.value).map(() => ({
        git,
        inputDigests,
        buildBinding: binding.value,
        buildCompletedAt,
      }));
    })
    .andThen(({ git, inputDigests, buildBinding, buildCompletedAt }) =>
      hashPiBuildOutputs(input.fileSystem).andThen((outputs) =>
        writePiExtensionBuildIdentityManifest({
          fileSystem: input.fileSystem,
          subject: git.subject,
          dirty: git.dirty,
          buildBinding,
          inputDigests,
          outputs,
          buildCompletedAt,
        }),
      ),
    );
}

function bindPiExtensionEntry(
  fileSystem: PublicPackageFileSystem,
  buildBinding: string,
): ResultAsync<void, PublicPackageBuildError> {
  const marker = new RegExp(
    `((?:const|var)\\s+WEAVE_PI_EMBEDDED_BUILD_BINDING\\s*=\\s*)"${EXTENSION_BUILD_BINDING_PLACEHOLDER}"(\\s*;)`,
    "gu",
  );
  return fileSystem
    .readText("packages/adapters/pi/dist/extension.js")
    .andThen((contents) => {
      const matches = [...contents.matchAll(marker)];
      if (matches.length !== 1) {
        return errAsync({
          type: "BuildIdentity" as const,
          reason: "output-unavailable" as const,
        });
      }
      return fileSystem.writeText(
        "packages/adapters/pi/dist/extension.js",
        contents.replace(marker, `$1"${buildBinding}"$2`),
      );
    });
}

function readPiBuildInputs(
  fileSystem: PublicPackageFileSystem,
): ResultAsync<readonly string[], PublicPackageBuildError> {
  const fallback = [
    ...PI_BUILD.entries.map((entry) => entry.source),
    PI_EXTENSION_IDENTITY_SOURCE,
  ];
  const listed = fileSystem.listPiBuildInputFiles?.();
  return (listed ?? okAsync([...new Set(fallback)].sort())).andThen((files) => {
    const normalized = [...new Set(files)].sort();
    return normalized.length === 0
      ? errAsync({
          type: "BuildIdentity" as const,
          reason: "input-unavailable" as const,
        })
      : okAsync(normalized);
  });
}

function hashPiBuildInputs(
  fileSystem: PublicPackageFileSystem,
  files: readonly string[],
): ResultAsync<readonly string[], PublicPackageBuildError> {
  let result = okAsync<string[], PublicPackageBuildError>([]);
  for (const file of files) {
    result = result.andThen((digests) =>
      hashTextForIdentity(fileSystem, file, "input-unavailable").map(
        (digest) => [...digests, digest],
      ),
    );
  }
  return result.map((digests) => [...digests].sort());
}

function hashPiBuildOutputs(
  fileSystem: PublicPackageFileSystem,
): ResultAsync<
  readonly { readonly name: string; readonly sha256: string }[],
  PublicPackageBuildError
> {
  let result = okAsync<
    { readonly name: string; readonly sha256: string }[],
    PublicPackageBuildError
  >([]);
  for (const path of PI_BUILD_OUTPUT_PATHS) {
    result = result.andThen((outputs) =>
      hashTextForIdentity(fileSystem, path, "output-unavailable").map(
        (sha256) => [...outputs, { name: piOutputName(path), sha256 }],
      ),
    );
  }
  return result.map((outputs) =>
    [...outputs].sort((left, right) => left.name.localeCompare(right.name)),
  );
}

function hashTextForIdentity(
  fileSystem: PublicPackageFileSystem,
  path: string,
  reason: "input-unavailable" | "output-unavailable",
): ResultAsync<string, PublicPackageBuildError> {
  return fileSystem.readText(path).andThen((contents) => {
    const digest = sha256Hex(new TextEncoder().encode(contents));
    return digest.isOk()
      ? okAsync(digest.value)
      : errAsync({ type: "BuildIdentity" as const, reason });
  });
}
