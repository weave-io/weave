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
 * Result of best-effort JSONC-to-DSL conversion.
 * `dsl` contains the converted DSL lines (without provenance comment).
 * `warnings` lists every skipped field with an explicit reason.
 */
export type ConversionResult = {
  dsl: string;
  warnings: ConversionWarning[];
};
