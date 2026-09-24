/**
 * Shared harness for the OpenCode 2 scenario bucket.
 *
 * OpenCode 2 is not a file-generating harness. Its plugin is handed a live
 * host `Context` and reconciles Weave's agents into it through
 * `ctx.agent.transform`, its command through `ctx.command.transform`, its
 * session hooks through `ctx.session.hook` and its plan surface through
 * `ctx.rpc.register`. What a user observes is therefore **the host the plugin
 * leaves behind**: which agents `opencode2 debug agents` would list, what each
 * one may do, which slash command appears, and how the session behaves when
 * that command is run.
 *
 * So the seam is `setupOpenCode2(context)` — the exact callback the real
 * `Plugin.define({ id: "weave", setup })` entry registers — driven against a
 * host double that records what the plugin did to it. A `.weave` file goes in,
 * a populated host comes out, and nothing in between is asserted.
 *
 * The project root is a real temporary directory because the catalog reads
 * config, prompt and plan files from disk through `Bun.file`. The global
 * `~/.weave` scope is redirected to an empty fixture by
 * [`scripts/test-setup.ts`](../../scripts/test-setup.ts), so a scenario sees
 * only the config it declared.
 *
 * This file shares nothing with [`opencode.ts`](opencode.ts): the V1 and V2
 * adapters are independent packages with different plugin shapes, and
 * [`docs/opencode2-adapter.md`](../../docs/opencode2-adapter.md) requires that
 * independence to be respected here too.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OpenCode2Context } from "../../packages/adapters/opencode2/src/v2/host-types.js";

/** A model as the host's catalog would report it. */
export interface HostModel {
  readonly providerID: string;
  readonly id: string;
  readonly variants?: readonly string[];
}

/** A skill as the host's skill inventory would report it. */
export interface HostSkill {
  readonly id: string;
  readonly name: string;
}

/** An agent record as the host holds it after the plugin has run. */
export interface HostAgent {
  readonly id: string;
  name: string;
  description?: string;
  system?: string;
  mode?: string;
  model?: { readonly providerID: string; readonly id: string };
  permissions: Array<{ action: string; resource: string; effect: string }>;
  [key: string]: unknown;
}

/** One call the plugin made into the host's session API. */
export interface SessionCall {
  readonly name: "switchAgent" | "switchModel" | "prompt" | "synthetic" | "get";
  readonly input: Record<string, unknown>;
}

/** An error an RPC handler returned, rather than a successful payload. */
export interface RpcFailure {
  readonly rpcError: true;
  readonly code: string;
  readonly message: string;
  readonly data?: unknown;
}

export function isRpcFailure(value: unknown): value is RpcFailure {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { rpcError?: unknown }).rpcError === true
  );
}

export interface HostOptions {
  /** Models the host's catalog reports. Defaults to one `probe/fast` model. */
  readonly models?: readonly HostModel[];
  /** Skills the host's inventory reports. Defaults to none. */
  readonly skills?: readonly HostSkill[];
  /**
   * Agents already present in the host before Weave runs — another plugin's,
   * or a built-in. Weave must not overwrite these.
   */
  readonly foreignAgents?: readonly string[];
  /** Plugin options as they would appear in `opencode.jsonc`. */
  readonly options?: Record<string, unknown>;
  /** The host's workspace identity. */
  readonly workspaceID?: string;
  /** The agent the session currently has selected. */
  readonly sessionAgent?: string;
  /**
   * The directory the session reports, when it differs from the plugin's —
   * i.e. a session belonging to another Location.
   */
  readonly sessionDirectory?: string;
  /** Makes `session.prompt` reject, as an overloaded host would. */
  readonly promptFails?: boolean;
  /** Makes the host refuse to install session hooks. */
  readonly refuseHooks?: boolean;
  /**
   * Defers agent transforms until the host next lists agents, which is how
   * the real host applies them.
   */
  readonly lazyAgents?: boolean;
}

function modelRecord(model: HostModel) {
  return {
    id: model.id,
    modelID: model.id,
    providerID: model.providerID,
    name: model.id,
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    variants: (model.variants ?? []).map((variant) => ({ id: variant })),
    time: { released: 0 },
    cost: [],
    status: "active",
    enabled: true,
    limit: { context: 1_000, output: 1_000 },
  };
}

/**
 * Rules the host itself puts on every new agent record.
 *
 * `todo` is outside Weave's five abstract dimensions, so it must survive;
 * `read` is inside them, so Weave must replace it.
 */
