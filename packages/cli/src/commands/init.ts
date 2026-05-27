import { resolve } from "node:path";
import { parseConfig } from "@weave/core";
import { errAsync, ok, type Result, ResultAsync } from "neverthrow";
import type { ParsedArgs } from "../args.js";
import { starterConfig } from "../config/starter-config.js";
import {
  type DetectedHarness,
  detectHarnesses,
  formatDetectionSummary,
  type SupportedHarnessId,
} from "../detect/index.js";
import type { DetectionProbes } from "../detect/probes.js";
import type { CliError } from "../errors.js";
import {
  BunFileSystem,
  describeFileSystemError,
  type FileSystem,
} from "../fs/file-system.js";
import { installerRegistry } from "../installers/index.js";
import type { TerminalIO } from "../io/terminal.js";
import { ClackPromptAdapter, type PromptAdapter } from "../prompt/index.js";
import type { ThemeColors } from "../theme/colors.js";
import { defaultThemeRenderer } from "../theme/render.js";

export interface InitContext {
  terminal: TerminalIO;
  theme: ThemeColors;
  flags: ParsedArgs["flags"];
  fs?: FileSystem;
  prompt?: PromptAdapter;
  probes?: DetectionProbes;
}

type InitScope = "global" | "local";

type InitPlan = {
  scope: InitScope;
  installDir: string;
  selectedHarnesses: SupportedHarnessId[];
  selectedModules: Record<string, string[]>;
  confirmed: boolean;
};

type ScaffoldResult = {
  configPath: string;
  promptsPath: string;
  messages: string[];
};

// ---------------------------------------------------------------------------
// Migration types
// ---------------------------------------------------------------------------

/**
 * Canonical legacy source paths, keyed by scope.
 * These are relative to the scope root (home or cwd).
 */
const LEGACY_SOURCE_RELATIVE: Record<InitScope, string> = {
  global: ".config/opencode/weave-opencode.jsonc",
  local: ".opencode/weave-opencode.jsonc",
};

/**
 * Canonical migration destination directory names, keyed by scope.
 * Migration ALWAYS writes to these paths — --install-dir is ignored.
 */
const CANONICAL_WEAVE_DIR: Record<InitScope, string> = {
  global: ".weave",
  local: ".weave",
};

export type MigrationPlan = {
  scope: InitScope;
  sourcePath: string;
  destinationDir: string;
  destinationPath: string;
  /** Number of legacy fields that will be skipped with warnings during conversion. */
  skippedWarningCount: number;
};

// ---------------------------------------------------------------------------
// JSONC conversion — best-effort partial success
// ---------------------------------------------------------------------------

/**
 * A single conversion warning: a legacy field that was skipped with a reason.
 */
export type ConversionWarning = {
  field: string;
  reason: string;
};

/**
 * Result of best-effort JSONC-to-DSL conversion.
 * `dsl` contains the converted DSL lines (without provenance comment).
 * `warnings` lists every skipped field with an explicit reason.
 */
export type ConversionResult = {
  dsl: string;
  warnings: ConversionWarning[];
};

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

// ---------------------------------------------------------------------------
// Task 4 — Agent, category, model, tool, and prompt conversion constants
// ---------------------------------------------------------------------------

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
 * Legacy tool names come from `src/tools/permissions.ts` in the legacy codebase.
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
 * Filename-only pattern: a safe prompt_file reference is a bare filename
 * (no directory separators) that can be placed directly in `.weave/prompts/`.
 * Paths with directory components (e.g. `../prompts/foo.md`, `/abs/path.md`,
 * `subdir/foo.md`) cannot be safely translated and are warned and skipped.
 */
function isPromptFileSafe(promptFile: string): boolean {
  // Must be a non-empty string with no path separators and no leading dots
  // that would escape the prompts/ directory.
  if (promptFile.length === 0) return false;
  if (promptFile.includes("/") || promptFile.includes("\\")) return false;
  if (promptFile.startsWith("..")) return false;
  return true;
}

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

/**
 * Strip JSONC-style line comments and block comments from a string so it
 * can be parsed by `JSON.parse`.
 *
 * Uses a char-by-char state machine that tracks string context so that
 * comment-like sequences inside string literals are preserved intact.
 * This correctly handles URLs (e.g. `"https://example.com"`) and other
 * string values that contain slashes.
 */
