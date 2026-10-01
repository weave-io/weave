import type { FileSystem } from "../fs/file-system.js";
import { OpenCodePluginInstaller } from "./opencode-plugin.js";

export const OPENCODE_PLUGIN_PACKAGE = "@weaveio/weave-adapter-opencode";

/** The legacy OpenCode-only Weave plugin the adapter supersedes. */
export const LEGACY_OPENCODE_PLUGIN_PACKAGE = "@opencode_weave/weave";

/**
 * The adapter version released with this CLI. `scripts/build-public-packages.ts`
 * replaces this expression with the adapter's `package.json` version when it
 * builds the published CLI; a source checkout leaves it unset.
 */
const RELEASED_ADAPTER_VERSION: string | undefined =
  process.env.WEAVE_OPENCODE_ADAPTER_VERSION;

/**
 * Adds the Weave adapter to OpenCode 1's `plugin` array. OpenCode installs
 * the package itself the next time it starts.
 */
export class OpenCodeInstaller extends OpenCodePluginInstaller {
  constructor(
    fs: FileSystem,
    adapterVersion: string | undefined = RELEASED_ADAPTER_VERSION,
  ) {
    super(
      fs,
      {
        harness: "opencode",
        label: "OpenCode",
        key: "plugin",
        packageName: OPENCODE_PLUGIN_PACKAGE,
        replaces: [LEGACY_OPENCODE_PLUGIN_PACKAGE],
      },
      adapterVersion,
    );
  }
}
