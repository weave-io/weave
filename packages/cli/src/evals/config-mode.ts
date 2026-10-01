/**
 * Which Weave config an eval run composes its prompts from (Spec 39, task
 * 0.1, gap G1 of the eval readiness record).
 *
 * `weave eval run` scores the prompts it composes. Composing them with
 * `loadConfig(cwd)` reads the working directory's `.weave/` and the
 * developer's global `~/.weave/config.weave`, so a run made inside this
 * repository scored Shuttle and Weft on `.weave/prompts/shuttle.md` and
 * `weft.md`, prompts no user receives. A run cited as evidence must score
 * what ships, so the config mode is part of every run:
 *
 * - `builtin` (the default) loads the builtin config alone. No project or
 *   global `.weave` is read: the loader is handed a file reader that finds
 *   no files, as `tapestry-category-config.ts` does for each case.
 * - `project` loads the merged builtin + global + project config from the
 *   working directory, which is what every run did before the mode existed.
 *   It is for prompt work on a checkout's own overrides, never for evidence.
 *
 * The mode is recorded in `bundle-index.json` and `provenance-manifest.json`,
 * and `weave eval compare` refuses two runs whose modes differ.
 */

import {
  type ConfigLoadError,
  type FileReader,
  loadConfig,
} from "@weaveio/weave-config";
import type { WeaveConfig } from "@weaveio/weave-core";
import { errAsync, type ResultAsync } from "neverthrow";

/** The config modes `weave eval run --config` accepts. */
export const EVAL_CONFIG_MODES = ["builtin", "project"] as const;

/** Which Weave config an eval run composes its prompts from. */
export type EvalConfigMode = (typeof EVAL_CONFIG_MODES)[number];

/**
 * The mode a run uses when `--config` is not given: the shipped builtins,
 * because a run that may be cited as evidence must score what users get.
 */
export const DEFAULT_EVAL_CONFIG_MODE: EvalConfigMode = "builtin";

/**
 * The mode a bundle written before the mode was recorded was made in. Those
 * runs composed prompts with `loadConfig(cwd)`, which is `project`.
 */
export const UNRECORDED_EVAL_CONFIG_MODE: EvalConfigMode = "project";

/** Narrow a string to an `EvalConfigMode`. */
export function isEvalConfigMode(value: string): value is EvalConfigMode {
  return (EVAL_CONFIG_MODES as readonly string[]).includes(value);
}

/**
 * A reader that finds no config files, so `loadConfig()` returns the builtin
 * layer alone. The root it is given is never read.
 */
const NO_CONFIG_FILES: FileReader = {
  exists: () => Promise.resolve(false),
  read: (path) =>
    errAsync({
      type: "FileReadError",
      path,
      cause: "no config files are read in builtin config mode",
    }),
};

/** Placeholder project root; `NO_CONFIG_FILES` never touches it. */
const UNREAD_PROJECT_ROOT = "/weave-eval-builtin-config";

/** Dependencies of `EvalConfigLoader`, injected so tests read fixtures. */
export interface EvalConfigLoaderOptions {
  /**
   * Project root `project` mode discovers config from. Defaults to the
   * working directory, as `loadConfig()` does.
   */
  projectRoot?: string;
  /**
   * The reader `project` mode discovers config through. Defaults to the
   * real file system. `builtin` mode never uses it.
   */
  fileReader?: FileReader;
}

/** Loads the Weave config an eval run composes its prompts from. */
export class EvalConfigLoader {
  constructor(private readonly options: EvalConfigLoaderOptions = {}) {}

  /** The config for `mode`: builtins only, or the merged project config. */
  load(mode: EvalConfigMode): ResultAsync<WeaveConfig, ConfigLoadError[]> {
    if (mode === "builtin") {
      return loadConfig(UNREAD_PROJECT_ROOT, NO_CONFIG_FILES);
    }
    if (this.options.fileReader === undefined) {
      return loadConfig(this.options.projectRoot);
    }
    return loadConfig(this.options.projectRoot, this.options.fileReader);
  }
}
