import { errAsync, okAsync, ResultAsync } from "neverthrow";
import { z } from "zod";
import type { CommandRunner } from "./command-runner.js";
import { RELEASE_INPUT_LIMITS } from "./constants.js";
import type { RegistryError } from "./errors.js";

const NPM_TEXT_LIMIT = 64 * 1024;
const NPM_VERSION_SCHEMA = z.string().min(1).max(128);
const NPM_VERSIONS_SCHEMA = z
  .array(NPM_VERSION_SCHEMA)
  .max(RELEASE_INPUT_LIMITS.artifactCount * 256);
const NPM_DIST_TAGS_SCHEMA = z
  .record(z.string().min(1).max(64), NPM_VERSION_SCHEMA)
  .refine(
    (tags) => Object.keys(tags).length <= 32,
    "npm dist-tags response has too many tags",
  );

function registryFailure(operation: string, message: string): RegistryError {
  return { type: "RegistryError", operation, message };
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

export class NpmCliRegistryClient implements NpmRegistryClient {
  constructor(private readonly commands: CommandRunner) {}
  publish(
    tarballPath: string,
    tag: "nightly" | "next",
  ): ResultAsync<void, RegistryError> {
    return this.commands
      .run(["npm", "publish", tarballPath, "--access", "public", "--tag", tag])
      .andThen(() =>
        ResultAsync.fromPromise(Promise.resolve(), () =>
          registryFailure("publish", "publish result unavailable"),
        ),
      )
      .mapErr(() => registryFailure("publish", "npm publish failed"));
  }
  viewVersion(packageName: string): ResultAsync<string, RegistryError> {
    return this.commands
      .run(["npm", "view", packageName])
      .andThen((result) => {
        const version = NPM_VERSION_SCHEMA.safeParse(result.stdout.trim());
        return version.success
          ? okAsync(version.data)
          : errAsync(
              registryFailure("viewVersion", "invalid npm version response"),
            );
      })
      .mapErr(() => registryFailure("viewVersion", "npm view failed"));
  }
  listVersions(
    packageName: string,
  ): ResultAsync<readonly string[], RegistryError> {
    return this.commands
      .run(["npm", "view", packageName, "versions", "--json"])
      .andThen((result) => {
        if (result.stdout.length > NPM_TEXT_LIMIT)
          return errAsync<readonly string[], RegistryError>(
            registryFailure(
              "listVersions",
              "npm versions response is too large",
            ),
          );
        return ResultAsync.fromThrowable(
          () => JSON.parse(result.stdout),
          () =>
            registryFailure("listVersions", "invalid npm versions response"),
        )().andThen((value) => {
          const parsed = NPM_VERSIONS_SCHEMA.safeParse(value);
          return parsed.success
            ? okAsync<readonly string[], RegistryError>(parsed.data)
            : errAsync<readonly string[], RegistryError>(
                registryFailure(
                  "listVersions",
                  "invalid npm versions response",
                ),
              );
        });
      })
      .mapErr(() =>
        registryFailure("listVersions", "npm versions lookup failed"),
      );
  }
  viewDistTags(
    packageName: string,
  ): ResultAsync<Record<string, string>, RegistryError> {
    return this.commands
      .run(["npm", "view", packageName, "dist-tags"])
      .andThen((result) => {
        if (result.stdout.length > NPM_TEXT_LIMIT)
          return errAsync<Record<string, string>, RegistryError>(
            registryFailure(
              "viewDistTags",
              "npm dist-tags response is too large",
            ),
          );
        return ResultAsync.fromThrowable(
          () => JSON.parse(result.stdout),
          () =>
            registryFailure("viewDistTags", "invalid npm dist-tags response"),
        )().andThen((value) => {
          const parsed = NPM_DIST_TAGS_SCHEMA.safeParse(value);
          return parsed.success
            ? okAsync<Record<string, string>, RegistryError>(parsed.data)
            : errAsync<Record<string, string>, RegistryError>(
                registryFailure(
                  "viewDistTags",
                  "invalid npm dist-tags response",
                ),
              );
        });
      })
      .mapErr(() =>
        registryFailure("viewDistTags", "npm dist-tags lookup failed"),
      );
  }
  distTagLs(
    packageName: string,
  ): ResultAsync<Record<string, string>, RegistryError> {
    return this.commands
      .run(["npm", "dist-tag", "ls", packageName, "--json"])
      .andThen((result) => {
        if (result.stdout.length > NPM_TEXT_LIMIT)
          return errAsync<Record<string, string>, RegistryError>(
            registryFailure("distTagLs", "npm dist-tag response is too large"),
          );
        return ResultAsync.fromThrowable(
          () => JSON.parse(result.stdout),
          () => registryFailure("distTagLs", "invalid npm dist-tag response"),
        )().andThen((value) => {
          const parsed = NPM_DIST_TAGS_SCHEMA.safeParse(value);
          return parsed.success
            ? okAsync<Record<string, string>, RegistryError>(parsed.data)
            : errAsync<Record<string, string>, RegistryError>(
                registryFailure("distTagLs", "invalid npm dist-tag response"),
              );
        });
      })
      .mapErr(() => registryFailure("distTagLs", "npm dist-tag lookup failed"));
  }
  verifyPublished(
    packageName: string,
    version: string,
    expectedSha256: string,
  ): ResultAsync<void, RegistryError> {
    const url = `https://registry.npmjs.org/${encodeURIComponent(packageName)}/-/${packageName.split("/").pop()}-${version}.tgz`;
    return ResultAsync.fromThrowable(
      async () => {
        const response = await fetch(url);
        const bytes = new Uint8Array(await response.arrayBuffer());
        return { response, bytes };
      },
      () => registryFailure("verifyPublished", "npm tarball request failed"),
    )().andThen(({ response, bytes }) => {
      if (!response.ok)
        return errAsync<undefined, RegistryError>(
          registryFailure("verifyPublished", "npm tarball request failed"),
        );
      if (bytes.byteLength > RELEASE_INPUT_LIMITS.artifactBytes)
        return errAsync<undefined, RegistryError>(
          registryFailure(
            "verifyPublished",
            "npm tarball response is too large",
          ),
        );
      const digest = `sha256:${new Bun.CryptoHasher("sha256").update(bytes).digest("hex")}`;
      if (digest !== expectedSha256)
        return errAsync<undefined, RegistryError>(
          registryFailure("verifyPublished", "tarball digest mismatch"),
        );
      return ResultAsync.fromPromise(Promise.resolve(), () =>
        registryFailure("verifyPublished", "verification result unavailable"),
      );
    });
  }
}
