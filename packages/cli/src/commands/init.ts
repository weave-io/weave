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
import { BunFileSystem, type FileSystem } from "../fs/file-system.js";
import { installerRegistry } from "../installers/index.js";
import type { TerminalIO } from "../io/terminal.js";
import { ClackPromptAdapter, type PromptAdapter } from "../prompt/index.js";
import type { ThemeColors } from "../theme/colors.js";
import { renderBanner, renderVersion } from "../theme/render.js";

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

const HARNESS_IDS: SupportedHarnessId[] = ["opencode", "claude-code", "pi"];

export async function runInit(
  ctx: InitContext,
): Promise<Result<number, CliError>> {
  const fs = ctx.fs ?? new BunFileSystem();
  const prompt = ctx.prompt ?? new ClackPromptAdapter();
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
  const decisive = Boolean(
    ctx.flags.yes ||
      ctx.flags.scope ||
      ctx.flags.installDir ||
      ctx.flags.harness ||
      ctx.flags.allHarnesses,
  );

  if (decisive) {
    return {
      type: "ready",
      plan: buildFlagPlan(ctx.flags, fs, harnesses),
    };
  }

  if (!prompt.isInteractive()) {
    return {
      type: "unavailable",
      message:
        "Interactive mode is unavailable. Re-run with --yes and --scope global|local.",
    };
  }

  ctx.terminal.stdout(renderBanner(ctx.theme).join("\n"));
  ctx.terminal.stdout(`Weave CLI v${renderVersion()}`);
  ctx.terminal.stdout(
    "Choose global config for shared defaults or local config for this project.",
  );

  const scope = await prompt.select<InitScope>({
    message: "Where should Weave create config?",
    options: [
      {
        value: "global",
        label: "Global ~/.weave",
        hint: "shared across projects",
      },
      { value: "local", label: "Local ./.weave", hint: "this repository only" },
    ],
    initialValue: "local",
  });
  if (scope.isErr()) return promptFailure(scope.error.message);

  const defaultDir = defaultInstallDir(scope.value, fs);
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
      scope: scope.value,
      installDir: fs.resolvePath(installDir.value),
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
): InitPlan {
  const scope = flags.scope ?? "local";
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
    .mapErr((error) => ({ message: String(error.cause) }))
    .andThen((exists) => {
      const messages: string[] = [];
      if (exists && !force) {
        messages.push(`Skipped existing config: ${configPath}`);
        return fs
          .mkdir(promptsPath)
          .mapErr((error) => ({ message: String(error.cause) }))
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
        .mapErr((error) => ({ message: String(error.cause) }))
        .andThen(() =>
          fs
            .writeText(configPath, starterConfig(plan.scope))
            .mapErr((error) => ({ message: String(error.cause) })),
        )
        .andThen(() =>
          fs
            .mkdir(promptsPath)
            .mapErr((error) => ({ message: String(error.cause) })),
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