export const HOST_DEFAULT_PERMISSIONS: ReadonlyArray<{
  action: string;
  resource: string;
  effect: string;
}> = [
  { action: "todo", resource: "*", effect: "allow" },
  { action: "read", resource: "*", effect: "deny" },
];

/** An event stream the scenario drives, closed by the plugin's abort signal. */
class HostEvents {
  private readonly queue: unknown[] = [];
  private waiters: Array<() => void> = [];

  emit(event: unknown): void {
    this.queue.push(event);
    this.wake();
  }

  private wake(): void {
    const pending = this.waiters;
    this.waiters = [];
    for (const resolve of pending) resolve();
  }

  async *subscribe({ signal }: { signal: AbortSignal }): AsyncGenerator<never> {
    signal.addEventListener("abort", () => this.wake(), { once: true });
    while (!signal.aborted) {
      while (this.queue.length > 0) {
        const event = this.queue.shift();
        if (signal.aborted) return;
        yield event as never;
      }
      if (signal.aborted) return;
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
      });
    }
  }
}

/**
 * A stand-in for a running OpenCode 2 host.
 *
 * It records only what the host would end up holding — agents, the default
 * agent, commands, session hooks, RPC handlers and the session calls a command
 * made — so a scenario can assert on the same things `opencode2 debug agents`
 * or a live session would show.
 */
export class OpenCode2Host {
  readonly agents = new Map<string, HostAgent>();
  readonly commands = new Map<
    string,
    { execute: (input: unknown) => Promise<void> }
  >();
  readonly hooks = new Map<string, (input: never) => Promise<void>>();
  readonly sessionCalls: SessionCall[] = [];
  readonly planEvents: Array<Record<string, unknown>> = [];
  readonly disposed: string[] = [];
  readonly reloads: string[] = [];
  defaultAgent: string | undefined;

  private readonly events = new HostEvents();
  private rpcHandlers: Record<
    string,
    (input: never, context: never) => Promise<unknown>
  > = {};
  private replay: (() => void) | undefined;
  private readonly storage = new Map<string, unknown>();
  private models: readonly HostModel[];
  private skills: readonly HostSkill[];

  constructor(
    readonly root: string,
    private readonly options: HostOptions = {},
  ) {
    this.models = options.models ?? [{ providerID: "probe", id: "fast" }];
    this.skills = options.skills ?? [];
    for (const name of options.foreignAgents ?? []) {
      this.agents.set(name, {
        id: name,
        name,
        description: "a plugin that was here first",
        system: "foreign prompt",
        mode: "primary",
        permissions: [{ action: "read", resource: "*", effect: "deny" }],
      });
    }
  }

  /** Replaces the host's model inventory, as installing a provider would. */
  setModels(models: readonly HostModel[]): void {
    this.models = models;
  }

  /** Replaces the host's skill inventory, as adding a skill file would. */
  setSkills(skills: readonly HostSkill[]): void {
    this.skills = skills;
  }

  /** Tells the plugin the host's inventory changed, as the real host does. */
  emitInventoryChange(type: "model.updated" | "skill.updated"): void {
    this.events.emit({
      type,
      location: {
        directory: this.root,
        workspaceID: this.options.workspaceID ?? "workspace",
      },
    });
  }

  /** Every agent the host holds, sorted — what `debug agents` would list. */
  agentNames(): string[] {
    this.flush();
    return [...this.agents.keys()].sort();
  }

  /** One agent, by the id a user would type. */
  agent(name: string): HostAgent {
    this.flush();
    const agent = this.agents.get(name);
    if (agent === undefined) {
      throw new Error(
        `no agent "${name}" — host holds [${[...this.agents.keys()].join(", ")}]`,
      );
    }
    return agent;
  }

  /** The effect an agent's rules give one action on one resource. */
  effectFor(name: string, action: string, resource = "*"): string | undefined {
    const matches = this.agent(name).permissions.filter(
      (rule) => rule.action === action && rule.resource === resource,
    );
    // V2 evaluates rules last-match-wins.
    return matches.at(-1)?.effect;
  }

  /** The effect each of `actions` resolves to for one agent. */
  effectsFor(name: string, actions: readonly string[]): (string | undefined)[] {
    return actions.map((action) => this.effectFor(name, action));
  }

  /** The `action:resource` pairs one agent's rules name, in rule order. */
  ruleOrder(name: string): string[] {
    return this.agent(name).permissions.map(
      (rule) => `${rule.action}:${rule.resource}`,
    );
  }

  /** The slash commands the host offers, sorted. */
  commandNames(): string[] {
    return [...this.commands.keys()].sort();
  }

