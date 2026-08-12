/**
 * Legacy JSONC-to-DSL conversion.
 *
 * Converts a legacy weave-opencode.jsonc source string into current `.weave` DSL.
 * This is a best-effort partial conversion: supported fields are converted,
 * unsupported fields are skipped with explicit warnings.
 */

import { type ParseError, parse as parseJsonc } from "jsonc-parser";

import {
  copyLegacyGraph,
  LEGACY_GRAPH_TOO_LARGE_MESSAGE,
  type LegacyGraphCopyError,
  UNSAFE_LEGACY_GRAPH_MESSAGE,
} from "./legacy-graph-copy.js";
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

/**
 * Legacy names that must never become `fast true`. The converter never infers
 * acceleration intent from a legacy or provider-specific field.
 */
const REJECTED_FAST_ALIASES = [
  "fast",
  "service_class",
  "speed",
  "variant",
  "priority",
] as const;

const MAX_CONVERSION_WARNINGS = 32;
const MAX_WARNING_FIELD_LENGTH = 256;
const MAX_WARNING_REASON_LENGTH = 512;
const MAX_WARNING_DIAGNOSTIC_SIZE = 8 * 1024;
const WARNING_TRUNCATION_SUFFIX = "... [truncated]";
const WARNINGS_TRUNCATED_REASON =
  "additional conversion diagnostics were truncated";

// ---------------------------------------------------------------------------
// JSONC parsing
// ---------------------------------------------------------------------------

/**
 * Parse legacy JSONC with comments and trailing commas. The old
 * comment-stripping pass left trailing commas for `JSON.parse` to reject,
 * which made migration fall back to the starter config.
 *
 * Returns `undefined` when parsing fails.
 */
function parseLegacyJsonc(source: string): unknown {
  const errors: ParseError[] = [];
  const result = parseJsonc(source, errors, {
    allowTrailingComma: true,
    disallowComments: false,
    allowEmptyContent: false,
  });
  if (errors.length > 0) return undefined;
  return result;
}

/**
 * Escapes a string value for safe embedding in a `.weave` DSL double-quoted
 * string literal. Handles backslashes, double-quotes, newlines, carriage
 * returns, tabs, and other ASCII control characters (U+0000–U+001F except
 * \n, \r, \t, and U+007F) so that any legacy prompt value produces valid DSL.
 */
// Regex for ASCII control characters not covered by named escape sequences
// (\n, \r, \t). Covers U+0000-U+0008, U+000B, U+000C, U+000E-U+001F, U+007F.
// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional — this regex exists specifically to detect and escape control characters
const CONTROL_CHAR_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

function escapeForDsl(str: string): string {
  return str
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t")
    .replace(CONTROL_CHAR_RE, (ch) => {
      const hex = ch.charCodeAt(0).toString(16).padStart(4, "0");
      return `\\u${hex}`;
    });
}

