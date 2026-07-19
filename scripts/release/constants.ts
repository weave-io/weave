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
