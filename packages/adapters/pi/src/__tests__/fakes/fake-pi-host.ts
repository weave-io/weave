import type { MaterializationPlan } from "@weaveio/weave-engine";
import { okAsync } from "neverthrow";
import { ADAPTER_PACKAGE_IDENTITY } from "../../commands.js";
import type {
  PiConfigLoaderPort,
  PiMaterializerPort,
} from "../../config-activator.js";
import { PiConfigActivator } from "../../config-activator.js";
import type {
  Clock,
  IdGenerator,
  PiAdapterLogger,
  PiCommandInfo,
  PiCommandRegistration,
  PiEventHandler,
  PiExtensionApi,
  PiMode,
  PiModelInfo,
  PiModelRegistry,
  PiSessionContext,
  PiSkillInfo,
  PiSourceInfo,
  PiToolCallEvent,
  PiToolCallEventResult,
  PiToolInfo,
  PiToolRegistration,
  PiUiDialogOptions,
  PiUiNotifyLevel,
  PiUiPort,
} from "../../types.js";

/**
 * Builds a `PiSourceInfo` matching Pi's own documented shape for a genuine
 * built-in tool (`docs/extensions.md`: `getAllTools()` reports built-ins
 * with `sourceInfo: { path: "<builtin:NAME>", source: "builtin", scope:
 * "temporary", origin: "top-level" }`). No extension can set `source:
 * "builtin"` through the public `registerTool()` API - only Pi's own
 * runtime assigns it - so this is the fake's canonical "real built-in"
 * fixture.
 */
export function piBuiltinSourceInfo(toolName: string): PiSourceInfo {
  return {
    path: `<builtin:${toolName}>`,
    source: "builtin",
    scope: "temporary",
    origin: "top-level",
  };
}

/** Builds a `PiSourceInfo` for a rival (non-Weave) extension's registration. */
export function foreignToolSourceInfo(
  overrides: Partial<PiSourceInfo> = {},
): PiSourceInfo {
  return {
    path: "/fake/node_modules/some-other-extension/dist/index.js",
    source: "npm:some-other-extension",
    scope: "user",
    origin: "package",
    ...overrides,
  };
}

export interface RecordedCommandRegistration {
  readonly name: string;
  readonly registration: PiCommandRegistration;
}

export interface RecordedEventSubscription {
  readonly event: string;
  readonly handler: PiEventHandler;
}

export interface RecordedNotify {
  readonly message: string;
  readonly level: PiUiNotifyLevel | undefined;
}

export interface RecordedStatus {
  readonly key: string;
  readonly value: string | undefined;
}

export interface RecordedWidget {
  readonly key: string;
  readonly value: unknown;
}

export interface RecordedSelectCall {
  readonly title: string;
  readonly options: readonly string[];
  readonly opts: PiUiDialogOptions | undefined;
}

export interface RecordedConfirmCall {
  readonly title: string;
  readonly message: string;
  readonly opts: PiUiDialogOptions | undefined;
}

export interface FakePiHostOptions {
  readonly mode?: PiMode;
  readonly trusted?: boolean;
  readonly cwd?: string;
  readonly installPath?: string;
  readonly currentModel?: PiModelInfo;
  readonly availableModels?: readonly PiModelInfo[];
  readonly hasUI?: boolean;
}

/**
 * Records every call an extension makes against a narrow, adapter-owned
 * port surface (Spec 33 §24, layer C/D). Supports fresh contexts per
 * generation, mode/trust simulation, foreign-command collision injection,
 * and host failure injection (a poisoned `getCommands`/`getAllTools`).
 *
 * This is not a reimplementation of the real Pi `ExtensionAPI` - it is a
 * test double for this adapter's own `PiExtensionApi`/`PiSessionContext`
 * ports, which is what `src/extension.ts` adapts the real host into.
 */
