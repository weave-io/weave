import type { WeaveConfig } from "@weaveio/weave-core";
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
  PiSessionManagerPort,
  PiSkillInfo,
  PiSourceInfo,
  PiTerminalInputHandler,
  PiToolRegistration,
  PiUiDialogOptions,
  PiUiNotifyLevel,
  PiUiPort,
  PiUiThemePort,
} from "../../types.js";

/** Default host-reported persistent parent session for fake extension contexts. */
export function persistentFakeSessionManager(
  overrides: { readonly id?: string; readonly file?: string } = {},
): PiSessionManagerPort {
  const id = overrides.id ?? "fake-session-1";
  return {
    getSessionId: () => id,
    getSessionFile: () =>
      overrides.file ?? "/fake/sessions/fake-session-1.jsonl",
    isPersisted: () => true,
    // Mirror Pi 0.83's public SessionManager.getHeader(): the persisted file
    // header id is the stable origin. Fake hosts keep it equal to `id` unless
    // a test supplies a divergent manager of its own.
    getHeader: () => ({ id }),
  };
}

/** Host-reported `--no-session` / ephemeral parent for fake extension contexts. */
export function ephemeralFakeSessionManager(): PiSessionManagerPort {
  return {
    getSessionId: () => "ephemeral-session",
    getSessionFile: () => undefined,
    isPersisted: () => false,
  };
}

export interface FakeNativeSessionEntry {
  readonly type: string;
  readonly data: unknown;
}

/**
 * A persistent native-session stand-in shared by successive fake Pi hosts.
 * `reload()` returns a new view over the same durable map, so tests can prove
 * reload/recovery behaviour without touching the host filesystem.
 */
export class PersistentFakeNativeSessionStore {
  private readonly sessions = new Map<string, FakeNativeSessionEntry[]>();
  private readonly tombstones = new Set<string>();

  create(sessionId: string): void {
    if (!this.sessions.has(sessionId)) this.sessions.set(sessionId, []);
  }

  append(sessionId: string, entry: FakeNativeSessionEntry): boolean {
    const entries = this.sessions.get(sessionId);
    if (entries === undefined || this.tombstones.has(sessionId)) return false;
    entries.push(entry);
    return true;
  }

  read(sessionId: string): readonly FakeNativeSessionEntry[] | undefined {
    const entries = this.sessions.get(sessionId);
    return entries === undefined
      ? undefined
      : entries.map((entry) => ({ ...entry }));
  }

  tombstone(sessionId: string): void {
    this.tombstones.add(sessionId);
  }

  isTombstoned(sessionId: string): boolean {
    return this.tombstones.has(sessionId);
  }

  reload(): PersistentFakeNativeSessionStore {
    const next = new PersistentFakeNativeSessionStore();
    for (const [sessionId, entries] of this.sessions)
      next.sessions.set(
        sessionId,
        entries.map((entry) => ({ ...entry })),
      );
    for (const sessionId of this.tombstones) next.tombstones.add(sessionId);
    return next;
  }
}

/**
 * Pi's own documented default keys for the bindings custom components read.
 * Mirrors `TUI_KEYBINDINGS` so a fake host behaves like an unconfigured one.
 */
const DEFAULT_FAKE_KEYBINDING_KEYS: Record<string, readonly string[]> = {
  "tui.select.up": ["up"],
  "tui.select.down": ["down"],
  "tui.select.cancel": ["escape", "ctrl+c"],
};

export interface RecordedCommandRegistration {
  readonly name: string;
  readonly registration: PiCommandRegistration;
}

export interface RecordedEventSubscription {
  readonly event: string;
  readonly handler: PiEventHandler;
}

