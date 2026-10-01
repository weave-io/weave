/**
 * `weave models status | update | apply | pin` — the user's side of model
 * recommendations (Spec 39 item 5, "Visibility").
 *
 * - `status` prints the mode, channel, the applied list's dates and evidence,
 *   a waiting list, the last check and error, and every builtin agent's merged
 *   `models` list with each entry's source, for one harness.
 * - `update` checks now (a forced refresh) and prints what changed.
 * - `apply` promotes a waiting list (the `notify` path).
 * - `pin` writes the applied lists into the global config as explicit
 *   `models`, after printing the diff and asking.
 *
 * The cache, clock and network are injected through `ModelsContext`; see
 * `RecommendationsSession`. Nothing here resolves a model against a live
 * catalog: the CLI has none, so `status` shows lists and sources only.
 */

import {
  type ApplyError,
  type ConfigLoadDiagnostic,
  describeModelRecommendationsError,
  describeModelRecommendationsSkipReason,
  describeRefreshFailure,
  type LoadedConfig,
  type ModelRecommendationsStatus,
  type RecommendationsHarness,
  type RefreshError,
  type ResolvedModelUpdates,
  resolveModelUpdates,
} from "@weaveio/weave-config";
import type {
  ModelUpdatesChannel,
  ModelUpdatesMode,
} from "@weaveio/weave-core";
import { err, ok, type Result } from "neverthrow";
import { type CliError, formatCliError } from "../errors.js";
import { BunFileSystem, type FileSystem } from "../fs/file-system.js";
import {
  chooseHarness,
  type HarnessChoice,
  unsupportedMessage,
} from "../models/harness.js";
import {
  describePinEditError,
  type PinHunk,
  pinModels,
} from "../models/pin-editor.js";
import {
  RecommendationsSession,
  type RecommendedLists,
} from "../models/recommendations-session.js";
import {
  firstListHint,
  listChanges,
  OPT_IN_HINT,
  recommendationsDiagnostic,
  renderListChanges,
} from "../models/report.js";
import { type AttributedModel, attributeModels } from "../models/sources.js";
import { ClackPromptAdapter } from "../prompt/index.js";
import type { ThemeColors } from "../theme/colors.js";
import type { ModelsContext } from "./models.js";

type Supported = Extract<HarnessChoice, { type: "supported" }>;

/** The status report, as `--json` prints it. */
interface StatusReport {
  readonly mode: ModelUpdatesMode;
  readonly channel: ModelUpdatesChannel;
  readonly harness: string;
  readonly supported: boolean;
  readonly reason?: string;
  readonly applied?:
    | { readonly state: "none" }
    | {
        readonly state: "usable";
        readonly issued: string;
        readonly expires: string;
        readonly evidence: string;
        readonly section?: string;
      }
    | { readonly state: "unusable"; readonly reason: string };
  readonly waiting?: {
    readonly issued: string;
    readonly expires: string;
    readonly evidence: string;
  } | null;
  readonly lastCheck?: string | null;
  readonly nextCheckAt?: string | null;
  readonly lastError?: {
    readonly code: string;
    readonly message: string;
    readonly at: string;
  } | null;
  readonly skippedAgents?: readonly string[];
  readonly agents?: Readonly<Record<string, readonly AttributedModel[]>>;
}

class ModelUpdatesCommand {
  private readonly fs: FileSystem;
  private readonly session: RecommendationsSession;
  private readonly theme: ThemeColors;

  constructor(private readonly ctx: ModelsContext) {
    this.fs = ctx.fs ?? new BunFileSystem();
    this.session = new RecommendationsSession(
      this.fs,
      ctx.modelRecommendations,
      ctx.now,
    );
    this.theme = ctx.theme;
  }

  private get projectRoot(): string {
    const flag = this.ctx.flags.projectRoot;
    return flag === undefined ? this.fs.cwd() : this.fs.resolvePath(flag);
  }

  private out(lines: readonly string[]): void {
    this.ctx.terminal.stdout(lines.join("\n"));
  }

  private fail(lines: readonly string[]): Result<number, CliError> {
    this.ctx.terminal.stderr(lines.join("\n"));
    return ok(1);
  }

  private failWith(error: CliError): Result<number, CliError> {
    return this.fail([formatCliError(error)]);
  }

