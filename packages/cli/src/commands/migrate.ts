/**
 * weave init migrate — migrate legacy OpenCode JSONC config to .weave DSL.
 *
 * This module owns the `weave init migrate` orchestration flow:
 * preflight display, confirmation prompt, write, success rendering,
 * and optional post-migration harness selection.
 *
 * It delegates to:
 * - `migration/migration-plan.ts` for path resolution
 * - `migration/migration-write.ts` for the validated write sequence
 * - `migration/conversion-warnings.ts` for warning rendering
 * - `migration/legacy-jsonc-converter.ts` for pre-conversion warning count
 */

import { ok, type Result } from "neverthrow";
import type { ParsedArgs } from "../args.js";
import {
  type DetectedHarness,
  detectHarnesses,
  type SupportedHarnessId,
} from "../detect/index.js";
import type { DetectionProbes } from "../detect/probes.js";
import type { CliError } from "../errors.js";
import { describeFileSystemError, type FileSystem } from "../fs/file-system.js";
import type { TerminalIO } from "../io/terminal.js";
import { renderConversionWarnings } from "../migration/conversion-warnings.js";
import { convertLegacyJsonc } from "../migration/legacy-jsonc-converter.js";
import { buildMigrationPlan } from "../migration/migration-plan.js";
import { performMigrationWrite } from "../migration/migration-write.js";
import type { ConversionWarning, MigrationPlan } from "../migration/types.js";
import type { PromptAdapter } from "../prompt/index.js";
import type { ThemeColors } from "../theme/colors.js";

// ---------------------------------------------------------------------------
// Context type
// ---------------------------------------------------------------------------

export interface MigrateContext {
  terminal: TerminalIO;
  theme: ThemeColors;
  flags: ParsedArgs["flags"];
  fs: FileSystem;
  prompt: PromptAdapter;
  probes?: DetectionProbes;
}

// ---------------------------------------------------------------------------
// Internal plan type (mirrors InitPlan in init.ts)
// ---------------------------------------------------------------------------

type InitScope = "global" | "local";

type InitPlan = {
  scope: InitScope;
  installDir: string;
  selectedHarnesses: SupportedHarnessId[];
  selectedModules: Record<string, string[]>;
  confirmed: boolean;
};

// ---------------------------------------------------------------------------
// Preflight rendering
// ---------------------------------------------------------------------------

