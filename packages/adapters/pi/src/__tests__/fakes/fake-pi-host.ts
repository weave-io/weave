import { ADAPTER_PACKAGE_IDENTITY } from "../../commands.js";
import type {
  Clock,
  IdGenerator,
  PiAdapterLogger,
  PiCommandInfo,
  PiCommandRegistration,
  PiEventHandler,
  PiExtensionApi,
  PiMode,
  PiSessionContext,
  PiSourceInfo,
  PiToolInfo,
  PiUiNotifyLevel,
  PiUiPort,
} from "../../types.js";

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

export interface FakePiHostOptions {
  readonly mode?: PiMode;
  readonly trusted?: boolean;
  readonly cwd?: string;
  readonly installPath?: string;
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

  private mode: PiMode;
  private trusted: boolean;
  private readonly cwd: string;
  private readonly installPath: string;
  private commandsInventory: PiCommandInfo[] = [];
  private toolsInventory: PiToolInfo[] = [];
  private readonly handlers = new Map<string, PiEventHandler[]>();
  private getCommandsOverride: (() => readonly PiCommandInfo[]) | undefined;
  private getAllToolsOverride: (() => readonly PiToolInfo[]) | undefined;

  constructor(options: FakePiHostOptions = {}) {
    this.mode = options.mode ?? "tui";
    this.trusted = options.trusted ?? true;
    this.cwd = options.cwd ?? "/fake/project";
    this.installPath = options.installPath ?? "/fake/node_modules";
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
    };
    return {
      mode,
      cwd,
      isProjectTrusted: () => trusted,
      ui,
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

  /** Invokes a registered command handler by name with a fresh context, returning the context used. */
  async invokeCommand(name: string, rawArgs = ""): Promise<PiSessionContext> {
    const ctx = this.createSessionContext();
    const call = this.registerCommandCalls.find((entry) => entry.name === name);
    if (call === undefined) throw new Error(`command not registered: ${name}`);
    await call.registration.handler(rawArgs, ctx);
    return ctx;
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
