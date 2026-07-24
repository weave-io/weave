/**
 * Pure classification and resolver-construction helpers for Pi's registered-
 * tool permission subsystem (Spec 33 §12, Spec 34).
 *
 * Nothing here calls into Pi's API or the Weave permission engine's I/O
 * surface - every export is a pure function over already-discovered data.
 * `permission-bridge.ts` composes these with the engine's
 * `PermissionRegistryBuilder` and `PermissionService`.
 *
 * @see docs/specs/33-spec-pi-adapter/33-spec-pi-adapter.md (Spec 33 §12)
 * @see docs/specs/34-spec-harness-neutral-permissions/34-spec-harness-neutral-permissions.md
 */

import type {
  EffectiveToolPolicy,
  PermissionCapability,
  PermissionResolver,
} from "@weaveio/weave-engine";
import { ok } from "neverthrow";
import { isGenuineBuiltinSourceInfo } from "./commands.js";
import type { PiToolInfo } from "./types.js";

/**
 * The closed set of Pi built-in tool names this adapter governs, mapped to
 * the abstract capability each exercises. Derived directly from Pi's own
 * `ToolCallEvent` union (`bash`/`read`/`edit`/`write`/`grep`/`find`/`ls`) -
 * these are the only built-in `toolName` literals Pi's `tool_call` event
 * can carry, so this list is exhaustive and closed, not a guess.
 */
export const PI_NATIVE_TOOL_CAPABILITY: Readonly<
  Record<string, PermissionCapability>
> = Object.freeze({
  bash: "execute",
  read: "read",
  grep: "read",
  find: "read",
  ls: "read",
  write: "write",
  edit: "write",
});

/** Result of classifying a discovered tool inventory against our governance intent. */
export interface PiToolClassification {
  /**
   * Every discovered name matching a native capability, regardless of
   * provenance. This is the *required* set fed to
   * `verifyPermissionCoverage`'s `nativeToolIdentities` - a name absent from
   * `allTools` altogether is simply not required (the host doesn't expose
   * it), but a name that *is* discovered always demands coverage proof.
   */
  readonly native: readonly string[];
  /**
   * The subset of `native` whose `sourceInfo` genuinely marks it as Pi's own
   * built-in (`sourceInfo.source === "builtin"`). Only these are actually
   * registered with a resolver and claimed as intercepted - a same-named
   * entry shadowed by a foreign extension is NOT included here, so
   * `verifyPermissionCoverage` reports `missing_registration` for it instead
   * of silently treating a governance-relevant shadowed name as Pi-native
   * (Spec 33 §7.1, §12.1).
   */
  readonly verifiedNative: readonly string[];
  /** Weave-owned tool names we intend to register and govern. */
  readonly weaveOwned: readonly string[];
  /** Every other discovered tool: preserved untouched, no Weave permit ever issued. */
  readonly unmanaged: readonly string[];
}

/**
 * Classifies every tool name `getAllTools()` discovered into native / Weave-
 * owned / unmanaged-third-party buckets (Spec 33 §12.1, §7.1).
 *
 * `weaveOwned` is the caller's *requested* set of Weave-owned tool names,
 * taken unconditionally - these are our own tools, not host-dependent, and
 * a fresh generation registers them before they can appear in `allTools`.
 * `native` is intersected with `allTools` so we never claim coverage for a
 * built-in this host version does not actually expose, but membership in
 * `native` never depends on provenance - a foreign extension's tool literally
 * named `bash` still belongs in `native` (it is required coverage that will
 * legitimately fail), never silently reclassified as unmanaged. `unmanaged`
 * is every other discovered name.
 */
export function classifyDiscoveredTools(
  allTools: readonly PiToolInfo[],
  weaveOwnedNames: readonly string[],
): PiToolClassification {
  const weaveOwnedSet = new Set(weaveOwnedNames);
  const native: string[] = [];
  const verifiedNative: string[] = [];
  const unmanaged: string[] = [];

  for (const tool of allTools) {
    if (weaveOwnedSet.has(tool.name)) continue;
    if (Object.hasOwn(PI_NATIVE_TOOL_CAPABILITY, tool.name)) {
      native.push(tool.name);
      if (isGenuineBuiltinSourceInfo(tool.sourceInfo, tool.name)) {
        verifiedNative.push(tool.name);
      }
      continue;
    }
    unmanaged.push(tool.name);
  }

  return { native, verifiedNative, weaveOwned: [...weaveOwnedSet], unmanaged };
}

