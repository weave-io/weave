/**
 * Shared types for the CLI migration subsystem.
 *
 * These types are used across migration planning, JSONC conversion,
 * warning rendering, and write orchestration.
 */

export type MigrationScope = "global" | "local";

/**
 * A fully resolved migration plan: source, destination, and preflight metadata.
 */
export type MigrationPlan = {
  scope: MigrationScope;
  sourcePath: string;
  destinationDir: string;
  destinationPath: string;
  /** Number of legacy fields that will be skipped with warnings during conversion. */
  skippedWarningCount: number;
};

/**
 * A single conversion warning: a legacy field that was skipped with a reason.
 */
export type ConversionWarning = {
  field: string;
  reason: string;
};

/**
 * A legacy prompt file carried over into the destination `prompts/` directory.
 * `path` is relative to that directory and is the value the generated DSL
 * references through `prompt_file`.
 */
export type MigratedPromptFile = {
  path: string;
  content: string;
};

/**
 * Result of best-effort JSONC-to-DSL conversion.
 * `dsl` contains the converted DSL lines (without provenance comment).
 * `warnings` lists every skipped field with an explicit reason.
 * `promptFiles` lists legacy prompt files the DSL now references.
 */
export type ConversionResult = {
  dsl: string;
  warnings: ConversionWarning[];
  promptFiles?: MigratedPromptFile[];
};

/**
 * The legacy source could not be converted at all, so callers must write
 * nothing. `warnings` explains why.
 * - `SourceUnreadable`: parse failure, oversized input, unsafe structure, or
 *   a non-object root.
 * - `ConvertedDslInvalid`: the combined converted DSL failed validation.
 */
export type LegacyConversionError = {
  type: "SourceUnreadable" | "ConvertedDslInvalid";
  warnings: ConversionWarning[];
};

/**
 * Contents of legacy `prompt_file` references, keyed by the exact value
 * written in the legacy config. Missing entries mean the file could not be read.
 */
export type LegacyPromptFileContents = ReadonlyMap<string, string>;
