/**
 * Harness-neutral, adapter-owned port types describing the narrow slice of
 * the Pi `ExtensionAPI` / `ExtensionContext` surface this adapter depends on.
 *
 * These are deliberately NOT re-exports of `@earendil-works/pi-coding-agent`
 * types: the peer package is unbundled and may be absent from a consumer's
 * dev environment (it is in this monorepo). Defining our own structural
 * ports keeps `PiExtensionController` / `PiSafeInitializer` testable against
 * an in-memory fake host without requiring the real package to typecheck or
 * to be installed. `src/extension.ts` is the only file that adapts the real
 * Pi-provided object into this shape.
 *
 * @see docs/adapters/pi.md (Pi adapter contract)
 */

import { err, ok, Result } from "neverthrow";

export type {
  PiChildSessionEvent,
  PiExtensionUiResponse,
} from "./child-session-events.js";

/** Pi's four extension execution modes. Only `"tui"` is in scope (Pi adapter contract). */
export type PiMode = "tui" | "rpc" | "json" | "print";

/** Whether the current project has been granted local trust. */
export type PiTrustState = "trusted" | "withheld";

/** Scope a discovered command/tool/skill/prompt resource was loaded from. */
export type PiResourceScope = "user" | "project" | "temporary";

/** Whether a resource came from a package manifest or a top-level file. */
export type PiResourceOrigin = "package" | "top-level";

/**
 * Canonical provenance for a discovered command or tool. Per Pi adapter contract,
 * ownership MUST be read from `sourceInfo`, never inferred from names or ad
 * hoc path parsing.
 */
export interface PiSourceInfo {
  readonly path: string;
  readonly source: string;
  readonly scope: PiResourceScope;
  readonly origin: PiResourceOrigin;
  readonly baseDir?: string;
}

/** One entry from `pi.getCommands()`. */
export interface PiCommandInfo {
  readonly name: string;
  readonly description?: string;
  readonly source: "extension" | "prompt" | "skill";
  readonly sourceInfo: PiSourceInfo;
}

/**
 * One entry from Pi's authenticated model catalog
 * (`ctx.modelRegistry.getAvailable()`) or the currently active model
 * (`ctx.model`). `api` is the host-reported Pi `Model.api` family when
 * present; it is never inferred from provider or model ids.
 */
export interface PiModelInfo {
  readonly provider: string;
  readonly id: string;
  readonly name?: string;
  readonly api?: string;
  /**
   * The model's *declared* transport base URL, when the host reports one.
   * This is configuration, not proof of where the request goes: Pi replaces
   * it with `resolution.auth.baseUrl` during request preparation whenever
   * auth resolution supplies one. Never classify a transport from this field
   * alone; resolve the effective origin through `getProviderAuth` first.
   */
  readonly baseUrl?: string;
}

/**
 * Narrow projection of `ctx.modelRegistry`: authenticated-model discovery,
 * plus the documented provider-auth seam that reports the base URL Pi will
 * actually use for the next request. `getProviderAuth` is optional because a
 * host that does not expose it leaves the final transport unprovable.
 */
export interface PiModelRegistry {
  getAvailable(): readonly PiModelInfo[];
  /**
   * `ctx.modelRegistry.getProviderAuth(provider)`. Documented to resolve the
   * provider's current API key, headers, base URL, and environment. Only the
   * resolved base URL is ever read from the result; credentials, headers, and
   * environment values are never inspected.
   */
  getProviderAuth?(provider: string): Promise<unknown>;
}

/**
 * One entry from `before_agent_start`'s `event.systemPromptOptions.skills`
 * (also `ctx.getSystemPromptOptions().skills` in command contexts): Pi's
 * own already-discovered, already-trusted skill catalog for this turn.
 */
export interface PiSkillInfo {
  readonly name: string;
  readonly filePath?: string;
  readonly sourceInfo?: PiSourceInfo;
}

/** The subset of Pi's `BuildSystemPromptOptions` this adapter reads. */
export interface PiBuildSystemPromptOptions {
  readonly skills?: readonly PiSkillInfo[];
}

