/**
 * OpenCode 2 live check: does Weave work on a real OpenCode 2 host?
 *
 *   bun scripts/proof/opencode2-live/main.ts \
 *     --host <pinned|latest|x.y.z> \
 *     --plugin <local|npm:<spec>|init:<cli-spec>> \
 *     [--root <dir>] [--keep] [--report <file>]
 *
 * It installs the requested `@opencode/cli`, installs Weave into a fresh
 * project the way `--plugin` says, starts an isolated host service, and
 * checks from outside the host that every builtin agent and `/weave:start`
 * are registered. It then sends one message to Loom through `opencode2 run`
 * with a scripted local model, and checks that Loom's composed prompt reached
 * the model, that Loom delegated to Shuttle through the host's own subagent
 * tool, that Shuttle ran with its prompt and tool policy, and that the result
 * came back. No credentials and no remote model are used.
 *
 * Exit codes: 0 every check passed; 1 a check failed or was skipped; 2 the
 * harness itself could not run (install, service or API failure).
 *
 * The host needs roughly 2 GB of disk under `--root`, so pass a root outside
 * a small `/tmp` when running locally. See
 * docs/testing/opencode2-verification.md ("Live host check").
 */

import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { getBuiltinConfig } from "@weaveio/weave-config";
import { logger } from "@weaveio/weave-engine";
import {
  err,
  errAsync,
  ok,
  okAsync,
  type Result,
  ResultAsync,
} from "neverthrow";
import { WEAVE_OWNERSHIP_MARKER } from "../../../packages/adapters/opencode2/src/translate-agent.js";
import { OPENCODE2_DELEGATION_ACTION } from "../../../packages/adapters/opencode2/src/v2/delegation.js";
import {
  type HostAgent,
  type HostPlugin,
  LiveChecks,
  type LiveObservation,
  type LiveVerdict,
} from "./checks.js";
import {
  type LiveHostError,
  type LivePaths,
  livePaths,
  mustRun,
  OpenCode2Host,
  runProcess,
  writeText,
} from "./host.js";
import {
  describePluginSource,
  PluginInstaller,
  type PluginSource,
  parsePluginSource,
} from "./plugin-source.js";
import {
  ScriptedProvider,
  scriptedProviderConfig,
} from "./scripted-provider.js";

const log = logger.child({ module: "opencode2-live" });

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..");
const PRIMARY = "loom";
const DELEGATE = "shuttle";
const START_COMMAND = "weave:start";
const PLUGIN_ACTIVATION_TIMEOUT_MS = 240_000;
const AGENT_SETTLE_TIMEOUT_MS = 60_000;
const POLL_MS = 2_000;

type LiveMainError =
  | { readonly type: "InvalidArguments"; readonly detail: string }
  | { readonly type: "BuiltinConfig"; readonly detail: string }
  | { readonly type: "Harness"; readonly error: LiveHostError };

interface LiveOptions {
  readonly host: string;
  readonly expectedHostVersion?: string;
  readonly plugin: PluginSource;
  readonly root: string;
  readonly keep: boolean;
  /** Builtin agents the default Weave config declares. */
  readonly agents: readonly string[];
  readonly reportPath?: string;
}

const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[\w.]+)?$/;

/** Marks a root this harness created, so only such a root is deleted. */
const ROOT_SENTINEL = ".weave-opencode2-live";

function pinnedHostVersion(): ResultAsync<string, LiveMainError> {
  const path = join(
    REPO_ROOT,
    "packages",
    "adapters",
    "opencode2",
    "package.json",
  );
  const invalid: LiveMainError = {
    type: "InvalidArguments",
    detail: `could not read the pinned @opencode/plugin version from ${path}`,
  };
  return ResultAsync.fromPromise(
    Bun.file(path).json() as Promise<{ dependencies?: Record<string, string> }>,
    () => invalid,
  ).andThen((manifest) => {
    const version = manifest.dependencies?.["@opencode/plugin"];
    if (version === undefined) return errAsync<string, LiveMainError>(invalid);
    return okAsync<string, LiveMainError>(version);
  });
}

function resolveHost(requested: string): ResultAsync<string, LiveMainError> {
  if (requested === "pinned") return pinnedHostVersion();
  return okAsync(requested);
}

/**
 * The expected agent set. An unreadable builtin config is a harness error:
 * an empty set would make `agents_registered` pass vacuously.
 */
