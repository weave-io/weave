/** Public npm artifacts and their permitted release channels. */
export const RELEASE_CHANNELS = ["stable", "nightly"] as const;

export type ReleaseChannel = (typeof RELEASE_CHANNELS)[number];

export const PRIVATE_PACKAGE_NAMES = [
  "@weaveio/weave-core",
  "@weaveio/weave-config",
  "@weaveio/weave-engine",
] as const;

export type PrivatePackageName = (typeof PRIVATE_PACKAGE_NAMES)[number];

export const PUBLIC_PACKAGES = {
  "@weaveio/weave-cli": {
    directory: "packages/cli",
    channels: ["stable", "nightly"],
  },
  "@weaveio/weave-adapter-opencode": {
    directory: "packages/adapters/opencode",
    channels: ["stable", "nightly"],
  },
  "@weaveio/weave-adapter-claude-code": {
    directory: "packages/adapters/claude-code",
    channels: ["nightly"],
  },
} as const satisfies Record<
  string,
  { directory: string; channels: readonly ReleaseChannel[] }
>;

export type PublicPackageName = keyof typeof PUBLIC_PACKAGES;

/** Third-party packages that are intentionally resolved by a packed artifact. */
export const PUBLIC_RUNTIME_EXTERNALS = [
  "@clack/prompts",
  "@langchain/core",
  "@langchain/openai",
  "@opencode-ai/plugin",
  "@opencode-ai/sdk",
  "agentevals",
  "figlet",
  "mustache",
  "neverthrow",
  "openevals",
  "zod",
] as const;

export interface PublicBuildEntry {
  source: string;
  output: string;
  executable?: boolean;
}

export interface PublicPackageBuild {
  entries: readonly PublicBuildEntry[];
  declarations: readonly PublicDeclarationBuild[];
  bootstrap?: readonly string[];
}

export interface PublicDeclarationBuild {
  config: string;
  output: string;
}

/** Entry points and assets that define each self-contained public runtime. */
export const PUBLIC_PACKAGE_BUILDS = {
  "@weaveio/weave-cli": {
    entries: [
      {
        source: "packages/cli/src/index.ts",
        output: "packages/cli/dist/index.js",
      },
      {
        source: "packages/cli/src/main.ts",
        output: "packages/cli/dist/main.js",
        executable: true,
      },
    ],
    declarations: [
      {
        config: "packages/cli/api-extractor.json",
        output: "packages/cli/dist/index.d.ts",
      },
    ],
    bootstrap: [
      ".claude-plugin/plugin.json",
      "hooks/hooks.json",
      "skills/compose/SKILL.md",
    ],
  },
  "@weaveio/weave-adapter-opencode": {
    entries: [
      {
        source: "packages/adapters/opencode/src/index.ts",
        output: "packages/adapters/opencode/dist/index.js",
      },
      {
        source: "packages/adapters/opencode/src/plugin.ts",
        output: "packages/adapters/opencode/dist/plugin.js",
      },
    ],
    declarations: [
      {
        config: "packages/adapters/opencode/api-extractor.index.json",
        output: "packages/adapters/opencode/dist/index.d.ts",
      },
      {
        config: "packages/adapters/opencode/api-extractor.plugin.json",
        output: "packages/adapters/opencode/dist/plugin.d.ts",
      },
    ],
  },
  "@weaveio/weave-adapter-claude-code": {
    entries: [
      {
        source: "packages/adapters/claude-code/src/index.ts",
        output: "packages/adapters/claude-code/dist/index.js",
      },
    ],
    declarations: [
      {
        config: "packages/adapters/claude-code/api-extractor.json",
        output: "packages/adapters/claude-code/dist/index.d.ts",
      },
    ],
    bootstrap: [
      ".claude-plugin/plugin.json",
      "hooks/hooks.json",
      "skills/compose/SKILL.md",
    ],
  },
} as const satisfies Record<PublicPackageName, PublicPackageBuild>;

/** Fields that may cross from a source workspace manifest into an npm artifact. */
export const PUBLIC_MANIFEST_FIELDS = [
  "name",
  "version",
  "description",
  "main",
  "module",
  "types",
  "bin",
  "exports",
  "files",
  "keywords",
  "license",
  "repository",
  "homepage",
  "bugs",
  "engines",
  "os",
  "cpu",
  "publishConfig",
] as const;

export const RUNTIME_DEPENDENCY_FIELDS = [
  "dependencies",
  "optionalDependencies",
  "peerDependencies",
] as const;

export const ALL_DEPENDENCY_FIELDS = [
  ...RUNTIME_DEPENDENCY_FIELDS,
  "devDependencies",
] as const;
