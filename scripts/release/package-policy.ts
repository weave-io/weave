import { err, ok, Result } from "neverthrow";
import {
  ALL_DEPENDENCY_FIELDS,
  PACKAGE_ARCHIVE_LIMITS,
  PRIVATE_PACKAGE_NAMES,
  PUBLIC_PACKAGE_BUILDS,
  PUBLIC_PACKAGES,
  type PublicPackageBuild,
  type PublicPackageName,
} from "./constants.js";
import { type TarInspectionError, TarInspector } from "./tar-inspector.js";

export interface CredentialScanInput {
  environment: Readonly<Record<string, string | undefined>>;
  npmConfigOutput?: string;
  configFiles?: readonly { path: string; contents: string }[];
}

/**
 * Finds every credential source which could cause npm to bypass trusted OIDC.
 * This is deliberately pure so the standalone binary can scan injected runner
 * state before it reads a binding record or contacts either service.
 */
export function scanCredentialSources(
  input: CredentialScanInput,
): Result<void, string> {
  for (const [name, value] of Object.entries(input.environment)) {
    if (value === undefined || value.length === 0) continue;
    if (
      name === "NODE_AUTH_TOKEN" ||
      name === "NPM_TOKEN" ||
      /^npm_config_(?:_auth|_authtoken|auth|\/\/.*:_auth(?:token)?)/i.test(
        name,
      ) ||
      /^NPM_CONFIG_(?:_AUTH|_AUTHTOKEN|AUTH|\/\/.*:_AUTH(?:TOKEN)?)/.test(
        name,
      ) ||
      name === "NPM_CONFIG_USERCONFIG" ||
      /(?:CREDENTIAL_HELPER|KEYCHAIN)/i.test(name)
    )
      return err(name);
  }
  if (
    input.npmConfigOutput !== undefined &&
    hasNpmCredential(input.npmConfigOutput)
  )
    return err("npm config");
  for (const file of input.configFiles ?? [])
    if (hasNpmCredential(file.contents)) return err(file.path);
  return ok(undefined);
}

function hasNpmCredential(contents: string): boolean {
  return /(?:^|\n)\s*(?:_auth|_authToken|authToken|\/\/[^\s=]+:\s*_auth(?:Token)?)\s*=/i.test(
    contents,
  );
}

export type PackagePolicyError =
  | { type: "Tar"; error: TarInspectionError }
  | { type: "MissingManifest" }
  | { type: "InvalidManifest" }
  | { type: "ManifestTooLarge"; size: number }
  | { type: "UnexpectedPackage"; packageName: string }
  | { type: "ForbiddenDependency"; field: string; name: string }
  | { type: "LifecycleScript" }
  | { type: "UnexpectedFile"; path: string }
  | { type: "WrongMode"; path: string; mode: number }
  | {
      type: "UndeclaredImport";
      packageName: PublicPackageName;
      path: string;
      specifier: string;
    }
  | { type: "MissingFile"; path: string }
  | { type: "HashMismatch"; expected: string; actual: string };

/** Validates the exact bytes npm will publish, before any caller extracts them. */
export class PackagePolicyValidator {
  constructor(private readonly inspector = new TarInspector()) {}

  validate(
    archive: Uint8Array,
    expectedHash?: string,
  ): Result<
    { packageName: PublicPackageName; sha256: string },
    PackagePolicyError
  > {
    const sha256 = Bun.CryptoHasher.hash("sha256", archive, "hex");
    if (expectedHash !== undefined && expectedHash !== sha256)
      return err({
        type: "HashMismatch",
        expected: expectedHash,
        actual: sha256,
      });
    const inspected = this.inspector.inspect(archive);
    if (inspected.isErr()) return err({ type: "Tar", error: inspected.error });
    const manifestEntry = inspected.value.find(
      (entry) => entry.path === "package/package.json",
    );
    if (manifestEntry === undefined) return err({ type: "MissingManifest" });
    if (manifestEntry.size > PACKAGE_ARCHIVE_LIMITS.manifestBytes)
      return err({ type: "ManifestTooLarge", size: manifestEntry.size });
    const manifest = Result.fromThrowable(
      () =>
        JSON.parse(new TextDecoder().decode(manifestEntry.contents)) as Record<
          string,
          unknown
        >,
      () => ({ type: "InvalidManifest" as const }),
    )();
    if (manifest.isErr()) return err(manifest.error);
    if (
      typeof manifest.value !== "object" ||
      manifest.value === null ||
      Array.isArray(manifest.value)
    )
      return err({ type: "InvalidManifest" });
    if (
      typeof manifest.value.name !== "string" ||
      !(manifest.value.name in PUBLIC_PACKAGES)
    )
      return err({
        type: "UnexpectedPackage",
        packageName: String(manifest.value.name),
      });
    const packageName = manifest.value.name as PublicPackageName;
    const declaredDependencies = this.validateManifest(manifest.value);
    if (declaredDependencies.isErr()) return err(declaredDependencies.error);
    const inventory = this.validateInventory(packageName, inspected.value);
    if (inventory.isErr()) return err(inventory.error);
    const imports = this.validateImports(
      inspected.value,
      declaredDependencies.value,
      packageName,
    );
    if (imports.isErr()) return err(imports.error);
    return ok({ packageName, sha256 });
  }