/** The subset of the `before_agent_start` event payload this adapter reads. */
export interface PiBeforeAgentStartEvent {
  readonly systemPrompt?: string;
  readonly systemPromptOptions?: PiBuildSystemPromptOptions;
}

/**
 * Narrow projections of Pi's provider hooks for eventual request mapping.
 * These types deliberately omit payload, header maps, response bodies, and
 * other harness objects. Task 9 owns any later mutation or evidence read.
 */
export type PiProviderHookName =
  | "before_provider_request"
  | "before_provider_headers"
  | "after_provider_response";

export interface PiBeforeProviderRequestEvent {
  readonly type: "before_provider_request";
}

export interface PiBeforeProviderHeadersEvent {
  readonly type: "before_provider_headers";
}

export interface PiAfterProviderResponseEvent {
  readonly type: "after_provider_response";
  readonly status: number;
}

export type PiProviderEventProjection =
  | PiBeforeProviderRequestEvent
  | PiBeforeProviderHeadersEvent
  | PiAfterProviderResponseEvent;

export type PiProviderEventProjectionError = {
  readonly type: "UnsupportedProviderEvent";
};

/**
 * Project a host provider hook into the adapter-owned shape. Copies only the
 * event name and, for responses, the integer status. Payload, headers, and
 * other harness fields stay behind this boundary.
 */
export function projectPiProviderEvent(
  event: unknown,
): Result<PiProviderEventProjection, PiProviderEventProjectionError> {
  const projected = Result.fromThrowable(
    () => {
      if (typeof event !== "object" || event === null) {
        return err({ type: "UnsupportedProviderEvent" } as const);
      }

      const prototype = Object.getPrototypeOf(event);
      if (prototype !== Object.prototype && prototype !== null) {
        return err({ type: "UnsupportedProviderEvent" } as const);
      }

      const descriptors = Object.create(null) as Record<
        string,
        PropertyDescriptor
      >;
      for (const key of Reflect.ownKeys(event)) {
        if (typeof key !== "string") {
          return err({ type: "UnsupportedProviderEvent" } as const);
        }
        const descriptor = Object.getOwnPropertyDescriptor(event, key);
        if (
          descriptor === undefined ||
          !("value" in descriptor) ||
          descriptor.enumerable !== true ||
          descriptor.writable !== true ||
          descriptor.configurable !== true
        ) {
          return err({ type: "UnsupportedProviderEvent" } as const);
        }
        descriptors[key] = descriptor;
      }

      const type = descriptors.type?.value;
      if (typeof type !== "string") {
        return err({ type: "UnsupportedProviderEvent" } as const);
      }
      if (type === "before_provider_request") {
        return ok({ type: "before_provider_request" } as const);
      }
      if (type === "before_provider_headers") {
        return ok({ type: "before_provider_headers" } as const);
      }
      if (type !== "after_provider_response") {
        return err({ type: "UnsupportedProviderEvent" } as const);
      }

      const status = descriptors.status?.value;
      if (typeof status !== "number" || !Number.isInteger(status)) {
        return err({ type: "UnsupportedProviderEvent" } as const);
      }
      return ok({ type: "after_provider_response", status } as const);
    },
    () => ({ type: "UnsupportedProviderEvent" }) as const,
  )();

  return projected.andThen((result) => result);
}

/**
 * The live model identity a provider hook must classify against. Provider
 * hooks read this from the hook context, never from activation-time state,
 * so a `/model` change cannot be mutated under a stale allowlist decision.
 */
export interface PiProviderHookModel {
  readonly provider: string;
  readonly id: string;
  readonly api: string;
  /**
   * The declared transport base URL only. Pi may replace it through auth
   * resolution before the request leaves, so this field identifies the model
   * for correlation and must never decide first-party eligibility.
   */
  readonly baseUrl: string;
}

/**
 * The proven final transport origin for the next provider request, or an
 * explicit statement that the host did not let the adapter prove it.
 */
export type PiResolvedTransport =
  | { readonly kind: "proved"; readonly baseUrl: string }
  | { readonly kind: "unprovable" };

const PI_RESOLVED_TRANSPORT: PiResolvedTransport = Object.freeze({
  kind: "unprovable",
});

