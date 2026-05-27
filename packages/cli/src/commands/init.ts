import { resolve } from "node:path";
import { parseConfig } from "@weave/core";
import { errAsync, ok, type Result, ResultAsync } from "neverthrow";
import type { ParsedArgs } from "../args.js";
import { starterConfig } from "../config/starter-config.js";
import {
  type DetectedHarness,
  detectHarnesses,
  formatDetectionSummary,
  type SupportedHarnessId,
} from "../detect/index.js";
import type { DetectionProbes } from "../detect/probes.js";
import type { CliError } from "../errors.js";
import {
  BunFileSystem,
  describeFileSystemError,
  type FileSystem,
} from "../fs/file-system.js";
import { installerRegistry } from "../installers/index.js";
import type { TerminalIO } from "../io/terminal.js";
import { ClackPromptAdapter, type PromptAdapter } from "../prompt/index.js";
import type { ThemeColors } from "../theme/colors.js";
import { defaultThemeRenderer } from "../theme/render.js";

export interface InitContext {
  terminal: TerminalIO;
  theme: ThemeColors;
  flags: ParsedArgs["flags"];
  fs?: FileSystem;
  prompt?: PromptAdapter;
  probes?: DetectionProbes;
}

type InitScope = "global" | "local";

type InitPlan = {
  scope: InitScope;
  installDir: string;
  selectedHarnesses: SupportedHarnessId[];
  selectedModules: Record<string, string[]>;
  confirmed: boolean;
};

type ScaffoldResult = {
  configPath: string;
  promptsPath: string;
  messages: string[];
};

// ---------------------------------------------------------------------------
// Migration types
// ---------------------------------------------------------------------------

/**
 * Canonical legacy source paths, keyed by scope.
 * These are relative to the scope root (home or cwd).
 */
const LEGACY_SOURCE_RELATIVE: Record<InitScope, string> = {
  global: ".config/opencode/weave-opencode.jsonc",
  local: ".opencode/weave-opencode.jsonc",
};

/**
 * Canonical migration destination directory names, keyed by scope.
 * Migration ALWAYS writes to these paths — --install-dir is ignored.
 */
const CANONICAL_WEAVE_DIR: Record<InitScope, string> = {
  global: ".weave",
  local: ".weave",
};

type MigrationPlan = {
  scope: InitScope;
  sourcePath: string;
  destinationDir: string;
  destinationPath: string;
  /** Number of legacy fields that will be skipped with warnings during conversion. */
  skippedWarningCount: number;
};

// ---------------------------------------------------------------------------

const HARNESS_IDS: SupportedHarnessId[] = ["opencode", "claude-code", "pi"];

export async function runInit(
  ctx: InitContext,
): Promise<Result<number, CliError>> {
  const fs = ctx.fs ?? new BunFileSystem();
  const prompt = ctx.prompt ?? new ClackPromptAdapter();

  // Explicit migrate submode: weave init migrate [--scope ...] [--yes]
  if (ctx.flags.initSubmode === "migrate") {
    return runMigrateMode(ctx, fs, prompt);
  }

  const detected = await detectHarnesses(ctx.probes);
  const harnesses = detected.isOk() ? detected.value : [];
  const planResult = await createPlan({ ctx, fs, prompt, harnesses });

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

  const scaffold = await scaffoldConfig(fs, planResult.plan, ctx.flags.force);
  if (scaffold.isErr()) {
    ctx.terminal.stderr(
      `Failed to initialize Weave config: ${scaffold.error.message}`,
    );
    return ok(1);
  }

  const installExit = await installHarnesses({
    ctx,
    fs,
    plan: planResult.plan,
    harnesses,
  });
  ctx.terminal.stdout(renderInitSummary(ctx.theme, scaffold.value, harnesses));
  return ok(installExit);
}

// ---------------------------------------------------------------------------
// Explicit migrate mode
// ---------------------------------------------------------------------------

