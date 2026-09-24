/**
 * How the live check puts Weave into the host.
 *
 * - `local`: build and pack `@weaveio/weave-adapter-opencode2` from this
 *   checkout, unpack the tarball, install its production dependencies, and
 *   name the unpacked directory in the project's `plugins`. This is the
 *   package that would be published from this revision.
 * - `npm:<spec>`: name a registry package in the project's `plugins`, e.g.
 *   `npm:@weaveio/weave-adapter-opencode2@next`. The host installs it.
 * - `init:<cli-spec>`: run the documented install,
 *   `<cli-spec> init --harness opencode2 --scope local --yes`, e.g.
 *   `init:@weaveio/weave-cli@next`, and keep whatever entry it writes.
 */

import { join } from "node:path";
import { err, ok, type Result, ResultAsync } from "neverthrow";
import {
  type LiveHostError,
  type LivePaths,
  mustRun,
  type OpenCode2Host,
  writeText,
} from "./host.js";

export type PluginSource =
  | { readonly kind: "local" }
  | { readonly kind: "npm"; readonly spec: string }
  | { readonly kind: "init"; readonly cliSpec: string };

export type PluginSourceError = {
  readonly type: "InvalidPluginSource";
  readonly value: string;
};

export function parsePluginSource(
  raw: string,
): Result<PluginSource, PluginSourceError> {
  if (raw === "local") return ok({ kind: "local" });
  if (raw.startsWith("npm:") && raw.length > 4) {
    return ok({ kind: "npm", spec: raw.slice(4) });
  }
  if (raw.startsWith("init:") && raw.length > 5) {
    return ok({ kind: "init", cliSpec: raw.slice(5) });
  }
  return err({ type: "InvalidPluginSource", value: raw });
}

export function describePluginSource(source: PluginSource): string {
  if (source.kind === "local") return "local";
  if (source.kind === "npm") return `npm:${source.spec}`;
  return `init:${source.cliSpec}`;
}

export class PluginInstaller {
  constructor(
    private readonly paths: LivePaths,
    private readonly host: OpenCode2Host,
    private readonly repoRoot: string,
  ) {}

  /** Installs the plugin; returns the project's resulting host config text. */
  install(source: PluginSource): ResultAsync<string, LiveHostError> {
    if (source.kind === "local") {
      return this.packLocal().andThen((dir) => this.writeProjectConfig(dir));
    }
    if (source.kind === "npm") return this.writeProjectConfig(source.spec);
    return this.weaveInit(source.cliSpec);
  }

  private packageDir(): string {
    return join(this.repoRoot, "packages", "adapters", "opencode2");
  }

  private buildEnv(): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(Bun.env)) {
      if (value !== undefined) env[key] = value;
    }
    return env;
  }

  private packLocal(): ResultAsync<string, LiveHostError> {
    const packDir = join(this.paths.root, "pack");
    const unpackDir = join(this.paths.root, "adapter");
    const packageRoot = join(unpackDir, "package");
    const build = { cwd: this.packageDir(), env: this.buildEnv() };
    return mustRun("build adapter", ["bun", "run", "build"], {
      ...build,
      timeoutMs: 300_000,
    })
      .andThen(() =>
        mustRun(
          "pack adapter",
          ["bun", "pm", "pack", "--destination", packDir],
          { ...build, timeoutMs: 120_000 },
        ),
      )
      .andThen(() => this.findTarball(packDir))
      .andThen((tarball) =>
        mustRun("unpack adapter", ["mkdir", "-p", unpackDir], {
          ...build,
          timeoutMs: 10_000,
        }).andThen(() =>
          mustRun("unpack adapter", ["tar", "-xzf", tarball, "-C", unpackDir], {
            ...build,
            timeoutMs: 60_000,
          }),
        ),
      )
      .andThen(() => this.dropDevDependencies(packageRoot))
      .andThen(() =>
        mustRun(
          "install adapter dependencies",
          ["bun", "install", "--production"],
          { cwd: packageRoot, env: this.host.env(), timeoutMs: 600_000 },
        ),
      )
      .map(() => packageRoot);
  }

  private findTarball(packDir: string): ResultAsync<string, LiveHostError> {
    return ResultAsync.fromPromise(
      Array.fromAsync(new Bun.Glob("*.tgz").scan({ cwd: packDir })),
      (): LiveHostError => ({
        type: "FileFailed",
        path: packDir,
        detail: "could not list packed tarballs",
      }),
    ).andThen((names) => {
      const name = names[0];
      if (names.length !== 1 || name === undefined) {
        return err<string, LiveHostError>({
          type: "FileFailed",
          path: packDir,
          detail: `expected one tarball, found ${names.length}`,
        });
      }
      return ok<string, LiveHostError>(join(packDir, name));
    });
  }

  /**
   * The packed manifest keeps workspace devDependencies at their unpublished
   * `0.0.1` versions, which a registry install cannot resolve. A registry
   * consumer never installs devDependencies, so dropping them changes nothing
   * the host sees.
   */
  private dropDevDependencies(
    packageRoot: string,
  ): ResultAsync<void, LiveHostError> {
    const manifestPath = join(packageRoot, "package.json");
    return ResultAsync.fromPromise(
      Bun.file(manifestPath).json() as Promise<Record<string, unknown>>,
      (): LiveHostError => ({
        type: "FileFailed",
        path: manifestPath,
        detail: "packed package.json is not readable JSON",
      }),
    ).andThen((manifest) => {
      const { devDependencies: _dropped, ...rest } = manifest;
      return writeText(manifestPath, `${JSON.stringify(rest, null, 2)}\n`);
    });
  }

  private writeProjectConfig(
    entry: string,
  ): ResultAsync<string, LiveHostError> {
    const text = `${JSON.stringify({ plugins: [entry] }, null, 2)}\n`;
    return writeText(join(this.paths.project, "opencode.json"), text).map(
      () => text,
    );
  }

  private weaveInit(cliSpec: string): ResultAsync<string, LiveHostError> {
    const configPath = join(this.paths.project, "opencode.jsonc");
    return mustRun(
      "weave init",
      [
        "bunx",
        cliSpec,
        "init",
        "--harness",
        "opencode2",
        "--scope",
        "local",
        "--yes",
      ],
      { cwd: this.paths.project, env: this.host.env(), timeoutMs: 300_000 },
    ).andThen(() =>
      ResultAsync.fromPromise(
        Bun.file(configPath).text(),
        (): LiveHostError => ({
          type: "FileFailed",
          path: configPath,
          detail: "weave init did not write opencode.jsonc",
        }),
      ),
    );
  }
}
