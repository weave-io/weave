import type { AgentDescriptor } from "@weaveio/weave-engine";
import type { PiUiThemePort } from "./types.js";

export const PI_PRIMARY_AGENT_CYCLE_SHORTCUT = "alt+a";

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

  return [
    theme.fg("accent", "◆"),
    theme.bold("WEAVE"),
    theme.fg("muted", "·"),
    theme.fg("accent", theme.bold(label)),
  ].join(" ");
}
