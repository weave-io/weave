/**
 * Native session MESSAGE → bounded overlay fact families.
 *
 * A Pi native session file holds pi-ai messages, not events, and the whole
 * story of a run's tool use is spread across two of them: an `AssistantMessage`
 * whose `content` carries `{ type: "toolCall", id, name, arguments }` blocks,
 * and a separate `ToolResultMessage` — `{ role: "toolResult", toolCallId,
 * toolName, content, isError }` — persisted as its own entry. This module owns
 * the closed, bounded projection of both into the fact families the transcript
 * reducer understands, plus the small identity and text primitives that
 * projection needs.
 *
 * It is a LEAF: it depends on `child-overlay-types.js` and nothing else, so the
 * replay mapper, the controller and the renderer all read one shared narrow of
 * the host's message shapes. Nothing here retains a raw host payload, image
 * bytes, or a storage location.
 */

import { err, ok, type Result } from "neverthrow";
import {
  CHILD_OVERLAY_BOUNDS,
  type ChildOverlayMappingError,
  OpaqueIdSchema,
} from "./child-overlay-types.js";

export function safeEntryId(value: string, fallback: string): string {
  const parsed = OpaqueIdSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  return fallback;
}

// C0 except TAB/LF/CR, DEL, and C1 U+0080–U+009F. Named first, compiled second:
// the literal form is rejected by `noControlCharactersInRegex`, and an inline
// `String.raw` argument is rewritten back into it by `useRegexLiterals`.
const BOUND_TEXT_CONTROL_CLASS = String.raw`[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u0080-\u009f]`;
const BOUND_TEXT_CONTROL_PATTERN = new RegExp(BOUND_TEXT_CONTROL_CLASS, "gu");

export function boundText(value: string): string {
  const clean = value.replace(BOUND_TEXT_CONTROL_PATTERN, "");
  if (clean.length <= CHILD_OVERLAY_BOUNDS.maxTextLength) return clean;
  return [...clean].slice(0, CHILD_OVERLAY_BOUNDS.maxTextLength).join("");
}

export function messageText(message: unknown): {
  readonly role: string | undefined;
  readonly text: string;
} {
  const record = recordOf(message);
  if (record === undefined) return { role: undefined, text: "" };
  const role = typeof record.role === "string" ? record.role : undefined;
  const content = record.content;
  if (typeof content === "string") return { role, text: boundText(content) };
  if (!Array.isArray(content)) return { role, text: "" };
  let text = "";
  for (const block of content) {
    if (typeof block === "string") {
      text += block;
      continue;
    }
    const b = recordOf(block);
    if (b === undefined) continue;
    if (typeof b.text === "string") text += b.text;
  }
  return { role, text: boundText(text) };
}

// ---------------------------------------------------------------------------
// Strict native content-block mapping
// ---------------------------------------------------------------------------

export function recordOf(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return undefined;
  return value as Record<string, unknown>;
}

export function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function boundLabel(value: string): string {
  return value.slice(0, CHILD_OVERLAY_BOUNDS.maxLabelLength);
}

/** Bounded normalized tool-result content: text and image presence only. */
export interface NativeResultBlock {
  readonly type: string;
  readonly text?: string;
  readonly mimeType?: string;
}

export interface NativeToolCallBlock {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly arguments: unknown;
}

export interface NativeToolResultBlock {
  readonly toolCallId: string;
  readonly isError: boolean;
  readonly content: readonly NativeResultBlock[];
  readonly text: string;
}

export interface NativeMessageParts {
  readonly role: string | undefined;
  readonly text: string;
  readonly thinking: readonly string[];
  readonly toolCalls: readonly NativeToolCallBlock[];
  readonly toolResults: readonly NativeToolResultBlock[];
  readonly images: readonly (string | undefined)[];
}

function imageMimeType(block: Record<string, unknown>): string | undefined {
  const source = recordOf(block.source);
  const mime =
    nonEmptyString(block.mimeType) ??
    nonEmptyString(block.mediaType) ??
    nonEmptyString(source?.mimeType) ??
    nonEmptyString(source?.media_type);
  return mime === undefined ? undefined : boundLabel(mime);
}

/**
 * Normalizes one tool result payload into bounded text/image blocks.
 *
 * Image bytes are deliberately dropped: the overlay never retains transcript
 * bytes, so an image result is preserved as a typed placeholder with its MIME
 * type. Text is bounded by {@link boundText}.
 */
function toolResultContent(
  value: unknown,
): Result<
  { readonly content: readonly NativeResultBlock[]; readonly text: string },
  ChildOverlayMappingError