export class RecordingFakePiHost {
  readonly registerCommandCalls: RecordedCommandRegistration[] = [];
  readonly onCalls: RecordedEventSubscription[] = [];
  readonly notifyCalls: RecordedNotify[] = [];
  readonly statusCalls: RecordedStatus[] = [];
  readonly widgetCalls: RecordedWidget[] = [];

  /**
   * Records every model `setModel` was *invoked* with, regardless of
   * outcome - applied, declined (`false`), still-pending (`deferNextSetModel`),
   * or about to throw (`poisonSetModel`). Use `currentModel` to observe
   * whether an invocation actually took effect.
   */
  readonly setModelCalls: PiModelInfo[] = [];
  readonly registerToolCalls: PiToolRegistration[] = [];
  readonly selectCalls: RecordedSelectCall[] = [];
  readonly confirmCalls: RecordedConfirmCall[] = [];

  private mode: PiMode;
  private trusted: boolean;
  private hasUI: boolean;
  private readonly cwd: string;
  private readonly installPath: string;
  private commandsInventory: PiCommandInfo[] = [];
  private toolsInventory: PiToolInfo[] = [];
  private selectResponses: (string | undefined)[] = [];
  private confirmResponses: boolean[] = [];
  private currentModel: PiModelInfo | undefined;
  private availableModels: readonly PiModelInfo[];
  private readonly handlers = new Map<string, PiEventHandler[]>();
  private getCommandsOverride: (() => readonly PiCommandInfo[]) | undefined;
  private getAllToolsOverride: (() => readonly PiToolInfo[]) | undefined;
  private setModelOverride:
    | ((model: PiModelInfo) => boolean | Promise<boolean>)
    | undefined;
  private registerToolOverride:
    | ((tool: PiToolRegistration) => void)
    | undefined;
  private getAvailableModelsOverride:
    | (() => readonly PiModelInfo[])
    | undefined;

  constructor(options: FakePiHostOptions = {}) {
    this.mode = options.mode ?? "tui";
    this.trusted = options.trusted ?? true;
    this.hasUI = options.hasUI ?? true;
    this.cwd = options.cwd ?? "/fake/project";
    this.installPath = options.installPath ?? "/fake/node_modules";
    this.currentModel = options.currentModel;
    this.availableModels = options.availableModels ?? [];
  }

  /** The object handed to an extension's default factory. */
  readonly api: PiExtensionApi = {
    registerCommand: (name, registration) => {
      this.registerCommandCalls.push({ name, registration });
      this.commandsInventory.push({
        name,
        description: registration.description,
        source: "extension",
        sourceInfo: this.ownSourceInfo(),
      });
    },
    getCommands: () => {
      if (this.getCommandsOverride !== undefined)
        return this.getCommandsOverride();
      return [...this.commandsInventory];
    },
    getAllTools: () => {
      if (this.getAllToolsOverride !== undefined)
        return this.getAllToolsOverride();
      return [...this.toolsInventory];
    },
    on: (event, handler) => {
      this.onCalls.push({ event, handler });
      const existing = this.handlers.get(event) ?? [];
      existing.push(handler);
      this.handlers.set(event, existing);
    },
    setModel: (model) => {
      this.setModelCalls.push(model);
      if (this.setModelOverride !== undefined) {
        return this.setModelOverride(model);
      }
      this.currentModel = model;
      return true;
    },
    registerTool: (tool) => {
      this.registerToolCalls.push(tool);
      if (this.registerToolOverride !== undefined) {
        this.registerToolOverride(tool);
        return;
      }
      this.toolsInventory = this.toolsInventory.filter(
        (existing) => existing.name !== tool.name,
      );
      this.toolsInventory.push({
        name: tool.name,
        description: tool.description,
        sourceInfo: this.ownSourceInfo(),
      });
    },
  };

  private ownSourceInfo(): PiSourceInfo {
    return {
      path: `${this.installPath}/${ADAPTER_PACKAGE_IDENTITY}/dist/extension.js`,
      source: `npm:${ADAPTER_PACKAGE_IDENTITY}`,
      scope: "user",
      origin: "package",
    };
  }

