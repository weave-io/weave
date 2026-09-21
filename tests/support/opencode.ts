/**
 * Shared harness for the OpenCode scenario bucket.
 *
 * The other adapters materialise by writing files, so their black box is a
 * directory. OpenCode's does not: its plugin registers agents with a running
 * harness through a `config` hook that mutates the config object OpenCode hands
 * it. The observable outcome is therefore **the config OpenCode ends up with**
 * — which agents it now knows about, and what each one may do.
 *
 * That makes this the right seam: a `.weave` file goes in, and the registered
 * agents come out, with nothing in between asserted.
 *
 * The project root is a real temporary directory, because config discovery
 * reads from disk. `projectOnlyReader` confines that read to the temp project,
 * so the developer's own `~/.weave` can never reach a scenario.
 */

import { expect } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { errAsync, okAsync, ResultAsync } from "neverthrow";

/** The subset of OpenCode's config object these scenarios inspect. */
export interface RegisteredConfig {
  agent?: Record<string, Record<string, unknown>>;
  command?: Record<string, Record<string, unknown>>;
  [key: string]: unknown;
}

/**
 * A file reader confined to `root`.
 *
 * Anything outside — notably the developer's global `~/.weave/config.weave` —
 * reports as absent, so a scenario sees only the config it declared.
 */
export function projectOnlyReader(root: string) {
  const normalizedRoot = `${root.replace(/\\/g, "/").replace(/\/$/, "")}/`;

  return {
    exists: async (path: string): Promise<boolean> => {
      const normalized = path.replace(/\\/g, "/");
      if (
        normalized !== normalizedRoot.slice(0, -1) &&
        !normalized.startsWith(normalizedRoot)
      ) {
        return false;
      }
      return Bun.file(path).exists();
    },
    read: (path: string) =>
      ResultAsync.fromPromise(Bun.file(path).text(), (cause: unknown) => ({
        type: "FileReadError" as const,
        path,
        cause,
      })),
  };
}

/** A no-op stand-in for the OpenCode SDK client. */
export function stubClient(): Record<string, unknown> {
  return {
    app: { log: async () => ({}) },
    session: { list: async () => ({ data: [] }) },
    config: { get: async () => ({ data: {} }) },
  };
}

/** The input OpenCode passes a plugin at load time. */
export function pluginInput(directory: string, client: unknown) {
  return {
    client,
    directory,
    project: {} as never,
    worktree: directory,
    experimental_workspace: { register: () => {} },
    serverUrl: new URL("http://localhost:1234"),
    $: {} as never,
  };
}

/**
 * Runs `body` with a temporary project whose `.weave/config.weave` holds
 * `config`. The directory is removed afterwards.
 */
/**
 * A unique temporary directory path.
 *
 * `AGENTS.md` forbids the Node `fs` runtime surface, so this does not call
 * `mkdtemp`. `Bun.write()` creates parent directories on demand, so the
 * directory comes into being with the first file written into it — the same
 * pattern the adapters' own tests use.
 */
function tempProjectPath(prefix: string): string {
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return join(tmpdir(), `${prefix}${unique}`);
}

/** Removes a directory tree through Bun's process API rather than `node:fs`. */
async function removeTree(dir: string): Promise<void> {
  const proc = Bun.spawn(["rm", "-rf", dir], {
    stdout: "ignore",
    stderr: "ignore",
  });
  await proc.exited;
}

export async function withWeaveProject<T>(
  config: string,
  body: (root: string) => Promise<T>,
): Promise<T> {
  const root = tempProjectPath("weave-opencode-scenario-");
  await Bun.write(join(root, ".weave", "config.weave"), config);
  try {
    return await body(root);
  } finally {
    await removeTree(root);
  }
}

/**
 * Loads a plugin against a project and returns the config OpenCode would hold
 * afterwards.
 *
 * `createPlugin` receives the project root and the confined file reader, and
 * returns the plugin factory's result — the shape differs between the V1 and V2
 * adapters, so each bucket file supplies its own.
 */
export async function registeredConfig(
  root: string,
  createPlugin: (
    root: string,
    reader: ReturnType<typeof projectOnlyReader>,
    client: unknown,
  ) => Promise<{ config?: (cfg: RegisteredConfig) => Promise<unknown> }>,
  /**
   * Config OpenCode already holds when the hook runs — what a user wrote in
   * their own `opencode.json`. Omit it for a project where Weave is the only
   * source of agents.
   */
  existing: RegisteredConfig = {},
): Promise<RegisteredConfig> {
  const client = stubClient();
  const hooks = await createPlugin(root, projectOnlyReader(root), client);

  // A plugin that could not load a usable config exposes no `config` hook at
  // all — it degrades to a no-op rather than registering anything. That is a
  // real outcome, not a harness failure, so the caller sees an empty config
  // and asserts on it.
  const cfg: RegisteredConfig = existing;
  if (typeof hooks.config === "function") {
    await hooks.config(cfg);
  }
  return cfg;
}

/** The names of every agent the plugin registered, sorted. */
export function registeredAgentNames(cfg: RegisteredConfig): string[] {
  return Object.keys(cfg.agent ?? {}).sort();
}