> {
  if (typeof value === "string") {
    const text = boundText(value);
    return ok({ content: [{ type: "text", text }], text });
  }
  const record = recordOf(value);
  if (record !== undefined && Array.isArray(record.content))
    return toolResultContent(record.content);
  if (record !== undefined) {
    const text = boundText(nonEmptyString(record.text) ?? "");
    return ok({
      content: text.length > 0 ? [{ type: "text", text }] : [],
      text,
    });
  }
  if (!Array.isArray(value)) return ok({ content: [], text: "" });
  if (value.length > CHILD_OVERLAY_BOUNDS.maxEntryContentBlocks) {
    return err({
      type: "OverlayCapacityExceeded",
      operation: "entry-content-blocks",
    });
  }
  const content: NativeResultBlock[] = [];
  let text = "";
  for (const item of value) {
    if (typeof item === "string") {
      text += item;
      content.push({ type: "text", text: boundText(item) });
      continue;
    }
    const block = recordOf(item);
    if (block === undefined) continue;
    const type = nonEmptyString(block.type) ?? "text";
    if (type === "image") {
      content.push({ type: "image", mimeType: imageMimeType(block) });
      continue;
    }
    const blockText = nonEmptyString(block.text);
    if (blockText === undefined) {
      content.push({ type: boundLabel(type) });
      continue;
    }
    text += blockText;
    content.push({ type: "text", text: boundText(blockText) });
  }
  return ok({ content, text: boundText(text) });
}

/**
 * Splits one native message into the bounded fact families the transcript
 * reducer understands: assistant text, reasoning, tool calls, tool results
 * (text / error / image) and standalone images. Nothing is flattened into an
 * opaque `unknown` fact and no raw host payload is retained.
 */
export function nativeMessageParts(
  message: unknown,
): Result<NativeMessageParts, ChildOverlayMappingError> {
  const record = recordOf(message);
  const role = nonEmptyString(record?.role);
  const content = record?.content;
  if (typeof content === "string") {
    return ok({
      role,
      text: boundText(content),
      thinking: [],
      toolCalls: [],
      toolResults: [],
      images: [],
    });
  }
  const thinking: string[] = [];
  const toolCalls: NativeToolCallBlock[] = [];
  const toolResults: NativeToolResultBlock[] = [];
  const images: (string | undefined)[] = [];
  let text = "";
  // A persisted pi-ai `ToolResultMessage` states its correlation on the
  // MESSAGE — `{ role: "toolResult", toolCallId, toolName, content, isError }`
  // — not inside a content block. Reading only blocks turned every answer in a
  // real session file into an unrecognised message, so a replayed page showed
  // three calls that never finished.
  if (role === "toolResult") {
    const toolCallId = nonEmptyString(record?.toolCallId);
    if (toolCallId !== undefined) {
      const normalized = toolResultContent(content);
      if (normalized.isErr()) return err(normalized.error);
      return ok({
        role,
        text: "",
        thinking: [],
        toolCalls: [],
        toolResults: [
          {
            toolCallId: safeEntryId(toolCallId, "tool-0"),
            isError: record?.isError === true || record?.is_error === true,
            content: normalized.value.content,
            text: normalized.value.text,
          },
        ],
        images: [],
      });
    }
  }
  if (content !== undefined && !Array.isArray(content)) {
    return ok({
      role,
      text: "",
      thinking: [],
      toolCalls: [],
      toolResults: [],
      images: [],
    });
  }
  const blocks = Array.isArray(content) ? content : [];
  if (blocks.length > CHILD_OVERLAY_BOUNDS.maxEntryContentBlocks) {
    return err({
      type: "OverlayCapacityExceeded",
      operation: "entry-content-blocks",
    });
  }
  for (const item of blocks) {
    if (typeof item === "string") {
      text += item;
      continue;
    }
    const block = recordOf(item);
    if (block === undefined) continue;
    const type = nonEmptyString(block.type) ?? "";
    if (type === "thinking" || type === "reasoning") {
      const value =
        nonEmptyString(block.thinking) ?? nonEmptyString(block.text);
      if (value !== undefined) thinking.push(boundText(value));
      continue;
    }
    if (type === "toolCall" || type === "tool_use" || type === "tool_call") {
      const rawId =
        nonEmptyString(block.id) ??
        nonEmptyString(block.toolCallId) ??
        `tool-${toolCalls.length}`;
      toolCalls.push({
        toolCallId: safeEntryId(rawId, `tool-${toolCalls.length}`),
        toolName: boundLabel(
          nonEmptyString(block.name) ??
            nonEmptyString(block.toolName) ??
            "tool",
        ),
        arguments: block.arguments ?? block.input ?? block.args,
      });
      continue;
    }
    if (type === "toolResult" || type === "tool_result") {
      const rawId =
        nonEmptyString(block.toolCallId) ??
        nonEmptyString(block.toolUseId) ??
        nonEmptyString(block.tool_use_id) ??
        nonEmptyString(block.id) ??
        `tool-${toolResults.length}`;
      const normalized = toolResultContent(
        block.content ?? block.output ?? block.result,
      );
      if (normalized.isErr()) return err(normalized.error);
      toolResults.push({
        toolCallId: safeEntryId(rawId, `tool-${toolResults.length}`),
        isError: block.isError === true || block.is_error === true,
        content: normalized.value.content,
        text: normalized.value.text,
      });
      continue;
    }
    if (type === "image") {
      images.push(imageMimeType(block));
      continue;
    }
    const blockText = nonEmptyString(block.text);
    if (blockText !== undefined) text += blockText;
  }
  return ok({
    role,
    text: boundText(text),
    thinking,
    toolCalls,
    toolResults,
    images,
  });
}
