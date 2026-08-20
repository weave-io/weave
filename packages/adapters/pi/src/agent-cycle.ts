import type { AgentDescriptor } from "@weaveio/weave-engine";
import type { PiUiThemeBgColor, PiUiThemePort } from "./types.js";

export const PI_PRIMARY_AGENT_CYCLE_SHORTCUT = "alt+a";

/**
 * The exact Pi background tokens the active-agent badge may use, in a fixed
 * order. Only tokens Pi's own `Theme.bg()` accepts appear here (`ThemeBg`);
 * the order is part of the mapping contract, so appending a token keeps every
 * existing agent on the same colour while reordering would not.
 */
export const PI_AGENT_BADGE_BG_TOKENS: readonly PiUiThemeBgColor[] = [
  "selectedBg",
  "userMessageBg",
  "customMessageBg",
  "toolPendingBg",
  "toolSuccessBg",
  "toolErrorBg",
];

/**
 * Reduces any spelling of an agent name to the single key the colour mapping
 * keys on, so `" Loom "`, `"LOOM"` and `"loom"` are one agent with one
 * colour. Case is folded, surrounding whitespace is dropped, and any internal
 * whitespace run collapses to a single space.
 */
export function normalizeAgentBadgeKey(agentName: string): string {
  return agentName.trim().replace(/\s+/gu, " ").toLowerCase();
}

/**
 * Maps one normalized agent name to a stable background token. Pure and
 * deterministic: the same name always yields the same token in every session,
 * on every machine, with no registry, mutable assignment map or ordering
 * dependency, so a user learns one colour per agent. FNV-1a keeps distinct
 * short names well spread; collisions between different agents are allowed.
 */
export function selectAgentBadgeBg(agentName: string): PiUiThemeBgColor {
  let hash = 0x811c9dc5;
  for (const codePoint of normalizeAgentBadgeKey(agentName)) {
    hash ^= codePoint.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  const index = hash % PI_AGENT_BADGE_BG_TOKENS.length;
  // `PI_AGENT_BADGE_BG_TOKENS` is non-empty, so the modulo always indexes it.
  return PI_AGENT_BADGE_BG_TOKENS[index] ?? "selectedBg";
}

export function listCycleablePrimaryAgents(
  descriptors: ReadonlyMap<string, AgentDescriptor>,
): readonly AgentDescriptor[] {
  return [...descriptors.values()].filter(
    (descriptor) => descriptor.mode === "primary" || descriptor.mode === "all",
  );
}

export function nextCycleablePrimaryAgent(
  descriptors: ReadonlyMap<string, AgentDescriptor>,
  currentName: string | undefined,
): AgentDescriptor | undefined {
  const candidates = listCycleablePrimaryAgents(descriptors);
  if (candidates.length < 2) return undefined;

  const currentIndex = candidates.findIndex(
    (descriptor) => descriptor.name === currentName,
  );
  if (currentIndex === -1) return candidates[0];
  return candidates[(currentIndex + 1) % candidates.length];
}

export function renderActiveAgentBadge(
  agentName: string,
  theme?: PiUiThemePort,
): string {
  const label = agentName.toUpperCase();
  if (theme === undefined) return `◆ WEAVE · ${label}`;

  // The agent name keeps its existing accent foreground; the background is the
  // only addition, and it is dropped entirely when the host theme has no
  // `bg()` rather than rendering an untinted-but-different badge.
  const name = theme.fg("accent", theme.bold(label));
  const tinted =
    theme.bg === undefined
      ? name
      : theme.bg(selectAgentBadgeBg(agentName), name);

  return [
    theme.fg("accent", "◆"),
    theme.bold("WEAVE"),
    theme.fg("muted", "·"),
    tinted,
  ].join(" ");
}