function expectedAgents(): Result<string[], LiveMainError> {
  const config = getBuiltinConfig();
  if (config.isErr()) {
    return err({
      type: "BuiltinConfig",
      detail: "builtin Weave config did not parse",
    });
  }
  const agents = Object.keys(config.value.agents ?? {});
  if (agents.length === 0) {
    return err({
      type: "BuiltinConfig",
      detail: "builtin Weave config declares no agents",
    });
  }
  return ok(agents);
}

function parseArguments(
  argv: readonly string[],
): ResultAsync<LiveOptions, LiveMainError> {
  const values = new Map<string, string>();
  let keep = false;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--keep") {
      keep = true;
      continue;
    }
    const value = argv[index + 1];
    if (flag === undefined || !flag.startsWith("--") || value === undefined) {
      return errAsync({
        type: "InvalidArguments",
        detail: `unexpected argument ${flag ?? ""}`,
      });
    }
    values.set(flag.slice(2), value);
    index += 1;
  }
  const plugin = parsePluginSource(values.get("plugin") ?? "local");
  if (plugin.isErr()) {
    return errAsync({
      type: "InvalidArguments",
      detail: `--plugin must be local, npm:<spec> or init:<cli-spec>; got ${plugin.error.value}`,
    });
  }
  const agents = expectedAgents();
  if (agents.isErr()) return errAsync(agents.error);
  const root =
    values.get("root") ??
    join(tmpdir(), `weave-opencode2-live-${Date.now().toString(36)}`);
  return resolveHost(values.get("host") ?? "pinned").map((host) => ({
    host,
    expectedHostVersion: EXACT_VERSION.test(host) ? host : undefined,
    plugin: plugin.value,
    root: resolve(root),
    keep,
    agents: agents.value,
    reportPath: values.get("report"),
  }));
}

/**
 * Claims `root` for this run: it must not exist yet or be empty, and it gets
 * a sentinel file. A caller who passes `--root "$HOME"` by mistake gets an
 * error instead of a deleted home directory.
 */
function claimRoot(root: string): ResultAsync<void, LiveMainError> {
  const env = { PATH: Bun.env.PATH ?? "" };
  const harness = (error: LiveHostError): LiveMainError => ({
    type: "Harness",
    error,
  });
  return runProcess(
    "inspect root",
    ["find", root, "-mindepth", "1", "-maxdepth", "1"],
    {
      cwd: REPO_ROOT,
      env,
      timeoutMs: 30_000,
    },
  )
    .mapErr(harness)
    .andThen((listing) => {
      if (listing.exitCode === 0 && listing.output.trim().length > 0) {
        return errAsync<void, LiveMainError>({
          type: "InvalidArguments",
          detail: `--root ${root} is not empty; pass a new or empty directory`,
        });
      }
      return writeText(join(root, ROOT_SENTINEL), "").mapErr(harness);
    });
}

