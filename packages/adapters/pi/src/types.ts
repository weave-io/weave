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
import { z } from "zod";
import type { PiAdapterFailure } from "./errors.js";
import type { JsonValue } from "./strict-json.js";

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
   * This is configuration, not proof of where a request goes: Pi replaces it
   * with the auth-resolved base URL during request preparation. It describes
   * the catalog entry and must never decide provider eligibility.
   */
  readonly baseUrl?: string;
}

/** Narrow projection of `ctx.modelRegistry`: authenticated-model discovery. */
export interface PiModelRegistry {
  getAvailable(): readonly PiModelInfo[];
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

/**
 * One entry from `ExtensionAPI.getAllTools()`. Only the provenance this
 * adapter reads is projected; Pi's own `ToolInfo` carries more.
 */
export interface PiToolInfo {
  readonly name: string;
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
 * Narrow projections of Pi's provider hooks. These types deliberately omit
 * payload, header maps, response bodies, and other harness objects. The
 * adapter never mutates a provider request, so no projection here reaches
 * request data.
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

const PiProviderHookNameSchema = z.enum([
  "before_provider_request",
  "before_provider_headers",
  "after_provider_response",
]);
const PiProviderStatusSchema = z.number();

const projectedProviderRequest = (): PiBeforeProviderRequestEvent => ({
  type: "before_provider_request",
});
const projectedProviderHeaders = (): PiBeforeProviderHeadersEvent => ({
  type: "before_provider_headers",
});
const projectedProviderResponse = (
  status: number,
): PiAfterProviderResponseEvent => ({
  type: "after_provider_response",
  status,
});
const unsupportedProviderEvent = (): PiProviderEventProjectionError => ({
  type: "UnsupportedProviderEvent",
});

/**
 * Project a host provider hook into the adapter-owned shape. Copies only the
 * event name and, for responses, the integer status. Payload, headers, and
 * other harness fields stay behind this boundary.
 */
export function projectPiProviderEvent<TEvent>(
  event: TEvent,
): Result<PiProviderEventProjection, PiProviderEventProjectionError> {
  const projected = Result.fromThrowable(() => {
    const candidate = new Object(event);
    if (candidate !== event) return err(unsupportedProviderEvent());

    const prototype = Object.getPrototypeOf(candidate);
    if (prototype !== Object.prototype && prototype !== null) {
      return err(unsupportedProviderEvent());
    }

    const descriptors: Record<string, PropertyDescriptor> = Object.create(null);
    for (const key of Reflect.ownKeys(candidate)) {
      const stringKey = String(key);
      if (key !== stringKey) return err(unsupportedProviderEvent());
      const descriptor = Object.getOwnPropertyDescriptor(candidate, stringKey);
      if (
        descriptor === undefined ||
        !("value" in descriptor) ||
        descriptor.enumerable !== true ||
        descriptor.writable !== true ||
        descriptor.configurable !== true
      ) {
        return err(unsupportedProviderEvent());
      }
      descriptors[stringKey] = descriptor;
    }

    const parsedType = PiProviderHookNameSchema.safeParse(
      descriptors.type?.value,
    );
    if (!parsedType.success) return err(unsupportedProviderEvent());
    if (parsedType.data === "before_provider_request") {
      return ok(projectedProviderRequest());
    }
    if (parsedType.data === "before_provider_headers") {
      return ok(projectedProviderHeaders());
    }

    const parsedStatus = PiProviderStatusSchema.safeParse(
      descriptors.status?.value,
    );
    if (!parsedStatus.success || !Number.isInteger(parsedStatus.data)) {
      return err(unsupportedProviderEvent());
    }
    return ok(projectedProviderResponse(parsedStatus.data));
  }, unsupportedProviderEvent)();

  return projected.andThen((result) => result);
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

/**
 * Foreground tokens every Pi theme defines, so every caller may use them
 * unconditionally.
 *
 * `borderAccent`, `customMessageLabel` and `thinkingText` are the tokens the
 * finalized Weave surfaces use for, respectively, the one high-contrast
 * overlay boundary, the alternate identity ink (badges and labels), and
 * reasoning summaries. They are listed here rather than approximated with
 * `accent`/`muted` so a user's theme keeps control of those three roles.
 *
 * `searchMatchText` is one of Pi's two *optional* theme colours, but it is
 * still an ordinary `ThemeColor` accepted by `Theme.fg`, not a separate
 * helper method. Pi degrades it deterministically inside the host: a theme
 * that does not define `searchMatchText` resolves it to `colors.text`, so a
 * caller may always pass the token unconditionally. That also keeps this
 * port narrow — a simple stand-in only has to implement `fg`, with no
 * special-cased search method to model.
 */
export type PiUiThemeFgColor =
  | "accent"
  | "muted"
  | "text"
  | "warning"
  | "error"
  | "success"
  | "dim"
  | "border"
  | "borderMuted"
  | "borderAccent"
  | "customMessageLabel"
  | "thinkingText"
  | "searchMatchText"
  | "toolTitle"
  | "toolOutput";

/** Narrow projection of Pi's theme helpers used by the Weave UI surfaces. */
export interface PiUiThemePort {
  fg(color: PiUiThemeFgColor, text: string): string;
  bold(text: string): string;
  /**
   * Optional deliberately: the real Pi `Theme` always provides `bg()`, but
   * this narrow port is also satisfied by simpler stand-ins, so every caller
   * must degrade to foreground-only rendering when it is absent.
   */
  bg?(color: PiUiThemeBgColor, text: string): string;
  /**
   * Optional deliberately: the real Pi `Theme` provides `inverse()`, but a
   * simpler stand-in may not.
   *
   * Documented degradation: when it is absent, a caller falls back to
   * `bold(…)`. An inverse run is always a short badge or alert pair, so bold
   * keeps it legible without inventing a background colour the theme did not
   * choose.
   */
  inverse?(text: string): string;
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

type PiUiHostCallable =
  | ((...args: never[]) => void)
  | ((...args: never[]) => PiUiHostValue);
type PiUiKeybindingConfig = Readonly<
  Record<string, string | readonly string[] | undefined>
>;
interface PiUiHostObject {
  readonly width?: number;
  readonly requestRender?: () => void;
  readonly terminal?: { readonly rows?: number };
  readonly matches?: (...args: never[]) => boolean;
  readonly getKeys?: (...args: never[]) => readonly string[] | undefined;
  readonly getEffectiveConfig?: (...args: never[]) => PiUiKeybindingConfig;
}
type PiUiHostValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | PiUiHostCallable
  | readonly PiUiHostValue[]
  | PiUiHostObject;
type PiEditorFactory = (...args: never[]) => object;
type PiUiWidgetValue =
  | string
  | readonly string[]
  | (() => PiToolRenderComponent)
  | undefined;
type PiEventHandlerNoValue = ReturnType<() => void>;
type PiEventHandlerResult =
  | { readonly action: "continue" | "handled" }
  | { readonly cancel: true }
  | { readonly systemPrompt: string }
  | undefined
  | PiEventHandlerNoValue;

interface PiUiCustomComponent {
  render(width: number): string[];
  invalidate?(): void;
}

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
    value: PiUiWidgetValue,
    options?: { placement?: "aboveEditor" | "belowEditor" },
  ): void;
  /**
   * Mirrors Pi's own `ctx.ui.getEditorComponent()`. The concrete
   * `EditorFactory`/`CustomEditor` shape is owned by the real
   * `@earendil-works/pi-coding-agent`/`@earendil-works/pi-tui` packages, so
   * this port keeps only the callable identity needed to restore the prior
   * editor. `src/extension.ts` is the real adapter boundary.
   */
  getEditorComponent?(): PiEditorFactory | undefined;
  /** Mirrors Pi's own `ctx.ui.setEditorComponent()`; pass `undefined` to restore the host default editor. */
  setEditorComponent?<TFactory>(factory: TFactory): void;
  /** Pi's real custom UI boundary for complex interactive components. */
  custom?<T>(
    factory: (
      tui: PiUiHostValue,
      /**
       * Pi hands the factory its `Theme`, a colour palette. Components that
       * need an `EditorTheme` (a record of styling functions) must build one
       * from it; the two are not interchangeable, and passing a palette where
       * a styling record belongs fails only at render time.
       */
      theme: PiUiThemePort,
      keybindings: PiUiHostValue,
      done: (value: T) => void,
    ) => PiUiCustomComponent,
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
export type PiEventHandler = <TEvent>(
  event: TEvent,
  ctx: PiSessionContext,
) => PiEventHandlerResult | Promise<PiEventHandlerResult>;

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

type PiToolArguments = Readonly<Record<string, JsonValue>>;

export interface PiToolRenderContext {
  readonly args?: PiToolArguments;
  readonly lastComponent?: PiToolRenderComponent;
  /**
   * Pi's own `ToolRenderContext.executionStarted`. A call renderer uses it to
   * stop drawing once the result renderer owns the entry, so a tool that draws
   * its own frame prints exactly one of them.
   */
  readonly executionStarted?: boolean;
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
  /**
   * Pi's own `ToolDefinition.renderShell`. `"default"` keeps Pi's coloured
   * tool shell; `"self"` hands the whole entry to this tool's renderers, which
   * is what lets the delegation card own its frame instead of sitting inside
   * a second one.
   */
  readonly renderShell?: "default" | "self";
  readonly renderCall?: (
    args: PiToolArguments,
    theme: PiUiThemePort,
    context: PiToolRenderContext,
  ) => PiToolRenderComponent;
  readonly renderResult?: (
    result: PiToolResult,
    options: PiToolRenderOptions,
    theme: PiUiThemePort,
    context: PiToolRenderContext,
  ) => PiToolRenderComponent;
  execute<TParams>(
    toolCallId: string,
    params: TParams,
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
  appendEntry<TEntry>(type: string, data: TEntry): void;
  /** Reads and changes Pi's active tool list. */
  getActiveTools(): readonly string[];
  setActiveTools(names: readonly string[]): void;
  /**
   * Reads every configured tool with its `sourceInfo`
   * (`ExtensionAPI.getAllTools`). Pi has exposed it publicly since the
   * declared host floor, but it stays optional here for the same reason
   * every other host surface does: a host gap must degrade into typed
   * evidence, never an exception.
   */
  getAllTools?: () => readonly PiToolInfo[];
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
   * Registers a complete provider object (`ExtensionAPI.registerProvider`),
   * overriding the host's own provider of the same id. Optional for the same
   * reason every other host surface is: a host without it must degrade into a
   * bounded typed outcome, never an exception. The provider is typed as
   * `unknown` deliberately — its full shape belongs to `@earendil-works/pi-ai`,
   * and this adapter only ever passes back a wrapped copy of the host's own.
   */
  registerProvider?: <TProvider>(provider: TProvider) => void;
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
  setThinkingLevel?: (level: string) => void | Promise<void>;
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
type PiLogJsonValue =
  | string
  | number
  | boolean
  | null
  | readonly PiLogJsonValue[]
  | { readonly [key: string]: PiLogJsonValue };
type PiLogValue = PiLogJsonValue | PiAdapterFailure | Error | undefined;
type PiLogFields = { readonly [key: string]: PiLogValue };

export interface PiAdapterLogger {
  debug(obj: PiLogFields, msg?: string): void;
  info(obj: PiLogFields, msg?: string): void;
  warn(obj: PiLogFields, msg?: string): void;
  error(obj: PiLogFields, msg?: string): void;
}

export type {
  PiChildInspectionEffectiveSettings,
  PiChildInspectionSettings,
  PiChildInspectionSettingsChoice,
  PiChildInspectionSettingsIssue,
  PiChildInspectionSettingsMode,
  PiChildInspectionSettingsResolution,
} from "./child-inspection-settings.js";
