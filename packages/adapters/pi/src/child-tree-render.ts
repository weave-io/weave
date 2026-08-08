/**
 * Pure, Pi-independent rendering of the bounded child tree widget (Pi adapter
 * contract): one line per node (name, status, current tool, turn count, elapsed
 * time, per-child usage), then one trailing cumulative-usage summary line.
 */
import type { PiChildTreeNode, PiChildUsageAggregate } from "./child-tree.js";

const DEFAULT_RENDER_WIDTH = 80;
const MAX_RENDER_WIDTH = 240;

export interface ChildTreeRenderNodeMetadata {
  /** Optional workflow label for direct-dispatch nodes. */
  readonly workflowName?: string;
  /** Optional step label for direct-dispatch nodes. */
  readonly stepName?: string;
  /** Count of user interventions. */
  readonly interventionCount?: number;
  /** Queue length indicator. */
  readonly queueSize?: number;
  /** Transcript was trimmed. */
  readonly trimmed?: boolean;
  /** Child is a recovery continuation. */
  readonly recoveryContinuation?: boolean;
  /** Child had an interruption history. */
  readonly interruptedHistory?: boolean;
  /** Child is terminal/reached completion. */
  readonly terminal?: boolean;
}

export interface ChildTreeRenderOptions {
  /** Optional terminal width in columns. */
  readonly width?: number;
  /** Optional trusted metadata keyed by child node id. */
  readonly nodeMetadata?:
    | ReadonlyMap<string, ChildTreeRenderNodeMetadata>
    | Readonly<Record<string, ChildTreeRenderNodeMetadata>>;
}

const MARKER_TRIMMED = "trimmed";
const MARKER_RECOVERY = "recovery";
const MARKER_INTERRUPTED = "interrupted";
const MARKER_TERMINAL = "terminal";

function renderWidth(width: number | undefined): number {
  if (width === undefined || !Number.isFinite(width)) return DEFAULT_RENDER_WIDTH;
  return Math.max(1, Math.min(MAX_RENDER_WIDTH, Math.floor(width)));
}

/**
 * Strips ANSI escape sequences and C0/C1 controls for safe terminal display.
 * Preserves printable content and spaces; collapses newlines.
 */
function sanitizeText(value: string): string {
  let result = "";
  let i = 0;
  while (i < value.length) {
    const code = value.charCodeAt(i);
    if (code === 0x1b || code === 0x9b) {
      if (code === 0x1b && value.charCodeAt(i + 1) === 0x5d) {
        // Skip OSC (`ESC ]`) to ST / BEL.
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
        // Skip CSI and other ANSI escapes.
        i += code === 0x1b ? 2 : 1;
        while (i < value.length) {
          const t = value.charCodeAt(i);
          i += 1;
          if (t >= 0x40 && t <= 0x7e) break;
        }
      }
      continue;
    }

    if (code === 0x0a) {
      result += " ";
    } else if (code === 0x20 || (code > 0x20 && code < 0x7f) || code >= 0xa0) {
      result += value[i];
    }
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

function clipToWidth(text: string, maxWidth: number): string {
  let used = 0;
  let result = "";
  if (maxWidth < 1) return "";
  for (const ch of text) {
    const cw = codePointWidth(ch.codePointAt(0) ?? 0);
    if (cw > 0 && used + cw > maxWidth) break;
    result += ch;
    used += cw;
  }
  return result;
}

function formatElapsed(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m${seconds}s` : `${seconds}s`;
}

function formatUsage(usage: PiChildUsageAggregate): string {
  return `in:${usage.inputTokens} out:${usage.outputTokens} cost:${usage.cost.toFixed(4)}`;
}

function getNodeMetadata(
  nodeMetadata:
    | ReadonlyMap<string, ChildTreeRenderNodeMetadata>
    | Readonly<Record<string, ChildTreeRenderNodeMetadata>>
    | undefined,
  nodeId: string,
): ChildTreeRenderNodeMetadata | undefined {
  if (nodeMetadata === undefined) return undefined;
  if (nodeMetadata instanceof Map) {
    return nodeMetadata.get(nodeId);
  }

  return (nodeMetadata as Readonly<Record<string, ChildTreeRenderNodeMetadata>>)[nodeId];
}

function buildMarkers(meta: ChildTreeRenderNodeMetadata | undefined): readonly string[] {
  const markers: string[] = [];
  if (meta === undefined) return markers;
  if (meta.trimmed === true) markers.push(MARKER_TRIMMED);
  if (meta.recoveryContinuation === true) markers.push(MARKER_RECOVERY);
  if (meta.interruptedHistory === true) markers.push(MARKER_INTERRUPTED);
  if (meta.terminal === true) markers.push(MARKER_TERMINAL);
  return markers;
}

/** Renders the live child-tree widget lines. Returns `[]` (hides the widget) when there are no nodes at all. */
export function renderChildTreeLines(
  nodes: readonly PiChildTreeNode[],
  selectedId: string,
  cumulativeUsage: PiChildUsageAggregate,
  options: ChildTreeRenderOptions = {},
): string[] {
  if (nodes.length === 0) return [];
  const width = renderWidth(options.width);

  const lines = nodes.map((node) => {
    const selectedMarker = node.id === selectedId ? "\u25b6" : " ";
    const meta = getNodeMetadata(options.nodeMetadata, node.id);

    const safeName = sanitizeText(node.name);
    const safeTool = node.currentTool !== undefined ? sanitizeText(node.currentTool) : undefined;
    const markers = buildMarkers(meta);

    const statusParts: string[] = [`[${node.status}]`];
    if (safeTool !== undefined && safeTool.length > 0) {
      statusParts.push(`tool:${safeTool}`);
    }
    if (meta?.interventionCount !== undefined && meta.interventionCount > 0) {
      statusParts.push(`interventions:${meta.interventionCount}`);
    }
    statusParts.push(`turn:${node.currentTurn}`);
    if (meta?.queueSize !== undefined) {
      statusParts.push(`queue:${meta.queueSize}`);
    }
    statusParts.push(`elapsed:${formatElapsed(node.elapsedMs)}`);
    statusParts.push(formatUsage(node.usage));

    let line = `${selectedMarker} ${safeName}`;

    if (meta?.workflowName !== undefined) {
      const wf = sanitizeText(meta.workflowName);
      if (wf.length > 0) {
        const suffix = meta.stepName
          ? `${wf}/${sanitizeText(meta.stepName)}`
          : wf;
        line += ` [${suffix}]`;
      }
    }

    line += ` ${statusParts.join(" ")}`;

    for (const marker of markers) {
      line += ` ${marker}`;
    }

    return clipToWidth(line, width);
  });

  lines.push(clipToWidth(`cumulative: ${formatUsage(cumulativeUsage)}`, width));
  return lines;
}