async function runMigrateMode(
  ctx: InitContext,
  fs: FileSystem,
  prompt: PromptAdapter,
): Promise<Result<number, CliError>> {
  const scope = ctx.flags.scope ?? "local";
  const migrationPlan = buildMigrationPlan(scope, fs);

  // Check legacy source exists
  const sourceExists = await fs.exists(migrationPlan.sourcePath);
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
        `Expected: ${migrationPlan.sourcePath}`,
        "",
        "Nothing to migrate.",
      ].join("\n"),
    );
    return ok(1);
  }

  // Read legacy source
  const sourceContent = await fs.readText(migrationPlan.sourcePath);
  if (sourceContent.isErr()) {
    ctx.terminal.stderr(
      `Failed to read legacy source: ${describeFileSystemError(sourceContent.error)}`,
    );
    return ok(1);
  }

  // Check destination exists
  const destExists = await fs.exists(migrationPlan.destinationPath);
  if (destExists.isErr()) {
    ctx.terminal.stderr(
      `Failed to check destination: ${describeFileSystemError(destExists.error)}`,
    );
    return ok(1);
  }

  // Show preflight summary
  ctx.terminal.stdout(
    renderMigratePreflight(ctx.theme, migrationPlan, destExists.value),
  );

  // Confirm unless --yes
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

  // Perform migration write
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

  ctx.terminal.stdout(
    renderMigrateSuccess(ctx.theme, migrationPlan, writeResult.value),
  );

  // Continue into normal harness selection and configuration flow
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
    const installExit = await installHarnesses({
      ctx,
      fs,
      plan: initPlan,
      harnesses,
    });
    return ok(installExit);
  }

  // Interactive path: ask for harness selection and confirmation
  const planResult = await continueAfterMigration(
    scope,
    migrationPlan.destinationDir,
    fs,
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

  const installExit = await installHarnesses({
    ctx,
    fs,
    plan: planResult.plan,
    harnesses,
  });
  return ok(installExit);
}

function buildMigrationPlan(
  scope: InitScope,
  fs: FileSystem,
  skippedWarningCount = 0,
): MigrationPlan {
  const scopeRoot = scope === "global" ? fs.home() : fs.cwd();
  const sourcePath = resolve(scopeRoot, LEGACY_SOURCE_RELATIVE[scope]);
  const destinationDir = resolve(scopeRoot, CANONICAL_WEAVE_DIR[scope]);
  const destinationPath = resolve(destinationDir, "config.weave");
  return {
    scope,
    sourcePath,
    destinationDir,
    destinationPath,
    skippedWarningCount,
  };
}

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

function performMigrationWrite(
  fs: FileSystem,
  plan: MigrationPlan,
  _sourceContent: string,
  destExists: boolean,
): ResultAsync<{ backedUp: boolean }, { message: string }> {
  // Generate migrated DSL content with provenance comment
  const migratedContent = buildMigratedContent(plan);

  // Validate generated DSL through the normal parse/validation pipeline
  // before mutating any files. Abort if validation fails — leaves both
  // destination and backup untouched.
  const validationResult = parseConfig(migratedContent);
  if (validationResult.isErr()) {
    const errorSummary = validationResult.error
      .map((e) => ("message" in e ? e.message : JSON.stringify(e)))
      .join("; ");
    return errAsync({
      message: `Generated DSL failed validation: ${errorSummary}`,
    });
  }

  const backup = destExists
    ? fs.copyFile(plan.destinationPath, `${plan.destinationPath}.bak`)
    : ResultAsync.fromSafePromise(Promise.resolve());

  return backup
    .mapErr((error) => ({ message: describeFileSystemError(error) }))
    .andThen(() =>
      fs
        .mkdir(plan.destinationDir)
        .mapErr((error) => ({ message: describeFileSystemError(error) })),
    )
    .andThen(() =>
      fs
        .writeText(plan.destinationPath, migratedContent)
        .mapErr((error) => ({ message: describeFileSystemError(error) })),
    )
    .map(() => ({ backedUp: destExists }));
}

/**
 * Build migrated config.weave content with a provenance comment.
 * In Task 1 scope this produces a minimal valid starter config.
 * Full JSONC-to-DSL conversion is implemented in Task 3/4.
 */
function buildMigratedContent(plan: MigrationPlan): string {
  const provenanceComment = [
    `# Migrated from legacy OpenCode JSONC config`,
    `# Source: ${plan.sourcePath}`,
    `# Scope: ${plan.scope}`,
    `# Generated by: weave init migrate`,
    "",
  ].join("\n");

  return provenanceComment + starterConfig(plan.scope);
}

