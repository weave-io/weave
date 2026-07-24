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
 * @see docs/specs/33-spec-pi-adapter/33-spec-pi-adapter.md (Spec 33 §6, §7)
 */

/** Pi's four extension execution modes. Only `"tui"` is in scope (Spec 33 §3). */
export type PiMode = "tui" | "rpc" | "json" | "print";

/** Whether the current project has been granted local trust. */
export type PiTrustState = "trusted" | "withheld";

/** Scope a discovered command/tool/skill/prompt resource was loaded from. */
export type PiResourceScope = "user" | "project" | "temporary";

/** Whether a resource came from a package manifest or a top-level file. */
export type PiResourceOrigin = "package" | "top-level";

/**
 * Canonical provenance for a discovered command or tool. Per Spec 33 §7.1,
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

/** One entry from `pi.getAllTools()`. */
export interface PiToolInfo {
  readonly name: string;
  readonly description?: string;
  readonly sourceInfo: PiSourceInfo;
}

/**
 * One entry from Pi's authenticated model catalog
 * (`ctx.modelRegistry.getAvailable()`) or the currently active model
 * (`ctx.model`).
 */
export interface PiModelInfo {
  readonly provider: string;
  readonly id: string;
  readonly name?: string;
}

/** Narrow projection of `ctx.modelRegistry`: authenticated-model discovery only. */
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

/** The subset of Pi's `BuildSystemPromptOptions` this adapter reads. */
export interface PiBuildSystemPromptOptions {
  readonly skills?: readonly PiSkillInfo[];
}

/** The subset of the `before_agent_start` event payload this adapter reads. */
export interface PiBeforeAgentStartEvent {
  readonly systemPrompt?: string;
  readonly systemPromptOptions?: PiBuildSystemPromptOptions;
}

/** Notification severity accepted by `ctx.ui.notify`. */
export type PiUiNotifyLevel = "info" | "warning" | "error";

/**
 * Narrow projection of `ctx.ui`. Diagnostics/status surfaces only - no
 * message/entry renderers, no shortcuts, no editor overrides (Spec 33 §7.1
 * reserves those for later tasks).
 */
export interface PiUiPort {
  notify(message: string, level?: PiUiNotifyLevel): void;
  setStatus(key: string, value: string | undefined): void;
  setWidget(key: string, value: unknown): void;
}

/** Narrow projection of `ExtensionContext` used by command handlers and lifecycle delegates. */
export interface PiSessionContext {
  readonly mode: PiMode;
  readonly cwd: string;
  isProjectTrusted(): boolean;
  readonly ui: PiUiPort;
  /** The currently active model, if any (`ctx.model`). */
  readonly model: PiModelInfo | undefined;
  /** Authenticated-model discovery (`ctx.modelRegistry`). */
  readonly modelRegistry: PiModelRegistry;
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
 * Narrow projection of the Pi `ExtensionAPI` object passed to an extension's
 * default factory. Only the members this adapter's foundation layer uses.
 */
export interface PiExtensionApi {
  registerCommand(name: string, registration: PiCommandRegistration): void;
  getCommands(): readonly PiCommandInfo[];
  getAllTools(): readonly PiToolInfo[];
  on(event: string, handler: PiEventHandler): void;
  /**
   * Applies a model selection (`ExtensionAPI.setModel`). May reject/throw for
   * an invalid or unauthenticated model. May also *resolve* to `false`
   * without throwing (e.g. the host declined the selection) - callers MUST
   * treat a resolved `false` as a failed application, not as success.
   */
  setModel(
    model: PiModelInfo,
  ): boolean | undefined | Promise<boolean | undefined>;
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
