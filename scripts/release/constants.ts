/** Public npm artifacts and their permitted release channels. */
export const RELEASE_CHANNELS = ["stable", "nightly"] as const;

export type ReleaseChannel = (typeof RELEASE_CHANNELS)[number];

/** Immutable GitHub identity for every release-control invocation. */
export const RELEASE_REPOSITORY = "weave-io/weave" as const;
export const RELEASE_WORKFLOW_PATH = ".github/workflows/publish.yml" as const;

export const RELEASE_EVENTS = ["schedule", "workflow_dispatch"] as const;
export const RELEASE_OPERATIONS = [
  "nightly",
  "stable-cut",
  "stable-fix",
  "stable-publish",
  "stable-finalize",
  "metadata-replay",
] as const;

export const RELEASE_CONTROL_REF = "refs/heads/main" as const;
export const NPM_DIGEST_PREFIX = "sha256:" as const;
export const TRAIN_SCHEMA_VERSION = 1 as const;
export const TRAIN_VALIDITY_DAYS = 7 as const;
export const ACTIONS_ARTIFACT_RETENTION_DAYS = 30 as const;

/** Limits untrusted workflow values before they reach a command or API. */
export const RELEASE_INPUT_LIMITS = {
  packageCount: 4,
  artifactCount: 3,
  artifactBytes: 5 * 1024 * 1024,
  manifestBytes: 64 * 1024,
  identifierLength: 128,
} as const;

export const STABLE_TRAIN_STATES = [
  "prepared",
  "built",
  "bound",
  "published-next",
  "awaiting-promotion",
  "promoted",
  "release-draft",
  "finalized",
  "metadata-pending",
  "blocked",
  "expired",
  "abandoned",
  "partial",
] as const;

/**
 * The complete stable-train lifecycle.  Terminal outcomes deliberately have no
 * escape hatch: recovery always starts from a fresh `main` cut.
 */
export const STABLE_TRAIN_TRANSITIONS = {
  prepared: ["built", "blocked", "abandoned", "expired"],
  built: ["bound", "blocked", "abandoned", "expired"],
  bound: ["published-next", "blocked", "abandoned", "expired"],
  "published-next": ["awaiting-promotion", "partial", "blocked", "expired"],
  "awaiting-promotion": ["promoted", "partial", "blocked", "expired"],
  promoted: ["release-draft", "finalized", "metadata-pending", "blocked"],
  "release-draft": ["finalized", "metadata-pending", "blocked", "abandoned"],
  finalized: ["metadata-pending"],
  "metadata-pending": ["finalized", "blocked"],
  blocked: ["abandoned", "expired"],
  expired: ["abandoned"],
  abandoned: [],
  partial: ["blocked", "abandoned"],
} as const;

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
  "@weaveio/weave-adapter-pi": {
    directory: "packages/adapters/pi",
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
  "@earendil-works/pi-ai",
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-tui",
  "@langchain/core",
  "@langchain/openai",
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
}

export interface PublicPackageBuild {
  entries: readonly PublicBuildEntry[];
  declarations: readonly PublicDeclarationBuild[];
  bootstrap?: readonly string[];
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
  "@weaveio/weave-adapter-pi": {
    runtimeExternals: ["kysely", "pino"],
    entries: [
      {
        source: "packages/adapters/pi/src/index.ts",
        output: "packages/adapters/pi/dist/index.js",
      },
      {
        source: "packages/adapters/pi/src/extension.ts",
        output: "packages/adapters/pi/dist/extension.js",
      },
    ],
    declarations: [
      {
        config: "packages/adapters/pi/api-extractor.index.json",
        output: "packages/adapters/pi/dist/index.d.ts",
      },
      {
        config: "packages/adapters/pi/api-extractor.extension.json",
        output: "packages/adapters/pi/dist/extension.d.ts",
      },
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
