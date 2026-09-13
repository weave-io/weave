/**
 * Builds the global OpenCode config that `scripts/dev/opencode` runs with:
 * the user's real global config with every Weave OpenCode plugin (published
 * adapter, legacy plugin, or an older file:// build) replaced by this
 * checkout's dev build. OpenCode concatenates `plugin` lists across config
 * layers, so adding the dev build without removing the others would load two
 * Weave adapters at once.
 *
 * Usage:
 *   bun scripts/dev/opencode-config.ts <real-opencode-config-dir> <dev-plugin-spec> <project-dir>
 *
 * Writes the rewritten config as JSON to stdout, and what it replaced plus any
 * project-level Weave plugins (which it cannot remove) to stderr.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

type JsonObject = Record<string, unknown>;

/** OpenCode's global config files, merged in this order. */
export const GLOBAL_CONFIG_FILES = [
  "config.json",
  "opencode.json",
  "opencode.jsonc",
] as const;

const PROJECT_CONFIG_FILES = [
  "opencode.json",
  "opencode.jsonc",
  ".opencode/opencode.json",
  ".opencode/opencode.jsonc",
] as const;

const WEAVE_PACKAGE_SPEC =
  /^(@weaveio\/weave-adapter-opencode|@opencode_weave\/weave)(@.*)?$/;
const WEAVE_FILE_SPEC =
  /(weave-adapter-opencode|opencode-weave|packages\/adapters\/opencode\/)/;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A `plugin` entry is a spec string or a `[spec, options]` tuple. */
function pluginSpec(entry: unknown): string | undefined {
  if (typeof entry === "string") return entry;
  if (Array.isArray(entry) && typeof entry[0] === "string") return entry[0];
  return undefined;
}

/** True for any spec that loads a Weave OpenCode plugin. */
export function isWeavePluginSpec(spec: string): boolean {
  if (WEAVE_PACKAGE_SPEC.test(spec)) return true;
  return spec.startsWith("file:") && WEAVE_FILE_SPEC.test(spec);
}

/** Deep-merge config layers the way OpenCode does: objects merge, `plugin` lists concatenate, other values replace. */
export function mergeConfigs(layers: readonly JsonObject[]): JsonObject {
  const merge = (base: JsonObject, next: JsonObject): JsonObject => {
    const out: JsonObject = { ...base };
    for (const [key, value] of Object.entries(next)) {
      const current = out[key];
      if (key === "plugin" && Array.isArray(current) && Array.isArray(value)) {
        out[key] = [...current, ...value];
      } else if (isObject(current) && isObject(value)) {
        out[key] = merge(current, value);
      } else {
        out[key] = value;
      }
    }
    return out;
  };
  return layers.reduce<JsonObject>((acc, layer) => merge(acc, layer), {});
}

/** Replace every Weave plugin entry with `devSpec`, keeping all other plugins in order. */
export function useDevPlugin(
  config: JsonObject,
  devSpec: string,
): { config: JsonObject; replaced: string[] } {
  const plugins = Array.isArray(config.plugin) ? config.plugin : [];
  const replaced: string[] = [];
  const kept = plugins.filter((entry) => {
    const spec = pluginSpec(entry);
    if (spec !== undefined && isWeavePluginSpec(spec)) {
      replaced.push(spec);
      return false;
    }
    return true;
  });
  return { config: { ...config, plugin: [...kept, devSpec] }, replaced };
}

function readJsonc(path: string): JsonObject {
  const value = Bun.JSONC.parse(readFileSync(path, "utf8"));
  if (!isObject(value)) throw new Error(`${path} is not a JSON object`);
  return value;
}

/** Read and merge the user's global OpenCode config files from `dir`. */
export function readGlobalConfig(dir: string): JsonObject {
  const layers = GLOBAL_CONFIG_FILES.map((name) => join(dir, name))
    .filter((path) => existsSync(path))
    .map(readJsonc);
  return mergeConfigs(layers);
}

/**
 * Weave plugins declared in project config between `start` and the git root
 * (or the filesystem root). OpenCode loads these too, and this script can't
 * override them without disabling the whole project config.
 */
export function findProjectWeavePlugins(
  start: string,
): { file: string; spec: string }[] {
  const found: { file: string; spec: string }[] = [];
  let dir = start;
  for (;;) {
    for (const name of PROJECT_CONFIG_FILES) {
      const file = join(dir, name);
      if (!existsSync(file)) continue;
      let config: JsonObject;
      try {
        config = readJsonc(file);
      } catch {
        continue;
      }
      const plugins = Array.isArray(config.plugin) ? config.plugin : [];
      for (const entry of plugins) {
        const spec = pluginSpec(entry);
        if (spec !== undefined && isWeavePluginSpec(spec))
          found.push({ file, spec });
      }
    }
    const parent = dirname(dir);
    if (existsSync(join(dir, ".git")) || parent === dir) return found;
    dir = parent;
  }
}

if (import.meta.main) {
  const [configDir, devSpec, projectDir] = process.argv.slice(2);
  if (!configDir || !devSpec || !projectDir) {
    console.error(
      "usage: bun scripts/dev/opencode-config.ts <real-opencode-config-dir> <dev-plugin-spec> <project-dir>",
    );
    process.exit(2);
  }

  const { config, replaced } = useDevPlugin(
    readGlobalConfig(configDir),
    devSpec,
  );
  for (const spec of replaced)
    console.error(`[weave-dev] replacing global plugin ${spec}`);
  for (const { file, spec } of findProjectWeavePlugins(projectDir)) {
    console.error(
      `[weave-dev] warning: ${file} also loads ${spec}; OpenCode will run it alongside the dev build. Remove it while testing.`,
    );
  }
  process.stdout.write(`${JSON.stringify(config, null, 2)}\n`);
}
