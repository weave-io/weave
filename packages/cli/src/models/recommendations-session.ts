/**
 * Everything the `weave models` cache commands and `weave validate` share
 * (Spec 39 item 5): one `ModelRecommendations` cache, the merged config with
 * its diagnostics, each config layer on its own, and the per-agent lists of
 * the applied or waiting recommendations.
 *
 * Network, clock and cache files are injected (`CliDeps.modelRecommendations`
 * and `CliDeps.now`), so tests run without a network or a disk. Config files
 * go through the CLI's `FileSystem`, and the loader reads the cache through
 * the same cache files the commands write, so a test's `update` is seen by its
 * `status`.
 */

import {
  BunModelRecommendationsFiles,
  BunModelRecommendationsShell,
  type ConfigLoadError,
  discoverAndParse,
  type FileReader,
  getBuiltinConfig,
  globalConfigDir,
  type LoadedConfig,
  loadConfigDetailed,
  MODEL_RECOMMENDATIONS_CACHE_DIR,
  MODEL_RECOMMENDATIONS_CLIENT_VERSION,
  ModelRecommendations,
  type ModelRecommendationsDeps,
  type ModelRecommendationsFiles,
  ModelRecommendationsVerifier,
  modelRecommendationsCachePaths,
  normalizePath,
  type RecommendationsHarness,
  selectRecommendationsSection,
} from "@weaveio/weave-config";
import {
  formatError,
  type ModelUpdatesChannel,
  type WeaveConfig,
} from "@weaveio/weave-core";
import { errAsync, okAsync, type ResultAsync } from "neverthrow";
import type { CliError } from "../errors.js";
import { type FileSystem, toConfigFileReader } from "../fs/file-system.js";

/** What a test (or a local proof) may replace. Defaults are production. */
export type CliModelRecommendationsDeps = Pick<
  ModelRecommendationsDeps,
  "fetch" | "files" | "shell" | "publicKeys" | "baseUrl" | "uniqueId"
>;

/** One cached list's section for a harness, builtin agents only. */
export interface RecommendedLists {
  readonly issued: string;
  /** The harness's own section, or `default`. */
  readonly section: RecommendationsHarness | "default";
  readonly agents: Readonly<Record<string, readonly string[]>>;
}

/** The global and project config files, each parsed on its own. */
export interface UserLayers {
  readonly global?: WeaveConfig;
  readonly project?: WeaveConfig;
}

/** Format config load errors the way `weave validate` prints them. */
export function formatConfigLoadErrors(
  errors: readonly ConfigLoadError[],
): string[] {
  return errors.flatMap((error) => {
    if (error.type === "FileReadError")
      return [`${error.path}: could not read config`];
    if (error.type === "BuiltinParseError")
      return error.errors.map((e) => `builtins:${formatError(e)}`);
    if (error.type === "MergeError")
      return error.errors.flatMap((e) =>
        e.type === "ConfigValidationError"
          ? e.errors.map((issue) => `merge:${e.layer}:${formatError(issue)}`)
          : [`merge:${e.type}:${e.error.type}`],
      );
    return error.errors.map((e) => `${error.path}:${formatError(e)}`);
  });
}

export class RecommendationsSession {
  /** The global config directory; the cache lives under it. */
  readonly globalDir: string;
  readonly models: ModelRecommendations;
  private readonly files: ModelRecommendationsFiles;
  private readonly verifier: ModelRecommendationsVerifier;
  private readonly now: () => Date;

  constructor(
    private readonly fs: FileSystem,
    private readonly deps: CliModelRecommendationsDeps = {},
    now?: () => Date,
  ) {
    this.globalDir = globalConfigDir();
    this.now = now ?? (() => new Date());
    this.files = deps.files ?? new BunModelRecommendationsFiles();
    this.models = new ModelRecommendations({
      ...deps,
      files: this.files,
      shell: deps.shell ?? new BunModelRecommendationsShell(this.files),
      globalDir: this.globalDir,
      now: this.now,
    });
    this.verifier = new ModelRecommendationsVerifier({
      ...(deps.publicKeys === undefined ? {} : { publicKeys: deps.publicKeys }),
      now: this.now,
    });
  }