/**
 * Bound for every authority-bearing string (command/path/pattern/glob).
 * These values become part of the authorization identity - Spec 34 §5
 * requires distinct security effects to produce distinct authorization
 * fields, so a value at or under this bound is carried EXACTLY, never
 * truncated (two long values sharing only a prefix must never collapse
 * onto the same authorization). A value that exceeds this bound is
 * rejected as `unresolved` instead.
 */
const MAX_AUTHORITY_STRING_LENGTH = 512;
const MAX_DISPLAY_SUMMARY_LENGTH = 200;

/** Truncates arbitrary text for DISPLAY ONLY - never for an authorization-bearing field. */
function boundedDisplayText(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}…`;
}

/**
 * Rejects text containing lone surrogates or C0/C1 control characters - the
 * same class of unsafe content the engine's own display sanitizer rejects
 * (Spec 34 §5). Native resolvers check this themselves so unsafe input
 * produces an explicit `unresolved` request rather than surfacing as a
 * confusing `invalid_output` failure downstream.
 */
function isSafeTargetText(value: string): boolean {
  if (value.length === 0) return false;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional control-character rejection
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/.test(value)) {
    return false;
  }
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    const isHighSurrogate = code >= 0xd800 && code <= 0xdbff;
    const isLowSurrogate = code >= 0xdc00 && code <= 0xdfff;
    if (!isHighSurrogate && !isLowSurrogate) continue;
    const pairedLow = isHighSurrogate ? value.charCodeAt(i + 1) : undefined;
    const pairedHigh = isLowSurrogate ? value.charCodeAt(i - 1) : undefined;
    if (
      isHighSurrogate &&
      (pairedLow === undefined ||
        Number.isNaN(pairedLow) ||
        pairedLow < 0xdc00 ||
        pairedLow > 0xdfff)
    ) {
      return false;
    }
    if (
      isLowSurrogate &&
      (pairedHigh === undefined ||
        Number.isNaN(pairedHigh) ||
        pairedHigh < 0xd800 ||
        pairedHigh > 0xdbff)
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Declares, per governed Pi built-in tool, which input field carries the
 * governance-relevant target and whether that field is genuinely optional
 * per Pi's own TypeBox schema (`dist/core/tools/*.d.ts`). Only `ls.path` is
 * optional - every other governed tool requires its field, so a missing or
 * malformed value there is malformed input, not a legitimate omission.
 */
interface NativeToolInputSpec {
  readonly field: string;
  readonly optional: boolean;
  readonly fallbackWhenOmitted: string;
}

const NATIVE_TOOL_INPUT_SPEC: Readonly<Record<string, NativeToolInputSpec>> =
  Object.freeze({
    bash: { field: "command", optional: false, fallbackWhenOmitted: "" },
    read: { field: "path", optional: false, fallbackWhenOmitted: "" },
    edit: { field: "path", optional: false, fallbackWhenOmitted: "" },
    write: { field: "path", optional: false, fallbackWhenOmitted: "" },
    ls: { field: "path", optional: true, fallbackWhenOmitted: "." },
    // grep/find are handled by buildGrepFindResolver - see below; they are
    // deliberately absent here so buildNativeToolResolver's spec-table
    // dispatch never reaches them.
  });

/**
 * The documented current-root default for an omitted optional `path` on
 * grep/find (mirrored from `ls`'s own optional-path default, Spec 33 §12.1).
 */
const CURRENT_ROOT_PATH = ".";

/** Bounds for grep/find numeric options - reject anything outside as unresolved. */
const MAX_CONTEXT_LINES = 10_000;
const MAX_RESULT_LIMIT = 1_000_000;

function isSafeNonNegativeInteger(
  value: unknown,
  max: number,
): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= max
  );
}