  setMode(mode: PiMode): void {
    this.mode = mode;
  }

  setTrusted(trusted: boolean): void {
    this.trusted = trusted;
  }

  /** Inserts a command entry not owned by this package, simulating a rival extension. */
  injectForeignCommand(
    name: string,
    sourceOverrides: Partial<PiSourceInfo> = {},
  ): void {
    this.commandsInventory.push({
      name,
      source: "extension",
      sourceInfo: {
        path: "/fake/node_modules/some-other-extension/dist/index.js",
        source: "npm:some-other-extension",
        scope: "user",
        origin: "package",
        ...sourceOverrides,
      },
    });
  }

  /** Simulates Pi assigning our registration a numeric collision suffix. */
  renameOwnCommand(originalName: string, suffixedName: string): void {
    const index = this.commandsInventory.findIndex(
      (command) =>
        command.name === originalName &&
        command.sourceInfo.origin === "package" &&
        command.sourceInfo.source === `npm:${ADAPTER_PACKAGE_IDENTITY}`,
    );
    if (index === -1) return;
    this.commandsInventory[index] = {
      ...this.commandsInventory[index],
      name: suffixedName,
    };
  }

  injectTool(tool: PiToolInfo): void {
    this.toolsInventory.push(tool);
  }

  /**
   * Simulates a (possibly foreign) extension calling `registerTool()` for a
   * name that already exists - Pi replaces the existing entry rather than
   * duplicating it, so a later call always wins as the single source of
   * truth for that name (`docs/extensions.md`: "Extensions can override
   * built-in tools ... by registering a tool with the same name").
   */
  displaceTool(name: string, sourceInfo: PiSourceInfo): void {
    this.toolsInventory = this.toolsInventory.filter((t) => t.name !== name);
    this.toolsInventory.push({ name, sourceInfo });
  }

  /** Makes the next `registerTool()` call throw, simulating a broken host. */
  poisonRegisterTool(): void {
    this.registerToolOverride = () => {
      throw new Error("simulated host failure: registerTool");
    };
  }

  setHasUI(hasUI: boolean): void {
    this.hasUI = hasUI;
  }

  /** Queues the next `ctx.ui.select()` response. `undefined` simulates a cancel (Esc). */
  scriptSelect(response: string | undefined): void {
    this.selectResponses.push(response);
  }

  /** Queues the next `ctx.ui.confirm()` response. */
  scriptConfirm(response: boolean): void {
    this.confirmResponses.push(response);
  }

  setModels(models: readonly PiModelInfo[]): void {
    this.availableModels = models;
  }

  setCurrentModel(model: PiModelInfo | undefined): void {
    this.currentModel = model;
  }

  /** The model currently applied on the host, for test observability. */
  getCurrentModel(): PiModelInfo | undefined {
    return this.currentModel;
  }

  /** Makes the next `modelRegistry.getAvailable()` call throw. */
  poisonGetAvailableModels(): void {
    this.getAvailableModelsOverride = () => {
      // Deliberately sensitive-looking content: proves callers never
      // surface a thrown message's content into logs or failures.
      throw new Error(
        "leaked: /Users/attacker/.ssh/id_rsa token=sk-super-secret-123",
      );
    };
  }

  /** Makes the next `setModel()` call throw, simulating a host that rejects the selection with an exception. */
  poisonSetModel(): void {
    this.setModelOverride = () => {
      throw new Error("simulated host failure: setModel");
    };
  }

  /**
   * Makes the next `setModel()` call resolve to `false` *without* throwing,
   * simulating a host that declines the selection silently (distinct from
   * `poisonSetModel()`'s thrown-exception case).
   */
  declineNextSetModel(): void {
    this.setModelOverride = () => false;
  }

