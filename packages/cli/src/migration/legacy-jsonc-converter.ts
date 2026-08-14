/**
 * Legacy JSONC-to-DSL conversion.
 *
 * Converts a legacy weave-opencode.jsonc source string into current `.weave` DSL.
 * This is a best-effort partial conversion: supported fields are converted,
 * unsupported fields are skipped with explicit sanitized warnings.
 */

import { parseConfig, parseModelIntentEntry } from "@weaveio/weave-core";
import { type ParseError, parse as parseJsonc } from "jsonc-parser";
import { Result } from "neverthrow";
import {
  boundWarning,
  CONVERSION_REASON,
  joinPath,
  PATH_DSL,
  PATH_SOURCE,
  pushWarning,
  reasonWithType,
} from "./legacy-conversion-diagnostics.js";
import {
  classifyDslName,
  isDangerousDslName,
} from "./legacy-dsl-identifiers.js";
import {
  copyLegacyGraph,
  LEGACY_GRAPH_TOO_LARGE_MESSAGE,
  type LegacyGraphCopyError,
  UNSAFE_LEGACY_GRAPH_MESSAGE,
} from "./legacy-graph-copy.js";
import { inspectLegacyJsonc } from "./legacy-jsonc-inspect.js";
import type { ConversionResult, ConversionWarning } from "./types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Legacy top-level fields that are explicitly unsupported in migration v1.
 * Lookups use Map so untrusted keys cannot hit Object.prototype.
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

type ToolCapability = "read" | "write" | "execute" | "delegate" | "network";
type ToolPermission = "allow" | "deny";

/**
 * Mapping from clearly known legacy OpenCode tool names to current abstract
 * `tool_policy` capability buckets.
 */
const LEGACY_TOOL_TO_CAPABILITY = new Map<string, ToolCapability>([
  ["read", "read"],
  ["write", "write"],
  ["edit", "write"],
  ["bash", "execute"],
  ["task", "delegate"],
  ["web_search", "network"],
  ["web_fetch", "network"],
]);

/**
 * Legacy tool names that are ambiguous or harness-specific and cannot be
 * mapped to a current abstract capability bucket.
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

const VALID_MODES = new Set(["primary", "subagent", "all"]);

const MIN_TEMPERATURE = 0;
const MAX_TEMPERATURE = 2;

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

type PathParts = Array<string | number>;

// ---------------------------------------------------------------------------
// JSONC parsing
// ---------------------------------------------------------------------------

const parseJsoncSource = Result.fromThrowable(
  (source: string): unknown => {
    const errors: ParseError[] = [];
    const result = parseJsonc(source, errors, {
      allowTrailingComma: true,
      disallowComments: false,
      allowEmptyContent: false,
    });
    if (errors.length > 0) return undefined;
    return result;
  },
  (): undefined => undefined,
);

/**
 * Parse legacy JSONC with comments and trailing commas.
 * Returns `undefined` when parsing fails.
 */
function parseLegacyJsonc(source: string): unknown {
  const parsed = parseJsoncSource(source);
  if (parsed.isErr()) return undefined;
  return parsed.value;
}