/** Deletes `root` only when it carries this harness's sentinel. */
function releaseRoot(root: string): ResultAsync<void, LiveHostError> {
  return ResultAsync.fromSafePromise(
    Bun.file(join(root, ROOT_SENTINEL)).exists(),
  ).andThen((claimed) => {
    if (!claimed) return okAsync<void, LiveHostError>(undefined);
    return mustRun("remove root", ["rm", "-rf", root], {
      cwd: REPO_ROOT,
      env: { PATH: Bun.env.PATH ?? "" },
      timeoutMs: 120_000,
    }).map(() => undefined);
  });
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function commandNames(value: unknown): string[] {
  return asArray<{ name?: unknown; id?: unknown }>(value).flatMap((command) => {
    const name = command.name ?? command.id;
    return typeof name === "string" ? [name] : [];
  });
}

class LiveCheckRun {
  private readonly paths: LivePaths;
  private readonly host: OpenCode2Host;
  private readonly provider = new ScriptedProvider({
    delegationTool: OPENCODE2_DELEGATION_ACTION,
    delegate: DELEGATE,
  });
  private readonly checks: LiveChecks;
  private readonly agents: readonly string[];

  constructor(private readonly options: LiveOptions) {
    this.paths = livePaths(options.root);
    this.agents = options.agents;
    this.host = new OpenCode2Host(this.paths, options.host);
    this.checks = new LiveChecks({
      expectedAgents: this.agents,
      ownershipMarker: WEAVE_OWNERSHIP_MARKER,
      primary: PRIMARY,
      delegate: DELEGATE,
      startCommand: START_COMMAND,
      delegationTool: OPENCODE2_DELEGATION_ACTION,
      subagentForbiddenTools: [OPENCODE2_DELEGATION_ACTION, "question"],
    });
  }

  async execute(): Promise<Result<LiveVerdict[], LiveMainError>> {
    const port = this.provider.start();
    const observed = await this.prepare(port)
      .andThen(() => this.host.startService())
      .andThen(() => this.observe());
    await this.host.stopService().match(
      () => undefined,
      (error) => log.warn({ error }, "Could not stop the isolated service"),
    );
    this.provider.stop();
    if (observed.isErr())
      return err({ type: "Harness", error: observed.error });
    return ok(this.checks.evaluate(observed.value));
  }

  private prepare(port: number): ResultAsync<void, LiveHostError> {
    const installer = new PluginInstaller(this.paths, this.host, REPO_ROOT);
    const hostEnv = { cwd: this.paths.root, env: this.host.env() };
    const runtimeDir =
      hostEnv.env.XDG_RUNTIME_DIR ?? join(this.paths.home, ".run");
    return mustRun(
      "create directories",
      ["mkdir", "-p", this.paths.home, this.paths.hostDir],
      {
        ...hostEnv,
        timeoutMs: 10_000,
      },
    )
      .andThen(() =>
        mustRun(
          "create runtime dir",
          ["mkdir", "-p", "-m", "700", runtimeDir],
          {
            ...hostEnv,
            timeoutMs: 10_000,
          },
        ),
      )
      .andThen(() =>
        writeText(
          this.host.globalConfigPath(),
          `${JSON.stringify(scriptedProviderConfig(port), null, 2)}\n`,
        ),
      )
      .andThen(() => {
        log.info({ host: this.options.host }, "Installing OpenCode 2 host");
        return this.host.install();
      })
      .andThen(() =>
        mustRun("create project", ["git", "init", "-q", this.paths.project], {
          ...hostEnv,
          timeoutMs: 30_000,
        }),
      )
      .andThen(() => {
        log.info(
          { plugin: describePluginSource(this.options.plugin) },
          "Installing Weave",
        );
        return installer.install(this.options.plugin);
      })
      .map((projectConfig) =>
        log.info({ projectConfig }, "Project host config"),
      );
  }

  /** Waits for activation, reads the host's lists, then runs Loom once. */
  private observe(): ResultAsync<LiveObservation, LiveHostError> {
    return this.host.version().andThen((hostVersion) =>
      this.awaitPlugin().andThen((plugins) =>
        this.awaitAgents().andThen(({ agents, commands }) => {
          const base = {
            hostVersion,
            ...this.expected(),
            plugins,
            agents,
            commands,
          };
          if (!this.registered(agents))
            return okAsync<LiveObservation, LiveHostError>({
              ...base,
              run: null,
            });
          log.info(
            { agent: PRIMARY },
            "Running one message through the real host",
          );
          return this.host
            .run(PRIMARY, "Delegate one small task to shuttle, then reply.")
            .map((outcome): LiveObservation => {
              log.info(
                {
                  exitCode: outcome.exitCode,
                  output: outcome.output.slice(-400),
                },
                "Run finished",
              );
              return {
                ...base,
                run: {
                  exitCode: outcome.exitCode,
                  requests: this.provider.captured(),
                },
              };
            });
        }),
      ),
    );
  }

  private registered(agents: readonly HostAgent[]): boolean {
    return this.agents.every((name) =>
      agents.some(
        (agent) =>
          agent.id === name &&
          (agent.description ?? "").startsWith(WEAVE_OWNERSHIP_MARKER),
      ),
    );
  }

  private expected(): Pick<LiveObservation, "expectedHostVersion"> {
    if (this.options.expectedHostVersion === undefined) return {};
    return { expectedHostVersion: this.options.expectedHostVersion };
  }

  /** Polls `plugin.list` until every non-builtin plugin has settled. */
  private awaitPlugin(): ResultAsync<HostPlugin[], LiveHostError> {
    return poll(
      () =>
        this.host.api("plugin.list").map((data) => asArray<HostPlugin>(data)),
      (plugins) => {
        const external = plugins.filter(
          (plugin) => plugin.source.type !== "builtin",
        );
        return (
          external.length > 0 &&
          external.every((plugin) => plugin.state.status !== "pending")
        );
      },
      PLUGIN_ACTIVATION_TIMEOUT_MS,
    );
  }

  /**
   * Polls `agent.list` and `command.list` until every expected agent and the
   * start command are present, or the settle window passes. Provider and
   * plugin transforms can land after the plugin reports active, so one read
   * is not enough.
   */
  private awaitAgents(): ResultAsync<
    { agents: HostAgent[]; commands: string[] },
    LiveHostError
  > {
    return poll(
      () =>
        this.host.api("agent.list").andThen((agentData) =>
          this.host.api("command.list").map((commandData) => ({
            agents: asArray<HostAgent>(agentData),
            commands: commandNames(commandData),
          })),
        ),
      ({ agents, commands }) =>
        this.registered(agents) && commands.includes(START_COMMAND),
      AGENT_SETTLE_TIMEOUT_MS,
    );
  }
}

/**
 * Re-reads until `done` holds or `timeoutMs` passes, and returns the last
 * read either way: a timeout is an observation for the checks to judge, not
 * a harness error.
 */
function poll<T>(
  read: () => ResultAsync<T, LiveHostError>,
  done: (value: T) => boolean,
  timeoutMs: number,
): ResultAsync<T, LiveHostError> {
  const deadline = Date.now() + timeoutMs;
  const attempt = (): ResultAsync<T, LiveHostError> =>
    read().andThen((value) => {
      if (done(value) || Date.now() >= deadline) return okAsync(value);
      return ResultAsync.fromSafePromise(Bun.sleep(POLL_MS)).andThen(attempt);
    });
  return attempt();
}

function summaryMarkdown(
  options: LiveOptions,
  verdicts: readonly LiveVerdict[],
): string {
  const icon = { passed: "✅", failed: "❌", skipped: "⏭️" } as const;
  const rows = verdicts.map(
    (verdict) =>
      `| ${icon[verdict.status]} | \`${verdict.id}\` | ${verdict.evidence.replaceAll("|", "\\|")} |`,
  );
  return [
    `### OpenCode 2 live check — host \`${options.host}\`, plugin \`${describePluginSource(options.plugin)}\``,
    "",
    "| | Check | Evidence |",
    "| --- | --- | --- |",
    ...rows,
    "",
  ].join("\n");
}

async function report(
  options: LiveOptions,
  verdicts: readonly LiveVerdict[],
): Promise<void> {
  const body = {
    schemaVersion: 1,
    host: options.host,
    plugin: describePluginSource(options.plugin),
    verdicts,
  };
  const markdown = summaryMarkdown(options, verdicts);
  await Bun.write(Bun.stdout, `${markdown}\n`);
  if (options.reportPath !== undefined) {
    await Bun.write(options.reportPath, `${JSON.stringify(body, null, 2)}\n`);
  }
  const summary = Bun.env.GITHUB_STEP_SUMMARY;
  if (summary !== undefined) {
    const previous = await Bun.file(summary)
      .text()
      .catch(() => "");
    await Bun.write(summary, `${previous}${markdown}\n`);
  }
}

async function main(): Promise<number> {
  const parsed = await parseArguments(Bun.argv.slice(2));
  if (parsed.isErr()) {
    log.error({ error: parsed.error }, "The live check could not start");
    return 2;
  }
  const options = parsed.value;
  const claimed = await claimRoot(options.root);
  if (claimed.isErr()) {
    log.error({ error: claimed.error }, "The live check could not start");
    return 2;
  }
  log.info(
    {
      host: options.host,
      plugin: describePluginSource(options.plugin),
      root: options.root,
    },
    "Starting OpenCode 2 live check",
  );
  const result = await new LiveCheckRun(options).execute();
  if (!options.keep) {
    await releaseRoot(options.root).match(
      () => undefined,
      (error) => log.warn({ error }, "Could not remove the live-check root"),
    );
  }
  if (result.isErr()) {
    log.error({ error: result.error }, "The live check could not run");
    return 2;
  }
  await report(options, result.value);
  return LiveChecks.outcome(result.value).match(
    () => 0,
    (notPassed) => {
      log.error(
        { checks: notPassed.map((verdict) => verdict.id) },
        "Weave does not work on this OpenCode 2 host",
      );
      return 1;
    },
  );
}

if (import.meta.main) {
  process.exitCode = await main();
}
