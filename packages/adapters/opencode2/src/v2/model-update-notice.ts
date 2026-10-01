/**
 * The one-line notice the TUI shows when a reload moved agents to the models
 * of a newly applied recommendations list (Spec 39, "Visibility"), built from
 * the `models.changed` RPC event. Pure, so it is tested without the TUI.
 */

/** The `models.changed` event data, as the TUI receives it. */
export interface ModelUpdateNoticeInput {
  readonly issued: string;
  readonly agents: readonly {
    readonly agent: string;
    readonly displayName?: string;
    readonly model: string;
  }[];
}

/** Agents named before the rest are counted. */
const NAMED_AGENTS = 3;

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

/** `2026-10-01T09:00:00Z` → `1 Oct 2026` (UTC); anything else unchanged. */
export function formatIssuedDate(issued: string): string {
  const date = new Date(issued);
  if (Number.isNaN(date.getTime())) return issued;
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

function agentLabel(agent: ModelUpdateNoticeInput["agents"][number]): string {
  if (agent.displayName !== undefined) return agent.displayName;
  return `${agent.agent.charAt(0).toUpperCase()}${agent.agent.slice(1)}`;
}

/**
 * For example "Loom now runs on claude-opus-5.6 (model recommendations of
 * 1 Oct 2026)", or with more agents "Loom now runs on a, Tapestry on b,
 * Shuttle on c and 2 more agents (…)".
 */
export function modelUpdateNotice(input: ModelUpdateNoticeInput): string {
  const named = input.agents.slice(0, NAMED_AGENTS);
  const parts = named.map((agent, index) =>
    index === 0
      ? `${agentLabel(agent)} now runs on ${agent.model}`
      : `${agentLabel(agent)} on ${agent.model}`,
  );
  const rest = input.agents.length - named.length;
  const restText =
    rest === 0 ? "" : ` and ${rest} more agent${rest === 1 ? "" : "s"}`;
  return `${parts.join(", ")}${restText} (model recommendations of ${formatIssuedDate(input.issued)})`;
}