/**
 * Escapes a string value for safe embedding in a `.weave` DSL double-quoted
 * string literal.
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

function graphCopyWarning(error: LegacyGraphCopyError): ConversionWarning {
  return boundWarning({
    field: PATH_SOURCE,
    reason:
      error.type === "GraphTooLarge"
        ? LEGACY_GRAPH_TOO_LARGE_MESSAGE
        : UNSAFE_LEGACY_GRAPH_MESSAGE,
  });
}

function parseFailedResult(): ConversionResult {
  const warnings: ConversionWarning[] = [];
  pushWarning(warnings, PATH_SOURCE, CONVERSION_REASON.parseFailed);
  return { dsl: "", warnings };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(record, key);
}

function isValidTemperature(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= MIN_TEMPERATURE &&
    value <= MAX_TEMPERATURE
  );
}

function formatTriggerList(triggers: string[]): string {
  return `  triggers [${triggers.map((trigger) => JSON.stringify(trigger)).join(", ")}]`;
}

function warnRejectedFastAliases(
  entry: Record<string, unknown>,
  context: PathParts,
  warnings: ConversionWarning[],
): void {
  for (const alias of REJECTED_FAST_ALIASES) {
    if (hasOwn(entry, alias)) {
      pushWarning(
        warnings,
        joinPath([...context, alias]),
        CONVERSION_REASON.fastAlias,
      );
    }
  }
}

function warnUnusableKey(
  key: string,
  parentPath: PathParts,
  warnings: ConversionWarning[],
): boolean {
  if (!isDangerousDslName(key)) return false;
  pushWarning(
    warnings,
    joinPath([...parentPath, key]),
    CONVERSION_REASON.dangerousKey,
  );
  return true;
}

function warnUnusableName(
  name: string,
  parentPath: PathParts,
  warnings: ConversionWarning[],
): boolean {
  const classification = classifyDslName(name);
  if (classification === "ok") return false;
  pushWarning(
    warnings,
    joinPath([...parentPath, name]),
    classification === "dangerous"
      ? CONVERSION_REASON.dangerousName
      : CONVERSION_REASON.invalidIdentifier,
  );
  return true;
}

function appendValidatedBlock(
  dslLines: string[],
  blockLines: string[],
  warnings: ConversionWarning[],
  path: string,
): void {
  if (blockLines.length === 0) return;
  const block = blockLines.join("\n");
  const validated = parseConfig(block);
  if (validated.isErr()) {
    pushWarning(warnings, path, CONVERSION_REASON.omittedInvalid);
    return;
  }
  dslLines.push(block);
}

function finalizeConversion(
  dslLines: string[],
  warnings: ConversionWarning[],
): ConversionResult {
  const dsl = dslLines.join("\n");
  if (dsl.trim().length === 0) return { dsl: "", warnings };
  const validated = parseConfig(dsl);
  if (validated.isOk()) return { dsl, warnings };
  pushWarning(warnings, PATH_DSL, CONVERSION_REASON.omittedInvalid);
  return { dsl: "", warnings };
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
  fieldPath: PathParts,
  warnings: ConversionWarning[],
): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    pushWarning(
      warnings,
      joinPath(fieldPath),
      reasonWithType(CONVERSION_REASON.expectedTriggerArray, value),
    );
    return undefined;
  }

  const selected: string[] = [];
  const seen = new Set<string>();

  for (let index = 0; index < value.length; index += 1) {
    const entryPath: PathParts = [...fieldPath, index];
    const entry = value[index];

    if (typeof entry === "string") {
      if (entry.trim().length === 0) {
        pushWarning(
          warnings,
          joinPath(entryPath),
          CONVERSION_REASON.emptyTrigger,
        );
        continue;
      }
      if (!seen.has(entry)) {
        seen.add(entry);
        selected.push(entry);
      }
      continue;
    }

    if (!isPlainRecord(entry)) {
      pushWarning(
        warnings,
        joinPath(entryPath),
        reasonWithType(CONVERSION_REASON.malformedTrigger, entry),
      );
      continue;
    }

    const routingHint = hasOwn(entry, "routing_hint")
      ? entry.routing_hint
      : undefined;
    const trigger = hasOwn(entry, "trigger") ? entry.trigger : undefined;
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
      if (warnUnusableKey(key, entryPath, warnings)) continue;
      pushWarning(
        warnings,
        joinPath([...entryPath, key]),
        reasonWithType(CONVERSION_REASON.discardedStructuredField, entry[key]),
      );
    }

    if (chosen === undefined) {
      pushWarning(
        warnings,
        joinPath(entryPath),
        CONVERSION_REASON.malformedTrigger,
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
  fieldPath: PathParts,
  warnings: ConversionWarning[],
): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    pushWarning(
      warnings,
      joinPath(fieldPath),
      reasonWithType(CONVERSION_REASON.patternsMalformed, value),
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
      joinPath([...fieldPath, index]),
      reasonWithType(CONVERSION_REASON.patternMalformed, pattern),
    );
  }

  if (validCount > 0) {
    pushWarning(
      warnings,
      joinPath(fieldPath),
      CONVERSION_REASON.patternsDropped,
    );
  } else if (value.length === 0) {
    pushWarning(warnings, joinPath(fieldPath), CONVERSION_REASON.patternsEmpty);
  }
}

// ---------------------------------------------------------------------------
// Prompt file safety check
// ---------------------------------------------------------------------------

/**
 * Filename-only pattern: a safe prompt_file reference is a bare filename
 * (no directory separators) that can be placed directly in `.weave/prompts/`.
 */
