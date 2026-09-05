/**
 * Every release channel a public artifact may reach. `stable` carries the npm
 * `latest` tag; `next` and `nightly` are prerelease channels. The catalog is
 * uniform: each public package releases on all three.
 */
export const RELEASE_CHANNELS = ["stable", "next", "nightly"] as const;

export type ReleaseChannel = (typeof RELEASE_CHANNELS)[number];

/** Immutable GitHub identity for every release-control invocation. */
export const RELEASE_REPOSITORY = "weave-io/weave" as const;

/**
 * The only release branch. Its atomic creation is the exclusivity lock for the
 * single open stable release PR, and it dies with that PR.
 */
export const RELEASE_PR_MARKER_REF = "release-pr/stable" as const;

export const RELEASE_EVENTS = ["schedule", "workflow_dispatch"] as const;

export const RELEASE_CONTROL_REF = "refs/heads/main" as const;
export const NPM_DIGEST_PREFIX = "sha256:" as const;
export const ACTIONS_ARTIFACT_RETENTION_DAYS = 30 as const;

/** Limits untrusted workflow values before they reach a command or API. */
export const RELEASE_INPUT_LIMITS = {
  packageCount: 4,
  artifactCount: 3,
  artifactBytes: 5 * 1024 * 1024,
  manifestBytes: 64 * 1024,
  identifierLength: 128,
} as const;

/** Private workspaces whose source is bundled into public artifacts. */
export const PRIVATE_PACKAGE_NAMES = [
  "@weaveio/weave-core",
  "@weaveio/weave-config",
  "@weaveio/weave-engine",
] as const;

export type PrivatePackageName = (typeof PRIVATE_PACKAGE_NAMES)[number];

/**
 * Every workspace that must never reach npm: the repository root, the bundled
 * private layers, and the documentation site.
 */
export const PRIVATE_WORKSPACE_NAMES = [
  "@weaveio/weave",
  ...PRIVATE_PACKAGE_NAMES,
  "@weaveio/weave-docs",
] as const;

export type PrivateWorkspaceName = (typeof PRIVATE_WORKSPACE_NAMES)[number];

/**
 * The canonical release catalog: exactly four public packages, each releasing
 * on every channel. Adding a fifth package is a deliberate catalog change, not
 * a configuration detail.
 *
 * Note: @weaveio/weave-adapter-pi is developed and released separately from a
 * private repository. It is not part of this public release catalog.
 */
export const PUBLIC_PACKAGES = {
  "@weaveio/weave-cli": {
    directory: "packages/cli",
    channels: RELEASE_CHANNELS,
  },
  "@weaveio/weave-adapter-opencode": {
    directory: "packages/adapters/opencode",
    channels: RELEASE_CHANNELS,
  },
  "@weaveio/weave-adapter-opencode2": {
    directory: "packages/adapters/opencode2",
    channels: RELEASE_CHANNELS,
  },
  "@weaveio/weave-adapter-claude-code": {
    directory: "packages/adapters/claude-code",
    channels: RELEASE_CHANNELS,
  },
} as const satisfies Record<
  string,
  { directory: string; channels: readonly ReleaseChannel[] }
>;

export type PublicPackageName = keyof typeof PUBLIC_PACKAGES;

/** The publishable catalog in its canonical declaration order. */
export const PUBLIC_PACKAGE_NAMES = [
  "@weaveio/weave-cli",
  "@weaveio/weave-adapter-opencode",
  "@weaveio/weave-adapter-opencode2",
  "@weaveio/weave-adapter-claude-code",
] as const satisfies readonly PublicPackageName[];

/** Third-party packages that are intentionally resolved by a packed artifact. */
export const PUBLIC_RUNTIME_EXTERNALS = [
  "@clack/prompts",
  "@earendil-works/pi-ai",
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-tui",
  "@langchain/core",
  "@langchain/openai",
  "@opencode-ai/client",
  "@opencode-ai/plugin",
  "@opencode-ai/sdk",
  "agentevals",
  "figlet",
  "mustache",
  "neverthrow",
  "openevals",
  "typebox",
  "zod",
] as const;

export interface PublicBuildEntry {
  source: string;
  output: string;
  executable?: boolean;
  /** Type-strip without bundling so Bun does not inject unused runtime helpers. */
  transpileOnly?: boolean;
}

export interface PublicPackageBuild {
  entries: readonly PublicBuildEntry[];
  declarations: readonly PublicDeclarationBuild[];
  bootstrap?: readonly string[];
  /** Extra package-relative files copied into the packed artifact as-is. */
  extraFiles?: readonly string[];
  runtimeExternals?: readonly string[];
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
  "@weaveio/weave-adapter-opencode2": {
    entries: [
      {
        source: "packages/adapters/opencode2/src/index.ts",
        output: "packages/adapters/opencode2/dist/index.js",
      },
      {
        source: "packages/adapters/opencode2/src/server.ts",
        output: "packages/adapters/opencode2/dist/server.js",
      },
    ],
    declarations: [
      {
        config: "packages/adapters/opencode2/api-extractor.index.json",
        output: "packages/adapters/opencode2/dist/index.d.ts",
      },
      {
        config: "packages/adapters/opencode2/api-extractor.server.json",
        output: "packages/adapters/opencode2/dist/server.d.ts",
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
  "pi",
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

/** Hard upper bounds for a public artifact before it is ever extracted. */
export const PACKAGE_ARCHIVE_LIMITS = {
  compressedBytes: 5 * 1024 * 1024,
  unpackedBytes: 25 * 1024 * 1024,
  entries: 128,
  compressionRatio: 100,
  manifestBytes: 64 * 1024,
} as const;
