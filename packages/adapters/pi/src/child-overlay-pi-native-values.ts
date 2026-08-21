import { Result } from "neverthrow";
import { stripPathLike } from "./child-overlay-search.js";
import {
  TOOL_ERROR_DETAILS_UNAVAILABLE,
  TOOL_RESULT_DETAILS_UNAVAILABLE,
} from "./child-provider-error.js";
import type { PiChildTranscriptToolEntry } from "./child-transcript.js";
import type { Tone } from "./ui-paint.js";
import { safeTrim } from "./ui-rows.js";

/** Characters of one summarized argument, result or queue item. */
const PI_NATIVE_VALUE_CHARS = 240;

/** Nesting depth a summarized payload is walked to before it folds. */
const PI_NATIVE_VALUE_DEPTH = 2;

/** Keys of one summarized object. */
const PI_NATIVE_VALUE_KEYS = 4;

/** Nesting depth normalizeOverlayPayload walks before it gives up. */
const PI_NATIVE_NORMALIZE_DEPTH = 6;
/** Object and array members a display preview may inspect. */
const PI_NATIVE_NORMALIZE_MEMBERS = 32;
/** Line and column facts are useful only inside this closed range. */
const PI_NATIVE_RANGE_LIMIT = 1_000_000;
const PI_NATIVE_ABSOLUTE_PATH = /(?:^|[\s"'])\/(?:[^/\s"']+\/)*[^/\s"']*/u;
const PI_NATIVE_WINDOWS_PATH = /(?:^|[\s"'])[A-Za-z]:\\/u;
const PI_NATIVE_RELATIVE_TRAVERSAL = /(?:^|[/\\])\.\.(?:[/\\]|$)/u;
const PI_NATIVE_SECRET_TEXT =
  /(?:SENTINEL|\bBearer\s|\b(?:api[-_ ]?key|secret|token|password)\s*[:=]|(?:ghp_|github_pat_|xox[bp]-|sk-))/iu;
const PI_NATIVE_SENSITIVE_KEY =
  /(?:authorization|bearer|cookie|credential|password|secret|token|api[-_ ]?key)/iu;
const PI_NATIVE_HIDDEN_KEY =
  /^(?:body|details|env|headers|metadata|payload|raw|reasoning|thinking)$/iu;

/**
 * The sentences the closed reducer projection substitutes for a value it may
 * not reproduce. They are a privacy outcome, not a fact about the run, so
 * they are dropped here rather than printed.
 */
const PI_NATIVE_WITHHELD_TEXT: ReadonlySet<string> = new Set([
  TOOL_RESULT_DETAILS_UNAVAILABLE,
  TOOL_ERROR_DETAILS_UNAVAILABLE,
]);

/**
 * Keys of a real Pi tool answer that carry correlation, not information.
 * They are dropped from a RESULT only; a tool's arguments keep every key,
 * because there the shape is the information.
 */
const PI_NATIVE_RESULT_BOOKKEEPING_KEYS: ReadonlySet<string> = new Set([
  "role",
  "type",
  "id",
  "toolCallId",
  "tool_use_id",
  "toolUseId",
  "toolName",
  "name",
  "isError",
  "is_error",
  "timestamp",
  "addedToolNames",
]);

/** The text of one pi-ai content block, or undefined when it carries none. */
function contentBlockText(record: Record<string, unknown>): string | undefined {
  const type = safeOwnValue(record, "type");
  if (typeof type !== "string") return undefined;
  if (type === "thinking" || type === "reasoning") return undefined;
  const value = safeOwnValue(record, "text");
  return typeof value === "string" ? value : undefined;
}

const safeOwnValue = (record: object, key: PropertyKey): unknown => {
  const descriptor = Result.fromThrowable(
    () => Object.getOwnPropertyDescriptor(record, key),
    () => undefined,
  )();
  if (descriptor.isErr() || descriptor.value === undefined) return undefined;
  return "value" in descriptor.value ? descriptor.value.value : undefined;
};

const safeObjectKeys = (record: object): readonly string[] => {
  const keys = Result.fromThrowable(
    () => Object.keys(record),
    () => [] as string[],
  )();
  return keys.isOk() ? keys.value : [];
};

const safeArrayLength = (value: object): number | undefined => {
  const raw = safeOwnValue(value, "length");
  return typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0
    ? raw
    : undefined;
};

const safePreviewString = (value: string): string | undefined => {
  const clean = safeTrim(value);
  if (
    clean.length === 0 ||
    PI_NATIVE_WITHHELD_TEXT.has(clean) ||
    PI_NATIVE_ABSOLUTE_PATH.test(clean) ||
    PI_NATIVE_WINDOWS_PATH.test(clean) ||
    PI_NATIVE_RELATIVE_TRAVERSAL.test(clean) ||
    PI_NATIVE_SECRET_TEXT.test(clean)
  ) {
    return undefined;
  }
  return truncateUtf8(clean, PI_NATIVE_VALUE_CHARS);
};

/**
 * A payload with its host wrappers removed and its withheld parts dropped.
 * Returns undefined for a value with nothing left to say.
 */
export function normalizeOverlayPayload(
  value: unknown,
  stripBookkeeping = false,
  depth = 0,
): unknown {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return safePreviewString(value);
  if (typeof value === "number") {
    return Number.isFinite(value) && Math.abs(value) <= PI_NATIVE_RANGE_LIMIT
      ? value
      : undefined;
  }
  if (typeof value === "boolean") return value;
  if (typeof value !== "object") return undefined;
  if (depth >= PI_NATIVE_NORMALIZE_DEPTH) return undefined;
  if (Array.isArray(value)) {
    const length = safeArrayLength(value);
    if (length === undefined) return undefined;
    const items: unknown[] = [];
    const size = Math.min(length, PI_NATIVE_NORMALIZE_MEMBERS);
    for (let index = 0; index < size; index += 1) {
      const item = normalizeOverlayPayload(
        safeOwnValue(value, String(index)),
        stripBookkeeping,
        depth + 1,
      );
      if (item !== undefined) items.push(item);
    }
    if (items.length === 0) return undefined;
    // A normalized content-block array is prose, so it reads as prose.
    return items.every((item) => typeof item === "string")
      ? (items as string[]).join(" ")
      : items;
  }
  const record = value as Record<string, unknown>;
  const blockType = safeOwnValue(record, "type");
  if (blockType === "thinking" || blockType === "reasoning") return undefined;
  const blockText = contentBlockText(record);
  if (blockText !== undefined) {
    return normalizeOverlayPayload(blockText, stripBookkeeping, depth + 1);
  }
  const normalized: Record<string, unknown> = {};
  for (const key of safeObjectKeys(record).slice(
    0,
    PI_NATIVE_NORMALIZE_MEMBERS,
  )) {
    if (stripBookkeeping && PI_NATIVE_RESULT_BOOKKEEPING_KEYS.has(key))
      continue;
    if (PI_NATIVE_SENSITIVE_KEY.test(key) || PI_NATIVE_HIDDEN_KEY.test(key))
      continue;
    const next = normalizeOverlayPayload(
      safeOwnValue(record, key),
      stripBookkeeping,
      depth + 1,
    );
    if (next !== undefined) normalized[key] = next;
  }
  return safeObjectKeys(normalized).length === 0 ? undefined : normalized;
}

export function summarizeOverlayValue(value: unknown, depth = 0): string {
  if (value === undefined) return "";
  if (value === null) return "null";
  if (typeof value === "string") return safeTrim(value);
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (typeof value !== "object") return "";
  if (depth >= PI_NATIVE_VALUE_DEPTH) return "…";
  if (Array.isArray(value)) {
    const length = safeArrayLength(value) ?? 0;
    const shown: string[] = [];
    const size = Math.min(length, PI_NATIVE_VALUE_KEYS);
    for (let index = 0; index < size; index += 1) {
      const item = summarizeOverlayValue(
        safeOwnValue(value, String(index)),
        depth + 1,
      );
      if (item.length > 0) shown.push(item);
    }
    const rest = Math.max(0, length - size);
    return `${shown.join(", ")}${rest > 0 ? ` …+${rest}` : ""}`;
  }
  const record = value as Record<string, unknown>;
  const keys = safeObjectKeys(record);
  const shown = keys.slice(0, PI_NATIVE_VALUE_KEYS).map((key) => {
    const item = summarizeOverlayValue(safeOwnValue(record, key), depth + 1);
    return item.length === 0 ? "" : `${safeTrim(key)}: ${item}`;
  });
  const rest = Math.max(0, keys.length - PI_NATIVE_VALUE_KEYS);
  return `${shown.filter((item) => item.length > 0).join(", ")}${rest > 0 ? ` …+${rest}` : ""}`;
}

/** summarizeOverlayValue, bounded and stripped of storage locations. */
export function overlayPayloadText(value: unknown): string {
  return boundedPayloadText(normalizeOverlayPayload(value, false));
}

/**
 * A tool's ANSWER in one bounded line: content blocks resolved to their prose,
 * correlation bookkeeping dropped, withheld parts absent.
 */
export function overlayToolResultText(value: unknown): string {
  const normalized = normalizeOverlayPayload(value, true);
  if (typeof normalized === "object" && normalized !== null) {
    const record = normalized as Record<string, unknown>;
    const output: Record<string, unknown> = {};
    for (const key of ["stdout", "stderr", "output"] as const) {
      const item = safeOwnValue(record, key);
      if (typeof item === "string" && item.length > 0) output[key] = item;
    }
    const outputKeys = safeObjectKeys(output);
    if (outputKeys.length === 1) {
      return boundedPayloadText(safeOwnValue(output, outputKeys[0] ?? ""));
    }
    if (outputKeys.length > 0) return boundedPayloadText(output);
  }
  return boundedPayloadText(normalized);
}

function truncateUtf8(value: string, maxBytes: number): string {
  let result = "";
  let bytes = 0;
  for (const character of value) {
    const size = new TextEncoder().encode(character).byteLength;
    if (bytes + size > maxBytes) break;
    result += character;
    bytes += size;
  }
  return result;
}

function boundedPayloadText(normalized: unknown): string {
  if (normalized === undefined) return "";
  const summary = summarizeOverlayValue(unwrapSoleContent(normalized));
  if (summary.length === 0) return "";
  return truncateUtf8(stripPathLike(summary).trim(), PI_NATIVE_VALUE_CHARS);
}

/**
 * Pi wraps a tool's answer in { content: … }. Printing the wrapper spends a
 * scarce transcript column on a key that carries no information, so a payload
 * whose ONLY surviving key is content is shown as that value.
 */
function unwrapSoleContent(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return value;
  }
  const keys = Object.keys(value as Record<string, unknown>);
  if (keys.length !== 1 || keys[0] !== "content") return value;
  return (value as Record<string, unknown>).content;
}

/** The single argument a tool row leads with, when one reads as its target. */
const toolArgumentKeys = (toolName: string): readonly string[] => {
  const name = toolName.toLowerCase();
  if (name === "bash" || name === "shell" || name === "exec")
    return ["command", "cmd", "script", "timeout"];
  if (name === "read" || name === "grep" || name === "find")
    return [
      "path",
      "file",
      "range",
      "startLine",
      "endLine",
      "startColumn",
      "endColumn",
      "limit",
      "offset",
    ];
  if (name === "edit" || name === "write")
    return ["path", "file", "range", "startLine", "endLine", "operation"];
  return [];
};

function selectedToolArguments(entry: PiChildTranscriptToolEntry): unknown {
  if (!entry.argumentsKnown) return undefined;
  const args = entry.arguments;
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    return args;
  }
  const record = args as Record<string, unknown>;
  const preferred = toolArgumentKeys(entry.toolName);
  const keys = safeObjectKeys(record);
  const selected =
    preferred.length === 0
      ? keys.slice(0, PI_NATIVE_VALUE_KEYS)
      : preferred.filter((key) => keys.includes(key));
  if (selected.length === 0) return undefined;
  const projected: Record<string, unknown> = {};
  for (const key of selected.slice(0, PI_NATIVE_VALUE_KEYS)) {
    const value = safeOwnValue(record, key);
    if (value !== undefined) projected[key] = value;
  }
  return safeObjectKeys(projected).length === 0 ? undefined : projected;
}

export function overlayToolTarget(entry: PiChildTranscriptToolEntry): string {
  const selected = selectedToolArguments(entry);
  if (typeof selected === "string") return overlayPayloadText(selected);
  if (typeof selected !== "object" || selected === null) return "";
  const record = selected as Record<string, unknown>;
  const preferred = toolArgumentKeys(entry.toolName);
  for (const key of [...preferred, ...safeObjectKeys(record)]) {
    const value = safeOwnValue(record, key);
    if (typeof value !== "string") continue;
    const text = overlayPayloadText(value);
    if (text.length > 0) return text;
  }
  return "";
}

/** Every allowlisted argument of a tool call, as the call signature prints it. */
export function overlayToolArgs(entry: PiChildTranscriptToolEntry): string {
  return overlayPayloadText(selectedToolArguments(entry));
}

/** What the latest phase of a tool call produced, in one bounded line. */
export function overlayToolOutcome(
  entry: PiChildTranscriptToolEntry,
): string | undefined {
  // A terminal phase always states an outcome, and never states running.
  if (entry.state === "error" || entry.error !== undefined) {
    const detail = overlayToolResultText(entry.error ?? entry.result);
    return detail.length === 0 ? "failed" : stripPathLike(detail);
  }
  if (entry.state === "result" || entry.result !== undefined) {
    const text = overlayToolResultText(entry.result);
    return text.length === 0 ? "done" : text;
  }
  const partial = entry.partialResults[entry.partialResults.length - 1];
  if (partial !== undefined) {
    const text = overlayToolResultText(partial);
    return text.length === 0 ? "running" : text;
  }
  if (entry.state === "called" || entry.state === "partial") return "running";
  return undefined;
}

/** The tone the latest phase of a tool call carries on every surface. */
export function overlayToolTone(entry: PiChildTranscriptToolEntry): Tone {
  if (entry.error !== undefined || entry.state === "error") return "bad";
  if (entry.state === "result") return "ok";
  if (entry.state === "placeholder") return "mute";
  return "run";
}