  /** The harness from `--harness`, or a usage error. */
  private harness(): HarnessChoice | undefined {
    const choice = chooseHarness(this.ctx.flags.harness);
    if (choice.isOk()) return choice.value;
    this.failWith(choice.error);
    return undefined;
  }

  /** The harness for a command that needs one with recommendations. */
  private supportedHarness(): Supported | undefined {
    const choice = this.harness();
    if (choice === undefined) return undefined;
    if (choice.type === "supported") return choice;
    this.fail([`Error: ${unsupportedMessage(choice)}`]);
    return undefined;
  }

  /** The opted-in settings, or a message that model updates are off. */
  private optedIn(
    loaded: LoadedConfig,
    action: string,
  ): ResolvedModelUpdates | undefined {
    const settings = resolveModelUpdates(loaded.config.settings.model_updates);
    if (settings !== undefined) return settings;
    this.fail([
      `Model updates are off, so ${action}.`,
      `  Turn them on with ${OPT_IN_HINT}.`,
    ]);
    return undefined;
  }

  // -------------------------------------------------------------------------
  // status
  // -------------------------------------------------------------------------

  async status(): Promise<Result<number, CliError>> {
    const choice = this.harness();
    if (choice === undefined) return ok(1);
    const supported = choice.type === "supported" ? choice.harness : undefined;
    const loaded = await this.session.load(this.projectRoot, supported);
    if (loaded.isErr()) return this.failWith(loaded.error);
    const block = loaded.value.config.settings.model_updates;
    const mode = block?.mode ?? "off";
    const channel = block?.channel ?? "stable";

    if (choice.type === "unsupported") {
      const report: StatusReport = {
        mode,
        channel,
        harness: choice.harness,
        supported: false,
        reason: unsupportedMessage(choice),
      };
      if (this.ctx.flags.json) this.out([JSON.stringify(report, null, 2)]);
      else
        this.out([
          ...this.header(mode, channel, choice.harness),
          "",
          unsupportedMessage(choice),
        ]);
      return ok(0);
    }

    const cache = await this.session.models.status({ settings: block });
    if (cache.isErr()) return this.fail([`Error: ${cache.error.message}`]);
    const diagnostic = recommendationsDiagnostic(loaded.value.diagnostics);
    const recommended =
      diagnostic?.type === "ModelRecommendationsApplied"
        ? await this.session.lists("applied", channel, choice.harness)
        : undefined;
    const [layers, builtins] = await Promise.all([
      this.session.userLayers(this.projectRoot),
      this.session.builtins(),
    ]);
    if (layers.isErr()) return this.failWith(layers.error);
    if (builtins.isErr()) return this.failWith(builtins.error);
    const agents = attributeModels(
      loaded.value.config,
      {
        builtin: builtins.value,
        ...(recommended?.isOk() && recommended.value !== undefined
          ? { recommended: recommended.value.agents }
          : {}),
        ...layers.value,
      },
      Object.keys(builtins.value.agents),
    );

    const report = this.statusReport(
      mode,
      choice.harness,
      cache.value,
      diagnostic,
      agents,
    );
    this.out(
      this.ctx.flags.json
        ? [JSON.stringify(report, null, 2)]
        : this.renderStatus(report),
    );
    return ok(0);
  }

  private statusReport(
    mode: ModelUpdatesMode,
    harness: RecommendationsHarness,
    cache: ModelRecommendationsStatus,
    diagnostic: ConfigLoadDiagnostic | undefined,
    agents: Record<string, AttributedModel[]>,
  ): StatusReport {
    const applied = (): NonNullable<StatusReport["applied"]> => {
      if (cache.applied.state === "none") return { state: "none" };
      if (cache.applied.state === "unusable")
        return {
          state: "unusable",
          reason: describeModelRecommendationsSkipReason(cache.applied.reason),
        };
      return {
        state: "usable",
        ...cache.applied.list,
        ...(diagnostic?.type === "ModelRecommendationsApplied"
          ? { section: diagnostic.section }
          : {}),
      };
    };
    return {
      mode,
      channel: cache.channel,
      harness,
      supported: true,
      applied: applied(),
      waiting: cache.waiting ?? null,
      lastCheck: cache.lastCheck ?? null,
      nextCheckAt: cache.nextCheckAt ?? null,
      lastError: cache.lastError ?? null,
      skippedAgents:
        diagnostic?.type === "ModelRecommendationsApplied"
          ? diagnostic.skippedAgents
          : [],
      agents,
    };
  }