function isPromptFileSafe(promptFile: string): boolean {
  if (promptFile.length === 0) return false;
  if (promptFile.includes("/") || promptFile.includes("\\")) return false;
  if (promptFile.startsWith("..")) return false;
  return true;
}

function convertTemperature(
  entry: Record<string, unknown>,
  context: PathParts,
  warnings: ConversionWarning[],
  lines: string[],
): void {
  if (!hasOwn(entry, "temperature")) return;
  const value = entry.temperature;
  if (isValidTemperature(value)) {
    lines.push(`  temperature ${value}`);
    return;
  }
  pushWarning(
    warnings,
    joinPath([...context, "temperature"]),
    reasonWithType(CONVERSION_REASON.invalidTemperature, value),
  );
}

// ---------------------------------------------------------------------------
// Field conversion helpers
// ---------------------------------------------------------------------------

/**
 * Convert a legacy `tools` record into a `tool_policy { ... }` DSL block.
 */
function convertLegacyTools(
  tools: Record<string, unknown>,
  context: PathParts,
  warnings: ConversionWarning[],
): string[] {
  const capabilities = Object.create(null) as Record<
    ToolCapability,
    ToolPermission
  >;

  for (const toolName of Object.keys(tools)) {
    const toolPath = joinPath([...context, "tools", toolName]);
    if (warnUnusableKey(toolName, [...context, "tools"], warnings)) {
      continue;
    }
    if (AMBIGUOUS_LEGACY_TOOLS.has(toolName)) {
      pushWarning(warnings, toolPath, CONVERSION_REASON.toolAmbiguous);
      continue;
    }
    const allowed = tools[toolName];
    if (typeof allowed !== "boolean") {
      pushWarning(
        warnings,
        toolPath,
        reasonWithType(CONVERSION_REASON.toolNotBoolean, allowed),
      );
      continue;
    }
    const capability = LEGACY_TOOL_TO_CAPABILITY.get(toolName);
    if (capability === undefined) {
      pushWarning(warnings, toolPath, CONVERSION_REASON.toolUnknown);
      continue;
    }
    capabilities[capability] = allowed ? "allow" : "deny";
  }

  const capEntries = Object.entries(capabilities) as Array<
    [ToolCapability, ToolPermission]
  >;
  if (capEntries.length === 0) return [];

  const lines = ["  tool_policy {"];
  for (const [cap, perm] of capEntries) {
    lines.push(`    ${cap} ${perm}`);
  }
  lines.push("  }");
  return lines;
}

/**
 * Convert legacy `model` + optional `fallback_models` into an ordered
 * `models [...]` array with the primary model first.
 */
function convertLegacyModels(
  entry: Record<string, unknown>,
  context: PathParts,
  warnings: ConversionWarning[],
): string[] {
  const models: string[] = [];

  if (hasOwn(entry, "model")) {
    const model = entry.model;
    if (typeof model !== "string") {
      pushWarning(
        warnings,
        joinPath([...context, "model"]),
        reasonWithType(CONVERSION_REASON.expectedStringModel, model),
      );
    } else {
      const intent = parseModelIntentEntry(model);
      if (intent.isErr()) {
        pushWarning(
          warnings,
          joinPath([...context, "model"]),
          CONVERSION_REASON.invalidModel,
        );
      } else {
        models.push(model);
      }
    }
  }

  if (hasOwn(entry, "fallback_models")) {
    const fallback = entry.fallback_models;
    if (!Array.isArray(fallback)) {
      pushWarning(
        warnings,
        joinPath([...context, "fallback_models"]),
        reasonWithType(CONVERSION_REASON.expectedArrayModels, fallback),
      );
    } else {
      for (let index = 0; index < fallback.length; index += 1) {
        const item = fallback[index];
        const itemPath = joinPath([...context, "fallback_models", index]);
        if (typeof item !== "string") {
          pushWarning(
            warnings,
            itemPath,
            reasonWithType(CONVERSION_REASON.expectedStringModel, item),
          );
          continue;
        }
        const intent = parseModelIntentEntry(item);
        if (intent.isErr()) {
          pushWarning(warnings, itemPath, CONVERSION_REASON.invalidModel);
          continue;
        }
        models.push(item);
      }
    }
  }

  if (models.length === 0) return [];

  const items = models.map((model) => JSON.stringify(model)).join(", ");
  return [`  models [${items}]`];
}

