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

/**
 * How one OpenCode host generation names its plugins.
 *
 * OpenCode 1 reads a `plugin` array and OpenCode 2 a `plugins` array, both
 * from the same `opencode.json(c)` files. Each host ignores the other's key,
 * so one file can carry both entries.
 */
export interface OpenCodePluginTarget {
  readonly harness: "opencode" | "opencode2";
  readonly label: string;
  readonly key: "plugin" | "plugins";
  readonly packageName: string;
  /** Entries this target replaces, e.g. the legacy `@opencode_weave/weave` plugin. */
  readonly replaces?: readonly string[];
}

/**
 * The entry `weave init` writes. The published CLI pins the exact adapter
 * version it was released with: an unpinned name makes OpenCode install the
 * npm `latest` dist-tag, which can be an adapter that does not support the
 * host (issue #209's silent empty install).
 */
export function pluginSpecifier(
  packageName: string,
  version: string | undefined,
): string {
  if (version === undefined || version.length === 0) return packageName;
  return `${packageName}@${version}`;
}

/** The package an entry names: a bare string, or an object's `package`. */
function entryPackage(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const name = Object.getOwnPropertyDescriptor(value, "package")?.value;
  return typeof name === "string" ? name : undefined;
}

/** Whether an entry names the package, with or without a version or subpath. */
function namesPackage(value: unknown, packageName: string): boolean {
  const name = entryPackage(value);
  if (name === undefined) return false;
  return (
    name === packageName ||
    name.startsWith(`${packageName}@`) ||
    name.startsWith(`${packageName}/`)
  );
}

export function openCodeConfigCandidates(
  fs: FileSystem,
  scope: "global" | "local",
): string[] {
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

type Edit = {
  readonly contents: string;
  readonly changed: boolean;
  readonly replaced?: string;
  /** The adapter was already listed, so the legacy entry was only removed. */
  readonly removedOnly?: boolean;
};

export class OpenCodePluginInstaller implements HarnessInstaller {
  readonly supported = true;
  readonly optionalModules = [];

  constructor(
    private readonly fs: FileSystem,
    private readonly target: OpenCodePluginTarget,
    private readonly adapterVersion: string | undefined,
  ) {}

  get id(): OpenCodePluginTarget["harness"] {
    return this.target.harness;
  }

  install(request: InstallRequest): ResultAsync<InstallResult, InstallError> {
    const scope = request.scope ?? "global";
    const candidates = openCodeConfigCandidates(this.fs, scope);
    return ResultAsync.combine(candidates.map((path) => this.fs.exists(path)))
      .mapErr((error) => this.failure(request.configPath, error))
      .andThen((existence) => {
        const existing = candidates.filter((_path, index) => existence[index]);
        if (existing.length > 1)
          return errAsync(
            this.failure(
              request.configPath,
              `multiple ${this.target.label} config files are present: ${existing.join(", ")}`,
            ),
          );
        const path = existing[0] ?? candidates[0];
        if (path === undefined)
          return errAsync(
            this.failure(
              request.configPath,
              `could not resolve ${this.target.label} config path`,
            ),
          );
        const read =
          existing.length === 0
            ? okAsync<string, InstallError>("{}\n")
            : this.fs
                .readText(path)
                .mapErr((error) => this.failure(path, error));
        return read.andThen((source) => this.write(path, source));
      });
  }

  private write(
    path: string,
    source: string,
  ): ResultAsync<InstallResult, InstallError> {
    const edited = this.edit(source, path);
    if (edited.isErr()) return errAsync(edited.error);
    const { contents, changed, replaced, removedOnly } = edited.value;
    if (!changed) {
      return okAsync({
        harness: this.target.harness,
        changed: false,
        messages: [`${this.target.label} plugin already configured in ${path}`],
      });
    }
    const messages = removedOnly
      ? [
          `Removed the legacy plugin entry ${replaced} from ${path}; the Weave adapter is already listed.`,
        ]
      : [
          `Configured ${this.target.label} plugin in ${path}: ${this.specifier()}`,
        ];
    if (replaced !== undefined && !removedOnly)
      messages.push(`Replaced the legacy plugin entry ${replaced}`);
    messages.push(
      `Restart ${this.target.label}; it installs the plugin on start.`,
    );
    return this.fs
      .mkdir(dirname(path))
      .mapErr((error) => this.failure(path, error))
      .andThen(() =>
        this.fs
          .writeText(path, contents)
          .mapErr((error) => this.failure(path, error)),
      )
      .map(() => ({ harness: this.target.harness, changed: true, messages }));
  }

  private specifier(): string {
    return pluginSpecifier(this.target.packageName, this.adapterVersion);
  }

  private edit(source: string, path: string): Result<Edit, InstallError> {
    const label = this.target.label;
    if (inspectLegacyJsonc(source).isErr())
      return err(
        this.failure(
          path,
          `${label} config contains unsafe or malformed JSONC`,
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
        this.failure(path, `${label} config is malformed or is not an object`),
      );
    }
    const key = this.target.key;
    const entries = Object.getOwnPropertyDescriptor(parsed, key)?.value;
    if (entries !== undefined && !Array.isArray(entries)) {
      return err(this.failure(path, `${key} must be an array`));
    }
    const list: unknown[] = Array.isArray(entries) ? entries : [];
    const installed = list.some((entry) =>
      namesPackage(entry, this.target.packageName),
    );
    const legacyIndex = list.findIndex((entry) =>
      (this.target.replaces ?? []).some((name) => namesPackage(entry, name)),
    );
    const replaced =
      legacyIndex >= 0 ? entryPackage(list[legacyIndex]) : undefined;
    if (installed && legacyIndex < 0)
      return ok({ contents: source, changed: false });

    // The legacy plugin and the adapter must not both load: replace the
    // legacy entry, or remove it when the adapter is already listed.
    const edit = this.editFor(entries, legacyIndex, installed);
    const edits = modify(source, edit.path, edit.value, {
      formattingOptions: {
        insertSpaces: true,
        tabSize: 2,
        eol: source.includes("\r\n") ? "\r\n" : "\n",
      },
      ...(edit.insert ? { isArrayInsertion: true } : {}),
    });
    return ok({
      contents: applyEdits(source, edits),
      changed: true,
      ...(replaced === undefined ? {} : { replaced }),
      ...(installed ? { removedOnly: true } : {}),
    });
  }

  private editFor(
    entries: unknown,
    legacyIndex: number,
    installed: boolean,
  ): { path: (string | number)[]; value: unknown; insert: boolean } {
    const key = this.target.key;
    if (!Array.isArray(entries))
      return { path: [key], value: [this.specifier()], insert: false };
    // Rewrite the array rather than delete one element: jsonc-parser's
    // element removal corrupts a single-line array when the last element goes.
    if (legacyIndex >= 0 && installed)
      return {
        path: [key],
        value: entries.filter((_entry, index) => index !== legacyIndex),
        insert: false,
      };
    if (legacyIndex >= 0)
      return {
        path: [key, legacyIndex],
        value: this.specifier(),
        insert: false,
      };
    return {
      path: [key, entries.length],
      value: this.specifier(),
      insert: true,
    };
  }

  private failure(path: string, cause: unknown): InstallError {
    return { type: "InstallFailed", harness: this.target.harness, path, cause };
  }
}
