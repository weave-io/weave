/**
 * Legacy JSONC-to-DSL conversion.
 *
 * Converts a legacy weave-opencode.jsonc source string into current `.weave` DSL.
 * This is a best-effort partial conversion: supported fields are converted,
 * unsupported fields are skipped with explicit warnings.
 */

import { posix, win32 } from "node:path";
import {
  copySafeGraph,
  parseConfig,
  type SafeGraphValue,
} from "@weaveio/weave-core";
import { type ParseError, parse as parseJsonc } from "jsonc-parser";
import { err, ok, Result } from "neverthrow";
import { createConversionWarnings } from "./legacy-conversion-diagnostics.js";
import { isSafeDslName } from "./legacy-dsl-identifiers.js";
import { inspectLegacyJsonc } from "./legacy-jsonc-inspect.js";
import type {
  ConversionResult,
  ConversionWarning,
  LegacyConversionError,
  LegacyPromptFileContents,
  MigratedPromptFile,
} from "./types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Legacy top-level fields that are explicitly unsupported in migration v1.
 * Each entry maps the field name to the human-readable skip reason.
 */
const UNSUPPORTED_LEGACY_FIELDS = new Map<string, string>([
  [
    "workflows",
    "legacy workflow definitions are not supported in migration v1; define workflows using the current DSL workflow syntax",
  ],
  [
    "continuation",
    "legacy continuation settings are not supported in migration v1; use the current DSL continuation block if needed",
  ],
  [
    "analytics",
    "legacy analytics settings are not supported in migration v1; use the current DSL analytics block if needed",
  ],
  [
    "background",
    "legacy background settings are not supported in migration v1; no equivalent exists in the current DSL",
  ],
  [
    "skill_directories",
    "legacy skill_directories are not migrated; move or symlink those skills into a directory your harness discovers (for OpenCode, .opencode/skills/)",
  ],
  [
    "disabled_tools",
    "legacy disabled_tools are not migrated; use tool_policy on agents or categories instead",
  ],
  [
    "tmux",
    "legacy tmux settings are not supported in migration v1; no equivalent exists in the current DSL",
  ],
  [
    "experimental",
    "legacy experimental settings are not supported in migration v1; no equivalent exists in the current DSL",
  ],
]);

/** JSON metadata keys that carry no Weave settings and are dropped silently. */
const IGNORED_LEGACY_FIELDS = new Set(["$schema"]);

/** Legacy agent override fields the converter handles (converted or warned). */
const HANDLED_AGENT_OVERRIDE_FIELDS = new Set([
  "fast",
  "triggers",
  "model",
  "fallback_models",
  "temperature",
  "prompt_append",
  "prompt_file",
  "tools",
  "display_name",
  "skills",
  "mode",
]);

/** Legacy custom agent fields the converter handles (converted or warned). */
const HANDLED_CUSTOM_AGENT_FIELDS = new Set([
  "fast",
  "triggers",
  "description",
  "prompt",
  "prompt_file",
  "model",
  "fallback_models",
  "temperature",
  "mode",
  "prompt_append",
  "tools",
  "skills",
  "display_name",
]);

/** Legacy category fields the converter handles (converted or warned). */
const HANDLED_CATEGORY_FIELDS = new Set([
  "description",
  "fast",
  "triggers",
  "patterns",
  "model",
  "fallback_models",
  "temperature",
  "prompt_append",
  "tools",
]);

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
const LEGACY_TOOL_TO_CAPABILITY = new Map<
  string,
  "read" | "write" | "execute" | "delegate" | "network"
>([
  // Read-only tools
  ["read", "read"],
  // Write tools
  ["write", "write"],
  ["edit", "write"],
  // Execute tools
  ["bash", "execute"],
  // Delegate tools
  ["task", "delegate"],
  // Network tools
  ["web_search", "network"],
  ["web_fetch", "network"],
]);

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
 * Matches LogLevelSchema in @weaveio/weave-core.
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
/**
 * Escapes a string value for safe embedding in a `.weave` DSL double-quoted
 * string literal. Handles backslashes, double-quotes, newlines, carriage
 * returns, tabs, and other ASCII control characters (U+0000–U+001F except
 * \n, \r, \t, and U+007F) so that any legacy prompt value produces valid DSL.
 */
