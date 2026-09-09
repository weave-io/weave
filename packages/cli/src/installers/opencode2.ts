import { dirname, resolve } from "node:path";
import { applyEdits, modify, type ParseError, parse } from "jsonc-parser";
import {
  err,
  errAsync,
  ok,
  okAsync,
  type Result,
  ResultAsync,
} from "neverthrow";
import type { FileSystem } from "../fs/file-system.js";
import { inspectLegacyJsonc } from "../migration/legacy-jsonc-inspect.js";
import type {
  HarnessInstaller,
  InstallError,
  InstallRequest,
  InstallResult,
} from "./index.js";

export const OPENCODE2_PLUGIN_PACKAGE = "@weaveio/weave-adapter-opencode2";

function configCandidates(fs: FileSystem, scope: "global" | "local"): string[] {
  if (scope === "global") {
    const root = fs.xdgConfigHome() ?? resolve(fs.home(), ".config");
    return [
      resolve(root, "opencode", "opencode.jsonc"),
      resolve(root, "opencode", "opencode.json"),
    ];
  }
  return [
    resolve(fs.cwd(), "opencode.jsonc"),
    resolve(fs.cwd(), "opencode.json"),
    resolve(fs.cwd(), ".opencode", "opencode.jsonc"),
    resolve(fs.cwd(), ".opencode", "opencode.json"),
  ];
}

function installFailure(path: string, cause: unknown): InstallError {
  return { type: "InstallFailed", harness: "opencode2", path, cause };
}

function hasEquivalentPlugin(value: unknown): boolean {
  if (typeof value === "string")
    return (
      value === OPENCODE2_PLUGIN_PACKAGE ||
      value.startsWith(`${OPENCODE2_PLUGIN_PACKAGE}@`)
    );
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return false;
  const descriptor = Object.getOwnPropertyDescriptor(value, "package");
  return (
    descriptor?.value === OPENCODE2_PLUGIN_PACKAGE ||
    (typeof descriptor?.value === "string" &&
      descriptor.value.startsWith(`${OPENCODE2_PLUGIN_PACKAGE}@`))
  );
}

function editConfig(
  source: string,
  path: string,
): Result<{ contents: string; changed: boolean }, InstallError> {
  const inspected = inspectLegacyJsonc(source);
  if (inspected.isErr())
    return err(
      installFailure(
        path,
        "OpenCode 2 config contains unsafe or malformed JSONC",
      ),
    );
  const errors: ParseError[] = [];
  const parsed = parse(source, errors, {
    allowTrailingComma: true,
    disallowComments: false,
    allowEmptyContent: false,
  });
  if (
    errors.length > 0 ||
    parsed === null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed)
  ) {
    return err(
      installFailure(
        path,
        "OpenCode 2 config is malformed or is not an object",
      ),
    );
  }
  if (Object.hasOwn(parsed, "plugin")) {
    return err(
      installFailure(
        path,
        "singular legacy plugin configuration requires manual review",
      ),
    );
  }
  const plugins = Object.getOwnPropertyDescriptor(parsed, "plugins")?.value;
  if (plugins !== undefined && !Array.isArray(plugins)) {
    return err(installFailure(path, "plugins must be an array"));
  }
  if (Array.isArray(plugins) && plugins.some(hasEquivalentPlugin))
    return ok({ contents: source, changed: false });
  const target = Array.isArray(plugins)
    ? ["plugins", plugins.length]
    : ["plugins"];
  const value = Array.isArray(plugins)
    ? OPENCODE2_PLUGIN_PACKAGE
    : [OPENCODE2_PLUGIN_PACKAGE];
  const edits = modify(source, target, value, {
    formattingOptions: {
      insertSpaces: true,
      tabSize: 2,
      eol: source.includes("\r\n") ? "\r\n" : "\n",
    },
  });
  return ok({ contents: applyEdits(source, edits), changed: true });
}

export class OpenCode2Installer implements HarnessInstaller {
  readonly id = "opencode2" as const;
  readonly supported = true;
  readonly optionalModules = [];

  constructor(private readonly fs: FileSystem) {}

  install(request: InstallRequest): ResultAsync<InstallResult, InstallError> {
    const scope = request.scope ?? "global";
    const candidates = configCandidates(this.fs, scope);
    return ResultAsync.combine(candidates.map((path) => this.fs.exists(path)))
      .mapErr((error) => installFailure(request.configPath, error))
      .andThen((existence) => {
        const existing = candidates.filter((_path, index) => existence[index]);
        if (existing.length > 1)
          return errAsync(
            installFailure(
              request.configPath,
              "multiple OpenCode 2 config files are present",
            ),
          );
        const path = existing[0] ?? candidates[0];
        if (path === undefined)
          return errAsync(
            installFailure(
              request.configPath,
              "could not resolve OpenCode 2 config path",
            ),
          );
        const read =
          existing.length === 0
            ? okAsync<string, InstallError>("{}\n")
            : this.fs
                .readText(path)
                .mapErr((error) => installFailure(path, error));
        return read.andThen((source) => {
          const edited = editConfig(source, path);
          if (edited.isErr()) return errAsync(edited.error);
          if (!edited.value.changed) {
            return okAsync({
              harness: this.id,
              changed: false,
              messages: [`OpenCode 2 plugin already configured in ${path}`],
            });
          }
          return this.fs
            .mkdir(dirname(path))
            .mapErr((error) => installFailure(path, error))
            .andThen(() =>
              this.fs
                .writeText(path, edited.value.contents)
                .mapErr((error) => installFailure(path, error)),
            )
            .map(() => ({
              harness: this.id,
              changed: true,
              messages: [
                `Configured OpenCode 2 plugin in ${path}`,
                "OpenCode 2 uses a different plugin ABI from OpenCode 1. Review shared config before enabling both.",
              ],
            }));
        });
      });
  }
}