function readOwnObjectField(
  container: object,
  field: string,
): object | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(container, field);
  if (descriptor === undefined || !("value" in descriptor)) {
    return undefined;
  }
  const value = descriptor.value;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value;
}

/**
 * Project one `AuthResult` into the base URL Pi will actually send to.
 *
 * Pi composes the request model as `resolution.auth.baseUrl ? { ...model,
 * baseUrl: resolution.auth.baseUrl } : model`. An own string `auth.baseUrl`
 * therefore *is* the final origin; an absent `auth.baseUrl` proves the
 * declared model URL survives unreplaced. Anything else - a missing result, a
 * non-object `auth`, an accessor, or a non-string override - leaves the final
 * origin unproven, and the caller must fail closed rather than trust the
 * declaration. Only `auth.baseUrl` is read; `auth.apiKey`, `auth.headers`,
 * and `env` are never touched.
 */
export function projectPiResolvedTransport(
  resolved: unknown,
  declaredBaseUrl: string,
): PiResolvedTransport {
  return Result.fromThrowable(
    (): PiResolvedTransport => {
      if (
        typeof resolved !== "object" ||
        resolved === null ||
        Array.isArray(resolved)
      ) {
        return PI_RESOLVED_TRANSPORT;
      }
      const auth = readOwnObjectField(resolved, "auth");
      if (auth === undefined) {
        return PI_RESOLVED_TRANSPORT;
      }
      if (!Object.hasOwn(auth, "baseUrl")) {
        return Object.freeze({
          kind: "proved" as const,
          baseUrl: declaredBaseUrl,
        });
      }
      const descriptor = Object.getOwnPropertyDescriptor(auth, "baseUrl");
      if (descriptor === undefined || !("value" in descriptor)) {
        return PI_RESOLVED_TRANSPORT;
      }
      // Pi treats a falsy `auth.baseUrl` as "no override", so an absent or
      // empty value proves the declared URL survives. A present non-string is
      // a shape this adapter does not understand, so it stays unprovable.
      const override = descriptor.value;
      if (override === undefined || override === "") {
        return Object.freeze({
          kind: "proved" as const,
          baseUrl: declaredBaseUrl,
        });
      }
      if (
        typeof override !== "string" ||
        override.length > PI_HOOK_MODEL_FIELD_MAX_LENGTH
      ) {
        return PI_RESOLVED_TRANSPORT;
      }
      return Object.freeze({ kind: "proved" as const, baseUrl: override });
    },
    () => PI_RESOLVED_TRANSPORT,
  )().unwrapOr(PI_RESOLVED_TRANSPORT);
}

const PI_HOOK_MODEL_FIELD_MAX_LENGTH = 512;

function readHookModelField(model: object, field: string): string | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(model, field);
  if (descriptor === undefined || !("value" in descriptor)) {
    return undefined;
  }
  const value = descriptor.value;
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > PI_HOOK_MODEL_FIELD_MAX_LENGTH
  ) {
    return undefined;
  }
  return value;
}

/**
 * Project `ctx.model` into the four fields a provider mapping may use.
 * Only own data descriptors are read, so getters never run, and a model that
 * does not declare all four fields yields `undefined` rather than a partial
 * identity that could be classified optimistically.
 */
export function projectPiHookModel(
  model: unknown,
): PiProviderHookModel | undefined {
  return Result.fromThrowable(
    (): PiProviderHookModel | undefined => {
      if (typeof model !== "object" || model === null || Array.isArray(model)) {
        return undefined;
      }
      const provider = readHookModelField(model, "provider");
      const id = readHookModelField(model, "id");
      const api = readHookModelField(model, "api");
      const baseUrl = readHookModelField(model, "baseUrl");
      if (
        provider === undefined ||
        id === undefined ||
        api === undefined ||
        baseUrl === undefined
      ) {
        return undefined;
      }
      return Object.freeze({ provider, id, api, baseUrl });
    },
    () => undefined,
  )().unwrapOr(undefined);
}

export type PiProviderEventFieldError = {
  readonly type: "UnsafeProviderEventField";
};

