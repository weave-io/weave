/**
 * Legacy JSONC-to-DSL conversion.
 *
 * Converts a legacy weave-opencode.jsonc source string into current `.weave` DSL.
 * This is a best-effort partial conversion: supported fields are converted,
 * unsupported fields are skipped with explicit warnings.
 */

import type { ConversionResult, ConversionWarning } from "./types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Legacy top-level fields that are explicitly unsupported in migration v1.
 * Each entry maps the field name to the human-readable skip reason.
 */
const UNSUPPORTED_LEGACY_FIELDS: Record<string, string> = {
  workflows:
    "legacy workflow definitions are not supported in migration v1; define workflows using the current DSL workflow syntax",
  continuation:
    "legacy continuation settings are not supported in migration v1; use the current DSL continuation block if needed",
  analytics:
    "legacy analytics settings are not supported in migration v1; use the current DSL analytics block if needed",
  background:
    "legacy background settings are not supported in migration v1; no equivalent exists in the current DSL",
};

/**
 * The set of builtin agent names in the current unified agent namespace.
 * Used to detect collisions when converting legacy `custom_agents`.
 */
const BUILTIN_AGENT_NAMES = new Set([
  "loom",
  "tapestry",
  "shuttle",
  "pattern",
  "thread",
  "spindle",
  "weft",
  "warp",
]);

/**
 * Mapping from clearly known legacy OpenCode tool names to current abstract
 * `tool_policy` capability buckets.
 *
 * Only tool names with a clear, unambiguous mapping are included here.
 * Ambiguous or harness-specific tool names are warned and skipped.
 *
 * Capability buckets: read | write | execute | delegate | network
 */
const LEGACY_TOOL_TO_CAPABILITY: Record<
  string,
  "read" | "write" | "execute" | "delegate" | "network"
> = {
  // Read-only tools
  read: "read",
  // Write tools
  write: "write",
  edit: "write",
  // Execute tools
  bash: "execute",
  // Delegate tools
  task: "delegate",
  // Network tools
  web_search: "network",
  web_fetch: "network",
};

/**
 * Legacy tool names that are ambiguous or harness-specific and cannot be
 * mapped to a current abstract capability bucket. These are warned and skipped.
 */
const AMBIGUOUS_LEGACY_TOOLS = new Set([
  "call_weave_agent",
  "todowrite",
  "mcp",
  "computer",
]);

/**
 * Valid log level values accepted by the current DSL settings block.
 * Matches LogLevelSchema in @weave/core.
 */
const VALID_LOG_LEVELS = new Set([
  "TRACE",
  "DEBUG",
  "INFO",
  "WARN",
  "ERROR",
  "FATAL",
]);

// ---------------------------------------------------------------------------
// JSONC comment stripping
// ---------------------------------------------------------------------------

/**
 * Strip JSONC-style line comments and block comments from a string so it
 * can be parsed by `JSON.parse`.
 *
 * Uses a char-by-char state machine that tracks string context so that
 * comment-like sequences inside string literals are preserved intact.
 * This correctly handles URLs (e.g. `"https://example.com"`) and other
 * string values that contain slashes.
 */
