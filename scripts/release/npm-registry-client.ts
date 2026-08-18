import { errAsync, okAsync, ResultAsync } from "neverthrow";
import type { CommandRunner } from "./command-runner.js";
import { PACKAGE_ARCHIVE_LIMITS } from "./constants.js";
import type { RegistryError } from "./errors.js";

export type PublishTag = "latest" | "next" | "nightly";

export type PublishedTarballState =
  | { state: "unpublished" }
  | { state: "published"; sha256: string };

/**
 * Registry port for the resumable OIDC executor. Mutation is provenance
 * publish only; there is no unpublish or dist-tag promotion.
 */
export interface PublishRegistry {
  publishWithProvenance(
    tarballPath: string,
    tag: PublishTag,
  ): ResultAsync<void, RegistryError>;
  readPublishedTarballDigest(
    packageName: string,
    version: string,
  ): ResultAsync<PublishedTarballState, RegistryError>;
  verifyPublished(
    packageName: string,
    version: string,
    expectedSha256: string,
  ): ResultAsync<void, RegistryError>;
}

export interface NpmRegistryClient {
  publish(
    tarballPath: string,
    tag: "nightly" | "next",
  ): ResultAsync<void, RegistryError>;
  viewVersion(packageName: string): ResultAsync<string, RegistryError>;
  listVersions(
    packageName: string,
  ): ResultAsync<readonly string[], RegistryError>;
  viewDistTags(
    packageName: string,
  ): ResultAsync<Record<string, string>, RegistryError>;
  /** Read-only equivalent of `npm dist-tag ls`; promotion mutation is human-only. */
  distTagLs(
    packageName: string,
  ): ResultAsync<Record<string, string>, RegistryError>;
  verifyPublished(
    packageName: string,
    version: string,
    expectedSha256: string,
  ): ResultAsync<void, RegistryError>;
}

