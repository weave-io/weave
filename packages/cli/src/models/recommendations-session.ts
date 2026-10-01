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
  mergeConfigsResult,
  modelRecommendationsCachePaths,
  normalizePath,
  type RecommendationsHarness,
  selectRecommendationsSection,
} from "@weaveio/weave-config";
import {
  formatError,
  type ModelUpdatesChannel,
  type WeaveConfig,
  WeaveConfigSchema,
} from "@weaveio/weave-core";
import { errAsync, okAsync, type ResultAsync } from "neverthrow";
import type { CliError } from "../errors.js";
import { type FileSystem, toConfigFileReader } from "../fs/file-system.js";

/** What a test (or a local proof) may replace. Defaults are production. */
export type CliModelRecommendationsDeps = Pick<
  ModelRecommendationsDeps,
  "fetch" | "files" | "shell" | "publicKeys" | "baseUrl" | "uniqueId"
>;

/** How a command uses the session, as opposed to what a test replaces. */
export interface RecommendationsSessionOptions {
  /**
   * The refresh's request timeout. Defaults to `ModelRecommendations`' own
   * (5 s); `weave compose` shortens it because Claude Code's session-start
   * hook waits for it.
   */
  readonly timeoutMs?: number;
}

/** One cached list's section for a harness, builtin agents only. */
export interface RecommendedLists {
  readonly issued: string;
  /** The harness's own section, or `default`. */
  readonly section: RecommendationsHarness | "default";
  readonly agents: Readonly<Record<string, readonly string[]>>;
}

/** Each agent's `models` list, by agent name. */
export type AgentModels = Readonly<Record<string, readonly string[]>>;

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
    options: RecommendationsSessionOptions = {},
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
      ...(options.timeoutMs === undefined
        ? {}
        : { timeoutMs: options.timeoutMs }),
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
    return this.discovered(projectRoot).map((discovered) => {
      const layers: { global?: WeaveConfig; project?: WeaveConfig } = {};
      for (const { config, scope } of discovered) {
        if (scope.kind === "global") layers.global = config;
        if (scope.kind === "project") layers.project = config;
      }
      return layers;
    });
  }

  /**
   * Every builtin agent's merged `models` list as the loader builds it with
   * `recommended` as the recommendations layer, or with none: builtins, then
   * the recommendations, then the config files. Comparing two of these tells
   * whether applying a list changes what any agent runs.
   */
  effectiveModels(
    projectRoot: string,
    recommended: RecommendedLists | undefined,
  ): ResultAsync<AgentModels, CliError> {
    return this.builtins().andThen((builtins) =>
      this.discovered(projectRoot).andThen((discovered) => {
        const merged = mergeConfigsResult(
          builtins,
          ...recommendationsLayer(recommended),
          ...discovered.map(({ config }) => config),
        );
        if (merged.isErr())
          return errAsync<AgentModels, CliError>({
            type: "ParseFailure",
            path: projectRoot,
            errors: formatConfigLoadErrors([
              { type: "MergeError", errors: merged.error },
            ]),
          });
        const models: Record<string, readonly string[]> = {};
        for (const agent of Object.keys(builtins.agents)) {
          const list = merged.value.agents[agent]?.models;
          if (list !== undefined) models[agent] = list;
        }
        return okAsync<AgentModels, CliError>(models);
      }),
    );
  }

  private discovered(projectRoot: string) {
    return discoverAndParse(projectRoot, this.reader()).mapErr(
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
        // A cache that cannot be checked is not a missing file: reject, so the
        // loader reports the layer as skipped (Unreadable), not pending.
        if (exists.isErr()) return Promise.reject(exists.error);
        return exists.value;
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

/**
 * A list's agents as a config layer, the way the loader adds it. A layer that
 * does not validate is left out, as the loader leaves it out.
 */
function recommendationsLayer(
  recommended: RecommendedLists | undefined,
): WeaveConfig[] {
  if (recommended === undefined) return [];
  const agents = Object.fromEntries(
    Object.entries(recommended.agents).map(([agent, models]) => [
      agent,
      { models: [...models] },
    ]),
  );
  const layer = WeaveConfigSchema.safeParse({ agents });
  return layer.success ? [layer.data] : [];
}