export function stripJsoncComments(source: string): string {
  let result = "";
  let i = 0;
  let inString = false;
  let isEscaped = false;

  while (i < source.length) {
    const ch = source[i] as string;

    if (inString) {
      if (isEscaped) {
        result += ch;
        isEscaped = false;
        i++;
        continue;
      }
      if (ch === "\\") {
        result += ch;
        isEscaped = true;
        i++;
        continue;
      }
      if (ch === '"') {
        result += ch;
        inString = false;
        i++;
        continue;
      }
      result += ch;
      i++;
      continue;
    }

    if (ch === '"') {
      result += ch;
      inString = true;
      i++;
      continue;
    }

    if (ch === "/" && source[i + 1] === "/") {
      while (i < source.length && source[i] !== "\n") {
        i++;
      }
      continue;
    }

    if (ch === "/" && source[i + 1] === "*") {
      i += 2;
      while (i < source.length) {
        if (source[i] === "*" && source[i + 1] === "/") {
          i += 2;
          break;
        }
        i++;
      }
      continue;
    }

    result += ch;
    i++;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Prompt file safety check
// ---------------------------------------------------------------------------

/**
 * Filename-only pattern: a safe prompt_file reference is a bare filename
 * (no directory separators) that can be placed directly in `.weave/prompts/`.
 * Paths with directory components (e.g. `../prompts/foo.md`, `/abs/path.md`,
 * `subdir/foo.md`) cannot be safely translated and are warned and skipped.
 */
function isPromptFileSafe(promptFile: string): boolean {
  if (promptFile.length === 0) return false;
  if (promptFile.includes("/") || promptFile.includes("\\")) return false;
  if (promptFile.startsWith("..")) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Field conversion helpers
// ---------------------------------------------------------------------------

/**
 * Convert a legacy `tools` record (Record<string, boolean>) into a
 * `tool_policy { ... }` DSL block.
 *
 * Only clearly known legacy tool names are mapped to abstract capability
 * buckets. Ambiguous or unmappable tool names are warned and skipped.
 *
 * Returns the DSL lines for the tool_policy block and any warnings.
 */
function convertLegacyTools(
  tools: Record<string, boolean>,
  contextLabel: string,
): { lines: string[]; warnings: ConversionWarning[] } {
  const warnings: ConversionWarning[] = [];
  const capabilities: Record<
    "read" | "write" | "execute" | "delegate" | "network",
    "allow" | "deny"
  > = {} as Record<
    "read" | "write" | "execute" | "delegate" | "network",
    "allow" | "deny"
  >;

  for (const [toolName, allowed] of Object.entries(tools)) {
    if (AMBIGUOUS_LEGACY_TOOLS.has(toolName)) {
      warnings.push({
        field: `${contextLabel}.tools.${toolName}`,
        reason: `"${toolName}" is a harness-specific tool name that cannot be mapped to an abstract tool_policy capability; skipped`,
      });
      continue;
    }
    if (typeof allowed !== "boolean") {
      warnings.push({
        field: `${contextLabel}.tools.${toolName}`,
        reason: "tool permission must be a boolean; skipped",
      });
      continue;
    }
    const capability = LEGACY_TOOL_TO_CAPABILITY[toolName];
    if (capability === undefined) {
      warnings.push({
        field: `${contextLabel}.tools.${toolName}`,
        reason: `"${toolName}" is an unknown legacy tool name that cannot be mapped to an abstract tool_policy capability; skipped`,
      });
      continue;
    }
    capabilities[capability] = allowed ? "allow" : "deny";
  }

  const capEntries = Object.entries(capabilities);
  if (capEntries.length === 0) return { lines: [], warnings };

  const lines = ["  tool_policy {"];
  for (const [cap, perm] of capEntries) {
    lines.push(`    ${cap} ${perm}`);
  }
  lines.push("  }");
  return { lines, warnings };
}

/**
 * Convert legacy `model` + optional `fallback_models` into an ordered
 * `models [...]` array with the primary model first.
 *
 * Returns DSL lines (indented for block context) and any warnings.
 */
function convertLegacyModels(
  entry: Record<string, unknown>,
  contextLabel: string,
): { lines: string[]; warnings: ConversionWarning[] } {
  const warnings: ConversionWarning[] = [];
  const models: string[] = [];

  if (entry["model"] !== undefined) {
    if (typeof entry["model"] !== "string") {
      warnings.push({
        field: `${contextLabel}.model`,
        reason: "expected a string model name; skipped",
      });
    } else {
      models.push(entry["model"]);
    }
  }

  if (entry["fallback_models"] !== undefined) {
    if (!Array.isArray(entry["fallback_models"])) {
      warnings.push({
        field: `${contextLabel}.fallback_models`,
        reason: "expected an array of model names; skipped",
      });
    } else {
      for (const m of entry["fallback_models"]) {
        if (typeof m === "string") models.push(m);
      }
    }
  }

  if (models.length === 0) return { lines: [], warnings };

  const items = models.map((m) => JSON.stringify(m)).join(", ");
  return { lines: [`  models [${items}]`], warnings };
}

/**
 * Convert a legacy `prompt_file` value into a DSL `prompt_file "..."` line.
 *
 * Safe: bare filename (no directory separators) → `  prompt_file "filename.md"`
 * Unsafe: paths with directory components → warn and skip.
 */
function convertLegacyPromptFile(
  value: unknown,
  contextLabel: string,
): { line: string | undefined; warnings: ConversionWarning[] } {
  const warnings: ConversionWarning[] = [];

  if (typeof value !== "string") {
    warnings.push({
      field: `${contextLabel}.prompt_file`,
      reason: "expected a string path; skipped",
    });
    return { line: undefined, warnings };
  }

  if (!isPromptFileSafe(value)) {
    warnings.push({
      field: `${contextLabel}.prompt_file`,
      reason: `"${value}" contains directory components and cannot be safely translated to the current .weave/prompts/ convention; skipped`,
    });
    return { line: undefined, warnings };
  }

  return { line: `  prompt_file "${value}"`, warnings };
}

/**
 * Convert a legacy agent override entry (from `agents` top-level key) into
 * DSL lines for an `agent <name> { ... }` block.
 *
 * Only fields with clear current-DSL equivalents are converted:
 * - `model` + `fallback_models` → `models [...]`
 * - `temperature` → `temperature <value>`
 * - `prompt_append` → `prompt_append "..."`
 * - `tools` → `tool_policy { ... }`
 * - `prompt_file` → `prompt_file "..."` (safe paths only)
 *
 * Fields without current-DSL equivalents (`display_name`, `skills`, etc.)
 * are warned and skipped.
 */
function convertLegacyAgentEntry(
  name: string,
  entry: Record<string, unknown>,
  warnings: ConversionWarning[],
): string[] {
  const lines: string[] = [`agent ${name} {`];

  const modelsResult = convertLegacyModels(entry, `agents.${name}`);
  warnings.push(...modelsResult.warnings);
  if (modelsResult.lines.length > 0) lines.push(...modelsResult.lines);

  if (typeof entry["temperature"] === "number") {
    lines.push(`  temperature ${entry["temperature"]}`);
  }

  if (typeof entry["prompt_append"] === "string") {
    const escaped = entry["prompt_append"].replace(/"/g, '\\"');
    lines.push(`  prompt_append "${escaped}"`);
  }

  if (entry["prompt_file"] !== undefined) {
    const promptFileResult = convertLegacyPromptFile(
      entry["prompt_file"],
      `agents.${name}`,
    );
    warnings.push(...promptFileResult.warnings);
    if (promptFileResult.line !== undefined) lines.push(promptFileResult.line);
  }

  if (
    entry["tools"] !== null &&
    typeof entry["tools"] === "object" &&
    !Array.isArray(entry["tools"])
  ) {
    const toolResult = convertLegacyTools(
      entry["tools"] as Record<string, boolean>,
      `agents.${name}`,
    );
    warnings.push(...toolResult.warnings);
    if (toolResult.lines.length > 0) lines.push(...toolResult.lines);
  }

  const unsupportedAgentFields = ["display_name", "skills", "mode", "triggers"];
  for (const field of unsupportedAgentFields) {
    if (entry[field] !== undefined) {
      warnings.push({
        field: `agents.${name}.${field}`,
        reason: `"${field}" is not supported in agent override migration v1; skipped`,
      });
    }
  }

  lines.push("}");
  return lines;
}

/**
 * Convert a legacy custom agent entry into a new `agent <name> { ... }` block.
 *
 * Supported fields:
 * - `prompt` (inline) → `prompt "..."`
 * - `prompt_file` → `prompt_file "..."` (safe paths only)
 * - `model` + `fallback_models` → `models [...]`
 * - `temperature` → `temperature <value>`
 * - `mode` → `mode <value>` (if valid)
 * - `prompt_append` → `prompt_append "..."`
 * - `tools` → `tool_policy { ... }`
 *
 * Unsupported fields are warned and skipped.
 */
function convertLegacyCustomAgent(
  name: string,
  entry: Record<string, unknown>,
  warnings: ConversionWarning[],
): string[] {
  const lines: string[] = [`agent ${name} {`];

  if (typeof entry["prompt"] === "string") {
    const escaped = entry["prompt"].replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    lines.push(`  prompt "${escaped}"`);
  }

  if (entry["prompt_file"] !== undefined && entry["prompt"] === undefined) {
    const promptFileResult = convertLegacyPromptFile(
      entry["prompt_file"],
      `custom_agents.${name}`,
    );
    warnings.push(...promptFileResult.warnings);
    if (promptFileResult.line !== undefined) lines.push(promptFileResult.line);
  } else if (
    entry["prompt_file"] !== undefined &&
    entry["prompt"] !== undefined
  ) {
    warnings.push({
      field: `custom_agents.${name}.prompt_file`,
      reason:
        "both prompt and prompt_file are set; prompt_file skipped (prompt takes precedence)",
    });
  }

  const modelsResult = convertLegacyModels(entry, `custom_agents.${name}`);
  warnings.push(...modelsResult.warnings);
  if (modelsResult.lines.length > 0) lines.push(...modelsResult.lines);

  if (typeof entry["temperature"] === "number") {
    lines.push(`  temperature ${entry["temperature"]}`);
  }

  if (entry["mode"] !== undefined) {
    const validModes = new Set(["primary", "subagent", "all"]);
    if (typeof entry["mode"] === "string" && validModes.has(entry["mode"])) {
      lines.push(`  mode ${entry["mode"]}`);
    } else {
      warnings.push({
        field: `custom_agents.${name}.mode`,
        reason: `"${entry["mode"]}" is not a valid mode (expected primary, subagent, or all); skipped`,
      });
    }
  }

  if (typeof entry["prompt_append"] === "string") {
    const escaped = entry["prompt_append"].replace(/"/g, '\\"');
    lines.push(`  prompt_append "${escaped}"`);
  }

  if (
    entry["tools"] !== null &&
    typeof entry["tools"] === "object" &&
    !Array.isArray(entry["tools"])
  ) {
    const toolResult = convertLegacyTools(
      entry["tools"] as Record<string, boolean>,
      `custom_agents.${name}`,
    );
    warnings.push(...toolResult.warnings);
    if (toolResult.lines.length > 0) lines.push(...toolResult.lines);
  }

  const unsupportedCustomAgentFields = ["skills", "triggers", "display_name"];
  for (const field of unsupportedCustomAgentFields) {
    if (entry[field] !== undefined) {
      warnings.push({
        field: `custom_agents.${name}.${field}`,
        reason: `"${field}" is not supported in custom agent migration v1; skipped`,
      });
    }
  }

  lines.push("}");
  return lines;
}

/**
 * Convert a legacy category entry into a `category <name> { ... }` block.
 *
 * Supported fields:
 * - `description` → `description "..."`
 * - `patterns` → `patterns [...]`
 * - `model` + `fallback_models` → `models [...]`
 * - `temperature` → `temperature <value>`
 * - `prompt_append` → `prompt_append "..."`
 * - `tools` → `tool_policy { ... }`
 *
 * Unsupported fields are warned and skipped.
 * Note: categories do NOT generate standalone shuttle agents — the current
 * DSL generates `shuttle-<category>` semantics automatically.
 */
function convertLegacyCategory(
  name: string,
  entry: Record<string, unknown>,
  warnings: ConversionWarning[],
): string[] {
  const lines: string[] = [`category ${name} {`];

  if (typeof entry["description"] === "string") {
    const escaped = entry["description"].replace(/"/g, '\\"');
    lines.push(`  description "${escaped}"`);
  }

  if (Array.isArray(entry["patterns"])) {
    const items = entry["patterns"]
      .filter((p): p is string => typeof p === "string")
      .map((p) => JSON.stringify(p))
      .join(", ");
    lines.push(`  patterns [${items}]`);
  } else if (entry["patterns"] !== undefined) {
    warnings.push({
      field: `categories.${name}.patterns`,
      reason: "expected an array of glob patterns; skipped",
    });
  }

  const modelsResult = convertLegacyModels(entry, `categories.${name}`);
  warnings.push(...modelsResult.warnings);
  if (modelsResult.lines.length > 0) lines.push(...modelsResult.lines);

  if (typeof entry["temperature"] === "number") {
    lines.push(`  temperature ${entry["temperature"]}`);
  }

  if (typeof entry["prompt_append"] === "string") {
    const escaped = entry["prompt_append"].replace(/"/g, '\\"');
    lines.push(`  prompt_append "${escaped}"`);
  }

  if (
    entry["tools"] !== null &&
    typeof entry["tools"] === "object" &&
    !Array.isArray(entry["tools"])
  ) {
    const toolResult = convertLegacyTools(
      entry["tools"] as Record<string, boolean>,
      `categories.${name}`,
    );
    warnings.push(...toolResult.warnings);
    if (toolResult.lines.length > 0) lines.push(...toolResult.lines);
  }

  lines.push("}");
  return lines;
}

// ---------------------------------------------------------------------------
// Main conversion entry point
// ---------------------------------------------------------------------------

/**
 * Convert a legacy weave-opencode.jsonc source string into current `.weave` DSL.
 *
 * This is a best-effort partial conversion:
 * - Supported fields are converted and included in the output DSL.
 * - Unsupported fields are skipped with explicit warnings.
 * - Unknown fields are also skipped with a warning.
 * - The function always returns a result (never throws); parse failures
 *   produce a single warning and an empty DSL body.
 *
 * Supported mappings:
 * - `disabled_agents`  → `disable agents [...]`
 * - `disabled_hooks`   → `disable hooks [...]`
 * - `disabled_skills`  → `disable skills [...]`
 * - `log_level`        → `settings { log_level <VALUE> }`
 * - `agents`           → builtin agent override blocks
 * - `custom_agents`    → new agent blocks (with collision detection)
 * - `categories`       → category blocks
 *
 * Explicitly unsupported (warn + skip):
 * - `workflows`, `continuation`, `analytics`, `background`
 */
export function convertLegacyJsonc(source: string): ConversionResult {
  const warnings: ConversionWarning[] = [];
  const dslLines: string[] = [];

  let parsed: Record<string, unknown>;
  try {
    const stripped = stripJsoncComments(source);
    parsed = JSON.parse(stripped) as Record<string, unknown>;
  } catch {
    warnings.push({
      field: "<source>",
      reason:
        "failed to parse legacy JSONC source; no fields could be converted",
    });
    return { dsl: "", warnings };
  }

  for (const [key, value] of Object.entries(parsed)) {
    if (key in UNSUPPORTED_LEGACY_FIELDS) {
      warnings.push({ field: key, reason: UNSUPPORTED_LEGACY_FIELDS[key]! });
      continue;
    }

    if (key === "disabled_agents") {
      if (!Array.isArray(value)) {
        warnings.push({
          field: key,
          reason: "expected an array of agent names; skipped",
        });
        continue;
      }
      const items = value
        .filter((v): v is string => typeof v === "string")
        .map((v) => JSON.stringify(v))
        .join(", ");
      dslLines.push(`disable agents [${items}]`);
      continue;
    }

    if (key === "disabled_hooks") {
      if (!Array.isArray(value)) {
        warnings.push({
          field: key,
          reason: "expected an array of hook names; skipped",
        });
        continue;
      }
      const items = value
        .filter((v): v is string => typeof v === "string")
        .map((v) => JSON.stringify(v))
        .join(", ");
      dslLines.push(`disable hooks [${items}]`);
      continue;
    }

    if (key === "disabled_skills") {
      if (!Array.isArray(value)) {
        warnings.push({
          field: key,
          reason: "expected an array of skill names; skipped",
        });
        continue;
      }
      const items = value
        .filter((v): v is string => typeof v === "string")
        .map((v) => JSON.stringify(v))
        .join(", ");
      dslLines.push(`disable skills [${items}]`);
      continue;
    }

    if (key === "log_level") {
      if (typeof value !== "string") {
        warnings.push({
          field: key,
          reason: "expected a string log level value; skipped",
        });
        continue;
      }
      const normalized = value.toUpperCase();
      if (!VALID_LOG_LEVELS.has(normalized)) {
        warnings.push({
          field: key,
          reason: `"${value}" is not a valid log level (expected one of TRACE, DEBUG, INFO, WARN, ERROR, FATAL); skipped`,
        });
        continue;
      }
      dslLines.push(`settings {`);
      dslLines.push(`  log_level ${normalized}`);
      dslLines.push(`}`);
      continue;
    }

    if (key === "agents") {
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        warnings.push({
          field: key,
          reason: "expected an object of agent override entries; skipped",
        });
        continue;
      }
      for (const [agentName, agentEntry] of Object.entries(
        value as Record<string, unknown>,
      )) {
        if (!BUILTIN_AGENT_NAMES.has(agentName)) {
          warnings.push({
            field: `agents.${agentName}`,
            reason: `"${agentName}" is not a builtin agent name; entries under "agents" are overrides of existing builtins only — use "custom_agents" to create new agents`,
          });
          continue;
        }
        if (
          agentEntry === null ||
          typeof agentEntry !== "object" ||
          Array.isArray(agentEntry)
        ) {
          warnings.push({
            field: `agents.${agentName}`,
            reason: "expected an object; skipped",
          });
          continue;
        }
        const agentLines = convertLegacyAgentEntry(
          agentName,
          agentEntry as Record<string, unknown>,
          warnings,
        );
        dslLines.push(...agentLines);
      }
      continue;
    }

    if (key === "custom_agents") {
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        warnings.push({
          field: key,
          reason: "expected an object of custom agent entries; skipped",
        });
        continue;
      }
      for (const [agentName, agentEntry] of Object.entries(
        value as Record<string, unknown>,
      )) {
        if (BUILTIN_AGENT_NAMES.has(agentName)) {
          warnings.push({
            field: `custom_agents.${agentName}`,
            reason: `"${agentName}" collides with a builtin agent name; skipped to avoid silently overriding the builtin`,
          });
          continue;
        }
        if (
          agentEntry === null ||
          typeof agentEntry !== "object" ||
          Array.isArray(agentEntry)
        ) {
          warnings.push({
            field: `custom_agents.${agentName}`,
            reason: "expected an object; skipped",
          });
          continue;
        }
        const agentLines = convertLegacyCustomAgent(
          agentName,
          agentEntry as Record<string, unknown>,
          warnings,
        );
        dslLines.push(...agentLines);
      }
      continue;
    }

    if (key === "categories") {
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        warnings.push({
          field: key,
          reason: "expected an object of category entries; skipped",
        });
        continue;
      }
      for (const [catName, catEntry] of Object.entries(
        value as Record<string, unknown>,
      )) {
        if (
          catEntry === null ||
          typeof catEntry !== "object" ||
          Array.isArray(catEntry)
        ) {
          warnings.push({
            field: `categories.${catName}`,
            reason: "expected an object; skipped",
          });
          continue;
        }
        const catLines = convertLegacyCategory(
          catName,
          catEntry as Record<string, unknown>,
          warnings,
        );
        dslLines.push(...catLines);
      }
      continue;
    }

    warnings.push({
      field: key,
      reason: "unknown legacy field; not supported in migration v1",
    });
  }

  return { dsl: dslLines.join("\n"), warnings };
}
