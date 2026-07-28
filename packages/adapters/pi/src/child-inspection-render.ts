/**
 * Child inspection view compositor (Pi adapter contract).
 *
 * Composes a bounded, width-safe inspection panel around the transcript
 * renderer from `child-transcript.ts`. The view owns the title/breadcrumb,
 * status line, fixed markers, task preview, and transcript composition —
 * never raw child event payloads in breadcrumb metadata.
 *
 * Every public function returns `Result`; nothing throws on an expected path.
 */
import { ok, type Result } from "neverthrow";
import type {
  PiChildTranscriptRender,
  PiChildTranscriptState,
  PiTranscriptComponentFactory,
  PiTranscriptRenderInput,
  PiTranscriptRenderOptions,
} from "./child-transcript.js";
import {
  PiChildTranscriptRenderer,
  renderPiChildTranscript,
} from "./child-transcript.js";
import type { PiChildStatus, PiChildUsageAggregate } from "./child-tree.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Breadcrumb separator. */
const BREADCRUMB_SEP = " › ";
/** Ellipsis for truncated breadcrumbs. */
const BREADCRUMB_ELLIPSIS = "…";
/** Maximum rendered width (mirrors transcript renderer). */
export const MAX_INSPECTION_RENDER_WIDTH = 240;
/** Maximum length of task preview text before truncation. */
export const MAX_TASK_PREVIEW_LENGTH = 512;

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

export type PiChildInspectionRenderError = {
  readonly type: "InspectionRenderFailed";
  readonly operation: string;
  readonly detail?: string;
};

// ---------------------------------------------------------------------------
// Input model
// ---------------------------------------------------------------------------

/** Topology breadcrumb segment — trusted, never from child event payloads. */
export interface InspectionBreadcrumbSegment {
  readonly name: string;
}

/** Optional workflow/step metadata for direct-dispatch children. */
export interface InspectionWorkflowMeta {
  readonly workflowName: string;
  readonly stepName?: string;
}

/** Queue/turn/usage numeric summary. */
export interface InspectionSummary {
  readonly queueSize: number;
  readonly turnCount: number;
  readonly usage?: PiChildUsageAggregate;
}

/** Typed inspection render input/model. */
export interface PiChildInspectionRenderInput {
  /** Trusted topology path from root to this child, names only. */
  readonly topologyPath: readonly InspectionBreadcrumbSegment[];
  /** The child descriptor name (trusted, from parent delegation metadata). */
  readonly childName: string;
  /** Optional workflow/step metadata (direct dispatch only). */
  readonly workflowMeta?: InspectionWorkflowMeta;
  /** Current child lifecycle status. */
  readonly status: PiChildStatus;
  /** Currently executing tool, if any. */
  readonly currentTool?: string;
  /** Count of user interventions (steering/follow-up). */
  readonly interventionCount: number;
  /** Queue/turn/usage numeric summary. */
  readonly summary: InspectionSummary;
  /** Sanitized task preview text (may contain user-provided content). */
  readonly taskPreview?: string;
  /** Generation ID for cache keying; changes on child restart/recovery. */
  readonly generationId: string;

  // -- Markers --
  /** Transcript history was trimmed (oldest events evicted). */
  readonly trimmed: boolean;
  /** Child is a recovery continuation of a prior session. */
  readonly recoveryContinuation: boolean;
  /** Child had a recoverable interruption (may resume). */
  readonly recoverableInterruption: boolean;
  /** Child has interrupted history (events from a prior run). */
  readonly interruptedHistory: boolean;
  /** View is read-only (child completed/cancelled/failed). */
  readonly readOnlyCompletion: boolean;

  // -- Transcript --
  /** Transcript state for the child session. */
  readonly transcriptState: PiChildTranscriptState;
  /** Transcript renderer input (component factory, theme, etc.). */
  readonly transcriptInput?: PiTranscriptRenderInput;
}

// ---------------------------------------------------------------------------
// Output model
// ---------------------------------------------------------------------------