/**
 * Convert a legacy `prompt_file` value into a DSL `prompt_file "..."` line.
 */
function convertLegacyPromptFile(
  value: unknown,
  context: PathParts,
  warnings: ConversionWarning[],
): string | undefined {
  if (typeof value !== "string") {
    pushWarning(
      warnings,
      joinPath([...context, "prompt_file"]),
      reasonWithType(CONVERSION_REASON.expectedStringPath, value),
    );
    return undefined;
  }

  if (!isPromptFileSafe(value)) {
    pushWarning(
      warnings,
      joinPath([...context, "prompt_file"]),
      CONVERSION_REASON.promptFileUnsafe,
    );
    return undefined;
  }

  return `  prompt_file "${escapeForDsl(value)}"`;
}

function convertUnsupportedFields(
  entry: Record<string, unknown>,
  context: PathParts,
  fields: readonly string[],
  warnings: ConversionWarning[],
): void {
  const kind =
    context[0] === "custom_agents" ? "custom agent" : "agent override";
  for (const field of fields) {
    if (hasOwn(entry, field)) {
      pushWarning(
        warnings,
        joinPath([...context, field]),
        `"${field}" is not supported in ${kind} migration v1; skipped`,
      );
    }
  }
}

/**
 * Convert a legacy agent override entry into DSL lines for an `agent <name>` block.
 */
function convertLegacyAgentEntry(
  name: string,
  entry: Record<string, unknown>,
  warnings: ConversionWarning[],
): string[] {
  const context: PathParts = ["agents", name];
  const lines: string[] = [`agent ${name} {`];

  const modelLines = convertLegacyModels(entry, context, warnings);
  if (modelLines.length > 0) lines.push(...modelLines);

  convertTemperature(entry, context, warnings, lines);

  if (
    hasOwn(entry, "prompt_append") &&
    typeof entry.prompt_append === "string"
  ) {
    lines.push(`  prompt_append "${escapeForDsl(entry.prompt_append)}"`);
  } else if (hasOwn(entry, "prompt_append")) {
    pushWarning(
      warnings,
      joinPath([...context, "prompt_append"]),
      reasonWithType(CONVERSION_REASON.expectedString, entry.prompt_append),
    );
  }

  if (hasOwn(entry, "prompt_file")) {
    const promptFileLine = convertLegacyPromptFile(
      entry.prompt_file,
      context,
      warnings,
    );
    if (promptFileLine !== undefined) lines.push(promptFileLine);
  }

  if (hasOwn(entry, "tools")) {
    if (isPlainRecord(entry.tools)) {
      const toolLines = convertLegacyTools(entry.tools, context, warnings);
      if (toolLines.length > 0) lines.push(...toolLines);
    } else {
      pushWarning(
        warnings,
        joinPath([...context, "tools"]),
        reasonWithType(CONVERSION_REASON.expectedObject, entry.tools),
      );
    }
  }

  const triggers = convertLegacyTriggers(
    hasOwn(entry, "triggers") ? entry.triggers : undefined,
    [...context, "triggers"],
    warnings,
  );
  if (triggers !== undefined) lines.push(formatTriggerList(triggers));

  warnRejectedFastAliases(entry, context, warnings);
  convertUnsupportedFields(
    entry,
    context,
    ["display_name", "skills", "mode"],
    warnings,
  );

  lines.push("}");
  return lines;
}

/**
 * Convert a legacy custom agent entry into a new `agent <name>` block.
 */