  /**
   * Makes the next `setModel()` call return a pending promise that only
   * settles once `settle()` is invoked, letting tests exercise a session
   * replacement while a model application is still in flight.
   */
  deferNextSetModel(): { settle: (succeeded: boolean) => void } {
    let resolveFn!: (value: boolean) => void;
    const promise = new Promise<boolean>((resolve) => {
      resolveFn = resolve;
    });
    this.setModelOverride = () => promise;
    return {
      settle: (succeeded: boolean) => resolveFn(succeeded),
    };
  }

  /**
   * Defers the next `select()` response indefinitely until `settle()` is
   * called - lets a test drive another event (e.g. a fresh `session_start`
   * producing a new controller generation) while an approval prompt is
   * still in flight, then resolve it.
   */
  deferNextSelect(): { settle: (response: string | undefined) => void } {
    let resolveFn!: (value: string | undefined) => void;
    const promise = new Promise<string | undefined>((resolve) => {
      resolveFn = resolve;
    });
    const originalShift = this.selectResponses.shift.bind(this.selectResponses);
    this.selectResponses.shift = () => {
      this.selectResponses.shift = originalShift;
      return promise as unknown as string | undefined;
    };
    return { settle: (response) => resolveFn(response) };
  }

  /** Makes the next `getCommands()` calls throw, simulating a broken host. */
  poisonGetCommands(): void {
    this.getCommandsOverride = () => {
      throw new Error("simulated host failure: getCommands");
    };
  }

  /** Makes `getCommands()` return a payload that fails schema validation. */
  returnMalformedCommands(): void {
    this.getCommandsOverride = () =>
      [{ name: 42 }] as unknown as readonly PiCommandInfo[];
  }

  poisonGetAllTools(): void {
    this.getAllToolsOverride = () => {
      throw new Error("simulated host failure: getAllTools");
    };
  }

  /** Builds a brand-new session context object, never shared across generations. */
  createSessionContext(): PiSessionContext {
    const mode = this.mode;
    const trusted = this.trusted;
    const cwd = this.cwd;
    const model = this.currentModel;
    const modelRegistry: PiModelRegistry = {
      getAvailable: () => {
        if (this.getAvailableModelsOverride !== undefined) {
          return this.getAvailableModelsOverride();
        }
        return this.availableModels;
      },
    };
    const ui: PiUiPort = {
      notify: (message, level) => {
        this.notifyCalls.push({ message, level });
      },
      setStatus: (key, value) => {
        this.statusCalls.push({ key, value });
      },
      setWidget: (key, value) => {
        this.widgetCalls.push({ key, value });
      },
      select: async (title, options, opts) => {
        this.selectCalls.push({ title, options, opts });
        return this.selectResponses.shift();
      },
      confirm: async (title, message, opts) => {
        this.confirmCalls.push({ title, message, opts });
        return this.confirmResponses.shift() ?? false;
      },
    };
    return {
      mode,
      cwd,
      isProjectTrusted: () => trusted,
      ui,
      hasUI: this.hasUI,
      model,
      modelRegistry,
    };
  }

  /** Fires every registered `session_start` handler against a fresh context, returning it. */
  async triggerSessionStart(): Promise<PiSessionContext> {
    const ctx = this.createSessionContext();
    const handlers = this.handlers.get("session_start") ?? [];
    for (const handler of handlers) {
      await handler({ reason: "startup" }, ctx);
    }
    return ctx;
  }

  async triggerSessionShutdown(): Promise<PiSessionContext> {
    const ctx = this.createSessionContext();
    const handlers = this.handlers.get("session_shutdown") ?? [];
    for (const handler of handlers) {
      await handler({ reason: "shutdown" }, ctx);
    }
    return ctx;
  }