function readOwnDataField(
  event: object,
  field: string,
): Result<unknown, PiProviderEventFieldError> {
  return Result.fromThrowable(
    () => {
      const ownKeys = Reflect.ownKeys(event);
      if (!ownKeys.includes(field)) {
        return err({ type: "UnsafeProviderEventField" } as const);
      }
      const descriptor = Object.getOwnPropertyDescriptor(event, field);
      if (
        descriptor === undefined ||
        !("value" in descriptor) ||
        descriptor.enumerable !== true ||
        descriptor.writable !== true ||
        descriptor.configurable !== true
      ) {
        return err({ type: "UnsafeProviderEventField" } as const);
      }
      return ok(descriptor.value);
    },
    () => ({ type: "UnsafeProviderEventField" }) as const,
  )().andThen((result) => result);
}

/**
 * Read a raw host `headers` or `payload` field through its own writable,
 * configurable, enumerable data descriptor. Getters are never invoked.
 */
export function extractPiProviderEventField(
  event: unknown,
  field: "headers" | "payload",
): Result<unknown, PiProviderEventFieldError> {
  if (typeof event !== "object" || event === null) {
    return err({ type: "UnsafeProviderEventField" });
  }
  return readOwnDataField(event, field);
}

/** Notification severity accepted by `ctx.ui.notify`. */
export type PiUiNotifyLevel = "info" | "warning" | "error";

/**
 * The exact background tokens Pi's own `Theme.bg()` accepts (`ThemeBg` in
 * `modes/interactive/theme/theme.d.ts`). Never invent a token here: an
 * unknown key would resolve to no ANSI background at all in the real host.
 */
export type PiUiThemeBgColor =
  | "selectedBg"
  | "userMessageBg"
  | "customMessageBg"
  | "toolPendingBg"
  | "toolSuccessBg"
  | "toolErrorBg";

/** Narrow projection of Pi's theme helpers used by the active-agent badge. */
export interface PiUiThemePort {
  fg(
    color:
      | "accent"
      | "muted"
      | "text"
      | "warning"
      | "error"
      | "success"
      | "dim"
      | "border"
      | "borderMuted"
      | "toolTitle"
      | "toolOutput",
    text: string,
  ): string;
  bold(text: string): string;
  /**
   * Optional deliberately: the real Pi `Theme` always provides `bg()`, but
   * this narrow port is also satisfied by simpler stand-ins, so every caller
   * must degrade to foreground-only rendering when it is absent.
   */
  bg?(color: PiUiThemeBgColor, text: string): string;
}

/**
 * Narrow projection of `ctx.ui`. Diagnostics/status/notify and dialog
 * surfaces plus the widget/status and compositional custom-editor APIs used
 * to expose the bounded child tree and wire Alt+1..9/Backspace/Esc.
 */
/**
 * Narrow mirror of Pi's own `ExtensionUIDialogOptions`
 * (`dist/core/extensions/types.d.ts` lines 35-41). The field name MUST
 * match Pi's exactly (`timeout`, in milliseconds, not `timeoutMs`) since
 * this object is passed straight through to the real `ctx.ui.select`/
 * `confirm` call with no translation layer - a renamed field would be
 * silently ignored by the real host and the dialog would never time out.
 * Once elapsed, Pi auto-dismisses the dialog (resolving the
 * reject-equivalent value) with a live countdown display.
 */
export interface PiUiDialogOptions {
  readonly timeout?: number;
}

/**
 * Narrow mirror of Pi's `OverlayOptions` (`@earendil-works/pi-tui`,
 * `dist/tui.d.ts`), limited to the fields this adapter sets.
 *
 * `maxHeight` is deliberately included even though the child overlay does not
 * use it, because its semantics are the reason not to: Pi enforces it by
 * keeping only the *first* `maxHeight` rows a component returns, so a
 * component that draws a bottom border must budget its own height instead.
 */
export interface PiUiOverlayOptions {
  readonly width?: number | `${number}%`;
  readonly minWidth?: number;
  readonly maxHeight?: number | `${number}%`;
  readonly anchor?:
    | "center"
    | "top-left"
    | "top-right"
    | "bottom-left"
    | "bottom-right"
    | "top-center"
    | "bottom-center"
    | "left-center"
    | "right-center";
  readonly margin?:
    | number
    | {
        readonly top?: number;
        readonly right?: number;
        readonly bottom?: number;
        readonly left?: number;
      };
}