function truncateWarningText(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit - WARNING_TRUNCATION_SUFFIX.length)}${WARNING_TRUNCATION_SUFFIX}`;
}

function warningSize(warning: ConversionWarning): number {
  return warning.field.length + warning.reason.length;
}

function boundWarning(warning: ConversionWarning): ConversionWarning {
  return {
    field: truncateWarningText(warning.field, MAX_WARNING_FIELD_LENGTH),
    reason: truncateWarningText(warning.reason, MAX_WARNING_REASON_LENGTH),
  };
}

function pushWarning(
  warnings: ConversionWarning[],
  field: string,
  reason: string,
): void {
  const next = boundWarning({ field, reason });
  let aggregate = 0;
  for (const warning of warnings) {
    aggregate += warningSize(warning);
  }
  const wouldExceedCount = warnings.length >= MAX_CONVERSION_WARNINGS;
  const wouldExceedSize =
    aggregate + warningSize(next) > MAX_WARNING_DIAGNOSTIC_SIZE;
  if (wouldExceedCount || wouldExceedSize) {
    const marker = boundWarning({
      field: "<diagnostics>",
      reason: WARNINGS_TRUNCATED_REASON,
    });
    const last = warnings[warnings.length - 1];
    if (last?.field === marker.field && last.reason === marker.reason) {
      return;
    }
    if (warnings.length >= MAX_CONVERSION_WARNINGS) {
      warnings[warnings.length - 1] = marker;
      return;
    }
    warnings.push(marker);
    return;
  }
  warnings.push(next);
}

function absorbWarnings(
  warnings: ConversionWarning[],
  extra: ConversionWarning[],
): void {
  for (const warning of extra) {
    pushWarning(warnings, warning.field, warning.reason);
  }
}

function graphCopyWarning(error: LegacyGraphCopyError): ConversionWarning {
  return boundWarning({
    field: "<source>",
    reason:
      error.type === "GraphTooLarge"
        ? LEGACY_GRAPH_TOO_LARGE_MESSAGE
        : UNSAFE_LEGACY_GRAPH_MESSAGE,
  });
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function formatTriggerList(triggers: string[]): string {
  return `  triggers [${triggers.map((trigger) => JSON.stringify(trigger)).join(", ")}]`;
}

function warnRejectedFastAliases(
  entry: Record<string, unknown>,
  contextLabel: string,
  warnings: ConversionWarning[],
): void {
  for (const alias of REJECTED_FAST_ALIASES) {
    if (entry[alias] !== undefined) {
      pushWarning(
        warnings,
        `${contextLabel}.${alias}`,
        `"${alias}" is not converted to fast intent; skipped`,
      );
    }
  }
}

/**
 * Convert a legacy trigger array into ordered unique strings.
 *
 * For each object, choose a nonblank `routing_hint`, else a nonblank `trigger`.
 * Preserve source order, drop exact duplicate strings, and warn for every
 * discarded structured field and every malformed or empty entry.
 */
function convertLegacyTriggers(
  value: unknown,
  fieldPath: string,
  warnings: ConversionWarning[],
): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    pushWarning(
      warnings,
      fieldPath,
      "expected an array of trigger strings or legacy trigger objects; skipped",
    );
    return undefined;
  }

  const selected: string[] = [];
  const seen = new Set<string>();

  for (let index = 0; index < value.length; index += 1) {
    const entryPath = `${fieldPath}.${index}`;
    const entry = value[index];

    if (typeof entry === "string") {
      if (entry.trim().length === 0) {
        pushWarning(warnings, entryPath, "empty trigger string discarded");
        continue;
      }
      if (!seen.has(entry)) {
        seen.add(entry);
        selected.push(entry);
      }
      continue;
    }

    if (!isPlainRecord(entry)) {
      pushWarning(warnings, entryPath, "malformed trigger entry discarded");
      continue;
    }

    const routingHint = entry.routing_hint;
    const trigger = entry.trigger;
    let chosen: string | undefined;
    let chosenKey: "routing_hint" | "trigger" | undefined;
    if (isNonBlankString(routingHint)) {
      chosen = routingHint;
      chosenKey = "routing_hint";
    } else if (isNonBlankString(trigger)) {
      chosen = trigger;
      chosenKey = "trigger";
    }

    for (const key of Object.keys(entry)) {
      if (key === chosenKey) continue;
      const discarded = entry[key];
      let preview: string;
      if (typeof discarded === "string") {
        preview = discarded;
      } else if (discarded === null) {
        preview = "null";
      } else if (Array.isArray(discarded)) {
        preview = "array";
      } else {
        preview = typeof discarded;
      }
      pushWarning(
        warnings,
        `${entryPath}.${key}`,
        `legacy trigger field "${key}" (${preview}) cannot be represented as a trigger string; discarded`,
      );
    }

    if (chosen === undefined) {
      pushWarning(
        warnings,
        entryPath,
        "malformed or empty trigger entry discarded",
      );
      continue;
    }

    if (!seen.has(chosen)) {
      seen.add(chosen);
      selected.push(chosen);
    }
  }

  return selected.length > 0 ? selected : undefined;
}

function convertLegacyPatternField(
  value: unknown,
  fieldPath: string,
  warnings: ConversionWarning[],
): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    pushWarning(
      warnings,
      fieldPath,
      "malformed category patterns discarded; categories no longer use file patterns",
    );
    return;
  }

  let validCount = 0;
  for (let index = 0; index < value.length; index += 1) {
    const pattern = value[index];
    if (typeof pattern === "string" && pattern.trim().length > 0) {
      validCount += 1;
      continue;
    }
    pushWarning(
      warnings,
      `${fieldPath}.${index}`,
      "malformed category pattern discarded",
    );
  }

  if (validCount > 0) {
    pushWarning(
      warnings,
      fieldPath,
      "category file patterns are not supported; dropped valid patterns and did not emit a replacement",
    );
  } else if (value.length === 0) {
    pushWarning(
      warnings,
      fieldPath,
      "empty category patterns discarded; categories no longer use file patterns",
    );
  }
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

  return { line: `  prompt_file "${escapeForDsl(value)}"`, warnings };
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
  absorbWarnings(warnings, modelsResult.warnings);
  if (modelsResult.lines.length > 0) lines.push(...modelsResult.lines);

  if (typeof entry["temperature"] === "number") {
    lines.push(`  temperature ${entry["temperature"]}`);
  }

  if (typeof entry["prompt_append"] === "string") {
    const escaped = escapeForDsl(entry["prompt_append"]);
    lines.push(`  prompt_append "${escaped}"`);
  }

  if (entry["prompt_file"] !== undefined) {
    const promptFileResult = convertLegacyPromptFile(
      entry["prompt_file"],
      `agents.${name}`,
    );
    absorbWarnings(warnings, promptFileResult.warnings);
    if (promptFileResult.line !== undefined) lines.push(promptFileResult.line);
  }

  if (isPlainRecord(entry["tools"])) {
    const toolResult = convertLegacyTools(
      entry["tools"] as Record<string, boolean>,
      `agents.${name}`,
    );
    for (const warning of toolResult.warnings) {
      pushWarning(warnings, warning.field, warning.reason);
    }
    if (toolResult.lines.length > 0) lines.push(...toolResult.lines);
  }

  const triggers = convertLegacyTriggers(
    entry["triggers"],
    `agents.${name}.triggers`,
    warnings,
  );
  if (triggers !== undefined) lines.push(formatTriggerList(triggers));

  warnRejectedFastAliases(entry, `agents.${name}`, warnings);

  const unsupportedAgentFields = ["display_name", "skills", "mode"];
  for (const field of unsupportedAgentFields) {
    if (entry[field] !== undefined) {
      pushWarning(
        warnings,
        `agents.${name}.${field}`,
        `"${field}" is not supported in agent override migration v1; skipped`,
      );
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
    const escaped = escapeForDsl(entry["prompt"]);
    lines.push(`  prompt "${escaped}"`);
  }

  if (entry["prompt_file"] !== undefined && entry["prompt"] === undefined) {
    const promptFileResult = convertLegacyPromptFile(
      entry["prompt_file"],
      `custom_agents.${name}`,
    );
    absorbWarnings(warnings, promptFileResult.warnings);
    if (promptFileResult.line !== undefined) lines.push(promptFileResult.line);
  } else if (
    entry["prompt_file"] !== undefined &&
    entry["prompt"] !== undefined
  ) {
    pushWarning(
      warnings,
      `custom_agents.${name}.prompt_file`,
      "both prompt and prompt_file are set; prompt_file skipped (prompt takes precedence)",
    );
  }

  const modelsResult = convertLegacyModels(entry, `custom_agents.${name}`);
  absorbWarnings(warnings, modelsResult.warnings);
  if (modelsResult.lines.length > 0) lines.push(...modelsResult.lines);

  if (typeof entry["temperature"] === "number") {
    lines.push(`  temperature ${entry["temperature"]}`);
  }

  if (entry["mode"] !== undefined) {
    const validModes = new Set(["primary", "subagent", "all"]);
    if (typeof entry["mode"] === "string" && validModes.has(entry["mode"])) {
      lines.push(`  mode ${entry["mode"]}`);
    } else {
      pushWarning(
        warnings,
        `custom_agents.${name}.mode`,
        `"${String(entry["mode"])}" is not a valid mode (expected primary, subagent, or all); skipped`,
      );
    }
  }

  if (typeof entry["prompt_append"] === "string") {
    const escaped = escapeForDsl(entry["prompt_append"]);
    lines.push(`  prompt_append "${escaped}"`);
  }

  if (isPlainRecord(entry["tools"])) {
    const toolResult = convertLegacyTools(
      entry["tools"] as Record<string, boolean>,
      `custom_agents.${name}`,
    );
    for (const warning of toolResult.warnings) {
      pushWarning(warnings, warning.field, warning.reason);
    }
    if (toolResult.lines.length > 0) lines.push(...toolResult.lines);
  }

  const triggers = convertLegacyTriggers(
    entry["triggers"],
    `custom_agents.${name}.triggers`,
    warnings,
  );
  if (triggers !== undefined) lines.push(formatTriggerList(triggers));

  warnRejectedFastAliases(entry, `custom_agents.${name}`, warnings);

  const unsupportedCustomAgentFields = ["skills", "display_name"];
  for (const field of unsupportedCustomAgentFields) {
    if (entry[field] !== undefined) {
      pushWarning(
        warnings,
        `custom_agents.${name}.${field}`,
        `"${field}" is not supported in custom agent migration v1; skipped`,
      );
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
 * - `triggers` → `triggers [...]` (string or legacy object conversion)
 * - `model` + `fallback_models` → `models [...]`
 * - `temperature` → `temperature <value>`
 * - `prompt_append` → `prompt_append "..."`
 * - `tools` → `tool_policy { ... }`
 *
 * Valid and malformed `patterns` are dropped with warnings. A category with a
 * nonblank description still converts. The converter never emits `patterns` or
 * infers `fast`.
 */
function convertLegacyCategory(
  name: string,
  entry: Record<string, unknown>,
  warnings: ConversionWarning[],
): string[] {
  convertLegacyPatternField(
    entry["patterns"],
    `categories.${name}.patterns`,
    warnings,
  );

  const description = entry["description"];
  if (!isNonBlankString(description)) {
    pushWarning(
      warnings,
      `categories.${name}.description`,
      "a non-empty string is required; category skipped",
    );
    return [];
  }

  const lines: string[] = [`category ${name} {`];
  lines.push(`  description "${escapeForDsl(description)}"`);

  const modelsResult = convertLegacyModels(entry, `categories.${name}`);
  for (const warning of modelsResult.warnings) {
    pushWarning(warnings, warning.field, warning.reason);
  }
  if (modelsResult.lines.length > 0) lines.push(...modelsResult.lines);

  if (typeof entry["temperature"] === "number") {
    lines.push(`  temperature ${entry["temperature"]}`);
  }

  if (typeof entry["prompt_append"] === "string") {
    lines.push(`  prompt_append "${escapeForDsl(entry["prompt_append"])}"`);
  }

  if (isPlainRecord(entry["tools"])) {
    const toolResult = convertLegacyTools(
      entry["tools"] as Record<string, boolean>,
      `categories.${name}`,
    );
    for (const warning of toolResult.warnings) {
      pushWarning(warnings, warning.field, warning.reason);
    }
    if (toolResult.lines.length > 0) lines.push(...toolResult.lines);
  }

  const triggers = convertLegacyTriggers(
    entry["triggers"],
    `categories.${name}.triggers`,
    warnings,
  );
  if (triggers !== undefined) lines.push(formatTriggerList(triggers));

  warnRejectedFastAliases(entry, `categories.${name}`, warnings);

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
  const parseResult = parseLegacyJsonc(source);
  if (
    parseResult === undefined ||
    parseResult === null ||
    typeof parseResult !== "object" ||
    Array.isArray(parseResult)
  ) {
    return {
      dsl: "",
      warnings: [
        boundWarning({
          field: "<source>",
          reason:
            "failed to parse legacy JSONC source; no fields could be converted",
        }),
      ],
    };
  }
  return convertLegacyValue(parseResult);
}

/**
 * Convert an already-parsed legacy value. Used by `convertLegacyJsonc` after
 * JSONC parsing, and by tests that inject crafted objects to prove the
 * descriptor-safe copy rejects getters, inherited fields, and callables
 * without executing them.
 */
export function convertLegacyValue(value: unknown): ConversionResult {
  const copied = copyLegacyGraph(value);
  if (copied.isErr()) {
    return { dsl: "", warnings: [graphCopyWarning(copied.error)] };
  }
  const copiedValue = copied.value;
  if (
    copiedValue === null ||
    typeof copiedValue !== "object" ||
    Array.isArray(copiedValue)
  ) {
    return {
      dsl: "",
      warnings: [
        boundWarning({
          field: "<source>",
          reason:
            "failed to parse legacy JSONC source; no fields could be converted",
        }),
      ],
    };
  }
  return convertCopiedRoot(copiedValue as Record<string, unknown>);
}

function convertCopiedRoot(parsed: Record<string, unknown>): ConversionResult {
  const warnings: ConversionWarning[] = [];
  const dslLines: string[] = [];

  for (const [key, value] of Object.entries(parsed)) {
    if (key in UNSUPPORTED_LEGACY_FIELDS) {
      pushWarning(warnings, key, UNSUPPORTED_LEGACY_FIELDS[key]!);
      continue;
    }

    if (key === "disabled_agents") {
      if (!Array.isArray(value)) {
        pushWarning(warnings, key, "expected an array of agent names; skipped");
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
        pushWarning(warnings, key, "expected an array of hook names; skipped");
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
        pushWarning(warnings, key, "expected an array of skill names; skipped");
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
        pushWarning(
          warnings,
          key,
          "expected a string log level value; skipped",
        );
        continue;
      }
      const normalized = value.toUpperCase();
      if (!VALID_LOG_LEVELS.has(normalized)) {
        pushWarning(
          warnings,
          key,
          `"${value}" is not a valid log level (expected one of TRACE, DEBUG, INFO, WARN, ERROR, FATAL); skipped`,
        );
        continue;
      }
      dslLines.push(`settings {`);
      dslLines.push(`  log_level ${normalized}`);
      dslLines.push(`}`);
      continue;
    }

    if (key === "agents") {
      if (!isPlainRecord(value)) {
        pushWarning(
          warnings,
          key,
          "expected an object of agent override entries; skipped",
        );
        continue;
      }
      for (const [agentName, agentEntry] of Object.entries(value)) {
        if (!BUILTIN_AGENT_NAMES.has(agentName)) {
          pushWarning(
            warnings,
            `agents.${agentName}`,
            `"${agentName}" is not a builtin agent name; entries under "agents" are overrides of existing builtins only — use "custom_agents" to create new agents`,
          );
          continue;
        }
        if (!isPlainRecord(agentEntry)) {
          pushWarning(
            warnings,
            `agents.${agentName}`,
            "expected an object; skipped",
          );
          continue;
        }
        dslLines.push(
          ...convertLegacyAgentEntry(agentName, agentEntry, warnings),
        );
      }
      continue;
    }

    if (key === "custom_agents") {
      if (!isPlainRecord(value)) {
        pushWarning(
          warnings,
          key,
          "expected an object of custom agent entries; skipped",
        );
        continue;
      }
      for (const [agentName, agentEntry] of Object.entries(value)) {
        if (BUILTIN_AGENT_NAMES.has(agentName)) {
          pushWarning(
            warnings,
            `custom_agents.${agentName}`,
            `"${agentName}" collides with a builtin agent name; skipped to avoid silently overriding the builtin`,
          );
          continue;
        }
        if (!isPlainRecord(agentEntry)) {
          pushWarning(
            warnings,
            `custom_agents.${agentName}`,
            "expected an object; skipped",
          );
          continue;
        }
        dslLines.push(
          ...convertLegacyCustomAgent(agentName, agentEntry, warnings),
        );
      }
      continue;
    }

    if (key === "categories") {
      if (!isPlainRecord(value)) {
        pushWarning(
          warnings,
          key,
          "expected an object of category entries; skipped",
        );
        continue;
      }
      for (const [catName, catEntry] of Object.entries(value)) {
        if (!isPlainRecord(catEntry)) {
          pushWarning(
            warnings,
            `categories.${catName}`,
            "expected an object; skipped",
          );
          continue;
        }
        dslLines.push(...convertLegacyCategory(catName, catEntry, warnings));
      }
      continue;
    }

    pushWarning(
      warnings,
      key,
      "unknown legacy field; not supported in migration v1",
    );
  }

  return { dsl: dslLines.join("\n"), warnings };
}