  private header(
    mode: ModelUpdatesMode,
    channel: ModelUpdatesChannel,
    harness: string,
    section?: string,
  ): string[] {
    const { theme } = this;
    return [
      theme.bold("Model updates"),
      `  mode        ${mode}`,
      `  channel     ${channel}`,
      `  harness     ${harness}${section === undefined ? "" : theme.dim(` (section: ${section})`)}`,
    ];
  }

  private renderStatus(report: StatusReport): string[] {
    const { theme } = this;
    const applied = report.applied;
    const lines = this.header(
      report.mode,
      report.channel,
      report.harness,
      applied?.state === "usable" ? applied.section : undefined,
    );
    if (report.mode === "off") {
      lines.push(
        `  ${theme.dim(`Recommendations are not used. Turn them on with ${OPT_IN_HINT}.`)}`,
      );
    } else {
      lines.push(...this.cacheLines(report));
    }
    lines.push("", theme.bold(`Agent models for ${report.harness}`));
    for (const [agent, models] of Object.entries(report.agents ?? {})) {
      lines.push(`  ${theme.boldCyan(agent)}`);
      const width = Math.max(...models.map((entry) => entry.model.length));
      for (const entry of models)
        lines.push(
          `    ${entry.model.padEnd(width)}  ${theme.dim(entry.source)}`,
        );
    }
    return lines;
  }

  private cacheLines(report: StatusReport): string[] {
    const { theme } = this;
    const mode = report.mode === "auto" ? "auto" : "notify";
    const lines: string[] = [];
    const applied = report.applied;
    if (applied?.state === "usable")
      lines.push(
        `  applied     issued ${applied.issued}, expires ${applied.expires}`,
        `  evidence    ${applied.evidence}`,
      );
    if (applied?.state === "none")
      lines.push(`  applied     nothing yet (${firstListHint(mode)})`);
    if (applied?.state === "unusable")
      lines.push(
        `  applied     ${theme.yellow("not used")}: ${applied.reason}; agents use their builtin models`,
      );
    if (report.waiting)
      lines.push(
        `  waiting     issued ${report.waiting.issued} (run weave models apply to use it)`,
      );
    lines.push(`  last check  ${report.lastCheck ?? "never"}`);
    if (report.nextCheckAt) lines.push(`  next check  ${report.nextCheckAt}`);
    if (report.lastError)
      lines.push(
        `  last error  ${theme.yellow(report.lastError.message)} ${theme.dim(`(${report.lastError.at})`)}`,
      );
    if (report.skippedAgents && report.skippedAgents.length > 0)
      lines.push(
        `  skipped     ${report.skippedAgents.join(", ")} ${theme.dim("(not builtin agents in this version)")}`,
      );
    return lines;
  }

  // -------------------------------------------------------------------------
  // update
  // -------------------------------------------------------------------------

  async update(): Promise<Result<number, CliError>> {
    const choice = this.supportedHarness();
    if (choice === undefined) return ok(1);
    const loaded = await this.session.load(this.projectRoot, choice.harness);
    if (loaded.isErr()) return this.failWith(loaded.error);
    const settings = this.optedIn(loaded.value, "nothing was fetched");
    if (settings === undefined) return ok(1);

    const { channel } = settings;
    const before = await this.appliedLists(channel, choice.harness);
    const refreshed = await this.session.models.refresh({
      settings: loaded.value.config.settings.model_updates,
      force: true,
    });
    if (refreshed.isErr())
      return this.fail([`Error: ${describeRefreshError(refreshed.error)}`]);

    const outcome = refreshed.value;
    const after = await this.appliedLists(channel, choice.harness);
    const latest = await this.latestLists(channel, choice.harness);
    const promoted = "promoted" in outcome ? outcome.promoted : undefined;
    if (promoted !== undefined) {
      this.out([
        `Applied the ${channel} list issued ${promoted.issued}${promoted.previousIssued === undefined ? "" : ` (was ${promoted.previousIssued})`}.`,
        ...renderListChanges(listChanges(before, after), choice.harness),
      ]);
      return ok(0);
    }
    if (latest !== undefined && isNewer(latest, after)) {
      this.out([
        `A newer ${channel} list, issued ${latest.issued}, is waiting. Run weave models apply to use it.`,
        ...renderListChanges(listChanges(after, latest), choice.harness),
      ]);
      return ok(0);
    }
    const issued = after?.issued ?? latest?.issued;
    this.out([
      `Model recommendations are up to date${issued === undefined ? "" : ` (${channel} list issued ${issued})`}.`,
    ]);
    return ok(0);
  }