  /**
   * Fires every registered `before_agent_start` handler in registration
   * order, chaining each handler's returned `systemPrompt` (if any) into the
   * next handler's `event.systemPrompt`, mirroring Pi's own chaining
   * behavior (docs/extensions.md). Returns the final chained value.
   */
  async triggerBeforeAgentStart(
    event: Record<string, unknown> = {},
    skills: readonly PiSkillInfo[] = [],
  ): Promise<{ systemPrompt: string | undefined; results: unknown[] }> {
    const ctx = this.createSessionContext();
    const handlers = this.handlers.get("before_agent_start") ?? [];
    let systemPrompt = event.systemPrompt as string | undefined;
    const results: unknown[] = [];
    for (const handler of handlers) {
      const result = await handler(
        { ...event, systemPrompt, systemPromptOptions: { skills } },
        ctx,
      );
      results.push(result);
      if (
        typeof result === "object" &&
        result !== null &&
        "systemPrompt" in result &&
        typeof (result as { systemPrompt?: unknown }).systemPrompt === "string"
      ) {
        systemPrompt = (result as { systemPrompt: string }).systemPrompt;
      }
    }
    return { systemPrompt, results };
  }

  /** Invokes a registered command handler by name with a fresh context, returning the context used. */
  async invokeCommand(name: string, rawArgs = ""): Promise<PiSessionContext> {
    const ctx = this.createSessionContext();
    const call = this.registerCommandCalls.find((entry) => entry.name === name);
    if (call === undefined) throw new Error(`command not registered: ${name}`);
    await call.registration.handler(rawArgs, ctx);
    return ctx;
  }

  /**
   * Fires every registered `tool_call` handler in registration order,
   * mirroring Pi's real behavior: later handlers see any mutation an
   * earlier handler made to `event.input`, and a `{block: true}` result
   * stops further handlers from running (Spec 33 §12.1). Returns the
   * blocking result, or `undefined` if every handler allowed the call.
   */
  async triggerToolCall(
    event: PiToolCallEvent,
  ): Promise<PiToolCallEventResult | undefined> {
    const ctx = this.createSessionContext();
    const handlers = this.handlers.get("tool_call") ?? [];
    for (const handler of handlers) {
      const result = (await handler(event, ctx)) as
        | PiToolCallEventResult
        | undefined;
      if (result?.block === true) return result;
    }
    return undefined;
  }
}

export class FakeIdGenerator implements IdGenerator {
  private counter = 0;
  next(): string {
    this.counter += 1;
    return `generation-${this.counter}`;
  }
}

export class FakeClock implements Clock {
  private current: number;
  constructor(start = 0) {
    this.current = start;
  }
  now(): number {
    return this.current;
  }
  advance(ms: number): void {
    this.current += ms;
  }
}

/**
 * A fully in-memory `PiConfigActivator` whose `configLoader`/`materializer`
 * ports are directly injected fixtures - it never touches `Bun.file()`,
 * the network, or a real developer config, matching AGENTS.md's testing
 * rules for adapter/harness-crossing modules.
 */
export function fakeConfigActivator(
  plan: MaterializationPlan = { agents: [], errors: [] },
): PiConfigActivator {
  const configLoader: PiConfigLoaderPort = {
    load: () =>
      okAsync({ agents: {}, disabled: { agents: [], skills: [] } } as never),
  };
  const materializer: PiMaterializerPort = {
    materialize: () => okAsync(plan),
  };
  return new PiConfigActivator({ configLoader, materializer });
}

export class RecordingLogger implements PiAdapterLogger {
  readonly entries: {
    level: string;
    obj: Record<string, unknown>;
    msg?: string;
  }[] = [];
  debug(obj: Record<string, unknown>, msg?: string): void {
    this.entries.push({ level: "debug", obj, msg });
  }
  info(obj: Record<string, unknown>, msg?: string): void {
    this.entries.push({ level: "info", obj, msg });
  }
  warn(obj: Record<string, unknown>, msg?: string): void {
    this.entries.push({ level: "warn", obj, msg });
  }
  error(obj: Record<string, unknown>, msg?: string): void {
    this.entries.push({ level: "error", obj, msg });
  }
}
