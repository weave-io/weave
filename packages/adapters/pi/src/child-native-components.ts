import {
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  getMarkdownTheme,
  ToolExecutionComponent,
  UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import {
  type DefaultTextStyle,
  Markdown,
  type MarkdownTheme,
  Text,
  type TUI,
} from "@earendil-works/pi-tui";
import { err, type Result as NeverthrowResult, Result } from "neverthrow";
import type { PiDelegationCardFacts } from "./child-card-model.js";
import {
  degradedDelegationCard,
  renderDelegationCard,
} from "./child-card-render.js";
import type { ChildCompactRenderOutput } from "./child-compact-render.js";
import type {
  PiTranscriptComponent,
  PiTranscriptComponentFactory,
  PiTranscriptComponentRequest,
} from "./child-transcript.js";
import type { PiToolRenderComponent, PiUiThemePort } from "./types.js";
import { makePaint, plainPaint } from "./ui-paint.js";

/** Stable code reported when compact native theming fails. */
export const CHILD_COMPACT_NATIVE_RENDER_FAILED =
  "ChildCompactRenderFailed" as const;

/** Stable code reported when the delegation card cannot be drawn. */
export const CHILD_CARD_NATIVE_RENDER_FAILED = "ChildCardRenderFailed" as const;

/**
 * The width the card is proved at before Pi ever mounts the component.
 *
 * A host theme is only known to work once it has actually painted, so the
 * component is built from one real render rather than from a promise that a
 * later one will succeed.
 */
const CARD_PROBE_WIDTH = 60;

/** Transcript facts Pi never shows in its own chat view. */
const SUPPRESSED_KINDS: ReadonlySet<PiTranscriptComponentRequest["kind"]> =
  new Set(["usage", "queue", "status", "retry", "extension_ui", "unknown"]);

/** Host wiring a native component needs; all of it comes from the Pi TUI session. */
export interface PiNativeTranscriptComponentDeps {
  readonly tui: TUI;
  readonly cwd: string;
  readonly markdownTheme?: MarkdownTheme;
  /** Horizontal padding Pi applies to chat content. Pi's own default is 1. */
  readonly outputPad?: number;
  readonly showImages?: boolean;
  readonly imageWidthCells?: number;
  /** Styling for reasoning text; Pi paints it with its `thinkingText` color. */
  readonly thinkingColor?: (text: string) => string;
}

interface NormalizedToolResult {
  readonly content: {
    type: string;
    text?: string;
    data?: string;
    mimeType?: string;
  }[];
  readonly details?: unknown;
  readonly isError: boolean;
}

/**
 * Pi renders a tool call through its definition's own renderer; without one it
 * prints just the bold tool name. The builtin definitions only need a cwd, so
 * an inspected child can show `read <path>` exactly like the native view.
 */
const BUILTIN_TOOL_DEFINITION_FACTORIES: Readonly<
  Record<string, (cwd: string) => unknown>
> = {
  bash: createBashToolDefinition,
  edit: createEditToolDefinition,
  find: createFindToolDefinition,
  grep: createGrepToolDefinition,
  ls: createLsToolDefinition,
  read: createReadToolDefinition,
  write: createWriteToolDefinition,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function textBlock(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "";
  return Result.fromThrowable(
    () => JSON.stringify(value, undefined, 2) ?? "",
    () => "tool_result_not_serializable",
  )().unwrapOr("[unserializable tool result]");
}

function normalizeToolResult(
  value: unknown,
  isError: boolean,
): NormalizedToolResult {
  if (isRecord(value) && Array.isArray(value.content))
    return {
      content: value.content as NormalizedToolResult["content"],
      details: value.details,
      isError: value.isError === true || isError,
    };
  return {
    content: [{ type: "text", text: textBlock(value) }],
    isError,
  };
}

function markdownComponent(
  text: string,
  theme: MarkdownTheme,
  outputPad: number,
  style?: DefaultTextStyle,
): PiTranscriptComponent {
  return new Markdown(text, outputPad, 0, theme, style);
}

/**
 * Drops the leading blank rows a native block opens with. Pi's chat has a whole
 * scrollback to breathe in; the inspection view has a fixed region, so every
 * wasted row costs visible child output.
 */
/**
 * Trims the blank rows a native block opens with and closes it with exactly one
 * blank row, so messages sit a cell apart instead of running together or
 * wasting the fixed inspection region on stacked padding.
 */
function spacedBlock(component: PiTranscriptComponent): PiTranscriptComponent {
  return {
    render(width) {
      const lines = component.render(width);
      let start = 0;
      while (start < lines.length && (lines[start] ?? "").trim() === "")
        start += 1;
      let end = lines.length;
      while (end > start && (lines[end - 1] ?? "").trim() === "") end -= 1;
      if (start >= end) return lines;
      return [...lines.slice(start, end), ""];
    },
    invalidate() {
      component.invalidate();
    },
  };
}

function toolComponent(
  request: PiTranscriptComponentRequest,
  deps: PiNativeTranscriptComponentDeps,
  definitionFor: (toolName: string) => unknown,
): PiTranscriptComponent {
  const payload =
    request.payload?.type === "tool" ? request.payload : undefined;
  const toolName = payload?.toolName ?? request.toolName ?? "tool";
  const component = new ToolExecutionComponent(
    toolName,
    payload?.toolCallId ?? request.entryId,
    payload?.arguments,
    {
      showImages: deps.showImages ?? false,
      imageWidthCells: deps.imageWidthCells,
    },
    (request.knownToolDefinition ?? definitionFor(toolName)) as never,
    deps.tui,
    deps.cwd,
  );
  if (payload === undefined) return component;
  if (payload.argumentsKnown) component.setArgsComplete();
  if (payload.state !== "placeholder") component.markExecutionStarted();
  for (const partial of payload.partialResults)
    component.updateResult(normalizeToolResult(partial, false), true);
  if (payload.state === "error")
    component.updateResult(
      normalizeToolResult(payload.error ?? payload.result, true),
      false,
    );
  else if (payload.state === "result")
    component.updateResult(normalizeToolResult(payload.result, false), false);
  return component;
}

function assistantText(request: PiTranscriptComponentRequest): string {
  const payload = request.payload;
  if (payload === undefined) return request.content;
  if (payload.type === "text") return payload.text;
  if (payload.type !== "assistant") return request.content;
  return request.factId.endsWith(":markdown") ? payload.markdown : payload.text;
}

function thinkingText(request: PiTranscriptComponentRequest): string {
  const payload = request.payload;
  if (payload?.type === "assistant") return payload.thinking;
  if (payload?.type === "text") return payload.text;
  return request.content;
}

const FALLBACK_MARKDOWN_THEME: MarkdownTheme = {
  heading: (text) => text,
  link: (text) => text,
  linkUrl: (text) => text,
  code: (text) => text,
  codeBlock: (text) => text,
  codeBlockBorder: (text) => text,
  quote: (text) => text,
  quoteBorder: (text) => text,
  hr: (text) => text,
  listBullet: (text) => text,
  bold: (text) => text,
  italic: (text) => text,
  strikethrough: (text) => text,
  underline: (text) => text,
};

/**
 * Themes the §6 compact three-line block (and optional expanded current item)
 * into a Pi `Text` component. Theme or helper failures become a typed Err with
 * a stable code — callers (tool `renderResult`) degrade and log without
 * affecting execution.
 */
export function renderPiChildCompactComponent(
  output: ChildCompactRenderOutput,
  options: { readonly expanded: boolean },
  theme: PiUiThemePort,
): NeverthrowResult<
  PiToolRenderComponent,
  typeof CHILD_COMPACT_NATIVE_RENDER_FAILED
> {
  return Result.fromThrowable(
    (): PiToolRenderComponent => {
      const line1 = theme.fg("toolTitle", theme.bold(output.lines[0]));
      const line2 = theme.fg("toolOutput", output.lines[1]);
      const line3 = theme.fg("muted", output.lines[2]);
      const collapsed = `${line1}\n${line2}\n${line3}`;
      if (
        options.expanded &&
        typeof output.expandedCurrentItem === "string" &&
        output.expandedCurrentItem.length > 0
      ) {
        return new Text(
          `${collapsed}\n${theme.fg("toolOutput", output.expandedCurrentItem)}`,
          0,
          0,
        );
      }
      return new Text(collapsed, 0, 0);
    },
    (): typeof CHILD_COMPACT_NATIVE_RENDER_FAILED =>
      CHILD_COMPACT_NATIVE_RENDER_FAILED,
  )();
}

/** What the card component needs beyond the facts themselves. */
export interface PiChildCardComponentOptions {
  /** Pi's own expanded flag for this tool entry. */
  readonly expanded: boolean;
  /**
   * Reports a stable render-failure code. Never receives paths, exception
   * text, or child content.
   */
  readonly onFailure?: (code: string) => void;
}

function normalizeComponentWidth(width: number): number {
  return Number.isFinite(width) ? Math.max(1, Math.floor(width)) : 1;
}

/**
 * The honest fallback component: a bounded framed card that says it could not
 * be drawn, painted without the host theme so a theme that throws cannot throw
 * a second time on the degraded path.
 */
export function degradedPiChildCardComponent(
  reason: string,
): PiToolRenderComponent {
  return {
    render(width) {
      const w = normalizeComponentWidth(width);
      return Result.fromThrowable(
        () => degradedDelegationCard(reason, { width: w, paint: plainPaint() }),
        () => "degraded_render_failed",
      )().unwrapOr([]);
    },
    invalidate() {
      // The degraded card holds no cache: it is derived from its width alone.
    },
  };
}

/**
 * Themes the finalized delegation card into a Pi tool-render component.
 *
 * The component re-renders at whatever width Pi asks for and caches only the
 * last width it drew, so `invalidate()` is enough to force a redraw. A theme
 * that throws becomes a typed Err here (and a degraded card later), never an
 * exception inside Pi's render loop.
 */
export function renderPiChildCardComponent(
  facts: PiDelegationCardFacts,
  options: PiChildCardComponentOptions,
  theme: PiUiThemePort,
): NeverthrowResult<
  PiToolRenderComponent,
  typeof CHILD_CARD_NATIVE_RENDER_FAILED
> {
  const expanded = options.expanded;
  const built = Result.fromThrowable(
    () => {
      const paint = makePaint(theme);
      // Proves the theme paints before the component is handed to Pi.
      const probe = renderDelegationCard(facts, {
        width: CARD_PROBE_WIDTH,
        expanded,
        paint,
      });
      return { paint, probe };
    },
    (): typeof CHILD_CARD_NATIVE_RENDER_FAILED =>
      CHILD_CARD_NATIVE_RENDER_FAILED,
  )();
  if (built.isErr()) return err(built.error);
  const { paint, probe } = built.value;
  let cache: { readonly width: number; readonly lines: string[] } | undefined =
    {
      width: CARD_PROBE_WIDTH,
      lines: probe,
    };
  return Result.fromThrowable(
    (): PiToolRenderComponent => ({
      render(width) {
        const w = normalizeComponentWidth(width);
        if (cache !== undefined && cache.width === w) return cache.lines;
        const drawn = Result.fromThrowable(
          () => renderDelegationCard(facts, { width: w, expanded, paint }),
          (): typeof CHILD_CARD_NATIVE_RENDER_FAILED =>
            CHILD_CARD_NATIVE_RENDER_FAILED,
        )();
        if (drawn.isErr()) {
          options.onFailure?.(drawn.error);
          cache = undefined;
          return degradedPiChildCardComponent("render_failed").render(w);
        }
        cache = { width: w, lines: drawn.value };
        return drawn.value;
      },
      invalidate() {
        cache = undefined;
      },
    }),
    (): typeof CHILD_CARD_NATIVE_RENDER_FAILED =>
      CHILD_CARD_NATIVE_RENDER_FAILED,
  )();
}

/**
 * Builds the native Pi chat components for a child transcript so an inspected
 * subagent reads like Pi's own session view instead of fallback prose.
 */
export function createPiNativeTranscriptComponentFactory(
  deps: PiNativeTranscriptComponentDeps,
): PiTranscriptComponentFactory {
  let resolvedTheme = deps.markdownTheme;
  const theme = (): MarkdownTheme => {
    resolvedTheme ??= Result.fromThrowable(
      () => getMarkdownTheme(),
      () => "markdown_theme_unavailable",
    )().unwrapOr(FALLBACK_MARKDOWN_THEME);
    return resolvedTheme;
  };
  const outputPad = deps.outputPad ?? 1;
  const definitions = new Map<string, unknown>();
  const definitionFor = (toolName: string): unknown => {
    if (definitions.has(toolName)) return definitions.get(toolName);
    const factory = BUILTIN_TOOL_DEFINITION_FACTORIES[toolName];
    const definition =
      factory === undefined
        ? undefined
        : Result.fromThrowable(
            () => factory(deps.cwd),
            () => "tool_definition_unavailable",
          )().unwrapOr(undefined);
    definitions.set(toolName, definition);
    return definition;
  };
  const thinkingStyle: DefaultTextStyle = {
    italic: true,
    color: deps.thinkingColor,
  };
  return {
    suppress(request) {
      if (SUPPRESSED_KINDS.has(request.kind)) return true;
      // A tool entry emits several facts (call, arguments, partials, result) and
      // Pi's tool block already renders all of them, so only the call fact
      // becomes a component; the rest would repeat the same block.
      if (request.kind === "tool") return !request.factId.endsWith(":tool");
      if (request.kind === "thinking")
        return thinkingText(request).trim() === "";
      if (request.kind === "assistant" || request.kind === "markdown")
        return assistantText(request).trim() === "";
      return false;
    },
    create(request) {
      switch (request.kind) {
        case "task":
        case "user":
        case "steering":
          return spacedBlock(
            new UserMessageComponent(
              request.payload?.type === "text"
                ? request.payload.text
                : request.content,
              theme(),
              outputPad,
            ),
          );
        case "assistant":
        case "markdown":
          return spacedBlock(
            markdownComponent(
              assistantText(request).trim(),
              theme(),
              outputPad,
            ),
          );
        case "thinking":
          return spacedBlock(
            markdownComponent(
              thinkingText(request).trim(),
              theme(),
              outputPad,
              thinkingStyle,
            ),
          );
        case "tool":
          return spacedBlock(toolComponent(request, deps, definitionFor));
        case "image":
          return spacedBlock(
            markdownComponent(
              `*[image ${request.imageMetadata?.imageId ?? "attachment"}]*`,
              theme(),
              outputPad,
            ),
          );
        default:
          return spacedBlock(
            markdownComponent(request.content, theme(), outputPad),
          );
      }
    },
  };
}