/**
 * grep/find bind pattern AND the effective search path together (Spec 33
 * §12.1, Spec 34 §5) - a session grant scoped to `pattern="TODO"` in one
 * tree must never authorize the same pattern in a different tree. An
 * omitted `path` resolves to the documented current-root default rather
 * than a wildcard.
 *
 * `target.identifier` carries ONLY the exact `path` - a single unambiguous
 * value, never a concatenation of path and pattern. `pattern` and every
 * option that changes read extent/semantics (`glob`, `ignoreCase`,
 * `literal`, `context`, `limit`) live in `constraints` as a canonical JSON
 * object, each in its own field - this cannot suffer the delimiter-collision
 * a string concatenation like `${path}::${pattern}` would (e.g. path
 * `"a::b"` + pattern `"c"` colliding with path `"a"` + pattern `"b::c"`).
 *
 * Any authority-bearing string (`path`, `pattern`, `glob`) that exceeds
 * {@link MAX_AUTHORITY_STRING_LENGTH} is rejected as `unresolved` rather
 * than truncated - truncating would let two distinct long values sharing
 * only a prefix collapse onto the same authorization. Any other
 * present-but-malformed optional field (wrong type or out of bounds) is
 * likewise `unresolved` rather than silently ignored or defaulted (Spec 34
 * §5.1).
 */
function buildGrepFindResolver(
  toolName: "grep" | "find",
  capability: PermissionCapability,
): PermissionResolver {
  return ({ call }) => {
    if (typeof call !== "object" || call === null || Array.isArray(call)) {
      return ok([
        {
          unresolved: true,
          display: { summary: `${toolName}: unrecognised call shape` },
        },
      ]);
    }
    const record = call as Record<string, unknown>;

    const pattern = record.pattern;
    if (
      typeof pattern !== "string" ||
      !isSafeTargetText(pattern) ||
      pattern.length > MAX_AUTHORITY_STRING_LENGTH
    ) {
      return ok([
        {
          unresolved: true,
          display: {
            summary: `${toolName}: missing, unsafe, or oversized "pattern" input`,
          },
        },
      ]);
    }

    const rawPath = record.path;
    let effectivePath: string;
    if (rawPath === undefined) {
      effectivePath = CURRENT_ROOT_PATH;
    } else if (
      typeof rawPath !== "string" ||
      !isSafeTargetText(rawPath) ||
      rawPath.length > MAX_AUTHORITY_STRING_LENGTH
    ) {
      return ok([
        {
          unresolved: true,
          display: { summary: `${toolName}: unsafe or oversized "path" input` },
        },
      ]);
    } else {
      effectivePath = rawPath;
    }

    const constraints: Record<string, boolean | number | string> = {
      pattern,
    };

    if (toolName === "grep") {
      const { glob, ignoreCase, literal, context } = record as {
        glob?: unknown;
        ignoreCase?: unknown;
        literal?: unknown;
        context?: unknown;
      };
      if (glob !== undefined) {
        if (
          typeof glob !== "string" ||
          !isSafeTargetText(glob) ||
          glob.length > MAX_AUTHORITY_STRING_LENGTH
        ) {
          return ok([
            {
              unresolved: true,
              display: {
                summary: `${toolName}: unsafe or oversized "glob" input`,
              },
            },
          ]);
        }
        constraints.glob = glob;
      }
      if (ignoreCase !== undefined) {
        if (typeof ignoreCase !== "boolean") {
          return ok([
            {
              unresolved: true,
              display: { summary: `${toolName}: malformed "ignoreCase" input` },
            },
          ]);
        }
        constraints.ignoreCase = ignoreCase;
      }
      if (literal !== undefined) {
        if (typeof literal !== "boolean") {
          return ok([
            {
              unresolved: true,
              display: { summary: `${toolName}: malformed "literal" input` },
            },
          ]);
        }
        constraints.literal = literal;
      }
      if (context !== undefined) {
        if (!isSafeNonNegativeInteger(context, MAX_CONTEXT_LINES)) {
          return ok([
            {
              unresolved: true,
              display: { summary: `${toolName}: malformed "context" input` },
            },
          ]);
        }
        constraints.context = context;
      }
    }

    const limit = record.limit;
    if (limit !== undefined) {
      if (!isSafeNonNegativeInteger(limit, MAX_RESULT_LIMIT)) {
        return ok([
          {
            unresolved: true,
            display: { summary: `${toolName}: malformed "limit" input` },
          },
        ]);
      }
      constraints.limit = limit;
    }

    return ok([
      {
        unresolved: false as const,
        capability,
        operation: toolName,
        target: { kind: "pi-tool-argument", identifier: effectivePath },
        display: {
          summary: boundedDisplayText(
            `${toolName}: ${effectivePath} :: ${pattern}`,
            MAX_DISPLAY_SUMMARY_LENGTH,
          ),
        },
        constraints,
      },
    ]);
  };
}

