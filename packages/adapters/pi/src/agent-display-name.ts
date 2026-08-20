/**
 * Bounded display projection for canonical agent names.
 *
 * The canonical name remains the lower-case protocol/lookup value. This helper
 * is a pure presentation function: it never resolves, authorizes, or stores an
 * agent name, and it never reads a value outside its input string.
 */

/** The closed initialism vocabulary used by the Pi surfaces. */
export const AGENT_DISPLAY_INITIALISMS = Object.freeze({
  ai: "AI",
  api: "API",
  cli: "CLI",
  cpu: "CPU",
  css: "CSS",
  gpt: "GPT",
  http: "HTTP",
  https: "HTTPS",
  id: "ID",
  json: "JSON",
  llm: "LLM",
  mcp: "MCP",
  oauth: "OAuth",
  openai: "OpenAI",
  pi: "Pi",
  rpc: "RPC",
  sdk: "SDK",
  ssh: "SSH",
  sse: "SSE",
  tcp: "TCP",
  tls: "TLS",
  tui: "TUI",
  ui: "UI",
  url: "URL",
  uuid: "UUID",
  xml: "XML",
} as const);

export const AGENT_DISPLAY_NAME_MAX = 64;

function displayPart(part: string): string {
  const lower = part.toLocaleLowerCase("en-US");
  const initialism =
    AGENT_DISPLAY_INITIALISMS[lower as keyof typeof AGENT_DISPLAY_INITIALISMS];
  if (initialism !== undefined) return initialism;
  if (part.length === 0) return "";
  return `${part[0]?.toLocaleUpperCase("en-US") ?? ""}${part.slice(1).toLocaleLowerCase("en-US")}`;
}

/**
 * Formats one bounded canonical name as Title Case.
 *
 * Hyphens, underscores, and whitespace are display separators. Empty pieces
 * are ignored, and an absent/invalid name has the honest display fallback
 * `Delegate` rather than an empty frame title.
 */
export function formatAgentDisplayName(agentName: string): string {
  const bounded = Array.from(agentName)
    .slice(0, AGENT_DISPLAY_NAME_MAX)
    .join("");
  const parts = bounded
    .split(/[\s_-]+/u)
    .filter((part) => part.length > 0)
    .map(displayPart)
    .filter((part) => part.length > 0);
  return parts.length > 0 ? parts.join(" ") : "Delegate";
}

/** Compatibility spelling for callers that use the production card name. */
export const formatDisplayAgentName = formatAgentDisplayName;

/**
 * Legacy category projection retained for existing picker/card callers.
 * Category agents keep the established `Infra-Shuttle` shape; ordinary names
 * use the shared bounded Title Case formatter with hyphen separators.
 */
export function formatDelegationAgentName(agentName: string): string {
  const bounded = Array.from(agentName)
    .slice(0, AGENT_DISPLAY_NAME_MAX)
    .join("");
  if (bounded === "shuttle") return "Shuttle";
  if (bounded.startsWith("shuttle-")) {
    const category = bounded
      .slice("shuttle-".length)
      .split("-")
      .filter((part) => part.length > 0)
      .map(displayPart)
      .join("-");
    return category.length > 0 ? `${category}-Shuttle` : "Shuttle";
  }
  const formatted = formatAgentDisplayName(bounded);
  return formatted === "Delegate" ? formatted : formatted.split(" ").join("-");
}