export interface RecordedShortcutRegistration {
  readonly shortcut: string;
  readonly registration: {
    readonly description?: string;
    readonly handler: (ctx: PiSessionContext) => void | Promise<void>;
  };
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

export interface RecordedSendMessage {
  readonly message: {
    readonly customType: string;
    readonly content: string;
    readonly display?: boolean;
  };
  readonly options:
    | {
        readonly triggerTurn?: boolean;
        readonly deliverAs?: "steer" | "followUp" | "nextTurn";
      }
    | undefined;
}

export interface FakePiHostOptions {
  readonly mode?: PiMode;
  readonly trusted?: boolean;
  readonly cwd?: string;
  readonly installPath?: string;
  readonly currentModel?: PiModelInfo;
  readonly availableModels?: readonly PiModelInfo[];
  readonly systemPromptSkills?: readonly PiSkillInfo[];
  readonly systemPromptOptionsAvailable?: boolean;
  readonly hasUI?: boolean;
  readonly idle?: boolean;
  /**
   * Optional Pi theme stand-in. Absent by default so existing assertions keep
   * observing the plain foreground-only badge text; supply one to observe the
   * themed active-agent badge exactly as the real host would render it.
   */
  readonly theme?: PiUiThemePort;
  /**
   * Host `ctx.sessionManager`. Defaults to a persistent session so production
   * delegation wiring keeps working. Pass `null` to omit the surface (unknown
   * / no-probe). Pass an ephemeral manager to simulate `--no-session`.
   */
  readonly sessionManager?: PiSessionManagerPort | null;
}

/**
 * Records every call an extension makes against a narrow, adapter-owned
 * port surface (Pi adapter contract,). Supports fresh contexts per
 * generation, mode/trust simulation, foreign-command collision injection,
 * and host failure injection.
 *
 * This is not a reimplementation of the real Pi `ExtensionAPI` - it is a
 * test double for this adapter's own `PiExtensionApi`/`PiSessionContext`
 * ports, which is what `src/extension.ts` adapts the real host into.
 */
export class RecordingFakePiHost {
  readonly registerCommandCalls: RecordedCommandRegistration[] = [];
  readonly registerShortcutCalls: RecordedShortcutRegistration[] = [];
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
  readonly setThinkingLevelCalls: string[] = [];
  readonly activationCalls: (
    | { readonly kind: "model"; readonly model: PiModelInfo }
    | { readonly kind: "thinking"; readonly level: string }
  )[] = [];
  readonly registerToolCalls: PiToolRegistration[] = [];
  readonly selectCalls: RecordedSelectCall[] = [];
  /** Select calls made by the settings activation boundary. */
  readonly settingsPopupCalls: RecordedSelectCall[] = [];
  readonly confirmCalls: RecordedConfirmCall[] = [];
  readonly sentUserMessages: {
    readonly content: string;
    readonly customType?: string;
    readonly display?: boolean;
    readonly options?: {
      readonly deliverAs?: "steer" | "followUp";
      readonly triggerTurn?: boolean;
    };
  }[] = [];
  readonly sendMessageCalls: RecordedSendMessage[] = [];
  beforeAgentStartCalls = 0;
  getSystemPromptOptionsCalls = 0;
  getSystemPromptCalls = 0;
  generatedTurnCount = 0;
  readonly customCalls: unknown[] = [];
  /**
   * Live `ctx.ui.onTerminalInput` listeners, in registration order.
   *
   * Present only when {@link supportsTerminalInput} is true, so a test can
   * model a host (or mode) without the public input-listener surface.
   */
  readonly terminalInputListeners: PiTerminalInputHandler[] = [];
  /** Number of listeners that have been unsubscribed. */
  terminalInputUnsubscribeCalls = 0;
  /** Whether `ctx.ui` exposes `onTerminalInput` at all. */
  supportsTerminalInput = true;
  /**
   * When true, every session context reuses one `ui` object, the way Pi hands
   * the extension runner a single `ExtensionUIContext` per session bind and
   * exposes it by reference. Tests that model host invalidation flip this on
   * and call {@link invalidateSessionUi} to replace the identity.
   */
  stableSessionUi = false;
  private cachedSessionUi: PiUiPort | undefined;