/** Narrow mirror of the options object Pi's `ctx.ui.custom` accepts. */
export interface PiUiCustomOptions {
  readonly overlay?: boolean;
  readonly overlayOptions?: PiUiOverlayOptions;
}

/**
 * Narrow mirror of Pi's own `TerminalInputHandler`
 * (`dist/core/extensions/types.d.ts`). Returning `{ consume: true }` stops the
 * host from routing the frame any further; returning `undefined` leaves the
 * frame untouched for the editor, overlays, and host shortcuts.
 */
export type PiTerminalInputHandler = (data: string) =>
  | {
      readonly consume?: boolean;
      readonly data?: string;
    }
  | undefined;

export interface PiUiPort {
  readonly theme?: PiUiThemePort;
  notify(message: string, level?: PiUiNotifyLevel): void;
  /**
   * Mirrors Pi's own `ctx.ui.onTerminalInput()` (interactive mode only).
   *
   * This is the only public input path that is independent of primary-editor
   * ownership: `pi.registerShortcut` is dispatched by Pi's *default* editor, so
   * when another extension (for example `pi-vim`) installs a custom editor the
   * registered handler never runs. Pi's TUI consults input listeners before
   * any component or shortcut routing, so a listener that consumes only the
   * keys it recognises reaches the same route without stealing ordinary input.
   *
   * Optional deliberately: non-interactive modes and unit-test doubles do not
   * provide it, and every caller must degrade instead of failing.
   */
  onTerminalInput?(handler: PiTerminalInputHandler): () => void;
  setStatus(key: string, value: string | undefined): void;
  setWidget(
    key: string,
    value: unknown,
    options?: { placement?: "aboveEditor" | "belowEditor" },
  ): void;
  /**
   * Mirrors Pi's own `ctx.ui.getEditorComponent()`. Deliberately typed
   * `unknown` - the concrete `EditorFactory`/`CustomEditor` shape is owned
   * by the real `@earendil-works/pi-coding-agent`/`@earendil-works/pi-tui`
   * packages, which this narrow port does not depend on. Only
   * `src/extension.ts` (the real adapter boundary) casts through this.
   */
  getEditorComponent?(): unknown;
  /** Mirrors Pi's own `ctx.ui.setEditorComponent()`; pass `undefined` to restore the host default editor. */
  setEditorComponent?(factory: unknown): void;
  /** Pi's real custom UI boundary for complex interactive components. */
  custom?<T>(
    factory: (
      tui: unknown,
      /**
       * Pi hands the factory its `Theme`, a colour palette. Components that
       * need an `EditorTheme` (a record of styling functions) must build one
       * from it; the two are not interchangeable, and passing a palette where
       * a styling record belongs fails only at render time.
       */
      theme: PiUiThemePort,
      keybindings: unknown,
      done: (value: T) => void,
    ) => unknown,
    options?: PiUiCustomOptions,
  ): Promise<T>;
  /**
   * Interactive single-choice prompt (`ctx.ui.select`). Resolves to
   * `undefined` when the user cancels OR the dialog times out - callers
   * MUST treat both as a reject-equivalent, never as an implicit choice.
   */
  select(
    title: string,
    options: readonly string[],
    opts?: PiUiDialogOptions,
  ): Promise<string | undefined>;
  /** Interactive yes/no prompt (`ctx.ui.confirm`). */
  confirm(
    title: string,
    message: string,
    opts?: PiUiDialogOptions,
  ): Promise<boolean>;
}

/**
 * Narrow projection of Pi's `SessionManager` for parent identity/persistence.
 * Matches the host methods Weave probes; the live object is
 * `ctx.sessionManager` (Pi's public readonly session-manager surface plus
 * `isPersisted()`, which the concrete manager exposes at runtime).
 */
export interface PiSessionManagerPort {
  getSessionId(): string;
  getSessionFile(): string | undefined;
  isPersisted(): boolean;
  /**
   * The persisted session header of the file this manager is reading, when
   * the host exposes one.
   *
   * `getSessionId()` is the *runtime* identity of the manager and may be a
   * freshly minted id at probe time, even when the manager is already serving
   * a reopened session file. The header `id` is the identity written into the
   * file itself, so it is stable across restarts of the same parent session
   * and newly minted for a fork, clone, or genuinely new session.
   */
  getHeader?(): PiSessionHeader | null | undefined;
}