function stripJsoncComments(source: string): string {
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
// Task 4 — Agent, category, model, tool, and prompt conversion helpers
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
  // Collect per-capability permissions (last write wins for duplicates)
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

  // model + fallback_models → models [...]
  const modelsResult = convertLegacyModels(entry, `agents.${name}`);
  warnings.push(...modelsResult.warnings);
  if (modelsResult.lines.length > 0) lines.push(...modelsResult.lines);

  // temperature
  if (typeof entry["temperature"] === "number") {
    lines.push(`  temperature ${entry["temperature"]}`);
  }

  // prompt_append (inline string)
  if (typeof entry["prompt_append"] === "string") {
    const escaped = entry["prompt_append"].replace(/"/g, '\\"');
    lines.push(`  prompt_append "${escaped}"`);
  }

  // prompt_file — safe paths only
  if (entry["prompt_file"] !== undefined) {
    const promptFileResult = convertLegacyPromptFile(
      entry["prompt_file"],
      `agents.${name}`,
    );
    warnings.push(...promptFileResult.warnings);
    if (promptFileResult.line !== undefined) lines.push(promptFileResult.line);
  }

  // tools → tool_policy
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

  // Warn on unsupported agent override fields
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

  // prompt (inline) — mutually exclusive with prompt_file
  if (typeof entry["prompt"] === "string") {
    const escaped = entry["prompt"].replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    lines.push(`  prompt "${escaped}"`);
  }

  // prompt_file — safe paths only
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

  // model + fallback_models → models [...]
  const modelsResult = convertLegacyModels(entry, `custom_agents.${name}`);
  warnings.push(...modelsResult.warnings);
  if (modelsResult.lines.length > 0) lines.push(...modelsResult.lines);

  // temperature
  if (typeof entry["temperature"] === "number") {
    lines.push(`  temperature ${entry["temperature"]}`);
  }

  // mode — validate against known values
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

  // prompt_append
  if (typeof entry["prompt_append"] === "string") {
    const escaped = entry["prompt_append"].replace(/"/g, '\\"');
    lines.push(`  prompt_append "${escaped}"`);
  }

  // tools → tool_policy
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

  // Warn on unsupported custom agent fields
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

  // description
  if (typeof entry["description"] === "string") {
    const escaped = entry["description"].replace(/"/g, '\\"');
    lines.push(`  description "${escaped}"`);
  }

  // patterns
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

  // model + fallback_models → models [...]
  const modelsResult = convertLegacyModels(entry, `categories.${name}`);
  warnings.push(...modelsResult.warnings);
  if (modelsResult.lines.length > 0) lines.push(...modelsResult.lines);

  // temperature
  if (typeof entry["temperature"] === "number") {
    lines.push(`  temperature ${entry["temperature"]}`);
  }

  // prompt_append
  if (typeof entry["prompt_append"] === "string") {
    const escaped = entry["prompt_append"].replace(/"/g, '\\"');
    lines.push(`  prompt_append "${escaped}"`);
  }

  // tools → tool_policy
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
 * Supported mappings (Task 3 scope):
 * - `disabled_agents`  → `disable agents [...]`
 * - `disabled_hooks`   → `disable hooks [...]`
 * - `disabled_skills`  → `disable skills [...]`
 * - `log_level`        → `settings { log_level <VALUE> }`
 *
 * Explicitly unsupported (warn + skip):
 * - `workflows`, `continuation`, `analytics`, `background`
 */
export function convertLegacyJsonc(source: string): ConversionResult {
  const warnings: ConversionWarning[] = [];
  const dslLines: string[] = [];

  // Parse JSONC — strip comments first, then JSON.parse
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

  // Process each top-level key
  for (const [key, value] of Object.entries(parsed)) {
    // --- Explicitly unsupported fields ---
    if (key in UNSUPPORTED_LEGACY_FIELDS) {
      warnings.push({ field: key, reason: UNSUPPORTED_LEGACY_FIELDS[key]! });
      continue;
    }

    // --- disabled_agents ---
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

    // --- disabled_hooks ---
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

    // --- disabled_skills ---
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

    // --- log_level ---
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

    // --- agents (4.1) — builtin agent overrides only ---
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
        // Only builtin agent names are valid override targets under `agents`.
        // Non-builtin names here are not silently promoted to new agents —
        // new agents must come from `custom_agents` instead.
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

    // --- custom_agents (4.2, 4.3) — new agent blocks with collision detection ---
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
        // 4.3 — warn and skip if name collides with a builtin
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

    // --- categories (4.5) — category blocks (no flattened shuttle agents) ---
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

    // --- Unknown field ---
    warnings.push({
      field: key,
      reason: "unknown legacy field; not supported in migration v1",
    });
  }

  return { dsl: dslLines.join("\n"), warnings };
}

/**
 * Render a warning summary block for skipped legacy fields.
 * Returns an empty string when there are no warnings.
 */
function renderConversionWarnings(warnings: ConversionWarning[]): string {
  if (warnings.length === 0) return "";
  const lines = [
    "",
    "⚠  Migration warnings — the following legacy fields were skipped:",
    "",
  ];
  for (const w of warnings) {
    lines.push(`  • ${w.field}: ${w.reason}`);
  }
  lines.push("");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------

const HARNESS_IDS: SupportedHarnessId[] = ["opencode", "claude-code", "pi"];

export async function runInit(
  ctx: InitContext,
): Promise<Result<number, CliError>> {
  const fs = ctx.fs ?? new BunFileSystem();
  const prompt = ctx.prompt ?? new ClackPromptAdapter();

  // Explicit migrate submode: weave init migrate [--scope ...] [--yes]
  if (ctx.flags.initSubmode === "migrate") {
    return runMigrateMode(ctx, fs, prompt);
  }

  const detected = await detectHarnesses(ctx.probes);
  const harnesses = detected.isOk() ? detected.value : [];
  const planResult = await createPlan({ ctx, fs, prompt, harnesses });

  if (planResult.type === "cancelled") {
    ctx.terminal.stdout("Setup cancelled.");
    return ok(0);
  }

  if (planResult.type === "unavailable") {
    ctx.terminal.stderr(planResult.message);
    return ok(1);
  }

  if (!planResult.plan.confirmed) {
    ctx.terminal.stdout("No changes made.");
    return ok(0);
  }

  const scaffold = await scaffoldConfig(fs, planResult.plan, ctx.flags.force);
  if (scaffold.isErr()) {
    ctx.terminal.stderr(
      `Failed to initialize Weave config: ${scaffold.error.message}`,
    );
    return ok(1);
  }

  const installExit = await installHarnesses({
    ctx,
    fs,
    plan: planResult.plan,
    harnesses,
  });
  ctx.terminal.stdout(renderInitSummary(ctx.theme, scaffold.value, harnesses));
  return ok(installExit);
}

// ---------------------------------------------------------------------------
// Explicit migrate mode
// ---------------------------------------------------------------------------

async function runMigrateMode(
  ctx: InitContext,
  fs: FileSystem,
  prompt: PromptAdapter,
): Promise<Result<number, CliError>> {
  const scope = ctx.flags.scope ?? "local";
  // Build a preliminary plan (skippedWarningCount=0) to get paths for existence checks
  const preliminaryPlan = buildMigrationPlan(scope, fs);

  // Check legacy source exists
  const sourceExists = await fs.exists(preliminaryPlan.sourcePath);
  if (sourceExists.isErr()) {
    ctx.terminal.stderr(
      `Failed to check legacy source: ${describeFileSystemError(sourceExists.error)}`,
    );
    return ok(1);
  }

  if (!sourceExists.value) {
    ctx.terminal.stderr(
      [
        `No legacy config found for scope "${scope}".`,
        `Expected: ${preliminaryPlan.sourcePath}`,
        "",
        "Nothing to migrate.",
      ].join("\n"),
    );
    return ok(1);
  }

  // Read legacy source
  const sourceContent = await fs.readText(preliminaryPlan.sourcePath);
  if (sourceContent.isErr()) {
    ctx.terminal.stderr(
      `Failed to read legacy source: ${describeFileSystemError(sourceContent.error)}`,
    );
    return ok(1);
  }

  // Pre-convert to compute accurate skippedWarningCount for preflight display
  const preConversion = convertLegacyJsonc(sourceContent.value);
  const migrationPlan = buildMigrationPlan(
    scope,
    fs,
    preConversion.warnings.length,
  );

  // Check destination exists
  const destExists = await fs.exists(migrationPlan.destinationPath);
  if (destExists.isErr()) {
    ctx.terminal.stderr(
      `Failed to check destination: ${describeFileSystemError(destExists.error)}`,
    );
    return ok(1);
  }

  // Show preflight summary
  ctx.terminal.stdout(
    renderMigratePreflight(ctx.theme, migrationPlan, destExists.value),
  );

  // Confirm unless --yes
  if (!ctx.flags.yes) {
    if (!prompt.isInteractive()) {
      ctx.terminal.stderr(
        "Interactive mode is unavailable. Re-run with --yes to proceed non-interactively.",
      );
      return ok(1);
    }

    const confirmed = await prompt.confirm({
      message: destExists.value
        ? `Overwrite ${migrationPlan.destinationPath} (backup will be created)?`
        : `Write migrated config to ${migrationPlan.destinationPath}?`,
      initialValue: true,
    });
    if (confirmed.isErr()) {
      ctx.terminal.stdout("Migration cancelled.");
      return ok(0);
    }
    if (!confirmed.value) {
      ctx.terminal.stdout("Migration cancelled.");
      return ok(0);
    }
  }

  // Perform migration write
  const writeResult = await performMigrationWrite(
    fs,
    migrationPlan,
    sourceContent.value,
    destExists.value,
  );
  if (writeResult.isErr()) {
    ctx.terminal.stderr(`Migration failed: ${writeResult.error.message}`);
    return ok(1);
  }

  ctx.terminal.stdout(
    renderMigrateSuccess(ctx.theme, migrationPlan, writeResult.value),
  );

  // Continue into normal harness selection and configuration flow
  const detected = await detectHarnesses(ctx.probes);
  const harnesses = detected.isOk() ? detected.value : [];

  // Non-interactive path: build plan from flags and install
  if (ctx.flags.yes || !prompt.isInteractive()) {
    const initPlan: InitPlan = {
      scope,
      installDir: migrationPlan.destinationDir,
      selectedHarnesses: resolveSelectedHarnesses(ctx.flags, harnesses),
      selectedModules: { opencode: ["agents"] },
      confirmed: true,
    };
    const installExit = await installHarnesses({
      ctx,
      fs,
      plan: initPlan,
      harnesses,
    });
    return ok(installExit);
  }

  // Interactive path: ask for harness selection and confirmation
  const planResult = await continueAfterMigration(
    scope,
    migrationPlan.destinationDir,
    fs,
    prompt,
    harnesses,
  );

  if (planResult.type === "cancelled") {
    ctx.terminal.stdout("Setup cancelled.");
    return ok(0);
  }

  if (planResult.type === "unavailable") {
    ctx.terminal.stderr(planResult.message);
    return ok(1);
  }

  if (!planResult.plan.confirmed) {
    ctx.terminal.stdout("No changes made.");
    return ok(0);
  }

  const installExit = await installHarnesses({
    ctx,
    fs,
    plan: planResult.plan,
    harnesses,
  });
  return ok(installExit);
}

function buildMigrationPlan(
  scope: InitScope,
  fs: FileSystem,
  skippedWarningCount = 0,
): MigrationPlan {
  const scopeRoot = scope === "global" ? fs.home() : fs.cwd();
  const sourcePath = resolve(scopeRoot, LEGACY_SOURCE_RELATIVE[scope]);
  const destinationDir = resolve(scopeRoot, CANONICAL_WEAVE_DIR[scope]);
  const destinationPath = resolve(destinationDir, "config.weave");
  return {
    scope,
    sourcePath,
    destinationDir,
    destinationPath,
    skippedWarningCount,
  };
}

function renderMigratePreflight(
  theme: ThemeColors,
  plan: MigrationPlan,
  destExists: boolean,
): string {
  const overwriteLine = destExists
    ? theme.boldYellow(
        "yes — backup will be created at " + plan.destinationPath + ".bak",
      )
    : "no (destination does not exist)";
  const warningLine =
    plan.skippedWarningCount > 0
      ? theme.boldYellow(
          `${plan.skippedWarningCount} field(s) will be skipped with warnings`,
        )
      : "none";
  const lines = [
    "",
    theme.boldCyan("Migration preflight"),
    "",
    `  Source:        ${plan.sourcePath}`,
    `  Destination:   ${plan.destinationPath}`,
    `  Scope:         ${plan.scope}`,
    `  Overwrite:     ${overwriteLine}`,
    `  Skipped fields: ${warningLine}`,
    "",
  ];
  return lines.join("\n");
}

/**
 * Write pre-built DSL content to the migration destination, with validation
 * before any file mutation.
 *
 * Exported for direct testing of the validation gate: callers can inject
 * arbitrary DSL (including intentionally invalid DSL) to verify that the
 * `parseConfig()` check fires before any destination or backup file is touched.
 *
 * Sequence:
 *   1. Validate `dslContent` through `parseConfig()` — abort with `errAsync` if invalid.
 *   2. If `destExists`, copy destination → `<destination>.bak`.
 *   3. `mkdir` the destination directory.
 *   4. Write `dslContent` to the destination path.
 *
 * On any failure the function returns `errAsync` and leaves the filesystem in
 * whatever state it was before the failing step (backup copy is atomic at the
 * MemoryFileSystem level; real FS callers should treat this as best-effort).
 */
export function writeMigratedDsl(
  fs: FileSystem,
  plan: MigrationPlan,
  dslContent: string,
  destExists: boolean,
): ResultAsync<{ backedUp: boolean }, { message: string }> {
  // Validate generated DSL through the normal parse/validation pipeline
  // before mutating any files. Abort if validation fails — leaves both
  // destination and backup untouched.
  const validationResult = parseConfig(dslContent);
  if (validationResult.isErr()) {
    const errorSummary = validationResult.error
      .map((e) => ("message" in e ? e.message : JSON.stringify(e)))
      .join("; ");
    return errAsync({
      message: `Generated DSL failed validation: ${errorSummary}`,
    });
  }

  const backup = destExists
    ? fs.copyFile(plan.destinationPath, `${plan.destinationPath}.bak`)
    : ResultAsync.fromSafePromise(Promise.resolve());

  return backup
    .mapErr((error) => ({ message: describeFileSystemError(error) }))
    .andThen(() =>
      fs
        .mkdir(plan.destinationDir)
        .mapErr((error) => ({ message: describeFileSystemError(error) })),
    )
    .andThen(() =>
      fs
        .writeText(plan.destinationPath, dslContent)
        .mapErr((error) => ({ message: describeFileSystemError(error) })),
    )
    .map(() => ({ backedUp: destExists }));
}

function performMigrationWrite(
  fs: FileSystem,
  plan: MigrationPlan,
  sourceContent: string,
  destExists: boolean,
): ResultAsync<
  { backedUp: boolean; warnings: ConversionWarning[] },
  { message: string }
> {
  // Convert legacy JSONC to DSL (best-effort partial success)
  const conversion = convertLegacyJsonc(sourceContent);
  // Generate migrated DSL content with provenance comment
  const migratedContent = buildMigratedContent(plan, conversion);
  return writeMigratedDsl(fs, plan, migratedContent, destExists).map(
    (result) => ({ ...result, warnings: conversion.warnings }),
  );
}

/**
 * Build migrated config.weave content with a provenance comment.
 * Incorporates converted DSL from the JSONC conversion result.
 * Falls back to starter config body when conversion produces no DSL.
 */
function buildMigratedContent(
  plan: MigrationPlan,
  conversion: ConversionResult,
): string {
  const provenanceComment = [
    `# Migrated from legacy OpenCode JSONC config`,
    `# Source: ${plan.sourcePath}`,
    `# Scope: ${plan.scope}`,
    `# Generated by: weave init migrate`,
    "",
  ].join("\n");

  // If conversion produced DSL content, use it; otherwise fall back to starter config
  const body =
    conversion.dsl.trim().length > 0
      ? conversion.dsl + "\n"
      : starterConfig(plan.scope);

  return provenanceComment + body;
}

function renderMigrateSuccess(
  theme: ThemeColors,
  plan: MigrationPlan,
  result: { backedUp: boolean; warnings?: ConversionWarning[] },
): string {
  const lines = [
    theme.boldCyan("Migration complete"),
    `  Written: ${plan.destinationPath}`,
  ];
  if (result.backedUp) {
    lines.push(`  Backup:  ${plan.destinationPath}.bak`);
  }
  lines.push(`  Source preserved: ${plan.sourcePath}`);
  lines.push("");
  lines.push("Next steps:");
  lines.push(`  - Review ${plan.destinationPath}`);
  lines.push("  - Run weave validate --project or weave validate --global");
  // Append warning summary if any fields were skipped
  if (result.warnings !== undefined && result.warnings.length > 0) {
    lines.push(renderConversionWarnings(result.warnings));
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Ordinary init — scope-aware legacy source detection
// ---------------------------------------------------------------------------

/**
 * Check whether a legacy weave-opencode.jsonc file exists for the given scope.
 * Returns the source path when found, undefined when absent, or an error when
 * the existence check itself fails (e.g. permission denied). Callers must
 * handle the error case and stop the migration flow rather than proceeding as
 * if the source were absent.
 */
async function detectLegacySource(
  scope: InitScope,
  fs: FileSystem,
): Promise<
  { ok: true; path: string | undefined } | { ok: false; message: string }
> {
  const scopeRoot = scope === "global" ? fs.home() : fs.cwd();
  const sourcePath = resolve(scopeRoot, LEGACY_SOURCE_RELATIVE[scope]);
  const exists = await fs.exists(sourcePath);
  if (exists.isErr()) {
    return {
      ok: false,
      message: `Failed to check legacy source at ${sourcePath}: ${describeFileSystemError(exists.error)}`,
    };
  }
  if (!exists.value) return { ok: true, path: undefined };
  return { ok: true, path: sourcePath };
}

// ---------------------------------------------------------------------------
// Ordinary init plan
// ---------------------------------------------------------------------------

async function createPlan(input: {
  ctx: InitContext;
  fs: FileSystem;
  prompt: PromptAdapter;
  harnesses: DetectedHarness[];
}): Promise<
  | { type: "ready"; plan: InitPlan }
  | { type: "cancelled" }
  | { type: "unavailable"; message: string }
> {
  const { ctx, fs, prompt, harnesses } = input;

  // Resolve scope: from flag or interactively
  let scope: InitScope;
  if (ctx.flags.scope !== undefined) {
    scope = ctx.flags.scope;
  } else if (
    ctx.flags.yes ||
    ctx.flags.installDir ||
    ctx.flags.harness ||
    ctx.flags.allHarnesses
  ) {
    // Non-interactive decisive flags without explicit scope — use default
    scope = "local";
  } else {
    // Need interactive scope selection
    if (!prompt.isInteractive()) {
      return {
        type: "unavailable",
        message:
          "Interactive mode is unavailable. Re-run with --yes and --scope global|local.",
      };
    }

    ctx.terminal.stdout(
      defaultThemeRenderer.renderBanner(ctx.theme).join("\n"),
    );
    ctx.terminal.stdout(`Weave CLI v${defaultThemeRenderer.renderVersion()}`);
    ctx.terminal.stdout(
      "Choose global config for shared defaults or local config for this project.",
    );

    const scopeResult = await prompt.select<InitScope>({
      message: "Where should Weave create config?",
      options: [
        {
          value: "global",
          label: "Global ~/.weave",
          hint: "shared across projects",
        },
        {
          value: "local",
          label: "Local ./.weave",
          hint: "this repository only",
        },
      ],
      initialValue: "local",
    });
    if (scopeResult.isErr()) return promptFailure(scopeResult.error.message);
    scope = scopeResult.value;
  }

  // After scope resolution, before harness selection: check for legacy source
  const legacySourceResult = await detectLegacySource(scope, fs);
  if (!legacySourceResult.ok) {
    ctx.terminal.stderr(legacySourceResult.message);
    return { type: "cancelled" };
  }
  const legacySourcePath = legacySourceResult.path;
  if (legacySourcePath !== undefined) {
    // --yes: auto-migrate without prompting
    if (ctx.flags.yes) {
      const migrationPlan = buildMigrationPlan(scope, fs);
      const sourceContent = await fs.readText(legacySourcePath);
      if (sourceContent.isErr()) {
        ctx.terminal.stderr(
          `Failed to read legacy source: ${describeFileSystemError(sourceContent.error)}`,
        );
        return { type: "cancelled" };
      }

      const destExists = await fs.exists(migrationPlan.destinationPath);
      if (destExists.isErr()) {
        ctx.terminal.stderr(
          `Failed to check destination: ${describeFileSystemError(destExists.error)}`,
        );
        return { type: "cancelled" };
      }

      const writeResult = await performMigrationWrite(
        fs,
        migrationPlan,
        sourceContent.value,
        destExists.value,
      );
      if (writeResult.isErr()) {
        ctx.terminal.stderr(`Migration failed: ${writeResult.error.message}`);
        return { type: "cancelled" };
      }

      ctx.terminal.stdout(
        renderMigrateSuccess(ctx.theme, migrationPlan, writeResult.value),
      );

      // --yes: non-interactive post-migration — build plan from flags
      return {
        type: "ready",
        plan: {
          scope,
          installDir: migrationPlan.destinationDir,
          selectedHarnesses: resolveSelectedHarnesses(ctx.flags, harnesses),
          selectedModules: { opencode: ["agents"] },
          confirmed: true,
        },
      };
    }

    // Interactive: offer migration
    if (prompt.isInteractive()) {
      const offerMigrate = await prompt.confirm({
        message: `Legacy config found at ${legacySourcePath}. Migrate to .weave DSL now?`,
        initialValue: true,
      });
      if (offerMigrate.isErr())
        return promptFailure(offerMigrate.error.message);

      if (offerMigrate.value) {
        const migrationPlan = buildMigrationPlan(scope, fs);
        const sourceContent = await fs.readText(legacySourcePath);
        if (sourceContent.isErr()) {
          ctx.terminal.stderr(
            `Failed to read legacy source: ${describeFileSystemError(sourceContent.error)}`,
          );
          return { type: "cancelled" };
        }

        const destExists = await fs.exists(migrationPlan.destinationPath);
        if (destExists.isErr()) {
          ctx.terminal.stderr(
            `Failed to check destination: ${describeFileSystemError(destExists.error)}`,
          );
          return { type: "cancelled" };
        }

        const writeResult = await performMigrationWrite(
          fs,
          migrationPlan,
          sourceContent.value,
          destExists.value,
        );
        if (writeResult.isErr()) {
          ctx.terminal.stderr(`Migration failed: ${writeResult.error.message}`);
          return { type: "cancelled" };
        }

        ctx.terminal.stdout(
          renderMigrateSuccess(ctx.theme, migrationPlan, writeResult.value),
        );

        // Continue into harness selection with the canonical destination as installDir
        return continueAfterMigration(
          scope,
          migrationPlan.destinationDir,
          fs,
          prompt,
          harnesses,
        );
      }
    }
  }

  // No migration (or migration declined): proceed with normal init
  // If decisive flags are set (other than scope alone), build plan from flags
  const decisiveNonScope = Boolean(
    ctx.flags.yes ||
      ctx.flags.installDir ||
      ctx.flags.harness ||
      ctx.flags.allHarnesses,
  );

  if (decisiveNonScope || ctx.flags.scope !== undefined) {
    return {
      type: "ready",
      plan: buildFlagPlan(ctx.flags, fs, harnesses, scope),
    };
  }

  // Fully interactive path: ask for install dir, harnesses, confirmation
  const defaultDir = defaultInstallDir(scope, fs);
  const installDir = await prompt.text({
    message: "Install directory",
    defaultValue: defaultDir,
    placeholder: defaultDir,
  });
  if (installDir.isErr()) return promptFailure(installDir.error.message);

  const harnessOptions = harnesses.map((harness) => ({
    value: harness.id,
    label: harness.id,
    hint: harness.version,
  }));
  const selectedHarnesses = await prompt.multiselect<SupportedHarnessId>({
    message: "Select harnesses to configure",
    options: harnessOptions,
    initialValues: harnessOptions.map((option) => option.value),
    required: false,
  });
  if (selectedHarnesses.isErr())
    return promptFailure(selectedHarnesses.error.message);

  const confirmed = await prompt.confirm({
    message: `Create ${installDir.value}/config.weave and configure selected harnesses?`,
    initialValue: true,
  });
  if (confirmed.isErr()) return promptFailure(confirmed.error.message);

  return {
    type: "ready",
    plan: {
      scope,
      installDir: fs.resolvePath(installDir.value),
      selectedHarnesses: selectedHarnesses.value,
      selectedModules: { opencode: ["agents"] },
      confirmed: confirmed.value,
    },
  };
}

/**
 * After a successful migration write in ordinary init, continue into
 * harness selection using the canonical destination directory.
 */
async function continueAfterMigration(
  scope: InitScope,
  installDir: string,
  fs: FileSystem,
  prompt: PromptAdapter,
  harnesses: DetectedHarness[],
): Promise<
  | { type: "ready"; plan: InitPlan }
  | { type: "cancelled" }
  | { type: "unavailable"; message: string }
> {
  const harnessOptions = harnesses.map((harness) => ({
    value: harness.id,
    label: harness.id,
    hint: harness.version,
  }));
  const selectedHarnesses = await prompt.multiselect<SupportedHarnessId>({
    message: "Select harnesses to configure",
    options: harnessOptions,
    initialValues: harnessOptions.map((option) => option.value),
    required: false,
  });
  if (selectedHarnesses.isErr())
    return promptFailure(selectedHarnesses.error.message);

  const confirmed = await prompt.confirm({
    message: `Configure selected harnesses with migrated config at ${installDir}?`,
    initialValue: true,
  });
  if (confirmed.isErr()) return promptFailure(confirmed.error.message);

  return {
    type: "ready",
    plan: {
      scope,
      installDir: fs.resolvePath(installDir),
      selectedHarnesses: selectedHarnesses.value,
      selectedModules: { opencode: ["agents"] },
      confirmed: confirmed.value,
    },
  };
}

function promptFailure(
  message: string,
): { type: "cancelled" } | { type: "unavailable"; message: string } {
  if (message.includes("unavailable")) return { type: "unavailable", message };
  return { type: "cancelled" };
}

function buildFlagPlan(
  flags: ParsedArgs["flags"],
  fs: FileSystem,
  harnesses: DetectedHarness[],
  resolvedScope?: InitScope,
): InitPlan {
  const scope = resolvedScope ?? flags.scope ?? "local";
  const selectedHarnesses = resolveSelectedHarnesses(flags, harnesses);
  return {
    scope,
    installDir: fs.resolvePath(
      flags.installDir ?? defaultInstallDir(scope, fs),
    ),
    selectedHarnesses,
    selectedModules: { opencode: ["agents"] },
    confirmed:
      flags.yes ||
      flags.scope !== undefined ||
      flags.installDir !== undefined ||
      flags.harness !== undefined ||
      flags.allHarnesses,
  };
}

function resolveSelectedHarnesses(
  flags: ParsedArgs["flags"],
  harnesses: DetectedHarness[],
): SupportedHarnessId[] {
  if (flags.harness !== undefined && isHarnessId(flags.harness))
    return [flags.harness];
  if (flags.allHarnesses) return harnesses.map((harness) => harness.id);
  return [];
}

function isHarnessId(value: string): value is SupportedHarnessId {
  return HARNESS_IDS.includes(value as SupportedHarnessId);
}

function defaultInstallDir(scope: InitScope, fs: FileSystem): string {
  if (scope === "global") return resolve(fs.home(), ".weave");
  return resolve(fs.cwd(), ".weave");
}

function scaffoldConfig(
  fs: FileSystem,
  plan: InitPlan,
  force: boolean,
): ResultAsync<ScaffoldResult, { message: string }> {
  const configPath = resolve(plan.installDir, "config.weave");
  const promptsPath = resolve(plan.installDir, "prompts");

  return fs
    .exists(configPath)
    .mapErr((error) => ({ message: describeFileSystemError(error) }))
    .andThen((exists) => {
      const messages: string[] = [];
      if (exists && !force) {
        messages.push(`Skipped existing config: ${configPath}`);
        return fs
          .mkdir(promptsPath)
          .mapErr((error) => ({ message: describeFileSystemError(error) }))
          .map(() => ({
            configPath,
            promptsPath,
            messages,
          }));
      }

      const backup = exists
        ? fs.copyFile(configPath, `${configPath}.bak`)
        : ResultAsync.fromSafePromise(Promise.resolve());
      return backup
        .mapErr((error) => ({ message: describeFileSystemError(error) }))
        .andThen(() =>
          fs
            .writeText(configPath, starterConfig(plan.scope))
            .mapErr((error) => ({ message: describeFileSystemError(error) })),
        )
        .andThen(() =>
          fs
            .mkdir(promptsPath)
            .mapErr((error) => ({ message: describeFileSystemError(error) })),
        )
        .map(() => {
          if (exists)
            messages.push(`Backed up existing config: ${configPath}.bak`);
          messages.push(`Created config: ${configPath}`);
          messages.push(`Created prompts directory: ${promptsPath}`);
          return { configPath, promptsPath, messages };
        });
    });
}

async function installHarnesses(input: {
  ctx: InitContext;
  fs: FileSystem;
  plan: InitPlan;
  harnesses: DetectedHarness[];
}): Promise<number> {
  const { ctx, fs, plan, harnesses } = input;
  if (plan.selectedHarnesses.length === 0) return 0;

  const registry = installerRegistry(fs);
  let exitCode = 0;

  for (const harnessId of plan.selectedHarnesses) {
    const installer = registry[harnessId];
    const detected = harnesses.find((harness) => harness.id === harnessId);
    if (detected === undefined) {
      ctx.terminal.stderr(`${harnessId} was requested but was not detected.`);
      exitCode = 1;
      continue;
    }
    if (!installer.supported) {
      const message = `${harnessId} installer support is not available yet.`;
      if (ctx.flags.allHarnesses && ctx.flags.harness === undefined) {
        ctx.terminal.stdout(`Skipped ${harnessId}: ${message}`);
        continue;
      }
      ctx.terminal.stderr(message);
      exitCode = 1;
      continue;
    }

    const result = await installer.install({
      harness: harnessId,
      configPath: detected.configPath,
      selectedModules: plan.selectedModules[harnessId] ?? [],
      force: ctx.flags.force,
    });
    if (result.isErr()) {
      ctx.terminal.stderr(formatInstallError(result.error));
      exitCode = 1;
      continue;
    }
    ctx.terminal.stdout(result.value.messages.join("\n"));
  }

  return exitCode;
}

function formatInstallError(error: {
  type: string;
  message?: string;
  path?: string;
  cause?: unknown;
}): string {
  if (error.message !== undefined) return error.message;
  if (error.path !== undefined) return `Install failed at ${error.path}`;
  return "Install failed.";
}

function renderInitSummary(
  theme: ThemeColors,
  scaffold: ScaffoldResult,
  harnesses: DetectedHarness[],
): string {
  return [
    theme.boldCyan("Weave init complete"),
    ...scaffold.messages,
    "",
    "Detected harnesses:",
    ...formatDetectionSummary(harnesses).map((line) => `- ${line}`),
    "",
    "Next steps:",
    `- Edit ${scaffold.configPath}`,
    "- Run weave validate --project or weave validate --global",
  ].join("\n");
}
