import { resolve } from "node:path";
import { ok, type Result, ResultAsync } from "neverthrow";
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
import {
  buildMigrationPlan,
  detectLegacySource,
} from "../migration/migration-plan.js";
import { performMigrationWrite } from "../migration/migration-write.js";
import { ClackPromptAdapter, type PromptAdapter } from "../prompt/index.js";
import type { ThemeColors } from "../theme/colors.js";
import { defaultThemeRenderer } from "../theme/render.js";
import {
  renderMigrateSuccess,
  resolveSelectedHarnesses,
  runMigrateMode,
} from "./migrate.js";

// ---------------------------------------------------------------------------
// Re-exports for backward compatibility
// ---------------------------------------------------------------------------

export { convertLegacyJsonc } from "../migration/legacy-jsonc-converter.js";
export { writeMigratedDsl } from "../migration/migration-write.js";
export type {
  ConversionResult,
  ConversionWarning,
  MigrationPlan,
} from "../migration/types.js";

// ---------------------------------------------------------------------------
// Context and plan types
// ---------------------------------------------------------------------------

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
// Entry point
// ---------------------------------------------------------------------------

export async function runInit(
  ctx: InitContext,
): Promise<Result<number, CliError>> {
  const fs = ctx.fs ?? new BunFileSystem();
  const prompt = ctx.prompt ?? new ClackPromptAdapter();

  // Explicit migrate submode: weave init migrate [--scope ...] [--yes]
  if (ctx.flags.initSubmode === "migrate") {
    return runMigrateMode({ ...ctx, fs, prompt }, (plan, harnesses) =>
      installHarnesses({ ctx, fs, plan, harnesses }),
    );
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
// Ordinary init — scope-aware legacy source detection and plan creation
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
    scope = "local";
  } else {
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

  // After scope resolution: check for legacy source
  const legacySourceResult = await detectLegacySource(scope, fs);
  if (legacySourceResult.isErr()) {
    ctx.terminal.stderr(legacySourceResult.error.message);
    return { type: "cancelled" };
  }
  const legacySourcePath = legacySourceResult.value;
  if (legacySourcePath !== undefined) {
    // --yes: auto-migrate without prompting
    if (ctx.flags.yes) {
      const migrationPlan = buildMigrationPlan(scope, fs);
      const sourceContent = await fs.readText(legacySourcePath);
      if (sourceContent.isErr()) {
        ctx.terminal.stderr(
          `Failed to read legacy source: ${describeFileSystemError(sourceContent.error)}`,
        );
        return { type: "cancelled" };
      }

      const destExists = await fs.exists(migrationPlan.destinationPath);
      if (destExists.isErr()) {
        ctx.terminal.stderr(
          `Failed to check destination: ${describeFileSystemError(destExists.error)}`,
        );
        return { type: "cancelled" };
      }

      const writeResult = await performMigrationWrite(
        fs,
        migrationPlan,
        sourceContent.value,
        destExists.value,
      );
      if (writeResult.isErr()) {
        ctx.terminal.stderr(`Migration failed: ${writeResult.error.message}`);
        return { type: "cancelled" };
      }

      ctx.terminal.stdout(
        renderMigrateSuccess(ctx.theme, migrationPlan, writeResult.value),
      );

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
        message: `Legacy config found at ${legacySourcePath}. Migrate to .weave DSL now?`,
        initialValue: true,
      });
      if (offerMigrate.isErr())
        return promptFailure(offerMigrate.error.message);

      if (offerMigrate.value) {
        const migrationPlan = buildMigrationPlan(scope, fs);
        const sourceContent = await fs.readText(legacySourcePath);
        if (sourceContent.isErr()) {
          ctx.terminal.stderr(
            `Failed to read legacy source: ${describeFileSystemError(sourceContent.error)}`,
          );
          return { type: "cancelled" };
        }

        const destExists = await fs.exists(migrationPlan.destinationPath);
        if (destExists.isErr()) {
          ctx.terminal.stderr(
            `Failed to check destination: ${describeFileSystemError(destExists.error)}`,
          );
          return { type: "cancelled" };
        }

        const writeResult = await performMigrationWrite(
          fs,
          migrationPlan,
          sourceContent.value,
          destExists.value,
        );
        if (writeResult.isErr()) {
          ctx.terminal.stderr(`Migration failed: ${writeResult.error.message}`);
          return { type: "cancelled" };
        }

        ctx.terminal.stdout(
          renderMigrateSuccess(ctx.theme, migrationPlan, writeResult.value),
        );

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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function defaultInstallDir(scope: InitScope, fs: FileSystem): string {
  if (scope === "global") return resolve(fs.home(), ".weave");
  return resolve(fs.cwd(), ".weave");
}

// ---------------------------------------------------------------------------
// Scaffold
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Harness installation
// ---------------------------------------------------------------------------

export async function installHarnesses(input: {
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

// ---------------------------------------------------------------------------
// Summary rendering
// ---------------------------------------------------------------------------

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
