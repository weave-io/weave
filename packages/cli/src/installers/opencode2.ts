import type { FileSystem } from "../fs/file-system.js";
import { OpenCodePluginInstaller, pluginSpecifier } from "./opencode-plugin.js";

export const OPENCODE2_PLUGIN_PACKAGE = "@weaveio/weave-adapter-opencode2";

/**
 * The adapter version released with this CLI. `scripts/build-public-packages.ts`
 * replaces this expression with the adapter's `package.json` version when it
 * builds the published CLI; a source checkout leaves it unset.
 */
const RELEASED_ADAPTER_VERSION: string | undefined =
  process.env.WEAVE_OPENCODE2_ADAPTER_VERSION;

/** The `plugins` entry `weave init` writes for OpenCode 2. */
export function opencode2PluginSpecifier(version: string | undefined): string {
  return pluginSpecifier(OPENCODE2_PLUGIN_PACKAGE, version);
}

/**
 * Adds the Weave adapter to OpenCode 2's `plugins` array. OpenCode 2 installs
 * the package itself the next time it starts.
 */
export class OpenCode2Installer extends OpenCodePluginInstaller {
  constructor(
    fs: FileSystem,
    adapterVersion: string | undefined = RELEASED_ADAPTER_VERSION,
  ) {
    super(
      fs,
      {
        harness: "opencode2",
        label: "OpenCode 2",
        key: "plugins",
        packageName: OPENCODE2_PLUGIN_PACKAGE,
      },
      adapterVersion,
    );
  }
}