function convertLegacyCustomAgent(
  name: string,
  entry: Record<string, unknown>,
  warnings: ConversionWarning[],
): string[] {
  const context: PathParts = ["custom_agents", name];
  const lines: string[] = [`agent ${name} {`];

  if (hasOwn(entry, "prompt") && typeof entry.prompt === "string") {
    lines.push(`  prompt "${escapeForDsl(entry.prompt)}"`);
  } else if (hasOwn(entry, "prompt")) {
    pushWarning(
      warnings,
      joinPath([...context, "prompt"]),
      reasonWithType(CONVERSION_REASON.expectedString, entry.prompt),
    );
  }

  if (hasOwn(entry, "prompt_file") && !hasOwn(entry, "prompt")) {
    const promptFileLine = convertLegacyPromptFile(
      entry.prompt_file,
      context,
      warnings,
    );
    if (promptFileLine !== undefined) lines.push(promptFileLine);
  } else if (hasOwn(entry, "prompt_file") && hasOwn(entry, "prompt")) {
    pushWarning(
      warnings,
      joinPath([...context, "prompt_file"]),
      CONVERSION_REASON.promptFileSkipped,
    );
  }

  const modelLines = convertLegacyModels(entry, context, warnings);
  if (modelLines.length > 0) lines.push(...modelLines);

  convertTemperature(entry, context, warnings, lines);

  if (hasOwn(entry, "mode")) {
    const mode = entry.mode;
    if (typeof mode === "string" && VALID_MODES.has(mode)) {
      lines.push(`  mode ${mode}`);
    } else {
      pushWarning(
        warnings,
        joinPath([...context, "mode"]),
        reasonWithType(CONVERSION_REASON.invalidMode, mode),
      );
    }
  }

  if (
    hasOwn(entry, "prompt_append") &&
    typeof entry.prompt_append === "string"
  ) {
    lines.push(`  prompt_append "${escapeForDsl(entry.prompt_append)}"`);
  } else if (hasOwn(entry, "prompt_append")) {
    pushWarning(
      warnings,
      joinPath([...context, "prompt_append"]),
      reasonWithType(CONVERSION_REASON.expectedString, entry.prompt_append),
    );
  }

  if (hasOwn(entry, "tools")) {
    if (isPlainRecord(entry.tools)) {
      const toolLines = convertLegacyTools(entry.tools, context, warnings);
      if (toolLines.length > 0) lines.push(...toolLines);
    } else {
      pushWarning(
        warnings,
        joinPath([...context, "tools"]),
        reasonWithType(CONVERSION_REASON.expectedObject, entry.tools),
      );
    }
  }

  const triggers = convertLegacyTriggers(
    hasOwn(entry, "triggers") ? entry.triggers : undefined,
    [...context, "triggers"],
    warnings,
  );
  if (triggers !== undefined) lines.push(formatTriggerList(triggers));

  warnRejectedFastAliases(entry, context, warnings);
  convertUnsupportedFields(
    entry,
    context,
    ["skills", "display_name"],
    warnings,
  );

  lines.push("}");
  return lines;
}

/**
 * Convert a legacy category entry into a `category <name>` block.
 */
