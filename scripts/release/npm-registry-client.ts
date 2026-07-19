import { errAsync, okAsync, ResultAsync } from "neverthrow";
import type { CommandRunner } from "./command-runner.js";
import type { RegistryError } from "./errors.js";

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
  verifyPublished(
    packageName: string,
    version: string,
    expectedSha256: string,
  ): ResultAsync<void, RegistryError> {
    const url = `https://registry.npmjs.org/${encodeURIComponent(packageName)}/-/${packageName.split("/").pop()}-${version}.tgz`;
    return ResultAsync.fromPromise(
      fetch(url).then(async (response) => ({
        response,
        bytes: new Uint8Array(await response.arrayBuffer()),
      })),
      (cause) => ({
        type: "RegistryError" as const,
        operation: "verifyPublished",
        message: String(cause),
      }),
    ).andThen(({ response, bytes }) => {
      if (!response.ok)
        return errAsync({
          type: "RegistryError" as const,
          operation: "verifyPublished",
          message: `HTTP ${response.status}`,
        });
      const digest = `sha256:${new Bun.CryptoHasher("sha256").update(bytes).digest("hex")}`;
      if (digest !== expectedSha256)
        return errAsync({
          type: "RegistryError" as const,
          operation: "verifyPublished",
          message: "tarball digest mismatch",
        });
      return okAsync(undefined);
    });
  }
}