function escapeForDsl(str: string): string {
  return str
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\t/g, "\\t");
}

function quoteForDsl(value: string): string {
  return `"${escapeForDsl(value)}"`;
}

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
// Prompt file references
// ---------------------------------------------------------------------------

/**
 * Legacy Weave resolved `prompt_file` relative to the legacy config directory
 * and refused absolute paths or paths escaping that directory. Only references
 * that satisfy the same rule are read and carried over.
 */
export function isLegacyPromptFileReferenceSafe(promptFile: string): boolean {
  if (promptFile.trim().length === 0) return false;
  if (posix.isAbsolute(promptFile) || win32.isAbsolute(promptFile))
    return false;
  // Drive-relative (`C:prompt.md`) and rooted (`\prompt.md`) Windows paths
  // resolve against another directory, so they are never inside the config dir.
  if (/^[A-Za-z]:/.test(promptFile) || promptFile.startsWith("\\"))
    return false;
  return !promptFile.split(/[\\/]+/).some((segment) => segment === "..");
}

function warnUnhandledFields(
  entry: Record<string, unknown>,
  handled: ReadonlySet<string>,
  path: string,
  migrationLabel: string,
  warnings: ConversionWarning[],
): void {
  for (const field of Object.keys(entry)) {
    if (handled.has(field)) continue;
    warnings.push({
      field: `${path}.${field}`,
      reason: `not supported in ${migrationLabel} migration v1; skipped`,
    });
  }
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
  const warnings = createConversionWarnings();
  const capabilities: Record<
    "read" | "write" | "execute" | "delegate" | "network",
    "allow" | "deny"
  > = {} as Record<
    "read" | "write" | "execute" | "delegate" | "network",
    "allow" | "deny"
  >;

  for (const [toolName, allowed] of Object.entries(tools)) {
    const warningName = isSafeDslName(toolName) ? toolName : "<entry>";
    if (AMBIGUOUS_LEGACY_TOOLS.has(toolName)) {
      warnings.push({
        field: `${contextLabel}.tools.${warningName}`,
        reason:
          "tool name is harness-specific and cannot be mapped to an abstract tool_policy capability; skipped",
      });
      continue;
    }
    if (typeof allowed !== "boolean") {
      warnings.push({
        field: `${contextLabel}.tools.${warningName}`,
        reason: "tool permission must be a boolean; skipped",
      });
      continue;
    }
    const capability = LEGACY_TOOL_TO_CAPABILITY.get(toolName);
    if (capability === undefined) {
      warnings.push({
        field: `${contextLabel}.tools.${warningName}`,
        reason:
          "unknown legacy tool name cannot be mapped to an abstract tool_policy capability; skipped",
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
  const warnings = createConversionWarnings();
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

  const items = models.map(quoteForDsl).join(", ");
  return { lines: [`  models [${items}]`], warnings };
}

/**
 * Carry a legacy custom agent `prompt_file` over into the destination
 * `prompts/` directory as `<agent>.md`.
 *
 * The caller pre-reads every safe reference relative to the legacy config
 * directory; references that are unsafe or could not be read are warned and
 * skipped.
 */
function convertLegacyPromptFile(
  agentName: string,
  value: unknown,
  contextLabel: string,
  promptFileContents: LegacyPromptFileContents,
): {
  line: string | undefined;
  promptFile: MigratedPromptFile | undefined;
  warnings: ConversionWarning[];
} {
  const warnings = createConversionWarnings();
  const skipped = (reason: string) => {
    warnings.push({ field: `${contextLabel}.prompt_file`, reason });
    return { line: undefined, promptFile: undefined, warnings };
  };

  if (typeof value !== "string")
    return skipped("expected a string path; skipped");
  if (!isLegacyPromptFileReferenceSafe(value)) {
    return skipped(
      "prompt_file must be a relative path inside the legacy config directory; skipped",
    );
  }
  const content = promptFileContents.get(value);
  if (content === undefined) {
    return skipped(
      "prompt_file could not be read relative to the legacy config directory; skipped",
    );
  }

  const promptFile = { path: `${agentName}.md`, content };
  return {
    line: `  prompt_file ${quoteForDsl(promptFile.path)}`,
    promptFile,
    warnings,
  };
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
 *
 * Legacy Weave ignored `prompt_file` on builtin overrides, so it is warned and
 * skipped to keep the builtin prompt in effect. Fields without current-DSL
 * equivalents (`display_name`, `skills`, etc.) are warned and skipped.
 */
function convertLegacyIntent(
  entry: Record<string, unknown>,
  path: string,
  warnings: ConversionWarning[],
): string[] {
  const lines: string[] = [];
  if (entry["fast"] === true) lines.push("  fast true");
  else if (entry["fast"] !== undefined) {
    warnings.push({
      field: `${path}.fast`,
      reason: "only fast true is supported; skipped",
    });
  }
  const triggers = entry["triggers"];
  if (triggers === undefined) return lines;
  if (
    Array.isArray(triggers) &&
    triggers.some((trigger) => typeof trigger === "object" && trigger !== null)
  ) {
    warnings.push({
      field: `${path}.triggers`,
      reason:
        "legacy structured triggers ({ domain, trigger }) are not migrated; add string triggers to the agent if Loom should route to it",
    });
    return lines;
  }
  if (
    !Array.isArray(triggers) ||
    triggers.length === 0 ||
    !triggers.every(
      (trigger) => typeof trigger === "string" && trigger.trim().length > 0,
    )
  ) {
    warnings.push({
      field: `${path}.triggers`,
      reason: "expected a non-empty array of non-blank strings; skipped",
    });
    return lines;
  }
  lines.push(`  triggers [${triggers.map(quoteForDsl).join(", ")}]`);
  return lines;
}

function convertLegacyAgentEntry(
  name: string,
  entry: Record<string, unknown>,
  warnings: ConversionWarning[],
): string[] {
  const lines: string[] = [`agent ${name} {`];
  lines.push(...convertLegacyIntent(entry, `agents.${name}`, warnings));

  const modelsResult = convertLegacyModels(entry, `agents.${name}`);
  warnings.push(...modelsResult.warnings);
  if (modelsResult.lines.length > 0) lines.push(...modelsResult.lines);

  if (typeof entry["temperature"] === "number") {
    lines.push(`  temperature ${entry["temperature"]}`);
  }

  if (typeof entry["prompt_append"] === "string") {
    const escaped = escapeForDsl(entry["prompt_append"]);
    lines.push(`  prompt_append "${escaped}"`);
  }

  if (entry["prompt_file"] !== undefined) {
    warnings.push({
      field: `agents.${name}.prompt_file`,
      reason:
        "legacy Weave ignored prompt_file on builtin agent overrides; skipped so the builtin prompt stays in effect",
    });
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

  const unsupportedAgentFields = ["display_name", "skills", "mode"];
  for (const field of unsupportedAgentFields) {
    if (entry[field] !== undefined) {
      warnings.push({
        field: `agents.${name}.${field}`,
        reason: `"${field}" is not supported in agent override migration v1; skipped`,
      });
    }
  }
  warnUnhandledFields(
    entry,
    HANDLED_AGENT_OVERRIDE_FIELDS,
    `agents.${name}`,
    "agent override",
    warnings,
  );

  // Every field was skipped: emit nothing rather than an empty override.
  if (lines.length === 1) return [];
  lines.push("}");
  return lines;
}

/**
 * Convert a legacy custom agent entry into a new `agent <name> { ... }` block.
 *
 * Supported fields:
 * - `description` → `description "..."` (falls back to `display_name`, as legacy did)
 * - `prompt_file` → copied to `prompts/<name>.md` and referenced by `prompt_file`
 * - `prompt` (inline) → `prompt "..."` (used when no readable `prompt_file`, as legacy did)
 * - `model` + `fallback_models` → `models [...]`
 * - `temperature` → `temperature <value>`
 * - `mode` → `mode <value>` (if valid)
 * - `prompt_append` → `prompt_append "..."`
 * - `tools` → `tool_policy { ... }`
 *
 * An agent left without any prompt source is skipped with a warning, because
 * harness adapters cannot register an agent that has no prompt.
 * Unsupported fields are warned and skipped.
 */
function convertLegacyCustomAgent(
  name: string,
  entry: Record<string, unknown>,
  warnings: ConversionWarning[],
  promptFileContents: LegacyPromptFileContents,
): { lines: string[]; promptFile: MigratedPromptFile | undefined } {
  const path = `custom_agents.${name}`;
  const lines: string[] = [`agent ${name} {`];

  const description = [entry["description"], entry["display_name"]].find(
    (value): value is string =>
      typeof value === "string" && value.trim().length > 0,
  );
  if (description !== undefined) {
    lines.push(`  description ${quoteForDsl(description)}`);
  }

  lines.push(...convertLegacyIntent(entry, path, warnings));

  const inlinePrompt =
    typeof entry["prompt"] === "string" && entry["prompt"].trim().length > 0
      ? entry["prompt"]
      : undefined;
  if (entry["prompt"] !== undefined && inlinePrompt === undefined) {
    warnings.push({
      field: `${path}.prompt`,
      reason: "expected a non-empty string; skipped",
    });
  }

  let promptFile: MigratedPromptFile | undefined;
  if (entry["prompt_file"] !== undefined) {
    const promptFileResult = convertLegacyPromptFile(
      name,
      entry["prompt_file"],
      path,
      promptFileContents,
    );
    warnings.push(...promptFileResult.warnings);
    if (promptFileResult.line !== undefined) {
      lines.push(promptFileResult.line);
      promptFile = promptFileResult.promptFile;
      if (inlinePrompt !== undefined) {
        warnings.push({
          field: `${path}.prompt`,
          reason:
            "both prompt and prompt_file are set; prompt skipped (prompt_file takes precedence, as in legacy Weave)",
        });
      }
    }
  }
  if (promptFile === undefined && inlinePrompt !== undefined) {
    lines.push(`  prompt ${quoteForDsl(inlinePrompt)}`);
  }
  if (promptFile === undefined && inlinePrompt === undefined) {
    warnings.push({
      field: path,
      reason:
        "custom agent has no usable prompt or prompt_file; agent skipped because harness adapters cannot register an agent without a prompt",
    });
    warnUnsupportedCustomAgentFields(entry, name, warnings);
    return { lines: [], promptFile: undefined };
  }

  const modelsResult = convertLegacyModels(entry, path);
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
        reason:
          "value is not a valid mode (expected primary, subagent, or all); skipped",
      });
    }
  }

  if (typeof entry["prompt_append"] === "string") {
    const escaped = escapeForDsl(entry["prompt_append"]);
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
  warnUnsupportedCustomAgentFields(entry, name, warnings);

  lines.push("}");
  return { lines, promptFile };
}

function warnUnsupportedCustomAgentFields(
  entry: Record<string, unknown>,
  name: string,
  warnings: ConversionWarning[],
): void {
  for (const field of ["skills", "display_name"]) {
    if (entry[field] !== undefined) {
      warnings.push({
        field: `custom_agents.${name}.${field}`,
        reason: `"${field}" is not supported in custom agent migration v1; skipped`,
      });
    }
  }
  warnUnhandledFields(
    entry,
    HANDLED_CUSTOM_AGENT_FIELDS,
    `custom_agents.${name}`,
    "custom agent",
    warnings,
  );
}

/**
 * Convert a legacy category entry into a `category <name> { ... }` block.
 *
 * Supported fields:
 * - `description` → `description "..."`
 * - `patterns` is removed; migration warns instead of inventing routing intent
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

  if (
    typeof entry["description"] !== "string" ||
    entry["description"].trim().length === 0
  ) {
    warnings.push({
      field: `categories.${name}.description`,
      reason: "a non-empty category description is required; category skipped",
    });
    warnUnhandledFields(
      entry,
      HANDLED_CATEGORY_FIELDS,
      `categories.${name}`,
      "category",
      warnings,
    );
    return [];
  }
  lines.push(`  description ${quoteForDsl(entry["description"])}`);
  lines.push(...convertLegacyIntent(entry, `categories.${name}`, warnings));
  if (entry["patterns"] !== undefined) {
    warnings.push({
      field: `categories.${name}.patterns`,
      reason:
        "patterns are removed; describe routing with category description and string triggers",
    });
  }

  const modelsResult = convertLegacyModels(entry, `categories.${name}`);
  warnings.push(...modelsResult.warnings);
  if (modelsResult.lines.length > 0) lines.push(...modelsResult.lines);

  if (typeof entry["temperature"] === "number") {
    lines.push(`  temperature ${entry["temperature"]}`);
  }

  if (typeof entry["prompt_append"] === "string") {
    const escaped = escapeForDsl(entry["prompt_append"]);
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
  warnUnhandledFields(
    entry,
    HANDLED_CATEGORY_FIELDS,
    `categories.${name}`,
    "category",
    warnings,
  );

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
 * - `workflows`, `continuation`, `analytics`, `background`,
 *   `skill_directories`, `disabled_tools`, `tmux`, `experimental`
 *
 * Ignored silently: `$schema` (JSON metadata).
 */
function isSafeRecord(
  value: SafeGraphValue,
): value is { [key: string]: SafeGraphValue } {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function appendValidBlock(
  dslLines: string[],
  blockLines: string[],
  warnings: ConversionWarning[],
  field: string,
): boolean {
  if (blockLines.length === 0) return false;
  const block = blockLines.join("\n");
  if (parseConfig(block).isOk()) {
    dslLines.push(block);
    return true;
  }
  warnings.push({
    field,
    reason:
      "converted DSL did not validate against the current schema; omitted",
  });
  return false;
}

function convertCopiedRoot(
  parsed: { [key: string]: SafeGraphValue },
  promptFileContents: LegacyPromptFileContents,
): Result<ConversionResult, LegacyConversionError> {
  const warnings = createConversionWarnings();
  const dslLines: string[] = [];
  const promptFiles: MigratedPromptFile[] = [];

  for (const [key, value] of Object.entries(parsed)) {
    if (IGNORED_LEGACY_FIELDS.has(key)) continue;

    const unsupportedReason = UNSUPPORTED_LEGACY_FIELDS.get(key);
    if (unsupportedReason !== undefined) {
      warnings.push({ field: key, reason: unsupportedReason });
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
        .map(quoteForDsl)
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
        .map(quoteForDsl)
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
        .map(quoteForDsl)
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
          reason:
            "value is not a valid log level (expected one of TRACE, DEBUG, INFO, WARN, ERROR, FATAL); skipped",
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
        if (!isSafeDslName(agentName)) {
          warnings.push({
            field: "agents.<entry>",
            reason: "name is not a safe DSL identifier; skipped",
          });
          continue;
        }
        if (!BUILTIN_AGENT_NAMES.has(agentName)) {
          warnings.push({
            field: `agents.${agentName}`,
            reason:
              "name is not a builtin agent name; use custom_agents to create a new agent",
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
        appendValidBlock(dslLines, agentLines, warnings, `agents.${agentName}`);
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
        if (!isSafeDslName(agentName)) {
          warnings.push({
            field: "custom_agents.<entry>",
            reason: "name is not a safe DSL identifier; skipped",
          });
          continue;
        }
        if (BUILTIN_AGENT_NAMES.has(agentName)) {
          warnings.push({
            field: `custom_agents.${agentName}`,
            reason:
              "name collides with a builtin agent; skipped to avoid an override",
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
        const converted = convertLegacyCustomAgent(
          agentName,
          agentEntry as Record<string, unknown>,
          warnings,
          promptFileContents,
        );
        const appended = appendValidBlock(
          dslLines,
          converted.lines,
          warnings,
          `custom_agents.${agentName}`,
        );
        if (appended && converted.promptFile !== undefined) {
          promptFiles.push(converted.promptFile);
        }
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
        if (!isSafeDslName(catName)) {
          warnings.push({
            field: "categories.<entry>",
            reason: "name is not a safe DSL identifier; skipped",
          });
          continue;
        }
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
        appendValidBlock(dslLines, catLines, warnings, `categories.${catName}`);
      }
      continue;
    }

    warnings.push({
      field: key,
      reason: "unknown legacy field; not supported in migration v1",
    });
  }

  const dsl = dslLines.join("\n");
  if (dsl.length === 0 || parseConfig(dsl).isOk()) {
    return ok({ dsl, warnings, promptFiles });
  }
  warnings.push({
    field: "<dsl>",
    reason:
      "converted DSL did not validate against the current schema; output omitted",
  });
  return err({ type: "ConvertedDslInvalid", warnings });
}

function sourceUnreadable(reason: string): LegacyConversionError {
  const warnings = createConversionWarnings();
  warnings.push({ field: "<source>", reason });
  return { type: "SourceUnreadable", warnings };
}

const parseJsoncSource = Result.fromThrowable(
  (source: string): unknown => {
    const errors: ParseError[] = [];
    const value = parseJsonc(source, errors, {
      allowTrailingComma: true,
      disallowComments: false,
      allowEmptyContent: false,
    });
    if (errors.length > 0) return undefined;
    return value;
  },
  (): undefined => undefined,
);

/** Options for legacy conversion. */
export type LegacyConversionOptions = {
  /** Pre-read contents of legacy custom agent `prompt_file` references. */
  promptFileContents?: LegacyPromptFileContents;
};

/** Convert an already-parsed legacy value through the descriptor-safe graph boundary. */
export function convertLegacyValue(
  value: unknown,
  options: LegacyConversionOptions = {},
): Result<ConversionResult, LegacyConversionError> {
  const copied = copySafeGraph(value);
  if (copied.isErr()) {
    return err(
      sourceUnreadable(
        "legacy value contains unsafe or excessive structure; no fields could be converted",
      ),
    );
  }
  if (!isSafeRecord(copied.value)) {
    return err(
      sourceUnreadable(
        "legacy JSONC root must be an object; no fields could be converted",
      ),
    );
  }
  return convertCopiedRoot(
    copied.value,
    options.promptFileContents ?? new Map(),
  );
}

/**
 * Convert a legacy weave-opencode.jsonc source. Individual fields that cannot
 * be converted become warnings on a successful result; the result is an error
 * only when nothing can be converted, in which case callers must write nothing.
 */
export function convertLegacyJsonc(
  source: string,
  options: LegacyConversionOptions = {},
): Result<ConversionResult, LegacyConversionError> {
  const inspected = inspectLegacyJsonc(source);
  if (inspected.isErr()) {
    return err({
      type: "SourceUnreadable",
      warnings: inspected.error.warnings,
    });
  }

  const parsed = parseJsoncSource(source);
  if (parsed.isErr() || parsed.value === undefined) {
    return err(
      sourceUnreadable(
        "failed to parse legacy JSONC source; no fields could be converted",
      ),
    );
  }
  return convertLegacyValue(parsed.value, options);
}

/**
 * List the safe custom agent `prompt_file` references in a legacy source, so
 * the caller can read them relative to the legacy config directory before
 * conversion. Returns an empty list when the source cannot be converted.
 */
export function listLegacyPromptFileReferences(source: string): string[] {
  if (inspectLegacyJsonc(source).isErr()) return [];
  const parsed = parseJsoncSource(source);
  if (parsed.isErr()) return [];
  const copied = copySafeGraph(parsed.value);
  if (copied.isErr() || !isSafeRecord(copied.value)) return [];
  const customAgents = copied.value["custom_agents"];
  if (customAgents === undefined || !isSafeRecord(customAgents)) return [];

  const references = new Set<string>();
  for (const entry of Object.values(customAgents)) {
    if (!isSafeRecord(entry)) continue;
    const promptFile = entry["prompt_file"];
    if (
      typeof promptFile === "string" &&
      isLegacyPromptFileReferenceSafe(promptFile)
    ) {
      references.add(promptFile);
    }
  }
  return [...references];
}
