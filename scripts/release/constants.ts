/**
 * Every release channel a public artifact may reach. `stable` carries the npm
 * `latest` tag; `next` and `nightly` are prerelease channels. The catalog is
 * uniform: each public package releases on all three.
 */
export const RELEASE_CHANNELS = ["stable", "next", "nightly"] as const;

export type ReleaseChannel = (typeof RELEASE_CHANNELS)[number];

/** Immutable GitHub identity for every release-control invocation. */
export const RELEASE_REPOSITORY = "weave-io/weave" as const;

/** Creates the single stable release PR; never regenerates one. */
export const RELEASE_STABLE_PREPARE_WORKFLOW_PATH =
  ".github/workflows/release-stable-prepare.yml" as const;
/** Regenerates the open stable release PR when `main` advances; never creates. */
export const RELEASE_STABLE_REGENERATE_WORKFLOW_PATH =
  ".github/workflows/release-stable-regenerate.yml" as const;
/**
 * The one workflow identity npm trusted publishing points at. Every `npm
 * publish` for every channel runs here, because npm permits exactly one
 * trusted-publisher configuration per package.
 */
export const RELEASE_PUBLISH_WORKFLOW_PATH =
  ".github/workflows/release-publish.yml" as const;
/**
 * Independent, non-reusable artifact attestation. Deliberately absent from
 * every npm trust record so its OIDC identity can never publish.
 */
export const RELEASE_ATTEST_WORKFLOW_PATH =
  ".github/workflows/release-attest.yml" as const;

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
  "@weaveio/weave-adapter-claude-code": {
    directory: "packages/adapters/claude-code",
    channels: RELEASE_CHANNELS,
  },
  "@weaveio/weave-adapter-pi": {
    directory: "packages/adapters/pi",
    channels: RELEASE_CHANNELS,
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
  /** Type-strip without bundling so Bun does not inject unused runtime helpers. */
  transpileOnly?: boolean;
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
        source: "packages/adapters/pi/src/cli.ts",
        output: "packages/adapters/pi/dist/cli.js",
      },
      {
        source: "packages/adapters/pi/src/host-module-loader.ts",
        output: "packages/adapters/pi/dist/host-module-loader.js",
      },
      {
        source: "packages/adapters/pi/src/extension.ts",
        output: "packages/adapters/pi/dist/extension.js",
        transpileOnly: true,
      },
      {
        source: "packages/adapters/pi/src/extension-impl.ts",
        output: "packages/adapters/pi/dist/extension-impl.js",
      },
    ],
    declarations: [
      {
        config: "packages/adapters/pi/api-extractor.index.json",
        output: "packages/adapters/pi/dist/index.d.ts",
      },
      {
        config: "packages/adapters/pi/api-extractor.cli.json",
        output: "packages/adapters/pi/dist/cli.d.ts",
      },
      {
        config: "packages/adapters/pi/api-extractor.extension.json",
        output: "packages/adapters/pi/dist/extension.d.ts",
      },
      {
        config: "packages/adapters/pi/api-extractor.extension-impl.json",
        output: "packages/adapters/pi/dist/extension-impl.d.ts",
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

// ---------------------------------------------------------------------------
// Deprecated stable-train constants.
//
// These exist only so the not-yet-removed stable-train and metadata-replay
// modules keep compiling. They are deleted with their consumers in a single
// commit. No new code may read them.
// ---------------------------------------------------------------------------

/** @deprecated Old publish workflow. Use the per-workflow paths above. */
export const RELEASE_WORKFLOW_PATH = ".github/workflows/publish.yml" as const;

/** @deprecated Stable-train operation names. The new pipeline routes by channel. */
export const RELEASE_OPERATIONS = [
  "nightly",
  "stable-cut",
  "stable-fix",
  "stable-publish",
  "stable-finalize",
  "metadata-replay",
] as const;

/** @deprecated Stable-train record schema version. */
export const TRAIN_SCHEMA_VERSION = 1 as const;

/** @deprecated Stable-train record lifetime. */
export const TRAIN_VALIDITY_DAYS = 7 as const;

/** @deprecated Stable-train lifecycle states. */
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

/** @deprecated Stable-train lifecycle transitions. */
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