  /**
   * Models Pi's `resetExtensionUI()`: extension terminal-input listeners are
   * dropped without telling the extension, and the next session context
   * carries a different `ui` object identity.
   */
  invalidateSessionUi(): void {
    this.terminalInputListeners.length = 0;
    this.cachedSessionUi = undefined;
  }

  /**
   * Feeds one raw terminal frame through the registered listeners exactly the
   * way Pi's TUI does: listeners run first, in order, and a `consume` result
   * stops routing. Returns true when the frame was consumed by a listener.
   */
  emitTerminalInput(data: string): boolean {
    let current = data;
    for (const listener of [...this.terminalInputListeners]) {
      const result = listener(current);
      if (result?.consume === true) return true;
      if (result?.data !== undefined) current = result.data;
    }
    return false;
  }
  readonly customRenderedLines: string[][] = [];
  readonly customComponents: {
    render(width: number): string[];
    handleInput(data: string): void;
  }[] = [];
  customRequestRenderCalls = 0;
  customDoneCalls = 0;
  /** Terminal height reported to `ctx.ui.custom()` components. */
  terminalRows: number | undefined = 24;
  /** Per-binding key overrides, so tests can prove alternate keybindings. */
  readonly customKeybindingKeys: Record<string, readonly string[] | undefined> =
    {};
  /**
   * When set, custom/editor keybindings expose `getEffectiveConfig()` so Task
   * 13 conflict inspection and shortcut registration can run.
   */
  effectiveKeybindingConfig:
    | Readonly<Record<string, string | readonly string[] | undefined>>
    | undefined = undefined;
  private nextCustomCalled: (() => void) | undefined;
  private activeCustomDone: (() => void) | undefined;
  private activeCustom:
    | { render(width: number): string[]; handleInput(data: string): void }
    | undefined;
  readonly interventionCalls: unknown[] = [];
  readonly editorFactoryCalls: unknown[] = [];
  private editorFactory: unknown;
  readonly appendedEntries: {
    readonly type: string;
    readonly data: unknown;
  }[] = [];
  private activeTools: string[] = [];

  getActiveTools(): readonly string[] {
    return [...this.activeTools];
  }

  waitForNextCustomCall(): Promise<void> {
    return new Promise((resolve) => {
      this.nextCustomCalled = resolve;
    });
  }

  private mode: PiMode;
  private readonly theme: PiUiThemePort | undefined;
  private trusted: boolean;
  private hasUI: boolean;
  private idle: boolean;
  private pendingMessages = false;
  private readonly cwd: string;
  private readonly installPath: string;
  private readonly systemPromptOptionsAvailable: boolean;
  private sessionManager: PiSessionManagerPort | undefined;
  private commandsInventory: PiCommandInfo[] = [];
  private selectResponses: (
    | string
    | undefined
    | Promise<string | undefined>
  )[] = [];
  private notifyFailure: Error | undefined;
  private confirmResponses: (boolean | Promise<boolean>)[] = [];
  private currentModel: PiModelInfo | undefined;
  private availableModels: readonly PiModelInfo[];
  private currentSkills: readonly PiSkillInfo[];
  private readonly handlers = new Map<string, PiEventHandler[]>();
  private getCommandsOverride: (() => readonly PiCommandInfo[]) | undefined;
  private setModelOverride:
    | ((model: PiModelInfo) => boolean | Promise<boolean>)
    | undefined;
  private setThinkingLevelOverride:
    | ((level: string) => void | Promise<void>)
    | undefined;
  private thinkingLevel = "off";
  private registerToolOverride:
    | ((tool: PiToolRegistration) => void)
    | undefined;
  private getAvailableModelsOverride:
    | (() => readonly PiModelInfo[])
    | undefined;
  private sendMessageOverride:
    | ((
        message: RecordedSendMessage["message"],
        options: RecordedSendMessage["options"],
      ) => void | Promise<void>)
    | undefined;