export interface PiChildInspectionRenderOutput {
  /** Fully composed lines, each fitting within visible width. */
  readonly lines: readonly string[];
  /** Effective rendered width. */
  readonly width: number;
  /** The breadcrumb line. */
  readonly breadcrumb: string;
  /** The status line. */
  readonly statusLine: string;
  /** Active fixed markers. */
  readonly markers: readonly string[];
  /** The task preview lines (separately labeled, sanitized). */
  readonly taskPreviewLines: readonly string[];
  /** The transcript render result. */
  readonly transcript: PiChildTranscriptRender;
}

// ---------------------------------------------------------------------------
// Cache key
// ---------------------------------------------------------------------------

export interface InspectionCacheKey {
  readonly childName: string;
  readonly generationId: string;
  readonly width: number;
  readonly status: PiChildStatus;
  readonly currentTool: string | undefined;
  readonly interventionCount: number;
  readonly queueSize: number;
  readonly turnCount: number;
  readonly trimmed: boolean;
  readonly recoveryContinuation: boolean;
  readonly recoverableInterruption: boolean;
  readonly interruptedHistory: boolean;
  readonly readOnlyCompletion: boolean;
  readonly transcriptNextSequence: number;
  readonly transcriptEntryCount: number;
  readonly transcriptHistoryTrimmedCount: number;
  readonly themeRef: unknown;
  readonly taskPreviewHash: string | undefined;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function renderWidth(width: number | undefined): number {
  if (width === undefined || !Number.isFinite(width)) return 80;
  return Math.max(1, Math.min(MAX_INSPECTION_RENDER_WIDTH, Math.floor(width)));
}

/**
 * Strips ANSI escape sequences and C0/C1 control characters from text.
 * Preserves printable content, spaces, and newlines only for display safety.
 */
function sanitizeText(value: string): string {
  let result = "";
  let i = 0;
  while (i < value.length) {
    const code = value.charCodeAt(i);
    // ESC or CSI start
    if (code === 0x1b || code === 0x9b) {
      if (code === 0x1b && value.charCodeAt(i + 1) === 0x5d) {
        // OSC sequence — skip to ST or BEL
        i += 2;
        while (i < value.length && value.charCodeAt(i) !== 0x07) {
          if (
            value.charCodeAt(i) === 0x1b &&
            value.charCodeAt(i + 1) === 0x5c
          ) {
            i += 2;
            break;
          }
          i += 1;
        }
        if (i < value.length && value.charCodeAt(i) === 0x07) i += 1;
      } else {
        i += code === 0x1b ? 2 : 1;
        while (i < value.length) {
          const t = value.charCodeAt(i);
          i += 1;
          if (t >= 0x40 && t <= 0x7e) break;
        }
      }
      continue;
    }
    // Allow space, printable ASCII, and high unicode; strip control chars
    if (code === 0x20 || (code > 0x20 && code < 0x7f) || code >= 0xa0) {
      result += value[i];
    } else if (code === 0x0a) {
      result += " "; // collapse newlines to space for single-line display
    }
    // skip other control chars silently
    i += 1;
  }
  return result;
}

function codePointWidth(cp: number): number {
  if (cp === 0 || cp < 32 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if (
    (cp >= 0x300 && cp <= 0x36f) ||
    (cp >= 0x1ab0 && cp <= 0x1aff) ||
    (cp >= 0x1dc0 && cp <= 0x1dff) ||
    (cp >= 0x20d0 && cp <= 0x20ff) ||
    (cp >= 0xfe00 && cp <= 0xfe0f) ||
    (cp >= 0x1f3fb && cp <= 0x1f3ff) ||
    cp === 0x200d
  )
    return 0;
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2329 && cp <= 0x232a) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe10 && cp <= 0xfe19) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f000 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  )
    return 2;
  return 1;
}

function visualWidth(text: string): number {
  let w = 0;
  for (const ch of text) w += codePointWidth(ch.codePointAt(0) ?? 0);
  return w;
}

/** Clip a string to fit within `maxWidth` visual columns. */
function clipToWidth(text: string, maxWidth: number): string {
  if (maxWidth < 1) return "";
  let result = "";
  let used = 0;
  for (const ch of text) {
    const cw = codePointWidth(ch.codePointAt(0) ?? 0);
    if (cw > 0 && used + cw > maxWidth) break;
    result += ch;
    used += cw;
  }
  return result;
}