function renderMigratePreflight(
  theme: ThemeColors,
  plan: MigrationPlan,
  destExists: boolean,
): string {
  const overwriteLine = destExists
    ? theme.boldYellow(
        "yes — backup will be created at " + plan.destinationPath + ".bak",
      )
    : "no (destination does not exist)";
  const warningLine =
    plan.skippedWarningCount > 0
      ? theme.boldYellow(
          `${plan.skippedWarningCount} field(s) will be skipped with warnings`,
        )
      : "none";
  const lines = [
    "",
    theme.boldCyan("Migration preflight"),
    "",
    `  Source:        ${plan.sourcePath}`,
    `  Destination:   ${plan.destinationPath}`,
    `  Scope:         ${plan.scope}`,
    `  Overwrite:     ${overwriteLine}`,
    `  Skipped fields: ${warningLine}`,
    "",
  ];
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Success rendering
// ---------------------------------------------------------------------------

function renderMigrateSuccess(
  theme: ThemeColors,
  plan: MigrationPlan,
  result: { backedUp: boolean; warnings?: ConversionWarning[] },
): string {
  const lines = [
    theme.boldCyan("Migration complete"),
    `  Written: ${plan.destinationPath}`,
  ];
  if (result.backedUp) {
    lines.push(`  Backup:  ${plan.destinationPath}.bak`);
  }
  lines.push(`  Source preserved: ${plan.sourcePath}`);
  lines.push("");
  lines.push("Next steps:");
  lines.push(`  - Review ${plan.destinationPath}`);
  lines.push("  - Run weave validate --project or weave validate --global");
  if (result.warnings !== undefined && result.warnings.length > 0) {
    lines.push(renderConversionWarnings(result.warnings));
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Post-migration harness selection helpers
// ---------------------------------------------------------------------------

function resolveSelectedHarnesses(
  flags: ParsedArgs["flags"],
  harnesses: DetectedHarness[],
): SupportedHarnessId[] {
  const HARNESS_IDS: SupportedHarnessId[] = ["opencode", "claude-code", "pi"];
  if (
    flags.harness !== undefined &&
    HARNESS_IDS.includes(flags.harness as SupportedHarnessId)
  ) {
    return [flags.harness as SupportedHarnessId];
  }
  if (flags.allHarnesses) return harnesses.map((h) => h.id);
  return [];
}

async function continueAfterMigration(
  scope: InitScope,
  installDir: string,
  prompt: PromptAdapter,
  harnesses: DetectedHarness[],
): Promise<
  | { type: "ready"; plan: InitPlan }
  | { type: "cancelled" }
  | { type: "unavailable"; message: string }
> {
  const harnessOptions = harnesses.map((harness) => ({
    value: harness.id,
    label: harness.id,
    hint: harness.version,
  }));
  const selectedHarnesses = await prompt.multiselect<SupportedHarnessId>({
    message: "Select harnesses to configure",
    options: harnessOptions,
    initialValues: harnessOptions.map((option) => option.value),
    required: false,
  });
  if (selectedHarnesses.isErr()) {
    const msg = selectedHarnesses.error.message;
    if (msg.includes("unavailable"))
      return { type: "unavailable", message: msg };
    return { type: "cancelled" };
  }

  const confirmed = await prompt.confirm({
    message: `Configure selected harnesses with migrated config at ${installDir}?`,
    initialValue: true,
  });
  if (confirmed.isErr()) {
    const msg = confirmed.error.message;
    if (msg.includes("unavailable"))
      return { type: "unavailable", message: msg };
    return { type: "cancelled" };
  }

  return {
    type: "ready",
    plan: {
      scope,
      installDir,
      selectedHarnesses: selectedHarnesses.value,
      selectedModules: { opencode: ["agents"] },
      confirmed: confirmed.value,
    },
  };
}

// ---------------------------------------------------------------------------
// Main migrate orchestration
// ---------------------------------------------------------------------------

/**
 * Run the `weave init migrate` flow.
 *
 * The `installHarnesses` callback receives the resolved InitPlan and the
 * detected harnesses list, and returns an exit code.
 *
 * Sequence:
 *   1. Build preliminary plan to get paths for existence checks.
 *   2. Check legacy source exists — abort if not.
 *   3. Read legacy source content.
 *   4. Pre-convert to compute accurate skippedWarningCount for preflight.
 *   5. Check destination exists.
 *   6. Show preflight summary.
 *   7. Confirm unless --yes.
 *   8. Perform migration write (convert + validate + write).
 *   9. Show success output.
 *  10. Continue into optional harness selection.
 */
export async function runMigrateMode(
  ctx: MigrateContext,
  installHarnesses: (
    plan: InitPlan,
    harnesses: DetectedHarness[],
  ) => Promise<number>,
): Promise<Result<number, CliError>> {
  const { fs, prompt } = ctx;
  const scope = ctx.flags.scope ?? "local";

  // Step 1: Build preliminary plan (skippedWarningCount=0) for path resolution
  const preliminaryPlan = buildMigrationPlan(scope, fs);

  // Step 2: Check legacy source exists
  const sourceExists = await fs.exists(preliminaryPlan.sourcePath);
  if (sourceExists.isErr()) {
    ctx.terminal.stderr(
      `Failed to check legacy source: ${describeFileSystemError(sourceExists.error)}`,
    );
    return ok(1);
  }

  if (!sourceExists.value) {
    ctx.terminal.stderr(
      [
        `No legacy config found for scope "${scope}".`,
        `Expected: ${preliminaryPlan.sourcePath}`,
        "",
        "Nothing to migrate.",
      ].join("\n"),
    );
    return ok(1);
  }

  // Step 3: Read legacy source
  const sourceContent = await fs.readText(preliminaryPlan.sourcePath);
  if (sourceContent.isErr()) {
    ctx.terminal.stderr(
      `Failed to read legacy source: ${describeFileSystemError(sourceContent.error)}`,
    );
    return ok(1);
  }

  // Step 4: Pre-convert to compute accurate skippedWarningCount
  const preConversion = convertLegacyJsonc(sourceContent.value);
  const migrationPlan = buildMigrationPlan(
    scope,
    fs,
    preConversion.warnings.length,
  );

  // Step 5: Check destination exists
  const destExists = await fs.exists(migrationPlan.destinationPath);
  if (destExists.isErr()) {
    ctx.terminal.stderr(
      `Failed to check destination: ${describeFileSystemError(destExists.error)}`,
    );
    return ok(1);
  }

  // Step 6: Show preflight summary
  ctx.terminal.stdout(
    renderMigratePreflight(ctx.theme, migrationPlan, destExists.value),
  );

  // Step 7: Confirm unless --yes
  if (!ctx.flags.yes) {
    if (!prompt.isInteractive()) {
      ctx.terminal.stderr(
        "Interactive mode is unavailable. Re-run with --yes to proceed non-interactively.",
      );
      return ok(1);
    }

    const confirmed = await prompt.confirm({
      message: destExists.value
        ? `Overwrite ${migrationPlan.destinationPath} (backup will be created)?`
        : `Write migrated config to ${migrationPlan.destinationPath}?`,
      initialValue: true,
    });
    if (confirmed.isErr()) {
      ctx.terminal.stdout("Migration cancelled.");
      return ok(0);
    }
    if (!confirmed.value) {
      ctx.terminal.stdout("Migration cancelled.");
      return ok(0);
    }
  }

  // Step 8: Perform migration write
  const writeResult = await performMigrationWrite(
    fs,
    migrationPlan,
    sourceContent.value,
    destExists.value,
  );
  if (writeResult.isErr()) {
    ctx.terminal.stderr(`Migration failed: ${writeResult.error.message}`);
    return ok(1);
  }

  // Step 9: Show success output
  ctx.terminal.stdout(
    renderMigrateSuccess(ctx.theme, migrationPlan, writeResult.value),
  );

  // Step 10: Continue into harness selection
  const detected = await detectHarnesses(ctx.probes);
  const harnesses = detected.isOk() ? detected.value : [];

  // Non-interactive path: build plan from flags and install
  if (ctx.flags.yes || !prompt.isInteractive()) {
    const initPlan: InitPlan = {
      scope,
      installDir: migrationPlan.destinationDir,
      selectedHarnesses: resolveSelectedHarnesses(ctx.flags, harnesses),
      selectedModules: { opencode: ["agents"] },
      confirmed: true,
    };
    const installExit = await installHarnesses(initPlan, harnesses);
    return ok(installExit);
  }

  // Interactive path: ask for harness selection and confirmation
  const planResult = await continueAfterMigration(
    scope,
    migrationPlan.destinationDir,
    prompt,
    harnesses,
  );

  if (planResult.type === "cancelled") {
    ctx.terminal.stdout("Setup cancelled.");
    return ok(0);
  }

  if (planResult.type === "unavailable") {
    ctx.terminal.stderr(planResult.message);
    return ok(1);
  }

  if (!planResult.plan.confirmed) {
    ctx.terminal.stdout("No changes made.");
    return ok(0);
  }

  const installExit = await installHarnesses(planResult.plan, harnesses);
  return ok(installExit);
}