function convertLegacyCategory(
  name: string,
  entry: Record<string, unknown>,
  warnings: ConversionWarning[],
): string[] {
  const context: PathParts = ["categories", name];
  convertLegacyPatternField(
    hasOwn(entry, "patterns") ? entry.patterns : undefined,
    [...context, "patterns"],
    warnings,
  );

  const description = hasOwn(entry, "description")
    ? entry.description
    : undefined;
  if (!isNonBlankString(description)) {
    pushWarning(
      warnings,
      joinPath([...context, "description"]),
      CONVERSION_REASON.descriptionRequired,
    );
    return [];
  }

  const lines: string[] = [`category ${name} {`];
  lines.push(`  description "${escapeForDsl(description)}"`);

  const modelLines = convertLegacyModels(entry, context, warnings);
  if (modelLines.length > 0) lines.push(...modelLines);

  convertTemperature(entry, context, warnings, lines);

  if (
    hasOwn(entry, "prompt_append") &&
    typeof entry.prompt_append === "string"
  ) {
    lines.push(`  prompt_append "${escapeForDsl(entry.prompt_append)}"`);
  } else if (hasOwn(entry, "prompt_append")) {
    pushWarning(
      warnings,
      joinPath([...context, "prompt_append"]),
      reasonWithType(CONVERSION_REASON.expectedString, entry.prompt_append),
    );
  }

  if (hasOwn(entry, "tools")) {
    if (isPlainRecord(entry.tools)) {
      const toolLines = convertLegacyTools(entry.tools, context, warnings);
      if (toolLines.length > 0) lines.push(...toolLines);
    } else {
      pushWarning(
        warnings,
        joinPath([...context, "tools"]),
        reasonWithType(CONVERSION_REASON.expectedObject, entry.tools),
      );
    }
  }

  const triggers = convertLegacyTriggers(
    hasOwn(entry, "triggers") ? entry.triggers : undefined,
    [...context, "triggers"],
    warnings,
  );
  if (triggers !== undefined) lines.push(formatTriggerList(triggers));

  warnRejectedFastAliases(entry, context, warnings);

  lines.push("}");
  return lines;
}

function convertDisableList(
  value: unknown,
  key: string,
  keyword: "agents" | "hooks" | "skills",
  expectedReason: string,
  warnings: ConversionWarning[],
  dslLines: string[],
): void {
  if (!Array.isArray(value)) {
    pushWarning(warnings, key, reasonWithType(expectedReason, value));
    return;
  }
  const items: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];
    if (typeof item !== "string") {
      pushWarning(
        warnings,
        joinPath([key, index]),
        reasonWithType(CONVERSION_REASON.expectedString, item),
      );
      continue;
    }
    items.push(JSON.stringify(item));
  }
  appendValidatedBlock(
    dslLines,
    [`disable ${keyword} [${items.join(", ")}]`],
    warnings,
    key,
  );
}

