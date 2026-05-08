/**
 * Represents the scope (origin layer) of a parsed config contribution.
 *
 * Three layers are supported in priority order (lowest → highest):
 * - `"builtin"` — the hard-coded default agents shipped with `@weave/config`
 * - `"global"`  — the user's `~/.weave/config.weave`
 * - `"project"` — the project's `.weave/config.weave`
 *
 * `rootDir` is the absolute path to the directory that contains the `prompts/`
 * sub-directory for this scope, used by `resolvePromptPaths()` to build
 * absolute prompt-file paths.
 */
export type ConfigScope = {
  /** Which layer this config contribution comes from. */
  kind: "builtin" | "global" | "project";

  /**
   * Absolute path to the scope's root directory.
   *
   * - builtin: `packages/config/` (where `prompts/` ships)
   * - global:  `~/.weave/`
   * - project: `<projectRoot>/.weave/`
   */
  rootDir: string;
};