function renderMigrateSuccess(
  theme: ThemeColors,
  plan: MigrationPlan,
  result: { backedUp: boolean },
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
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Ordinary init — scope-aware legacy source detection
// ---------------------------------------------------------------------------

/**
 * Check whether a legacy weave-opencode.jsonc file exists for the given scope.
 * Returns the source path if found, undefined otherwise.
 */
async function detectLegacySource(
  scope: InitScope,
  fs: FileSystem,
): Promise<string | undefined> {
  const scopeRoot = scope === "global" ? fs.home() : fs.cwd();
  const sourcePath = resolve(scopeRoot, LEGACY_SOURCE_RELATIVE[scope]);
  const exists = await fs.exists(sourcePath);
  if (exists.isErr()) return undefined;
  if (!exists.value) return undefined;
  return sourcePath;
}

// ---------------------------------------------------------------------------
// Ordinary init plan
// ---------------------------------------------------------------------------

async function createPlan(input: {
  ctx: InitContext;
  fs: FileSystem;
  prompt: PromptAdapter;
  harnesses: DetectedHarness[];
}): Promise<
  | { type: "ready"; plan: InitPlan }
  | { type: "cancelled" }
  | { type: "unavailable"; message: string }
> {
  const { ctx, fs, prompt, harnesses } = input;

  // Resolve scope: from flag or interactively
  let scope: InitScope;
  if (ctx.flags.scope !== undefined) {
    scope = ctx.flags.scope;
  } else if (
    ctx.flags.yes ||
    ctx.flags.installDir ||
    ctx.flags.harness ||
    ctx.flags.allHarnesses
  ) {
    // Non-interactive decisive flags without explicit scope — use default
    scope = "local";
  } else {
    // Need interactive scope selection
    if (!prompt.isInteractive()) {
      return {
        type: "unavailable",
        message:
          "Interactive mode is unavailable. Re-run with --yes and --scope global|local.",
      };
    }

    ctx.terminal.stdout(
      defaultThemeRenderer.renderBanner(ctx.theme).join("\n"),
    );
    ctx.terminal.stdout(`Weave CLI v${defaultThemeRenderer.renderVersion()}`);
    ctx.terminal.stdout(
      "Choose global config for shared defaults or local config for this project.",
    );

    const scopeResult = await prompt.select<InitScope>({
      message: "Where should Weave create config?",
      options: [
        {
          value: "global",
          label: "Global ~/.weave",
          hint: "shared across projects",
        },
        {
          value: "local",
          label: "Local ./.weave",
          hint: "this repository only",
        },
      ],
      initialValue: "local",
    });
    if (scopeResult.isErr()) return promptFailure(scopeResult.error.message);
    scope = scopeResult.value;
  }

  // After scope resolution, before harness selection: check for legacy source
  const legacySource = await detectLegacySource(scope, fs);
  if (legacySource !== undefined) {
    // --yes: auto-migrate without prompting
    if (ctx.flags.yes) {
      const migrationPlan = buildMigrationPlan(scope, fs);
      const sourceContent = await fs.readText(legacySource);
      if (sourceContent.isErr()) {
        ctx.terminal.stderr(
          `Failed to read legacy source: ${describeFileSystemError(sourceContent.error)}`,
        );
        return { type: "cancelled" };
      }

      const destExists = await fs.exists(migrationPlan.destinationPath);
      const destExistsValue = destExists.isOk() ? destExists.value : false;

      const writeResult = await performMigrationWrite(
        fs,
        migrationPlan,
        sourceContent.value,
        destExistsValue,
      );
      if (writeResult.isErr()) {
        ctx.terminal.stderr(`Migration failed: ${writeResult.error.message}`);
        return { type: "cancelled" };
      }

      ctx.terminal.stdout(
        renderMigrateSuccess(ctx.theme, migrationPlan, writeResult.value),
      );

      // --yes: non-interactive post-migration — build plan from flags
      return {
        type: "ready",
        plan: {
          scope,
          installDir: migrationPlan.destinationDir,
          selectedHarnesses: resolveSelectedHarnesses(ctx.flags, harnesses),
          selectedModules: { opencode: ["agents"] },
          confirmed: true,
        },
      };
    }

    // Interactive: offer migration
    if (prompt.isInteractive()) {
      const offerMigrate = await prompt.confirm({
        message: `Legacy config found at ${legacySource}. Migrate to .weave DSL now?`,
        initialValue: true,
      });
      if (offerMigrate.isErr())
        return promptFailure(offerMigrate.error.message);

      if (offerMigrate.value) {
        const migrationPlan = buildMigrationPlan(scope, fs);
        const sourceContent = await fs.readText(legacySource);
        if (sourceContent.isErr()) {
          ctx.terminal.stderr(
            `Failed to read legacy source: ${describeFileSystemError(sourceContent.error)}`,
          );
          return { type: "cancelled" };
        }

        const destExists = await fs.exists(migrationPlan.destinationPath);
        const destExistsValue = destExists.isOk() ? destExists.value : false;

        const writeResult = await performMigrationWrite(
          fs,
          migrationPlan,
          sourceContent.value,
          destExistsValue,
        );
        if (writeResult.isErr()) {
          ctx.terminal.stderr(`Migration failed: ${writeResult.error.message}`);
          return { type: "cancelled" };
        }

        ctx.terminal.stdout(
          renderMigrateSuccess(ctx.theme, migrationPlan, writeResult.value),
        );

        // Continue into harness selection with the canonical destination as installDir
        return continueAfterMigration(
          scope,
          migrationPlan.destinationDir,
          fs,
          prompt,
          harnesses,
        );
      }
    }
  }

  // No migration (or migration declined): proceed with normal init
  // If decisive flags are set (other than scope alone), build plan from flags
  const decisiveNonScope = Boolean(
    ctx.flags.yes ||
      ctx.flags.installDir ||
      ctx.flags.harness ||
      ctx.flags.allHarnesses,
  );

  if (decisiveNonScope || ctx.flags.scope !== undefined) {
    return {
      type: "ready",
      plan: buildFlagPlan(ctx.flags, fs, harnesses, scope),
    };
  }

  // Fully interactive path: ask for install dir, harnesses, confirmation
  const defaultDir = defaultInstallDir(scope, fs);
  const installDir = await prompt.text({
    message: "Install directory",
    defaultValue: defaultDir,
    placeholder: defaultDir,
  });
  if (installDir.isErr()) return promptFailure(installDir.error.message);

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
  if (selectedHarnesses.isErr())
    return promptFailure(selectedHarnesses.error.message);

  const confirmed = await prompt.confirm({
    message: `Create ${installDir.value}/config.weave and configure selected harnesses?`,
    initialValue: true,
  });
  if (confirmed.isErr()) return promptFailure(confirmed.error.message);

  return {
    type: "ready",
    plan: {
      scope,
      installDir: fs.resolvePath(installDir.value),
      selectedHarnesses: selectedHarnesses.value,
      selectedModules: { opencode: ["agents"] },
      confirmed: confirmed.value,
    },
  };
}

/**
 * After a successful migration write in ordinary init, continue into
 * harness selection using the canonical destination directory.
 */
async function continueAfterMigration(
  scope: InitScope,
  installDir: string,
  fs: FileSystem,
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
  if (selectedHarnesses.isErr())
    return promptFailure(selectedHarnesses.error.message);

  const confirmed = await prompt.confirm({
    message: `Configure selected harnesses with migrated config at ${installDir}?`,
    initialValue: true,
  });
  if (confirmed.isErr()) return promptFailure(confirmed.error.message);

  return {
    type: "ready",
    plan: {
      scope,
      installDir: fs.resolvePath(installDir),
      selectedHarnesses: selectedHarnesses.value,
      selectedModules: { opencode: ["agents"] },
      confirmed: confirmed.value,
    },
  };
}

function promptFailure(
  message: string,
): { type: "cancelled" } | { type: "unavailable"; message: string } {
  if (message.includes("unavailable")) return { type: "unavailable", message };
  return { type: "cancelled" };
}

function buildFlagPlan(
  flags: ParsedArgs["flags"],
  fs: FileSystem,
  harnesses: DetectedHarness[],
  resolvedScope?: InitScope,
): InitPlan {
  const scope = resolvedScope ?? flags.scope ?? "local";
  const selectedHarnesses = resolveSelectedHarnesses(flags, harnesses);
  return {
    scope,
    installDir: fs.resolvePath(
      flags.installDir ?? defaultInstallDir(scope, fs),
    ),
    selectedHarnesses,
    selectedModules: { opencode: ["agents"] },
    confirmed:
      flags.yes ||
      flags.scope !== undefined ||
      flags.installDir !== undefined ||
      flags.harness !== undefined ||
      flags.allHarnesses,
  };
}

function resolveSelectedHarnesses(
  flags: ParsedArgs["flags"],
  harnesses: DetectedHarness[],
): SupportedHarnessId[] {
  if (flags.harness !== undefined && isHarnessId(flags.harness))
    return [flags.harness];
  if (flags.allHarnesses) return harnesses.map((harness) => harness.id);
  return [];
}

function isHarnessId(value: string): value is SupportedHarnessId {
  return HARNESS_IDS.includes(value as SupportedHarnessId);
}

function defaultInstallDir(scope: InitScope, fs: FileSystem): string {
  if (scope === "global") return resolve(fs.home(), ".weave");
  return resolve(fs.cwd(), ".weave");
}

function scaffoldConfig(
  fs: FileSystem,
  plan: InitPlan,
  force: boolean,
): ResultAsync<ScaffoldResult, { message: string }> {
  const configPath = resolve(plan.installDir, "config.weave");
  const promptsPath = resolve(plan.installDir, "prompts");

  return fs
    .exists(configPath)
    .mapErr((error) => ({ message: describeFileSystemError(error) }))
    .andThen((exists) => {
      const messages: string[] = [];
      if (exists && !force) {
        messages.push(`Skipped existing config: ${configPath}`);
        return fs
          .mkdir(promptsPath)
          .mapErr((error) => ({ message: describeFileSystemError(error) }))
          .map(() => ({
            configPath,
            promptsPath,
            messages,
          }));
      }

      const backup = exists
        ? fs.copyFile(configPath, `${configPath}.bak`)
        : ResultAsync.fromSafePromise(Promise.resolve());
      return backup
        .mapErr((error) => ({ message: describeFileSystemError(error) }))
        .andThen(() =>
          fs
            .writeText(configPath, starterConfig(plan.scope))
            .mapErr((error) => ({ message: describeFileSystemError(error) })),
        )
        .andThen(() =>
          fs
            .mkdir(promptsPath)
            .mapErr((error) => ({ message: describeFileSystemError(error) })),
        )
        .map(() => {
          if (exists)
            messages.push(`Backed up existing config: ${configPath}.bak`);
          messages.push(`Created config: ${configPath}`);
          messages.push(`Created prompts directory: ${promptsPath}`);
          return { configPath, promptsPath, messages };
        });
    });
}

async function installHarnesses(input: {
  ctx: InitContext;
  fs: FileSystem;
  plan: InitPlan;
  harnesses: DetectedHarness[];
}): Promise<number> {
  const { ctx, fs, plan, harnesses } = input;
  if (plan.selectedHarnesses.length === 0) return 0;

  const registry = installerRegistry(fs);
  let exitCode = 0;

  for (const harnessId of plan.selectedHarnesses) {
    const installer = registry[harnessId];
    const detected = harnesses.find((harness) => harness.id === harnessId);
    if (detected === undefined) {
      ctx.terminal.stderr(`${harnessId} was requested but was not detected.`);
      exitCode = 1;
      continue;
    }
    if (!installer.supported) {
      const message = `${harnessId} installer support is not available yet.`;
      if (ctx.flags.allHarnesses && ctx.flags.harness === undefined) {
        ctx.terminal.stdout(`Skipped ${harnessId}: ${message}`);
        continue;
      }
      ctx.terminal.stderr(message);
      exitCode = 1;
      continue;
    }

    const result = await installer.install({
      harness: harnessId,
      configPath: detected.configPath,
      selectedModules: plan.selectedModules[harnessId] ?? [],
      force: ctx.flags.force,
    });
    if (result.isErr()) {
      ctx.terminal.stderr(formatInstallError(result.error));
      exitCode = 1;
      continue;
    }
    ctx.terminal.stdout(result.value.messages.join("\n"));
  }

  return exitCode;
}

function formatInstallError(error: {
  type: string;
  message?: string;
  path?: string;
  cause?: unknown;
}): string {
  if (error.message !== undefined) return error.message;
  if (error.path !== undefined) return `Install failed at ${error.path}`;
  return "Install failed.";
}

function renderInitSummary(
  theme: ThemeColors,
  scaffold: ScaffoldResult,
  harnesses: DetectedHarness[],
): string {
  return [
    theme.boldCyan("Weave init complete"),
    ...scaffold.messages,
    "",
    "Detected harnesses:",
    ...formatDetectionSummary(harnesses).map((line) => `- ${line}`),
    "",
    "Next steps:",
    `- Edit ${scaffold.configPath}`,
    "- Run weave validate --project or weave validate --global",
  ].join("\n");
}