  // -------------------------------------------------------------------------
  // apply
  // -------------------------------------------------------------------------

  async apply(): Promise<Result<number, CliError>> {
    const choice = this.supportedHarness();
    if (choice === undefined) return ok(1);
    const loaded = await this.session.load(this.projectRoot, choice.harness);
    if (loaded.isErr()) return this.failWith(loaded.error);
    const settings = this.optedIn(loaded.value, "there is nothing to apply");
    if (settings === undefined) return ok(1);

    const { channel } = settings;
    const before = await this.appliedLists(channel, choice.harness);
    const applied = await this.session.models.apply({
      settings: loaded.value.config.settings.model_updates,
    });
    if (applied.isErr())
      return this.fail([`Error: ${describeApplyError(applied.error)}`]);
    const outcome = applied.value;
    if (outcome.type === "NothingToApply") {
      this.out([
        outcome.reason === "NoLatest"
          ? "Nothing to apply: no list has been downloaded yet. Run weave models update."
          : `Nothing to apply: the applied ${channel} list${outcome.appliedIssued === undefined ? "" : `, issued ${outcome.appliedIssued},`} is the newest downloaded.`,
      ]);
      return ok(0);
    }
    const after = await this.appliedLists(channel, choice.harness);
    this.out([
      `Applied the ${channel} list issued ${outcome.issued}${outcome.previousIssued === undefined ? "" : ` (was ${outcome.previousIssued})`}.`,
      ...renderListChanges(listChanges(before, after), choice.harness),
    ]);
    return ok(0);
  }

  // -------------------------------------------------------------------------
  // pin
  // -------------------------------------------------------------------------

  async pin(): Promise<Result<number, CliError>> {
    const choice = this.supportedHarness();
    if (choice === undefined) return ok(1);
    const loaded = await this.session.load(this.projectRoot, choice.harness);
    if (loaded.isErr()) return this.failWith(loaded.error);
    const settings = this.optedIn(
      loaded.value,
      "no recommendations are applied to pin",
    );
    if (settings === undefined) return ok(1);

    const diagnostic = recommendationsDiagnostic(loaded.value.diagnostics);
    if (diagnostic?.type === "ModelRecommendationsSkipped")
      return this.fail([
        `Error: the applied recommendations cannot be used, so there is nothing to pin: ${describeModelRecommendationsSkipReason(diagnostic.reason)}.`,
      ]);
    const recommended = await this.appliedLists(
      settings.channel,
      choice.harness,
    );
    if (diagnostic?.type !== "ModelRecommendationsApplied" || !recommended)
      return this.fail([
        `Nothing to pin: no recommendations are applied yet (${firstListHint(settings.mode)}).`,
      ]);

    const path = this.session.globalConfigPath;
    const source = await this.readGlobalConfig(path);
    if (source.isErr()) return this.failWith(source.error);
    const layers = await this.session.userLayers(this.projectRoot);
    if (layers.isErr()) return this.failWith(layers.error);

    const lists: Record<string, string[]> = {};
    let changed = 0;
    for (const [agent, models] of Object.entries(recommended.agents)) {
      const own = layers.value.global?.agents[agent]?.models ?? [];
      lists[agent] = [...new Set([...own, ...models])];
      if (lists[agent].length !== own.length) changed++;
    }
    const header = `# Pinned by weave models pin: the ${settings.channel} list issued ${recommended.issued}, ${choice.harness} (section ${recommended.section}).`;
    const edit = pinModels(source.value, lists, header);
    if (edit.isErr())
      return this.fail([`Error: ${describePinEditError(edit.error)}`]);
    if (edit.value.hunks.length === 0) {
      this.out([
        `The global config already lists these models; nothing to pin (${path}).`,
        ...this.offHint(),
      ]);
      return ok(0);
    }

    this.out([
      `Pin the ${choice.harness} recommendations (${settings.channel} list issued ${recommended.issued}) into ${path}:`,
      "",
      ...this.renderHunks(edit.value.hunks),
      "",
      this.theme.dim(
        "The global config applies to every harness. Your own entries stay first.",
      ),
    ]);
    const confirmed = await this.confirm(path);
    if (confirmed !== true) return ok(confirmed === "cancelled" ? 0 : 1);

    const written = await this.fs.writeText(path, edit.value.text);
    if (written.isErr())
      return this.failWith({
        type: "FileWriteError",
        path,
        cause: written.error,
        message: "The pinned models were not written.",
      });
    this.out([
      `Pinned the models of ${changed} agent${changed === 1 ? "" : "s"} in ${path}.`,
      ...this.offHint(),
    ]);
    return ok(0);
  }