/**
 * Narrow projection of Pi's session header. Only the fields Weave needs for
 * stable parent identity are modelled; everything else is ignored.
 */
export interface PiSessionHeader {
  readonly id?: unknown;
  readonly parentSession?: unknown;
}

/** Narrow projection of `ExtensionContext` used by command handlers and lifecycle delegates. */
export interface PiSessionContext {
  readonly mode: PiMode;
  readonly cwd: string;
  isProjectTrusted(): boolean;
  /** Whether Pi is idle and can accept an immediate user-message turn. */
  isIdle(): boolean;
  readonly ui: PiUiPort;
  /** Whether dialog-capable UI is available (`ctx.hasUI`) - false in headless/print modes. */
  readonly hasUI: boolean;
  /** The currently active model, if any (`ctx.model`). */
  readonly model: PiModelInfo | undefined;
  /** Authenticated-model discovery (`ctx.modelRegistry`). */
  readonly modelRegistry: PiModelRegistry;
  /**
   * Pi's live session manager. Present on real extension contexts; unit-test
   * doubles may omit it, which the persistent-parent guard treats as unknown.
   */
  readonly sessionManager?: PiSessionManagerPort;
  /** Command-context access to Pi's current skill discovery snapshot. */
  readonly getSystemPromptOptions?: () => PiBuildSystemPromptOptions;
  /** Public on ordinary Pi extension contexts, including `session_start`. */
  readonly getSystemPrompt?: () => string;
}

/** A registered command handler. Receives raw argument text and the live session context. */
export type PiCommandHandler = (
  rawArgs: string,
  ctx: PiSessionContext,
) => void | Promise<void>;

export interface PiCommandRegistration {
  readonly description?: string;
  readonly handler: PiCommandHandler;
}

/** Lifecycle event handler signature used by `pi.on(...)`. */
export type PiEventHandler = (
  event: unknown,
  ctx: PiSessionContext,
) => unknown | Promise<unknown>;

/**
 * A single content block returned from a registered tool's `execute()`.
 * Mirrors the narrow slice of Pi's `AgentToolResult` this adapter produces.
 */
export interface PiToolResultContent {
  readonly type: "text";
  readonly text: string;
}

/** Narrow structural result shape accepted by Pi for final and partial tool output. */
export interface PiToolResult {
  readonly content: readonly PiToolResultContent[];
  readonly details?: unknown;
}

/** Narrow structural component returned by Pi custom tool renderers. */
export interface PiToolRenderComponent {
  render(width: number): string[];
  invalidate(): void;
}

export interface PiToolRenderOptions {
  readonly expanded: boolean;
  readonly isPartial: boolean;
}

export interface PiToolRenderContext {
  readonly args?: Record<string, unknown>;
  readonly lastComponent?: PiToolRenderComponent;
}

/**
 * Registration input for `pi.registerTool()` (Pi adapter contract). `parameters`
 * is deliberately `unknown` - the concrete TypeBox schema shape is owned by
 * the real Pi package, which this narrow port does not depend on.
 */
export interface PiToolRegistration {
  readonly name: string;
  readonly label: string;
  readonly description: string;
  readonly parameters: unknown;
  readonly promptSnippet?: string;
  readonly promptGuidelines?: readonly string[];
  readonly renderCall?: (
    args: Record<string, unknown>,
    theme: PiUiThemePort,
    context: PiToolRenderContext,
  ) => PiToolRenderComponent;
  readonly renderResult?: (
    result: PiToolResult,
    options: PiToolRenderOptions,
    theme: PiUiThemePort,
    context: PiToolRenderContext,
  ) => PiToolRenderComponent;
  execute(
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: ((update: PiToolResult) => void) | undefined,
    ctx: PiSessionContext,
  ): Promise<PiToolResult>;
}

/**
 * Narrow projection of the Pi `ExtensionAPI` object passed to an extension's
 * default factory. Only the members this adapter's foundation layer uses.
 */
