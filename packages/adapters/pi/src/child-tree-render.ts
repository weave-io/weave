/**
 * Pure, Pi-independent rendering of the bounded child tree widget (Pi adapter contract
 * §11.5) - one line per node (name, status, current tool, turn count,
 * elapsed time, per-child usage), the currently selected node marked, and
 * a trailing cumulative-usage summary line. No Pi/TUI dependency: the
 * caller (`extension.ts`) hands the resulting `string[]` straight to
 * `ctx.ui.setWidget`.
 */
import type { PiChildTreeNode, PiChildUsageAggregate } from "./child-tree.js";

function formatElapsed(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m${seconds}s` : `${seconds}s`;
}

function formatUsage(usage: PiChildUsageAggregate): string {
  return `in:${usage.inputTokens} out:${usage.outputTokens} cost:${usage.cost.toFixed(4)}`;
}

/** Renders the live child-tree widget lines. Returns `[]` (hides the widget) when there are no nodes at all. */
export function renderChildTreeLines(
  nodes: readonly PiChildTreeNode[],
  selectedId: string,
  cumulativeUsage: PiChildUsageAggregate,
): string[] {
  if (nodes.length === 0) return [];
  const lines = nodes.map((node) => {
    const marker = node.id === selectedId ? "\u25b6" : " ";
    const tool =
      node.currentTool !== undefined ? ` tool:${node.currentTool}` : "";
    return `${marker} ${node.name} [${node.status}]${tool} turn:${node.currentTurn} elapsed:${formatElapsed(node.elapsedMs)} ${formatUsage(node.usage)}`;
  });
  lines.push(`cumulative: ${formatUsage(cumulativeUsage)}`);
  return lines;
}
