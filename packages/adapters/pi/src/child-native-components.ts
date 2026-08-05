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
  type TUI,
} from "@earendil-works/pi-tui";
import { Result } from "neverthrow";
import type {
  PiTranscriptComponent,
  PiTranscriptComponentFactory,
  PiTranscriptComponentRequest,
} from "./child-transcript.js";

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