  private validateManifest(
    manifest: Record<string, unknown>,
  ): Result<Set<string>, PackagePolicyError> {
    if (manifest.scripts !== undefined) return err({ type: "LifecycleScript" });
    const declared = new Set<string>();
    for (const field of ALL_DEPENDENCY_FIELDS) {
      const value = manifest[field];
      if (value === undefined) continue;
      if (
        field === "devDependencies" ||
        typeof value !== "object" ||
        value === null ||
        Array.isArray(value)
      )
        return err({ type: "ForbiddenDependency", field, name: field });
      for (const [name, version] of Object.entries(value)) {
        if (
          typeof version !== "string" ||
          PRIVATE_PACKAGE_NAMES.includes(name as never) ||
          name.startsWith("@weaveio/")
        )
          return err({ type: "ForbiddenDependency", field, name });
        declared.add(name);
      }
    }
    return ok(declared);
  }

  private validateInventory(
    packageName: PublicPackageName,
    entries: readonly { path: string; mode: number }[],
  ): Result<void, PackagePolicyError> {
    const expected = expectedFiles(packageName);
    const actual = new Set(entries.map((entry) => entry.path));
    for (const path of actual)
      if (
        !expected.has(path) ||
        /(?:\.map$|(?:^|\/)(?:test|tests|src|config)(?:\/|$))/.test(path)
      )
        return err({ type: "UnexpectedFile", path });
    for (const path of expected)
      if (!actual.has(path)) return err({ type: "MissingFile", path });
    for (const entry of entries) {
      const desiredMode = entry.path === "package/dist/main.js" ? 0o755 : 0o644;
      if (entry.mode !== desiredMode)
        return err({ type: "WrongMode", path: entry.path, mode: entry.mode });
    }
    return ok(undefined);
  }

  private validateImports(
    entries: readonly { path: string; contents: Uint8Array }[],
    declared: Set<string>,
    packageName: PublicPackageName,
  ): Result<void, PackagePolicyError> {
    const decoder = new TextDecoder();
    for (const entry of entries) {
      if (!/\.(?:js|d\.ts)$/.test(entry.path)) continue;
      const text = decoder.decode(entry.contents);
      for (const match of text.matchAll(
        /(?:from\s*|import\s*\(|require\s*\()["']([^"']+)["']/g,
      )) {
        const specifier = match[1] ?? "";
        if (
          !/^(?:@?[A-Za-z0-9_.-]+)(?:\/[A-Za-z0-9_.@-]+)*$/.test(specifier) &&
          !specifier.startsWith(".")
        )
          continue;
        if (
          specifier.startsWith(".") ||
          specifier.startsWith("node:") ||
          NODE_BUILTINS.has(specifier.split("/")[0] ?? specifier)
        )
          continue;
        const dependency = specifier.startsWith("@")
          ? specifier.split("/").slice(0, 2).join("/")
          : specifier.split("/")[0];
        if (!declared.has(dependency))
          return err({
            type: "UndeclaredImport",
            packageName,
            path: entry.path,
            specifier,
          });
      }
    }
    return ok(undefined);
  }
}

const NODE_BUILTINS = new Set([
  "assert",
  "async_hooks",
  "buffer",
  "child_process",
  "cluster",
  "console",
  "constants",
  "crypto",
  "diagnostics_channel",
  "dns",
  "domain",
  "events",
  "fs",
  "http",
  "http2",
  "https",
  "module",
  "net",
  "os",
  "path",
  "perf_hooks",
  "process",
  "punycode",
  "querystring",
  "readline",
  "repl",
  "stream",
  "string_decoder",
  "sys",
  "timers",
  "tls",
  "trace_events",
  "tty",
  "url",
  "util",
  "v8",
  "vm",
  "wasi",
  "worker_threads",
  "zlib",
]);

function expectedFiles(packageName: PublicPackageName): Set<string> {
  const build: PublicPackageBuild = PUBLIC_PACKAGE_BUILDS[packageName];
  const files = new Set<string>(["package/package.json"]);
  for (const entry of build.entries)
    files.add(
      `package/${entry.output.slice(PUBLIC_PACKAGES[packageName].directory.length + 1)}`,
    );
  for (const declaration of build.declarations)
    files.add(
      `package/${declaration.output.slice(PUBLIC_PACKAGES[packageName].directory.length + 1)}`,
    );
  if (build.bootstrap !== undefined)
    for (const file of build.bootstrap)
      files.add(`package/dist/bootstrap/${file}`);
  if (packageName !== "@weaveio/weave-cli") files.add("package/README.md");
  return files;
}