export class NpmCliRegistryClient
  implements NpmRegistryClient, PublishRegistry
{
  constructor(
    private readonly commands: CommandRunner,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}
  publish(
    tarballPath: string,
    tag: "nightly" | "next",
  ): ResultAsync<void, RegistryError> {
    return this.commands
      .run(["npm", "publish", tarballPath, "--access", "public", "--tag", tag])
      .map(() => undefined)
      .mapErr((error) => ({
        type: "RegistryError",
        operation: "publish",
        message: error.type,
      }));
  }
  publishWithProvenance(
    tarballPath: string,
    tag: PublishTag,
  ): ResultAsync<void, RegistryError> {
    return this.commands
      .run(["npm", "publish", tarballPath, "--provenance", "--tag", tag])
      .map(() => undefined)
      .mapErr((error) => ({
        type: "RegistryError",
        operation: "publish",
        message: error.type,
      }));
  }
  viewVersion(packageName: string): ResultAsync<string, RegistryError> {
    return this.commands
      .run(["npm", "view", packageName])
      .map((result) => result.stdout.trim())
      .mapErr((error) => ({
        type: "RegistryError",
        operation: "viewVersion",
        message: error.type,
      }));
  }
  listVersions(
    packageName: string,
  ): ResultAsync<readonly string[], RegistryError> {
    return this.commands
      .run(["npm", "view", packageName, "versions", "--json"])
      .andThen((result) =>
        ResultAsync.fromThrowable(
          () => Promise.resolve(JSON.parse(result.stdout) as unknown),
          () => ({
            type: "RegistryError" as const,
            operation: "listVersions",
            message: "invalid npm versions response",
          }),
        )(),
      )
      .andThen((value) =>
        Array.isArray(value) &&
        value.every((version) => typeof version === "string")
          ? okAsync(value)
          : errAsync({
              type: "RegistryError" as const,
              operation: "listVersions",
              message: "invalid npm versions response",
            }),
      )
      .mapErr((error) =>
        error.type === "RegistryError"
          ? error
          : {
              type: "RegistryError" as const,
              operation: "listVersions",
              message: error.type,
            },
      );
  }
  viewDistTags(
    packageName: string,
  ): ResultAsync<Record<string, string>, RegistryError> {
    return this.commands
      .run(["npm", "view", packageName, "dist-tags"])
      .andThen((result) =>
        ResultAsync.fromThrowable(
          () => Promise.resolve(JSON.parse(result.stdout) as unknown),
          () => ({
            type: "RegistryError" as const,
            operation: "viewDistTags",
            message: "invalid npm dist-tags response",
          }),
        )(),
      )
      .andThen((value) =>
        typeof value === "object" &&
        value !== null &&
        !Array.isArray(value) &&
        Object.values(value).every((version) => typeof version === "string")
          ? okAsync(value as Record<string, string>)
          : errAsync({
              type: "RegistryError" as const,
              operation: "viewDistTags",
              message: "invalid npm dist-tags response",
            }),
      )
      .mapErr((error) => ({
        type: "RegistryError",
        operation: "viewDistTags",
        message: error.type,
      }));
  }
  distTagLs(
    packageName: string,
  ): ResultAsync<Record<string, string>, RegistryError> {
    return this.commands
      .run(["npm", "dist-tag", "ls", packageName, "--json"])
      .andThen((result) =>
        ResultAsync.fromThrowable(
          () => Promise.resolve(JSON.parse(result.stdout) as unknown),
          () => ({
            type: "RegistryError" as const,
            operation: "distTagLs",
            message: "invalid npm dist-tag response",
          }),
        )(),
      )
      .andThen((value) => {
        if (
          typeof value !== "object" ||
          value === null ||
          Array.isArray(value) ||
          Object.values(value).some((version) => typeof version !== "string")
        )
          return errAsync({
            type: "RegistryError" as const,
            operation: "distTagLs",
            message: "invalid npm dist-tag response",
          });
        return okAsync(value as Record<string, string>);
      })
      .mapErr((error) =>
        error.type === "RegistryError"
          ? error
          : {
              type: "RegistryError" as const,
              operation: "distTagLs",
              message: error.type,
            },
      );
  }
  readPublishedTarballDigest(
    packageName: string,
    version: string,
  ): ResultAsync<PublishedTarballState, RegistryError> {
    return this.fetchTarball(
      packageName,
      version,
      "readPublishedTarballDigest",
    ).andThen(({ response, bytes }) => {
      if (response.status === 404)
        return okAsync({ state: "unpublished" as const });
      if (!response.ok)
        return errAsync({
          type: "RegistryError" as const,
          operation: "readPublishedTarballDigest",
          message: `HTTP ${response.status}`,
        });
      if (bytes.byteLength > PACKAGE_ARCHIVE_LIMITS.compressedBytes)
        return errAsync({
          type: "RegistryError" as const,
          operation: "readPublishedTarballDigest",
          message: "tarball exceeds archive limit",
        });
      return okAsync({
        state: "published" as const,
        sha256: tarballDigest(bytes),
      });
    });
  }
  verifyPublished(
    packageName: string,
    version: string,
    expectedSha256: string,
  ): ResultAsync<void, RegistryError> {
    return this.readPublishedTarballDigest(packageName, version).andThen(
      (state) => {
        if (state.state === "unpublished")
          return errAsync({
            type: "RegistryError" as const,
            operation: "verifyPublished",
            message: "HTTP 404",
          });
        if (state.sha256 !== expectedSha256)
          return errAsync({
            type: "RegistryError" as const,
            operation: "verifyPublished",
            message: "tarball digest mismatch",
          });
        return okAsync(undefined);
      },
    );
  }
  private fetchTarball(
    packageName: string,
    version: string,
    operation: string,
  ): ResultAsync<{ response: Response; bytes: Uint8Array }, RegistryError> {
    const url = publishedTarballUrl(packageName, version);
    return ResultAsync.fromPromise(
      this.fetchImpl(url).then(async (response) => ({
        response,
        bytes: new Uint8Array(await response.arrayBuffer()),
      })),
      (cause) => ({
        type: "RegistryError" as const,
        operation,
        message: String(cause),
      }),
    );
  }
}

export function publishedTarballUrl(
  packageName: string,
  version: string,
): string {
  const unscoped = packageName.split("/").pop() ?? packageName;
  return `https://registry.npmjs.org/${encodeURIComponent(packageName)}/-/${unscoped}-${version}.tgz`;
}

function tarballDigest(bytes: Uint8Array): string {
  return `sha256:${new Bun.CryptoHasher("sha256").update(bytes).digest("hex")}`;
}
