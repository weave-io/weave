/**
 * Where model recommendations live on disk, and which channel a config asks
 * for (Spec 39, "Cache").
 *
 * The loader reads `applied.json` from here; the fetcher (Spec 39 item 4)
 * writes `latest.json`, `applied.json` and `state.json` here under `lock/`.
 * Both use these helpers so they can never disagree about a path.
 */

import type {
  ModelUpdatesChannel,
  ModelUpdatesMode,
  ModelUpdatesSettings,
} from "@weaveio/weave-core";
import { globalConfigDir } from "./discovery.js";
import { normalizePath } from "./normalize-path.js";

/** The channel used when `settings.model_updates` sets none. */
export const DEFAULT_MODEL_UPDATES_CHANNEL: ModelUpdatesChannel = "stable";

/** The cache directory, relative to the global config directory. */
export const MODEL_RECOMMENDATIONS_CACHE_DIR = "cache/model-recommendations";

/** Every path in one channel's cache directory. */
export interface ModelRecommendationsCachePaths {
  /** `<global>/cache/model-recommendations/<channel>` */
  readonly dir: string;
  /** Last verified download, as the served envelope. */
  readonly latest: string;
  /** What the loader merges, same envelope. */
  readonly applied: string;
  /** Last check time, ETag and last error code. */
  readonly state: string;
  /** Directory present while one process refreshes or applies. */
  readonly lock: string;
}

/**
 * The cache paths for `channel`, under `globalDir`, which defaults to the
 * global config directory (`WEAVE_GLOBAL_CONFIG_DIR`, else `~/.weave`).
 * Paths use forward slashes on every platform, as discovery's do.
 */
export function modelRecommendationsCachePaths(
  channel: ModelUpdatesChannel,
  globalDir: string = globalConfigDir(),
): ModelRecommendationsCachePaths {
  const dir = `${normalizePath(globalDir)}/${MODEL_RECOMMENDATIONS_CACHE_DIR}/${channel}`;
  return {
    dir,
    latest: `${dir}/latest.json`,
    applied: `${dir}/applied.json`,
    state: `${dir}/state.json`,
    lock: `${dir}/lock`,
  };
}

/** An opted-in `model_updates` setting with its channel filled in. */
export interface ResolvedModelUpdates {
  readonly mode: Exclude<ModelUpdatesMode, "off">;
  readonly channel: ModelUpdatesChannel;
}

/**
 * Read the merged `settings.model_updates`. An absent block and `mode off`
 * both mean no recommendations (`undefined`); an unset channel is `stable`.
 */
export function resolveModelUpdates(
  settings: ModelUpdatesSettings | undefined,
): ResolvedModelUpdates | undefined {
  if (settings === undefined) return undefined;
  if (settings.mode === "off") return undefined;
  return {
    mode: settings.mode,
    channel: settings.channel ?? DEFAULT_MODEL_UPDATES_CHANNEL,
  };
}