/** Truncate a task preview, sanitize it, and bound its length. */
function sanitizeTaskPreview(raw: string | undefined): string | undefined {
  if (raw === undefined || raw.length === 0) return undefined;
  const clean = sanitizeText(raw);
  if (clean.length === 0) return undefined;
  const codePoints = [...clean];
  if (codePoints.length <= MAX_TASK_PREVIEW_LENGTH) return clean;
  return `${codePoints.slice(0, MAX_TASK_PREVIEW_LENGTH - 1).join("")}…`;
}

// ---------------------------------------------------------------------------
// Breadcrumb
// ---------------------------------------------------------------------------

function buildBreadcrumb(
  input: PiChildInspectionRenderInput,
  width: number,
): string {
  const segments: string[] = [];
  for (const seg of input.topologyPath) {
    const name = sanitizeText(seg.name);
    if (name.length > 0) segments.push(name);
  }
  const childName = sanitizeText(input.childName);
  if (childName.length > 0) segments.push(childName);
  if (segments.length === 0) segments.push("child");

  // For direct dispatch, append workflow/step after the breadcrumb
  let suffix = "";
  if (input.workflowMeta !== undefined) {
    const wf = sanitizeText(input.workflowMeta.workflowName);
    const step = input.workflowMeta.stepName
      ? sanitizeText(input.workflowMeta.stepName)
      : undefined;
    if (wf.length > 0) {
      suffix = step ? ` [${wf}/${step}]` : ` [${wf}]`;
    }
  }

  const full = segments.join(BREADCRUMB_SEP) + suffix;
  if (visualWidth(full) <= width) return clipToWidth(full, width);

  // Truncate: keep first + last segment, elide middle
  if (segments.length <= 2) return clipToWidth(full, width);
  const first = segments[0] ?? "";
  const last = segments[segments.length - 1] ?? "";
  const shortened =
    first +
    BREADCRUMB_SEP +
    BREADCRUMB_ELLIPSIS +
    BREADCRUMB_SEP +
    last +
    suffix;
  if (visualWidth(shortened) <= width) return clipToWidth(shortened, width);

  // Last resort: just clip the full string
  return clipToWidth(full, width);
}

// ---------------------------------------------------------------------------
// Status line
// ---------------------------------------------------------------------------

function buildStatusLine(input: PiChildInspectionRenderInput): string {
  const parts: string[] = [`[${input.status}]`];

  if (input.currentTool !== undefined) {
    parts.push(`tool:${sanitizeText(input.currentTool)}`);
  }
  if (input.interventionCount > 0) {
    parts.push(`interventions:${input.interventionCount}`);
  }
  parts.push(`turn:${input.summary.turnCount}`);
  parts.push(`queue:${input.summary.queueSize}`);

  if (input.summary.usage !== undefined) {
    const u = input.summary.usage;
    parts.push(
      `in:${u.inputTokens} out:${u.outputTokens} cost:${u.cost.toFixed(4)}`,
    );
  }

  return parts.join(" ");
}

function clipStatusLine(status: string, width: number): string {
  return clipToWidth(status, width);
}

// ---------------------------------------------------------------------------
// Markers
// ---------------------------------------------------------------------------

const MARKER_TRIMMED = "▲ transcript trimmed";
const MARKER_RECOVERY = "↻ recovery continuation";
const MARKER_RECOVERABLE = "⚡ recoverable interruption";
const MARKER_INTERRUPTED = "⏸ interrupted history";
const MARKER_READONLY = "● read-only (completed)";

function buildMarkers(input: PiChildInspectionRenderInput): string[] {
  const markers: string[] = [];
  if (input.trimmed) markers.push(MARKER_TRIMMED);
  if (input.recoveryContinuation) markers.push(MARKER_RECOVERY);
  if (input.recoverableInterruption) markers.push(MARKER_RECOVERABLE);
  if (input.interruptedHistory) markers.push(MARKER_INTERRUPTED);
  if (input.readOnlyCompletion) markers.push(MARKER_READONLY);
  return markers;
}