  constructor(options: FakePiHostOptions = {}) {
    this.mode = options.mode ?? "tui";
    this.theme = options.theme;
    this.trusted = options.trusted ?? true;
    this.hasUI = options.hasUI ?? true;
    this.idle = options.idle ?? true;
    this.cwd = options.cwd ?? "/fake/project";
    this.installPath = options.installPath ?? "/fake/node_modules";
    this.currentModel = options.currentModel;
    this.availableModels = options.availableModels ?? [];
    this.currentSkills = options.systemPromptSkills ?? [];
    this.systemPromptOptionsAvailable =
      options.systemPromptOptionsAvailable ?? true;
    this.sessionManager =
      options.sessionManager === null
        ? undefined
        : (options.sessionManager ?? persistentFakeSessionManager());
    this.api = this.buildApi();
  }

  /** Replaces the host-reported session manager for the next context. */
  setSessionManager(manager: PiSessionManagerPort | undefined): void {
    this.sessionManager = manager;
  }

  /** The object handed to an extension's default factory. */
  readonly api: PiExtensionApi;

  private buildApi(): PiExtensionApi {
    return {
      registerCommand: (name, registration) => {
        this.registerCommandCalls.push({ name, registration });
        this.commandsInventory.push({
          name,
          description: registration.description,
          source: "extension",
          sourceInfo: this.ownSourceInfo(),
        });
      },
      registerShortcut: (shortcut, registration) => {
        this.registerShortcutCalls.push({ shortcut, registration });
      },
      getCommands: () => {
        if (this.getCommandsOverride !== undefined)
          return this.getCommandsOverride();
        return [...this.commandsInventory];
      },
      on: (event, handler) => {
        this.onCalls.push({ event, handler });
        const existing = this.handlers.get(event) ?? [];
        existing.push(handler);
        this.handlers.set(event, existing);
      },
      sendUserMessage: (content, options) => {
        this.generatedTurnCount += 1;
        this.sentUserMessages.push({
          content,
          ...(options === undefined ? {} : { options }),
        });
      },
      appendEntry: (type, data) => {
        this.appendedEntries.push({ type, data });
      },
      getActiveTools: () => [...this.activeTools],
      setActiveTools: (names) => {
        this.activeTools = [...names];
      },
      sendMessage: (message, options) => {
        if (this.sendMessageOverride !== undefined)
          return this.sendMessageOverride(message, options);
        this.sendMessageCalls.push({ message, options });
      },
      setModel: (model) => {
        this.setModelCalls.push(model);
        this.activationCalls.push({ kind: "model", model });
        if (this.setModelOverride !== undefined) {
          return this.setModelOverride(model);
        }
        this.currentModel = model;
        return true;
      },
      getThinkingLevel: () => this.thinkingLevel,
      setThinkingLevel: (level) => {
        this.setThinkingLevelCalls.push(level);
        this.activationCalls.push({ kind: "thinking", level });
        this.thinkingLevel = level;
        return this.setThinkingLevelOverride?.(level);
      },
      registerTool: (tool) => {
        this.registerToolCalls.push(tool);
        this.registerToolOverride?.(tool);
      },
    };
  }

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

  /** Makes the next `registerTool()` call throw, simulating a broken host. */
  poisonRegisterTool(): void {
    this.registerToolOverride = () => {
      throw new Error("simulated host failure: registerTool");
    };
  }

  setHasUI(hasUI: boolean): void {
    this.hasUI = hasUI;
  }

  setIdle(idle: boolean): void {
    this.idle = idle;
  }

  /** Queues the next `ctx.ui.select()` response. `undefined` simulates a cancel (Esc). */
  scriptSelect(response: string | undefined): void {
    this.selectResponses.push(response);
  }