  private offHint(): string[] {
    return [
      "To keep these lists and stop fetching recommendations, set the mode to off:",
      "  settings { model_updates { mode off } }",
    ];
  }

  private async readGlobalConfig(
    path: string,
  ): Promise<Result<string, CliError>> {
    const readError = (cause: unknown): CliError => ({
      type: "FileReadError",
      path,
      cause,
      message: "The global config could not be read.",
    });
    const exists = await this.fs.exists(path);
    if (exists.isErr()) return err(readError(exists.error));
    if (!exists.value) return ok("");
    return (await this.fs.readText(path)).mapErr(readError);
  }

  private async confirm(
    path: string,
  ): Promise<true | "cancelled" | "unavailable"> {
    if (this.ctx.flags.yes) return true;
    const prompt = this.ctx.prompt ?? new ClackPromptAdapter();
    if (!prompt.isInteractive()) {
      this.fail([
        "Interactive mode is unavailable. Re-run with --yes to write the pinned models.",
      ]);
      return "unavailable";
    }
    const answer = await prompt.confirm({
      message: `Write the pinned models to ${path}?`,
      initialValue: true,
    });
    if (answer.isOk() && answer.value) return true;
    this.out(["Nothing was written."]);
    return "cancelled";
  }

  private renderHunks(hunks: readonly PinHunk[]): string[] {
    const { theme } = this;
    return hunks.flatMap((hunk) => [
      theme.cyan(
        hunk.kind === "append"
          ? `@@ new blocks: ${hunk.agent} @@`
          : `@@ agent ${hunk.agent} @@`,
      ),
      ...hunk.removed.map((line) => theme.red(`-${line}`)),
      ...hunk.added.map((line) => theme.green(`+${line}`)),
    ]);
  }

  private async appliedLists(
    channel: ModelUpdatesChannel,
    harness: RecommendationsHarness,
  ): Promise<RecommendedLists | undefined> {
    const lists = await this.session.lists("applied", channel, harness);
    return lists.isOk() ? lists.value : undefined;
  }

  private async latestLists(
    channel: ModelUpdatesChannel,
    harness: RecommendationsHarness,
  ): Promise<RecommendedLists | undefined> {
    const lists = await this.session.lists("latest", channel, harness);
    return lists.isOk() ? lists.value : undefined;
  }
}

function isNewer(
  latest: RecommendedLists,
  applied: RecommendedLists | undefined,
): boolean {
  if (applied === undefined) return true;
  return Date.parse(latest.issued) > Date.parse(applied.issued);
}

function describeRefreshError(error: RefreshError): string {
  switch (error.type) {
    case "Busy":
      return "another Weave process is updating the model recommendations; try again in a minute";
    case "CheckFailed":
      return `the ${error.channel} list could not be checked: ${describeRefreshFailure(error.failure)}`;
    case "CacheFailed":
      return describeRefreshFailure(error.error);
    case "Unexpected":
      return `the update failed unexpectedly: ${error.message}`;
  }
}

function describeApplyError(error: ApplyError): string {
  switch (error.type) {
    case "Off":
      return "model updates are off";
    case "Busy":
      return "another Weave process is updating the model recommendations; try again in a minute";
    case "LatestRejected":
      return `the downloaded ${error.channel} list can no longer be applied: ${describeModelRecommendationsError(error.error)}`;
    case "CacheFailed":
      return describeRefreshFailure(error.error);
    case "Unexpected":
      return `the apply failed unexpectedly: ${error.message}`;
  }
}

/** Run `weave models status | update | apply | pin`. */
export function runModelUpdates(
  ctx: ModelsContext,
  subcommand: "status" | "update" | "apply" | "pin",
): Promise<Result<number, CliError>> {
  const command = new ModelUpdatesCommand(ctx);
  switch (subcommand) {
    case "status":
      return command.status();
    case "update":
      return command.update();
    case "apply":
      return command.apply();
    case "pin":
      return command.pin();
  }
}