  /** The global `config.weave`, which `weave models pin` edits. */
  get globalConfigPath(): string {
    return `${normalizePath(this.globalDir)}/config.weave`;
  }

  /**
   * The merged config and its diagnostics, as the harness would load it. With
   * no harness, no recommendations layer is added.
   */
  load(
    projectRoot: string,
    harness?: RecommendationsHarness,
  ): ResultAsync<LoadedConfig, CliError> {
    return loadConfigDetailed(projectRoot, this.reader(), {
      ...(harness === undefined ? {} : { harness }),
      now: this.now,
      ...(this.deps.publicKeys === undefined
        ? {}
        : { publicKeys: this.deps.publicKeys }),
    }).mapErr(
      (errors): CliError => ({
        type: "ParseFailure",
        path: projectRoot,
        errors: formatConfigLoadErrors(errors),
      }),
    );
  }

  /** The global and project config files on their own, for entry sources. */
  userLayers(projectRoot: string): ResultAsync<UserLayers, CliError> {
    return discoverAndParse(projectRoot, this.reader())
      .map((discovered) => {
        const layers: { global?: WeaveConfig; project?: WeaveConfig } = {};
        for (const { config, scope } of discovered) {
          if (scope.kind === "global") layers.global = config;
          if (scope.kind === "project") layers.project = config;
        }
        return layers;
      })
      .mapErr(
        (errors): CliError => ({
          type: "ParseFailure",
          path: projectRoot,
          errors: formatConfigLoadErrors(errors),
        }),
      );
  }

  /** The builtin config, unmerged. A failure is a bug in this release. */
  builtins(): ResultAsync<WeaveConfig, CliError> {
    const builtins = getBuiltinConfig();
    if (builtins.isOk()) return okAsync(builtins.value);
    return errAsync({
      type: "ParseFailure",
      path: "builtins",
      errors: builtins.error.map((e) => `builtins:${formatError(e)}`),
    });
  }

  /**
   * The harness's section of the cached `applied` or `latest` list, builtin
   * agents only; `undefined` when the file is missing or does not verify now.
   * Used to show what a refresh, apply or pin changes.
   */
  lists(
    slot: "applied" | "latest",
    channel: ModelUpdatesChannel,
    harness: RecommendationsHarness,
  ): ResultAsync<RecommendedLists | undefined, never> {
    const path = modelRecommendationsCachePaths(channel, this.globalDir)[slot];
    const builtins = getBuiltinConfig();
    const names = new Set(
      builtins.isOk() ? Object.keys(builtins.value.agents) : [],
    );
    return this.files
      .exists(path)
      .andThen((exists) =>
        exists ? this.files.read(path) : errAsync({ type: "Missing" as const }),
      )
      .andThen((text) =>
        this.verifier.verifyEnvelope(text, {
          channel,
          clientVersion: MODEL_RECOMMENDATIONS_CLIENT_VERSION,
        }),
      )
      .map((file): RecommendedLists | undefined => {
        const section = selectRecommendationsSection(file, harness);
        if (section === undefined) return undefined;
        const agents: Record<string, readonly string[]> = {};
        for (const [name, entry] of Object.entries(section.agents))
          if (names.has(name)) agents[name] = entry.models;
        return { issued: file.issued, section: section.source, agents };
      })
      .orElse(() => okAsync(undefined));
  }

  /**
   * A config reader that reads config files through the CLI's filesystem and
   * the recommendations cache through the cache files, so the loader sees
   * exactly what `update` and `apply` wrote.
   */
  private reader(): FileReader {
    const configReader = toConfigFileReader(this.fs);
    const cacheRoot = `${normalizePath(this.globalDir)}/${MODEL_RECOMMENDATIONS_CACHE_DIR}/`;
    const files = this.files;
    return {
      exists: async (path) => {
        if (!path.startsWith(cacheRoot)) return configReader.exists(path);
        const exists = await files.exists(path);
        return exists.isOk() && exists.value;
      },
      read: (path) => {
        if (!path.startsWith(cacheRoot)) return configReader.read(path);
        return files.read(path).mapErr(
          (cause): ConfigLoadError => ({
            type: "FileReadError",
            path,
            cause,
          }),
        );
      },
    };
  }
}