  /** Runs a registered slash command the way a user typing it would. */
  async runCommand(name: string, text: string): Promise<void> {
    const command = this.commands.get(name);
    if (command === undefined) {
      throw new Error(
        `no command "${name}" — host offers [${this.commandNames().join(", ")}]`,
      );
    }
    await command.execute({
      sessionID: "session",
      prompt: { id: "command-prompt", text, files: [] },
      delivery: "queue",
    });
  }

  /** The session hooks the plugin installed, in registration order. */
  hookNames(): string[] {
    return [...this.hooks.keys()];
  }

  /** Delivers a user prompt through the host's `prompt` hook. */
  async promptSession(
    prompt: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    const hook = this.hooks.get("prompt");
    const payload = { sessionID: "session", prompt: { text: "hi", ...prompt } };
    if (hook !== undefined) await hook(payload as never);
    return payload.prompt;
  }

  /** Builds a model request through the host's `context` hook. */
  async contextForAgent(agent: string): Promise<Record<string, unknown>> {
    const hook = this.hooks.get("context");
    const payload = { sessionID: "session", agent, options: {} };
    if (hook !== undefined) await hook(payload as never);
    return payload.options;
  }

  /** Calls one of the plugin's RPC methods the way the TUI panel does. */
  async rpc(
    method: string,
    input: Record<string, unknown> = {},
  ): Promise<unknown> {
    const handler = this.rpcHandlers[method];
    if (handler === undefined) {
      throw new Error(
        `no RPC method "${method}" — plugin registered [${Object.keys(this.rpcHandlers).join(", ")}]`,
      );
    }
    return handler(
      {
        sessionID: "session",
        directory: this.root,
        workspaceID: this.options.workspaceID ?? "workspace",
        scopeToken: "token",
        ...input,
      } as never,
      {
        error: (code: string, message: string, data?: unknown): RpcFailure => ({
          rpcError: true,
          code,
          message,
          data,
        }),
      } as never,
    );
  }

  /** The names of the session calls a command made, in order. */
  sessionCallNames(): string[] {
    return this.sessionCalls
      .filter((call) => call.name !== "get")
      .map((call) => call.name);
  }

  /** The input of the last session call of one kind. */
  lastSessionCall(
    name: SessionCall["name"],
  ): Record<string, unknown> | undefined {
    return this.sessionCalls.filter((call) => call.name === name).at(-1)?.input;
  }

  private flush(): void {
    const replay = this.replay;
    this.replay = undefined;
    replay?.();
  }

  private registration(name: string) {
    return {
      dispose: async (): Promise<void> => {
        this.disposed.push(name);
      },
    };
  }

  private applyAgentTransform(transform: (editor: unknown) => void): void {
    transform({
      get: (id: string) => this.agents.get(id),
      list: () => [...this.agents.values()],
      remove: (id: string) => this.agents.delete(id),
      default: (id: string) => {
        this.defaultAgent = id;
      },
      update: (id: string, update: (agent: HostAgent) => void) => {
        const agent: HostAgent = this.agents.get(id) ?? {
          id,
          name: id,
          mode: "primary",
          // A real host hands out an agent record that already carries its
          // own safeguards, including for actions Weave does not manage.
          permissions: [...HOST_DEFAULT_PERMISSIONS],
        };
        update(agent);
        this.agents.set(id, agent);
      },
    });
  }

  private recordSession(
    name: SessionCall["name"],
    input: Record<string, unknown>,
  ): void {
    this.sessionCalls.push({ name, input });
  }