/**
 * Builds a pure, synchronous `PermissionResolver` for one governed Pi
 * built-in tool: reads the exact input field Pi's own schema defines for
 * that tool (Spec 33 §12.1 "input-aware registrations") and returns exactly
 * one grantable request when the field is present, non-empty, and safe.
 *
 * When the field is missing (and not legitimately optional), non-string,
 * empty, or contains unsafe/unrepresentable content, this returns an
 * explicit `unresolved` request instead of a grantable wildcard (Spec 34
 * §5.1) - unresolved requests always require a fresh once-only approval and
 * are never reusable, regardless of policy.
 *
 * Never performs I/O, discovery, or the proposed operation - it only reads
 * its own validated `call` argument (Spec 34 §4).
 */
export function buildNativeToolResolver(
  toolName: string,
  capability: PermissionCapability,
): PermissionResolver {
  if (toolName === "grep" || toolName === "find") {
    return buildGrepFindResolver(toolName, capability);
  }
  const spec = NATIVE_TOOL_INPUT_SPEC[toolName];
  return ({ call }) => {
    if (spec === undefined) {
      return ok([
        {
          unresolved: true,
          display: { summary: `${toolName}: ungoverned built-in input shape` },
        },
      ]);
    }
    if (typeof call !== "object" || call === null || Array.isArray(call)) {
      return ok([
        {
          unresolved: true,
          display: { summary: `${toolName}: unrecognised call shape` },
        },
      ]);
    }
    const record = call as Record<string, unknown>;
    const raw = record[spec.field];
    if (raw === undefined && spec.optional) {
      return grantableRequest(toolName, capability, spec.fallbackWhenOmitted);
    }
    if (
      typeof raw !== "string" ||
      !isSafeTargetText(raw) ||
      raw.length > MAX_AUTHORITY_STRING_LENGTH
    ) {
      return ok([
        {
          unresolved: true,
          display: {
            summary: `${toolName}: missing, unsafe, or oversized "${spec.field}" input`,
          },
        },
      ]);
    }
    return grantableRequest(toolName, capability, raw);
  };
}

/**
 * Builds a grantable request from an already-validated, exact
 * authority-bearing `identifier` (never truncated - Spec 34 §5 requires
 * distinct security effects to produce distinct authorization fields).
 * Only the `display.summary` text is ever truncated.
 */
function grantableRequest(
  toolName: string,
  capability: PermissionCapability,
  identifier: string,
) {
  return ok([
    {
      unresolved: false as const,
      capability,
      operation: toolName,
      target: { kind: "pi-tool-argument", identifier },
      display: {
        summary: boundedDisplayText(
          `${toolName}: ${identifier}`,
          MAX_DISPLAY_SUMMARY_LENGTH,
        ),
      },
    },
  ]);
}

/**
 * Derives the exact, closed set of concrete Pi tool names a delegated
 * child's bootstrap should activate (Spec 33 §11.2 Task 9): every
 * `PI_NATIVE_TOOL_CAPABILITY` entry whose capability the child's own
 * effective tool policy does not explicitly `deny`, plus the child's own
 * registered Weave-owned delegation tool name when one is supplied.
 *
 * Pure and parent-side: this never calls `getAllTools()` or any other live
 * Pi discovery - the native tool-name set is the closed, version-pinned
 * list above, so the parent can derive this list *before* the child process
 * even exists. The child still independently re-derives and validates its
 * own live tool-policy plan in `applyChildBootstrap`; this function only
 * produces the list the parent asserts and the child must strictly
 * validate against that live plan before calling `pi.setActiveTools()`.
 *
 * A capability absent from `policy` (or a fully `undefined` policy) is
 * treated as included - `EffectiveToolPolicy` only ever carries `"deny"`,
 * `"ask"`, or `"allow"`, never an absent/unknown value, and only `"deny"`
 * means the tool must never even be offered as active.
 */
export function deriveActiveToolNames(
  policy: EffectiveToolPolicy | undefined,
  delegationToolName: string | undefined,
): readonly string[] {
  const names: string[] = [];
  for (const [toolName, capability] of Object.entries(
    PI_NATIVE_TOOL_CAPABILITY,
  )) {
    if (policy !== undefined && policy[capability] === "deny") continue;
    names.push(toolName);
  }
  if (
    delegationToolName !== undefined &&
    (policy === undefined || policy.delegate !== "deny")
  ) {
    names.push(delegationToolName);
  }
  return names;
}
