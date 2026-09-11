/**
 * GitHub Copilot CLI concrete tool classification.
 *
 * Maps Copilot CLI's harness-specific tool identifiers (the `tools:`
 * frontmatter aliases documented for `.agent.md` files) to Weave's abstract
 * capability vocabulary. The engine uses these classifications with
 * `resolveToolDecisions()` to produce per-tool permission decisions.
 *
 * Evidence source: `docs/artifacts/copilot-adapter-research.md`, §6 "Tool
 * identifiers accepted in `tools:` frontmatter — enumerated with source",
 * which reproduces the "Tool aliases" table from GitHub Docs' *Custom agents
 * configuration reference* (`.../reference/custom-agents-configuration`).
 * That table is flagged in the research doc as sourced from the cloud-agent
 * reference page and not independently confirmed 1:1 for the CLI — treated
 * here as authoritative per the doc's own recommendation ("treat the alias
 * table above as authoritative for the CLI too ... but revalidate against a
 * future CLI version bump").
 */

import type { ConcreteToolClassification } from "@weaveio/weave-engine";

/**
 * Complete classification of Copilot CLI's documented tool alias surface.
 *
 * Each entry pairs a concrete Copilot tool identifier (a primary alias or one
 * of its documented compatible aliases from the "Tool aliases" table) with
 * the abstract capability it exercises. This list is the adapter's single
 * source of truth for tool→capability mapping.
 *
 * See `docs/artifacts/copilot-adapter-research.md` §6 for the full alias
 * table and its provenance.
 */
export const COPILOT_TOOL_CLASSIFICATIONS: readonly ConcreteToolClassification[] =
  [
    // Primary alias: "execute" — "Execute a command in the appropriate
    // shell". Compatible aliases: shell, Bash, powershell.
    // Source: docs/artifacts/copilot-adapter-research.md §6, "Tool aliases" table.
    { toolId: "execute", capability: "execute" },
    { toolId: "shell", capability: "execute" },
    { toolId: "Bash", capability: "execute" },
    { toolId: "powershell", capability: "execute" },

    // Primary alias: "read" — "Read file contents". Compatible aliases:
    // Read, NotebookRead, view.
    // Source: docs/artifacts/copilot-adapter-research.md §6, "Tool aliases" table.
    { toolId: "read", capability: "read" },
    { toolId: "Read", capability: "read" },
    { toolId: "NotebookRead", capability: "read" },
    { toolId: "view", capability: "read" },

    // Primary alias: "edit" — "Edit files (exact arguments vary)".
    // Compatible aliases: Edit, MultiEdit, Write, NotebookEdit.
    // Source: docs/artifacts/copilot-adapter-research.md §6, "Tool aliases" table.
    { toolId: "edit", capability: "write" },
    { toolId: "Edit", capability: "write" },
    { toolId: "MultiEdit", capability: "write" },
    { toolId: "Write", capability: "write" },
    { toolId: "NotebookEdit", capability: "write" },

    // Primary alias: "search" — "Search for files or text in files".
    // Compatible aliases: Grep, Glob, search. Read-only capability — search
    // inspects but does not modify the filesystem.
    // Source: docs/artifacts/copilot-adapter-research.md §6, "Tool aliases" table.
    { toolId: "search", capability: "read" },
    { toolId: "Grep", capability: "read" },
    { toolId: "Glob", capability: "read" },

    // Primary alias: "agent" — "Invoke another custom agent as a subtask".
    // Compatible aliases: custom-agent, Task.
    // Source: docs/artifacts/copilot-adapter-research.md §6, "Tool aliases" table.
    { toolId: "agent", capability: "delegate" },
    { toolId: "custom-agent", capability: "delegate" },
    { toolId: "Task", capability: "delegate" },

    // Primary alias: "web" — "Fetch URL content / web search". Compatible
    // aliases: WebSearch, WebFetch.
    // Source: docs/artifacts/copilot-adapter-research.md §6, "Tool aliases" table.
    { toolId: "web", capability: "network" },
    { toolId: "WebSearch", capability: "network" },
    { toolId: "WebFetch", capability: "network" },

    // Primary alias: "todo" — "Structured task-list management". Compatible
    // alias: TodoWrite. Classified as `write` — it mutates session-local
    // task-list state, the closest abstract capability to a state mutation
    // that is neither a filesystem read, a shell execution, a delegation, nor
    // a network call.
    // Source: docs/artifacts/copilot-adapter-research.md §6, "Tool aliases" table.
    { toolId: "todo", capability: "write" },
    { toolId: "TodoWrite", capability: "write" },
  ] as const;

// UNCLASSIFIED — see research doc
//
// MCP-server-scoped tool references of the form `server-name/tool-name` or
// `server-name/*` (documented in §6, e.g. the out-of-box `github` and
// `playwright` servers) are omitted here. Their capability depends entirely
// on the specific MCP server and tool invoked, which the research doc does
// not enumerate with confidence — guessing a single fixed capability for an
// open-ended, server-defined tool namespace would be unsafe.

/**
 * Returns the full Copilot CLI tool classification array.
 *
 * Adapters pass this to `resolveToolDecisions()` alongside an agent's
 * effective tool policy to determine per-tool permissions.
 */
export function getCopilotToolClassifications(): readonly ConcreteToolClassification[] {
  return COPILOT_TOOL_CLASSIFICATIONS;
}

/**
 * All known Copilot CLI tool identifiers, derived from the classification list.
 */
export const COPILOT_TOOL_IDS: readonly string[] =
  COPILOT_TOOL_CLASSIFICATIONS.map((c) => c.toolId);