// ---------------------------------------------------------------------------
// Task preview
// ---------------------------------------------------------------------------

function buildTaskPreviewLines(
  preview: string | undefined,
  width: number,
): string[] {
  if (preview === undefined) return [];
  const label = "task: ";
  const labelWidth = visualWidth(label);
  const contentWidth = Math.max(1, width - labelWidth);
  const clipped = clipToWidth(preview, contentWidth);
  return [`${label}${clipped}`];
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

function computeCacheKey(
  input: PiChildInspectionRenderInput,
  width: number,
  themeRef: unknown,
): InspectionCacheKey {
  const ts = input.transcriptState;
  return {
    childName: input.childName,
    generationId: input.generationId,
    width,
    status: input.status,
    currentTool: input.currentTool,
    interventionCount: input.interventionCount,
    queueSize: input.summary.queueSize,
    turnCount: input.summary.turnCount,
    trimmed: input.trimmed,
    recoveryContinuation: input.recoveryContinuation,
    recoverableInterruption: input.recoverableInterruption,
    interruptedHistory: input.interruptedHistory,
    readOnlyCompletion: input.readOnlyCompletion,
    transcriptNextSequence: ts.nextSequence,
    transcriptEntryCount: ts.entries.length,
    transcriptHistoryTrimmedCount: ts.historyTrimmedCount,
    themeRef,
    taskPreviewHash: input.taskPreview,
  };
}

function cacheKeysEqual(a: InspectionCacheKey, b: InspectionCacheKey): boolean {
  return (
    a.childName === b.childName &&
    a.generationId === b.generationId &&
    a.width === b.width &&
    a.status === b.status &&
    a.currentTool === b.currentTool &&
    a.interventionCount === b.interventionCount &&
    a.queueSize === b.queueSize &&
    a.turnCount === b.turnCount &&
    a.trimmed === b.trimmed &&
    a.recoveryContinuation === b.recoveryContinuation &&
    a.recoverableInterruption === b.recoverableInterruption &&
    a.interruptedHistory === b.interruptedHistory &&
    a.readOnlyCompletion === b.readOnlyCompletion &&
    a.transcriptNextSequence === b.transcriptNextSequence &&
    a.transcriptEntryCount === b.transcriptEntryCount &&
    a.transcriptHistoryTrimmedCount === b.transcriptHistoryTrimmedCount &&
    Object.is(a.themeRef, b.themeRef) &&
    a.taskPreviewHash === b.taskPreviewHash
  );
}

// ---------------------------------------------------------------------------
// Compositor
// ---------------------------------------------------------------------------

function composeLines(
  breadcrumb: string,
  statusLine: string,
  markers: readonly string[],
  taskPreviewLines: readonly string[],
  transcriptLines: readonly string[],
  width: number,
): string[] {
  const lines: string[] = [];
  lines.push(clipToWidth(breadcrumb, width));
  lines.push(clipToWidth(statusLine, width));
  for (const m of markers) lines.push(clipToWidth(m, width));
  for (const tp of taskPreviewLines) lines.push(clipToWidth(tp, width));
  if (transcriptLines.length > 0) {
    lines.push(clipToWidth("─".repeat(Math.min(width, 40)), width));
    for (const tl of transcriptLines) lines.push(clipToWidth(tl, width));
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Public API: stateless render
// ---------------------------------------------------------------------------

/**
 * Renders a complete child inspection view, composing breadcrumb, status,
 * markers, task preview, and transcript. Pure and stateless — no caching.
 */
export function renderChildInspection(
  input: PiChildInspectionRenderInput,
  width = 80,
): Result<PiChildInspectionRenderOutput, PiChildInspectionRenderError> {
  const w = renderWidth(width);
  const breadcrumb = buildBreadcrumb(input, w);
  const rawStatus = buildStatusLine(input);
  const statusLine = clipStatusLine(rawStatus, w);
  const markers = buildMarkers(input);
  const preview = sanitizeTaskPreview(input.taskPreview);
  const taskPreviewLines = buildTaskPreviewLines(preview, w);
  const transcript = renderPiChildTranscript(
    input.transcriptState,
    w,
    input.transcriptInput,
  );
  const lines = composeLines(
    breadcrumb,
    statusLine,
    markers,
    taskPreviewLines,
    transcript.lines,
    w,
  );

  return ok({
    lines,
    width: w,
    breadcrumb,
    statusLine,
    markers,
    taskPreviewLines,
    transcript,
  });
}

function resolveTranscriptOptions(
  input: PiTranscriptRenderInput | undefined,
): PiTranscriptRenderOptions | undefined {
  if (input === undefined) return undefined;
  if (typeof input === "object" && "componentFactory" in input) {
    return input as PiTranscriptRenderOptions;
  }
  return { componentFactory: input as PiTranscriptComponentFactory };
}

// ---------------------------------------------------------------------------
// Public API: cached renderer
// ---------------------------------------------------------------------------

/**
 * Stateful inspection renderer with deterministic cache invalidation.
 * Caches by child/generation, width, status, markers, transcript state,
 * and theme identity. Invalidates on any relevant state change.
 */
export class PiChildInspectionRenderer {
  private cachedKey: InspectionCacheKey | undefined;
  private cachedOutput: PiChildInspectionRenderOutput | undefined;
  private transcriptRenderer: PiChildTranscriptRenderer;

  constructor(transcriptInput?: PiTranscriptRenderInput) {
    this.transcriptRenderer = new PiChildTranscriptRenderer(transcriptInput);
  }

  render(
    input: PiChildInspectionRenderInput,
    width = 80,
  ): Result<PiChildInspectionRenderOutput, PiChildInspectionRenderError> {
    const w = renderWidth(width);
    const themeRef =
      input.transcriptInput !== undefined &&
      typeof input.transcriptInput === "object" &&
      "theme" in input.transcriptInput
        ? (input.transcriptInput as { theme?: unknown }).theme
        : undefined;
    const key = computeCacheKey(input, w, themeRef);

    if (
      this.cachedKey !== undefined &&
      this.cachedOutput !== undefined &&
      cacheKeysEqual(this.cachedKey, key)
    ) {
      return ok(this.cachedOutput);
    }

    const breadcrumb = buildBreadcrumb(input, w);
    const rawStatus = buildStatusLine(input);
    const statusLine = clipStatusLine(rawStatus, w);
    const markers = buildMarkers(input);
    const preview = sanitizeTaskPreview(input.taskPreview);
    const taskPreviewLines = buildTaskPreviewLines(preview, w);
    const resolvedOptions = resolveTranscriptOptions(input.transcriptInput);
    const transcript = this.transcriptRenderer.render(
      input.transcriptState,
      w,
      resolvedOptions,
    );
    const lines = composeLines(
      breadcrumb,
      statusLine,
      markers,
      taskPreviewLines,
      transcript.lines,
      w,
    );

    const output: PiChildInspectionRenderOutput = {
      lines,
      width: w,
      breadcrumb,
      statusLine,
      markers,
      taskPreviewLines,
      transcript,
    };

    this.cachedKey = key;
    this.cachedOutput = output;
    return ok(output);
  }

  /** Force-invalidate the cache (e.g. on theme change). */
  invalidate(): void {
    this.cachedKey = undefined;
    this.cachedOutput = undefined;
  }
}

export function createChildInspectionRenderer(
  transcriptInput?: PiTranscriptRenderInput,
): PiChildInspectionRenderer {
  return new PiChildInspectionRenderer(transcriptInput);
}

// ---------------------------------------------------------------------------
// Re-exports for convenience
// ---------------------------------------------------------------------------

// Testing-only exports
export {
  buildBreadcrumb as _buildBreadcrumb,
  buildMarkers as _buildMarkers,
  buildStatusLine as _buildStatusLine,
  buildTaskPreviewLines as _buildTaskPreviewLines,
  cacheKeysEqual as _cacheKeysEqual,
  clipToWidth as _clipToWidth,
  computeCacheKey as _computeCacheKey,
  MARKER_INTERRUPTED,
  MARKER_READONLY,
  MARKER_RECOVERABLE,
  MARKER_RECOVERY,
  MARKER_TRIMMED,
  sanitizeText as _sanitizeText,
  visualWidth as _visualWidth,
};