export interface PiExtensionApi {
  registerCommand(name: string, registration: PiCommandRegistration): void;
  getCommands(): readonly PiCommandInfo[];
  on(event: string, handler: PiEventHandler): void;
  /** Sends a real user message into the current parent session and starts a turn. */
  sendUserMessage(
    content: string,
    options?: { readonly deliverAs?: "steer" | "followUp" },
  ): void;
  /** Appends a custom entry to the current Pi session branch. */
  appendEntry(type: string, data: unknown): void;
  /** Reads and changes Pi's active tool list. */
  getActiveTools(): readonly string[];
  setActiveTools(names: readonly string[]): void;
  /** Injects a custom context message without impersonating the user. */
  sendMessage(
    message: {
      customType: string;
      content: string;
      display?: boolean;
      details?: unknown;
    },
    options?: {
      triggerTurn?: boolean;
      deliverAs?: "steer" | "followUp" | "nextTurn";
    },
  ): void | Promise<void>;
  /** Registers a tool the LLM can call (`ExtensionAPI.registerTool`). */
  registerTool(tool: PiToolRegistration): void;
  /**
   * Applies a model selection (`ExtensionAPI.setModel`). May reject/throw for
   * an invalid or unauthenticated model. May also *resolve* to `false`
   * without throwing (e.g. the host declined the selection) - callers MUST
   * treat a resolved `false` as a failed application, not as success.
   */
  setModel(
    model: PiModelInfo,
  ): boolean | undefined | Promise<boolean | undefined>;
  /** Reads Pi's current-session thinking level (`ExtensionAPI.getThinkingLevel`). */
  getThinkingLevel?: () => string;
  /** Applies Pi's current-session thinking level (`ExtensionAPI.setThinkingLevel`). */
  setThinkingLevel?: (
    level: string,
  ) => void | undefined | Promise<void | undefined>;
  /**
   * Registers a keyboard shortcut (`ExtensionAPI.registerShortcut`, Pi adapter contract
   *). Alt+A cycles primary agents. Alt+1..Alt+9 direct-child selection
   * uses keys that are not default editor bindings. Backspace
   * (parent selection) and Esc (cancel selected subtree) are wired
   * separately, and NOT through this shortcut port: `src/extension.ts`'s
   * `WeaveChildTreeEditor` composes the real `CustomEditor` via
   * `ctx.ui.getEditorComponent()`/`setEditorComponent()` and drives the same
   * pure `child-tree.ts` reducer from its own `handleInput`, falling through
   * to `super.handleInput` for every key it does not recognize or that the
   * reducer reports as root-level host-default behavior.
   */
  registerShortcut?(
    shortcut: string,
    registration: {
      description?: string;
      handler: (ctx: PiSessionContext) => void | Promise<void>;
    },
  ): void;
}

/** Injected environment-variable port for reading the child's private bootstrap values (Pi adapter contract). Production reads/deletes Bun's own `Bun.env` (see `child-env.ts`'s `BunEnvPort`) - never Node's `process.env`, and never argv or prompt text. */
export interface PiEnvPort {
  read(name: string): string | undefined;
  /** Deletes the value so it cannot be read again later in the child's lifetime. */
  deleteValue(name: string): void;
}

/** Injected monotonic-enough clock port. */
export interface Clock {
  now(): number;
}

/** Injected opaque generation-ID source. Production uses `crypto.randomUUID()`. */
export interface IdGenerator {
  next(): string;
}

/** Minimal structural logger port compatible with the shared pino instance. */
export interface PiAdapterLogger {
  debug(obj: Record<string, unknown>, msg?: string): void;
  info(obj: Record<string, unknown>, msg?: string): void;
  warn(obj: Record<string, unknown>, msg?: string): void;
  error(obj: Record<string, unknown>, msg?: string): void;
}

export type {
  PiChildInspectionEffectiveSettings,
  PiChildInspectionSettings,
  PiChildInspectionSettingsChoice,
  PiChildInspectionSettingsIssue,
  PiChildInspectionSettingsMode,
  PiChildInspectionSettingsResolution,
} from "./child-inspection-settings.js";