  /** Queues the explicit choice used by an invalid-settings activation popup. */
  scriptSettingsChoice(
    response: "Use defaults" | "Enter health-only mode",
  ): void {
    this.scriptSelect(response);
  }

  /** Queues the next `ctx.ui.confirm()` response. */
  scriptConfirm(response: boolean): void {
    this.confirmResponses.push(response);
  }

  /** Defers the next confirmation so tests can change session state while the dialog is open. */
  deferNextConfirm(): { settle: (response: boolean) => void } {
    let resolveFn!: (value: boolean) => void;
    const promise = new Promise<boolean>((resolve) => {
      resolveFn = resolve;
    });
    this.confirmResponses.push(promise);
    return { settle: (response) => resolveFn(response) };
  }

  setModels(models: readonly PiModelInfo[]): void {
    this.availableModels = models;
  }

  setCurrentModel(model: PiModelInfo | undefined): void {
    this.currentModel = model;
  }

  /** Simulates a native Pi model selection and its documented event. */
  async triggerModelSelect(
    model: PiModelInfo,
    source: "set" | "cycle" | "restore" = "set",
  ): Promise<PiSessionContext> {
    const previousModel = this.currentModel;
    this.currentModel = model;
    const ctx = this.createSessionContext();
    const handlers = this.handlers.get("model_select") ?? [];
    for (const handler of handlers) {
      await handler({ model, previousModel, source }, ctx);
    }
    return ctx;
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

  /** Makes `pi.setThinkingLevel()` throw synchronously. */
  poisonSetThinkingLevel(): void {
    this.setThinkingLevelOverride = () => {
      throw new Error("simulated host failure: setThinkingLevel");
    };
  }

  /** Makes `pi.setThinkingLevel()` return a rejecting promise. */
  rejectSetThinkingLevel(): void {
    this.setThinkingLevelOverride = () =>
      Promise.reject(new Error("simulated host rejection: setThinkingLevel"));
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
  deferNextSetModel(): {
    called: Promise<void>;
    settle: (succeeded: boolean) => void;
  } {
    let resolveCalled!: () => void;
    let resolveFn!: (value: boolean) => void;
    const called = new Promise<void>((resolve) => {
      resolveCalled = resolve;
    });
    const promise = new Promise<boolean>((resolve) => {
      resolveFn = resolve;
    });
    const previousOverride = this.setModelOverride;
    this.setModelOverride = () => {
      this.setModelOverride = previousOverride;
      resolveCalled();
      return promise;
    };
    return {
      called,
      settle: (succeeded: boolean) => resolveFn(succeeded),
    };
  }

  /**
   * Defers the next `select()` response indefinitely until `settle()` is
   * called - lets a test drive another event (e.g. a fresh `session_start`
   * producing a new controller generation) while a selection is still in
   * flight, then resolve it.
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

  /** Makes the next `select()` throw synchronously. */
  poisonSelect(): void {
    const originalShift = this.selectResponses.shift.bind(this.selectResponses);
    this.selectResponses.shift = () => {
      this.selectResponses.shift = originalShift;
      throw new Error("leaked: /Users/attacker/.ssh/id_rsa");
    };
  }

  /** Makes the next `select()` return a rejecting promise. */
  rejectSelect(): void {
    const originalShift = this.selectResponses.shift.bind(this.selectResponses);
    this.selectResponses.shift = () => {
      this.selectResponses.shift = originalShift;
      return Promise.reject(new Error("leaked: token=sk-super-secret-123"));
    };
  }

  /** Makes the next `notify()` throw synchronously. */
  poisonNextNotify(): void {
    this.notifyFailure = new Error(
      "leaked: /Users/attacker/.config/weave/history.json",
    );
  }

  /** Makes `sendMessage()` throw synchronously. */
  poisonSendMessage(): void {
    this.sendMessageOverride = () => {
      throw new Error("simulated host failure: sendMessage");
    };
  }

  /** Makes `sendMessage()` return a rejecting promise. */
  rejectSendMessage(): void {
    this.sendMessageOverride = () =>
      Promise.reject(new Error("simulated host rejection: sendMessage"));
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
    const builtUi: PiUiPort = {
      ...(this.theme === undefined ? {} : { theme: this.theme }),
      notify: (message, level) => {
        const failure = this.notifyFailure;
        this.notifyFailure = undefined;
        if (failure) throw failure;
        this.notifyCalls.push({ message, level });
      },
      setStatus: (key, value) => {
        this.statusCalls.push({ key, value });
      },
      setWidget: (key, value) => {
        this.widgetCalls.push({ key, value });
      },
      select: async (title, options, opts) => {
        const call = { title, options, opts };
        this.selectCalls.push(call);
        if (title.startsWith("Invalid Pi child-inspection settings.")) {
          this.settingsPopupCalls.push(call);
        }
        return await this.selectResponses.shift();
      },
      confirm: async (title, message, opts) => {
        this.confirmCalls.push({ title, message, opts });
        return await (this.confirmResponses.shift() ?? false);
      },
      ...(this.supportsTerminalInput
        ? {
            onTerminalInput: (handler: PiTerminalInputHandler) => {
              this.terminalInputListeners.push(handler);
              return () => {
                const index = this.terminalInputListeners.indexOf(handler);
                if (index === -1) return;
                this.terminalInputListeners.splice(index, 1);
                this.terminalInputUnsubscribeCalls += 1;
              };
            },
          }
        : {}),
      getEditorComponent: () => this.editorFactory,
      setEditorComponent: (factory) => {
        this.editorFactoryCalls.push(factory);
        this.editorFactory = factory;
      },
      custom: async (factory) => {
        this.customCalls.push(factory);
        this.nextCustomCalled?.();
        this.nextCustomCalled = undefined;
        let resolve!: (value: unknown) => void;
        const result = new Promise<unknown>((res) => {
          resolve = res;
        });
        this.activeCustomDone = () => {
          this.customDoneCalls += 1;
          resolve(undefined);
        };
        const component = factory(
          {
            width: 80,
            requestRender: () => {
              this.customRequestRenderCalls += 1;
            },
            terminal: { rows: this.terminalRows },
          },
          {},
          this.buildKeybindingsPort(),
          (value) => {
            this.customDoneCalls += 1;
            resolve(value);
          },
        ) as {
          render(width: number): string[];
          handleInput(data: string): void;
        };
        this.customComponents.push(component);
        this.activeCustom = component;
        this.customRenderedLines.push(component.render(80));
        return (await result) as never;
      },
    };
    const ui: PiUiPort = this.stableSessionUi
      ? (this.cachedSessionUi ?? builtUi)
      : builtUi;
    if (this.stableSessionUi) this.cachedSessionUi = ui;
    return Object.assign(
      {
        mode,
        cwd,
        isProjectTrusted: () => trusted,
        isIdle: () => this.idle,
        ui,
        hasUI: this.hasUI,
        model,
        modelRegistry,
        ...(this.sessionManager === undefined
          ? {}
          : { sessionManager: this.sessionManager }),
        getSystemPrompt: () => {
          this.getSystemPromptCalls += 1;
          if (this.currentSkills.length === 0) return "native-system-prompt";
          const escapeXml = (value: string): string =>
            value
              .replace(/&/gu, "&amp;")
              .replace(/</gu, "&lt;")
              .replace(/>/gu, "&gt;")
              .replace(/"/gu, "&quot;")
              .replace(/'/gu, "&apos;");
          return [
            "native-system-prompt",
            "<available_skills>",
            ...this.currentSkills.flatMap((skill) => [
              "  <skill>",
              `    <name>${escapeXml(skill.name)}</name>`,
              "    <description>Fake skill</description>",
              `    <location>${escapeXml(skill.filePath ?? `/fake/skills/${skill.name}/SKILL.md`)}</location>`,
              "  </skill>",
            ]),
            "</available_skills>",
          ].join("\n");
        },
      },
      this.systemPromptOptionsAvailable
        ? {
            getSystemPromptOptions: () => {
              this.getSystemPromptOptionsCalls += 1;
              return { skills: this.currentSkills };
            },
          }
        : {},
      { hasPendingMessages: () => this.pendingMessages },
    ) as PiSessionContext;
  }

  renderCustom(): string[] {
    const lines = this.activeCustom?.render(80) ?? [];
    this.customRenderedLines.push(lines);
    return lines;
  }

  inputCustom(data: string): void {
    this.activeCustom?.handleInput(data);
    this.renderCustom();
  }

  finishCustom(): void {
    this.activeCustomDone?.();
  }

  setPendingMessages(pending: boolean): void {
    this.pendingMessages = pending;
  }

  async triggerEvent(
    event: string,
    payload: unknown = {},
    ctx = this.createSessionContext(),
  ): Promise<PiSessionContext> {
    for (const handler of this.handlers.get(event) ?? []) {
      await handler(payload, ctx);
    }
    return ctx;
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
    this.beforeAgentStartCalls += 1;
    this.currentSkills = skills;
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

  /** Invokes a registered shortcut handler with a fresh context. */
  async invokeShortcut(shortcut: string): Promise<PiSessionContext> {
    const ctx = this.createSessionContext();
    const call = this.registerShortcutCalls.find(
      (entry) => entry.shortcut === shortcut,
    );
    if (call === undefined) {
      throw new Error(`shortcut not registered: ${shortcut}`);
    }
    await call.registration.handler(ctx);
    return ctx;
  }

  setEditorComponentForTest(factory: unknown): void {
    this.editorFactory = factory;
  }

  getEditorComponentForTest(): unknown {
    return this.editorFactory;
  }

  /**
   * Stands in for Pi's process-wide `KeybindingsManager`. Overlay shortcut
   * registration inspects this before claiming any key, independently of who
   * owns the primary editor.
   */
  hostKeybindingsForTest(): unknown {
    if (this.effectiveKeybindingConfig === undefined) return undefined;
    return {
      getResolvedBindings: () => this.effectiveKeybindingConfig ?? {},
    };
  }

  /** Constructs the currently installed editor through the host-facing factory. */
  createEditor(...args: readonly unknown[]): {
    handleInput(input: string): void | Promise<void>;
  } {
    if (typeof this.editorFactory !== "function") {
      throw new Error("editor factory not installed");
    }
    const resolvedArgs =
      args.length >= 3
        ? args
        : ([{}, {}, this.buildKeybindingsPort()] as const);
    return (this.editorFactory as (...values: readonly unknown[]) => unknown)(
      ...resolvedArgs,
    ) as {
      handleInput(input: string): void | Promise<void>;
    };
  }

  private buildKeybindingsPort(): {
    matches: () => boolean;
    getKeys: (binding: string) => readonly string[] | undefined;
    getEffectiveConfig?: () => Readonly<
      Record<string, string | readonly string[] | undefined>
    >;
  } {
    return {
      matches: () => false,
      getKeys: (binding: string) =>
        this.customKeybindingKeys[binding] ??
        DEFAULT_FAKE_KEYBINDING_KEYS[binding],
      ...(this.effectiveKeybindingConfig === undefined
        ? {}
        : {
            getEffectiveConfig: () => this.effectiveKeybindingConfig ?? {},
          }),
    };
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
  config: WeaveConfig = {
    agents: {},
    disabled: { agents: [], skills: [] },
  } as unknown as WeaveConfig,
): PiConfigActivator {
  const configLoader: PiConfigLoaderPort = {
    load: () => okAsync(config),
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