function convertCopiedRoot(parsed: Record<string, unknown>): ConversionResult {
  const warnings: ConversionWarning[] = [];
  const dslLines: string[] = [];

  for (const key of Object.keys(parsed)) {
    if (warnUnusableKey(key, [], warnings)) continue;
    const value = parsed[key];

    const unsupportedReason = UNSUPPORTED_LEGACY_FIELDS.get(key);
    if (unsupportedReason !== undefined) {
      pushWarning(warnings, key, unsupportedReason);
      continue;
    }

    if (key === "disabled_agents") {
      convertDisableList(
        value,
        key,
        "agents",
        CONVERSION_REASON.expectedArrayAgentNames,
        warnings,
        dslLines,
      );
      continue;
    }

    if (key === "disabled_hooks") {
      convertDisableList(
        value,
        key,
        "hooks",
        CONVERSION_REASON.expectedArrayHookNames,
        warnings,
        dslLines,
      );
      continue;
    }

    if (key === "disabled_skills") {
      convertDisableList(
        value,
        key,
        "skills",
        CONVERSION_REASON.expectedArraySkillNames,
        warnings,
        dslLines,
      );
      continue;
    }

    if (key === "log_level") {
      if (typeof value !== "string") {
        pushWarning(
          warnings,
          key,
          reasonWithType(CONVERSION_REASON.expectedStringLogLevel, value),
        );
        continue;
      }
      const normalized = value.toUpperCase();
      if (!VALID_LOG_LEVELS.has(normalized)) {
        pushWarning(
          warnings,
          key,
          reasonWithType(CONVERSION_REASON.invalidLogLevel, value),
        );
        continue;
      }
      appendValidatedBlock(
        dslLines,
        ["settings {", `  log_level ${normalized}`, "}"],
        warnings,
        key,
      );
      continue;
    }

    if (key === "agents") {
      if (!isPlainRecord(value)) {
        pushWarning(
          warnings,
          key,
          reasonWithType(CONVERSION_REASON.expectedAgentObject, value),
        );
        continue;
      }
      for (const agentName of Object.keys(value)) {
        if (warnUnusableKey(agentName, ["agents"], warnings)) continue;
        if (warnUnusableName(agentName, ["agents"], warnings)) continue;
        const agentEntry = value[agentName];
        if (!BUILTIN_AGENT_NAMES.has(agentName)) {
          pushWarning(
            warnings,
            joinPath(["agents", agentName]),
            CONVERSION_REASON.notBuiltin,
          );
          continue;
        }
        if (!isPlainRecord(agentEntry)) {
          pushWarning(
            warnings,
            joinPath(["agents", agentName]),
            reasonWithType(CONVERSION_REASON.expectedObjectEntry, agentEntry),
          );
          continue;
        }
        appendValidatedBlock(
          dslLines,
          convertLegacyAgentEntry(agentName, agentEntry, warnings),
          warnings,
          joinPath(["agents", agentName]),
        );
      }
      continue;
    }

    if (key === "custom_agents") {
      if (!isPlainRecord(value)) {
        pushWarning(
          warnings,
          key,
          reasonWithType(CONVERSION_REASON.expectedCustomAgentObject, value),
        );
        continue;
      }
      for (const agentName of Object.keys(value)) {
        if (warnUnusableKey(agentName, ["custom_agents"], warnings)) continue;
        if (warnUnusableName(agentName, ["custom_agents"], warnings)) continue;
        const agentEntry = value[agentName];
        if (BUILTIN_AGENT_NAMES.has(agentName)) {
          pushWarning(
            warnings,
            joinPath(["custom_agents", agentName]),
            CONVERSION_REASON.builtinCollision,
          );
          continue;
        }
        if (!isPlainRecord(agentEntry)) {
          pushWarning(
            warnings,
            joinPath(["custom_agents", agentName]),
            reasonWithType(CONVERSION_REASON.expectedObjectEntry, agentEntry),
          );
          continue;
        }
        appendValidatedBlock(
          dslLines,
          convertLegacyCustomAgent(agentName, agentEntry, warnings),
          warnings,
          joinPath(["custom_agents", agentName]),
        );
      }
      continue;
    }

    if (key === "categories") {
      if (!isPlainRecord(value)) {
        pushWarning(
          warnings,
          key,
          reasonWithType(CONVERSION_REASON.expectedCategoryObject, value),
        );
        continue;
      }
      for (const catName of Object.keys(value)) {
        if (warnUnusableKey(catName, ["categories"], warnings)) continue;
        if (warnUnusableName(catName, ["categories"], warnings)) continue;
        const catEntry = value[catName];
        if (!isPlainRecord(catEntry)) {
          pushWarning(
            warnings,
            joinPath(["categories", catName]),
            reasonWithType(CONVERSION_REASON.expectedObjectEntry, catEntry),
          );
          continue;
        }
        appendValidatedBlock(
          dslLines,
          convertLegacyCategory(catName, catEntry, warnings),
          warnings,
          joinPath(["categories", catName]),
        );
      }
      continue;
    }

    pushWarning(warnings, joinPath([key]), CONVERSION_REASON.unknownField);
  }

  return finalizeConversion(dslLines, warnings);
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
    return parseFailedResult();
  }
  return convertCopiedRoot(copiedValue as Record<string, unknown>);
}

/**
 * Convert a legacy weave-opencode.jsonc source string into current `.weave` DSL.
 *
 * This is a best-effort partial conversion:
 * - Supported fields are converted and included in the output DSL.
 * - Unsupported fields are skipped with explicit warnings.
 * - Unknown fields are also skipped with a warning.
 * - The function always returns a result (never throws); parse failures
 *   produce a single warning and an empty DSL body.
 * - Successful DSL always validates with `parseConfig()` before return.
 */
export function convertLegacyJsonc(source: string): ConversionResult {
  const inspected = inspectLegacyJsonc(source);
  if (inspected.isErr()) {
    return { dsl: "", warnings: inspected.error.warnings };
  }
  const parseResult = parseLegacyJsonc(source);
  if (
    parseResult === undefined ||
    parseResult === null ||
    typeof parseResult !== "object" ||
    Array.isArray(parseResult)
  ) {
    return parseFailedResult();
  }
  return convertLegacyValue(parseResult);
}