/** One registered agent, failing readably when it is absent. */
export function registeredAgent(
  cfg: RegisteredConfig,
  name: string,
): Record<string, unknown> {
  const agent = cfg.agent?.[name];
  if (agent === undefined) {
    expect(registeredAgentNames(cfg)).toContain(name);
    throw new Error("unreachable");
  }
  return agent;
}

/** The names of every slash command the plugin registered, sorted. */
export function registeredCommandNames(cfg: RegisteredConfig): string[] {
  return Object.keys(cfg.command ?? {}).sort();
}

/** One registered slash command, failing readably when it is absent. */
export function registeredCommand(
  cfg: RegisteredConfig,
  name: string,
): Record<string, unknown> {
  const command = cfg.command?.[name];
  if (command === undefined) {
    expect(registeredCommandNames(cfg)).toContain(name);
    throw new Error("unreachable");
  }
  return command;
}

/**
 * Writes a file into a temporary project, creating parent directories.
 *
 * Scenarios that need more than a config — a plan file under `.weave/plans/`,
 * say — use this inside a `withWeaveProject` body.
 */
export async function writeProjectFile(
  root: string,
  relativePath: string,
  contents: string,
): Promise<void> {
  await Bun.write(join(root, relativePath), contents);
}

// ---------------------------------------------------------------------------
// The second black box: a running OpenCode instance
// ---------------------------------------------------------------------------

/**
 * The shape the adapter's client facade reports failures in.
 *
 * Declared here rather than imported so this module stays adapter-neutral —
 * both OpenCode adapters speak the same three operations.
 */
export interface FakeOpenCodeFailure {
  readonly type: "ListAgentsError" | "CreateAgentError" | "UpdateAgentError";
  readonly agentName?: string;
  readonly message: string;
}

/** An agent as a running OpenCode instance reports it back. */
export interface FakeOpenCodeAgent {
  readonly name: string;
  readonly description?: string;
  readonly [key: string]: unknown;
}

/**
 * A running OpenCode instance, in memory.
 *
 * The config hook makes OpenCode's *startup* config observable; this makes the
 * other half observable — the agents a live OpenCode holds once Weave has
 * talked to it over the SDK. Unlike a call recorder, this is a real store:
 * `createAgent` adds, `updateAgent` replaces, and `listAgents` reports what is
 * there now. That is what lets a scenario restart Weave and see an update
 * rather than a duplicate.
 *
 * Callers pass it where the adapter expects its client facade. The cast is
 * theirs to make, so this module stays free of adapter imports.
 */
export class FakeOpenCodeInstance {
  /** Every agent OpenCode currently holds, keyed by name. */
  readonly agents = new Map<string, Record<string, unknown>>();

  /** Every write OpenCode was asked to make, as `create:<name>` / `update:<name>`. */
  readonly writes: string[] = [];

  private listFailure: string | undefined;
  private createFailure: string | undefined;
  private updateFailure: string | undefined;

  /** Puts an agent into OpenCode that Weave did not create. */
  seedForeignAgent(name: string, description: string): this {
    this.agents.set(name, { description });
    return this;
  }

  /** Puts an agent into OpenCode exactly as it is, tag and all. */
  seedAgent(name: string, config: Record<string, unknown>): this {
    this.agents.set(name, config);
    return this;
  }

  /** Makes every subsequent read of the agent list fail. */
  failListAgents(message: string): this {
    this.listFailure = message;
    return this;
  }

  /** Makes every subsequent agent creation fail. */
  failCreateAgent(message: string): this {
    this.createFailure = message;
    return this;
  }

  /** Makes every subsequent agent update fail. */
  failUpdateAgent(message: string): this {
    this.updateFailure = message;
    return this;
  }

  /** Forgets the writes recorded so far, leaving the agents in place. */
  forgetWrites(): void {
    this.writes.length = 0;
  }

  listAgents(): ResultAsync<FakeOpenCodeAgent[], FakeOpenCodeFailure> {
    if (this.listFailure !== undefined) {
      return errAsync({
        type: "ListAgentsError" as const,
        message: this.listFailure,
      });
    }
    return okAsync(
      [...this.agents.entries()].map(([name, config]) => ({
        ...config,
        name,
      })),
    );
  }

  createAgent(
    name: string,
    config: Record<string, unknown>,
  ): ResultAsync<void, FakeOpenCodeFailure> {
    if (this.createFailure !== undefined) {
      return errAsync({
        type: "CreateAgentError" as const,
        agentName: name,
        message: this.createFailure,
      });
    }
    this.writes.push(`create:${name}`);
    this.agents.set(name, config);
    return okAsync(undefined);
  }

  updateAgent(
    name: string,
    config: Record<string, unknown>,
  ): ResultAsync<void, FakeOpenCodeFailure> {
    if (this.updateFailure !== undefined) {
      return errAsync({
        type: "UpdateAgentError" as const,
        agentName: name,
        message: this.updateFailure,
      });
    }
    this.writes.push(`update:${name}`);
    this.agents.set(name, config);
    return okAsync(undefined);
  }
}

/** One agent a running OpenCode holds, failing readably when it is absent. */
export function heldAgent(
  opencode: FakeOpenCodeInstance,
  name: string,
): Record<string, unknown> {
  const agent = opencode.agents.get(name);
  if (agent === undefined) {
    expect([...opencode.agents.keys()].sort()).toContain(name);
    throw new Error("unreachable");
  }
  return agent;
}