  /** The `Context` the real host hands `setup()`. */
  get context(): OpenCode2Context {
    return {
      options: this.options.options ?? {},
      location: {
        directory: this.root,
        workspaceID: this.options.workspaceID ?? "workspace",
      },
      model: {
        list: async () => ({ data: this.models.map(modelRecord) }),
      },
      skill: {
        list: async () => ({
          data: this.skills.map((skill) => ({
            id: skill.id,
            name: skill.name,
            location: "/skills",
            content: `# ${skill.name}`,
          })),
        }),
      },
      event: {
        subscribe: (args: { signal: AbortSignal }) =>
          this.events.subscribe(args),
      },
      agent: {
        transform: async (transform: (editor: unknown) => void) => {
          const apply = () => this.applyAgentTransform(transform);
          if (this.options.lazyAgents === true) this.replay = apply;
          else apply();
          return this.registration("agent");
        },
        list: async () => {
          this.flush();
          return { data: [...this.agents.values()] };
        },
        reload: async () => {
          this.reloads.push("agent");
        },
      },
      command: {
        transform: async (transform: (editor: unknown) => void) => {
          transform({
            add: (command: {
              name: string;
              execute: (input: unknown) => Promise<void>;
            }) => {
              this.commands.set(command.name, command);
            },
          });
          return this.registration("command");
        },
        reload: async () => {
          this.reloads.push("command");
        },
      },
      session: {
        hook: async (
          name: string,
          callback: (input: never) => Promise<void>,
        ) => {
          if (this.options.refuseHooks === true) {
            throw new Error(`the host refuses the ${name} hook`);
          }
          this.hooks.set(name, callback);
          return this.registration(name);
        },
        get: async ({ sessionID }: { sessionID: string }) => {
          this.recordSession("get", { sessionID });
          return {
            location: {
              directory: this.options.sessionDirectory ?? this.root,
              workspaceID: this.options.workspaceID ?? "workspace",
            },
            agent: this.options.sessionAgent,
            model: { providerID: "probe", id: "previous" },
          };
        },
        switchAgent: async (input: Record<string, unknown>) => {
          this.recordSession("switchAgent", input);
        },
        switchModel: async (input: Record<string, unknown>) => {
          this.recordSession("switchModel", input);
        },
        prompt: async (input: Record<string, unknown>) => {
          this.recordSession("prompt", input);
          if (this.options.promptFails === true) throw new Error("rejected");
        },
        synthetic: async (input: Record<string, unknown>) => {
          this.recordSession("synthetic", input);
        },
      },
      rpc: {
        register: async (
          _schema: unknown,
          handlers: Record<
            string,
            (input: never, context: never) => Promise<unknown>
          >,
        ) => {
          this.rpcHandlers = handlers;
          return {
            ...this.registration("rpc"),
            events: {
              emit: async (name: string, payload: Record<string, unknown>) => {
                this.planEvents.push({ name, ...payload });
              },
            },
          };
        },
      },
      storage: {
        get: async (key: string) => this.storage.get(key),
        set: async (key: string, value: unknown) => {
          this.storage.set(key, value);
        },
        remove: async (key: string) => {
          this.storage.delete(key);
        },
      },
    } as unknown as OpenCode2Context;
  }
}

/**
 * A unique temporary directory path.
 *
 * `AGENTS.md` forbids the Node `fs` runtime surface, so this does not call
 * `mkdtemp`. `Bun.write()` creates parent directories on demand.
 */
function tempProjectPath(): string {
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return join(tmpdir(), `weave-opencode2-scenario-${unique}`);
}

/** Removes a directory tree through Bun's process API rather than `node:fs`. */
async function removeTree(dir: string): Promise<void> {
  const proc = Bun.spawn(["rm", "-rf", dir], {
    stdout: "ignore",
    stderr: "ignore",
  });
  await proc.exited;
}

/**
 * Runs `body` against a temporary project whose files are `files`, keyed by
 * path relative to the project root. The directory is removed afterwards.
 */
export async function withOpenCode2Project<T>(
  files: Readonly<Record<string, string>>,
  body: (root: string) => Promise<T>,
): Promise<T> {
  const root = tempProjectPath();
  for (const [path, content] of Object.entries(files)) {
    await Bun.write(join(root, path), content);
  }
  try {
    return await body(root);
  } finally {
    await removeTree(root);
  }
}

/**
 * Loads a `.weave` config into a live OpenCode 2 host and hands `body` the
 * host the plugin left behind. Cleanup runs afterwards, exactly as it would
 * when the host deactivates the plugin.
 */
export async function withWeaveOnOpenCode2<T>(
  input: {
    readonly config?: string;
    readonly files?: Readonly<Record<string, string>>;
    readonly host?: HostOptions;
  },
  body: (host: OpenCode2Host) => Promise<T>,
): Promise<T> {
  const { setupOpenCode2 } = await import(
    "../../packages/adapters/opencode2/src/v2/plugin.js"
  );
  const files: Record<string, string> = { ...input.files };
  if (input.config !== undefined) files[".weave/config.weave"] = input.config;
  return withOpenCode2Project(files, async (root) => {
    const host = new OpenCode2Host(root, input.host);
    const cleanup = await setupOpenCode2(host.context);
    try {
      return await body(host);
    } finally {
      await cleanup();
    }
  });
}

/**
 * Loads a `.weave` config into a host and returns that host once the plugin
 * has been deactivated again — for scenarios that only look at what the host
 * ended up holding, rather than driving a session.
 */
export function loadWeaveOnOpenCode2(input: {
  readonly config?: string;
  readonly files?: Readonly<Record<string, string>>;
  readonly host?: HostOptions;
}): Promise<OpenCode2Host> {
  return withWeaveOnOpenCode2(input, async (host) => host);
}
