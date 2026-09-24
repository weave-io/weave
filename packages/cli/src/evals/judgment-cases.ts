/**
 * Shared helpers for text-only *judgment* cases.
 *
 * Most text-only cases test output structure: their descriptions state the
 * expected verdict and runners list the required signal names in the user
 * message. A judgment case tests whether the agent reaches the right
 * conclusion from the evidence it is given (for example, approving code that
 * looks unsafe but is guarded elsewhere), so the runner must not reveal the
 * expected verdict. Cases opt in with the `judgment` tag.
 *
 * This module also extracts code locations (`path/to/file.ts:12`) from
 * review text. Citing at least two distinct locations in one finding is the
 * deterministic proxy for "traced": the finding names where the data comes
 * from and where it is used, not just the line that looks suspicious. A
 * reviewer may also name the far end by the symbol the case declares there
 * (`saveSettings`) rather than by its path; `isTracedThroughDeclaredSymbol`
 * accepts that when the cited file calls the symbol and the case declares it.
 */

import type { EvalCase } from "./types.js";

export const JUDGMENT_CASE_TAG = "judgment";

/** Minimum distinct locations a finding must cite to count as traced. */
export const TRACED_FINDING_MIN_LOCATIONS = 2;

// A path with a known extension, optionally followed by a line reference in
// one of three shapes: `a.ts:12` / `a.ts#L12`, `` `a.ts` (line 12) ``, or
// `a.ts line 12` / `a.ts, at line 12`. Ranges keep their first line.
const CODE_LOCATION_RE =
  /((?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_-][A-Za-z0-9_.-]*\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|weave|yml|yaml|go|rs|py))(?:(?::|#L)(\d+)(?:-\d+)?|`?\s*\(\s*lines?\s+(\d+)|`?,?\s+(?:at\s+)?lines?\s+(\d+))?/gi;

export function isJudgmentCase(evalCase: EvalCase): boolean {
  return evalCase.tags.includes(JUDGMENT_CASE_TAG);
}

/**
 * Builds the "Required structural signals" line for a runner's user message.
 * Judgment cases withhold the signal names because they encode the verdict.
 */
export function buildRequiredSignalsLine(
  evalCase: EvalCase,
  requiredArtifacts: readonly string[],
): string {
  if (isJudgmentCase(evalCase)) {
    return "Required structural signals: not disclosed for this case; decide from the evidence above.";
  }
  if (requiredArtifacts.length === 0) {
    return "Required structural signals: none";
  }
  return `Required structural signals: ${requiredArtifacts.join(", ")}`;
}

/**
 * Returns the distinct code locations cited in `text`.
 *
 * A location is a file path with a known extension, optionally followed by a
 * line reference (`:12`, `:12-14`, `#L12`, `(line 12)`, `line 12`). A bare
 * path is dropped when the same path is also cited with a line number, so
 * `a.ts` plus `a.ts:3` counts once.
 */
export function extractCodeLocations(text: string): string[] {
  const withLine = new Set<string>();
  const bare = new Set<string>();

  for (const match of text.matchAll(CODE_LOCATION_RE)) {
    const path = match[1];
    if (path === undefined) {
      continue;
    }
    const line = match[2] ?? match[3] ?? match[4];
    if (line === undefined) {
      // A bare name with neither a directory nor a line (for example the
      // string literal "settings.json") is not a code location.
      if (path.includes("/")) {
        bare.add(path);
      }
      continue;
    }
    withLine.add(`${path}:${line}`);
  }

  const pathsWithLines = new Set(
    [...withLine].map((location) =>
      location.slice(0, location.lastIndexOf(":")),
    ),
  );
  const unlinedPaths = [...bare].filter((path) => !pathsWithLines.has(path));

  return [...withLine, ...unlinedPaths];
}

export function isTracedFinding(text: string): boolean {
  return extractCodeLocations(text).length >= TRACED_FINDING_MIN_LOCATIONS;
}

// A `path` written in backticks, then (on a later line) a code fence: the
// fence's code belongs to that file, the way a case shows each file.
const MATERIAL_PATH_RE =
  /`((?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_-][A-Za-z0-9_.-]*\.(?:ts|tsx|js|jsx|mjs|cjs|go|rs|py))`/g;
// Functions and classes only: a trace ends at the code that fails, and a
// local such as `const spy` is too common a word to stand for a location.
const DECLARATION_RE = /\b(?:function\*?|class)\s+([A-Za-z_$][\w$]*)/g;
// A call: an identifier (possibly after `obj.`) followed by `(`.
const CALL_RE = /(?<![\w$])([A-Za-z_$][\w$]*)\s*\(/g;

/**
 * What a case's material shows about its code: each function or class it
 * declares, mapped to the file that declares it, and the names each file
 * calls. A case shows each file as a backticked path followed by a fenced
 * code block; the block belongs to that path. A name declared in two files
 * is dropped from `declared`, since naming it does not say which is meant.
 */
export interface CodeMaterial {
  declared: ReadonlyMap<string, string>;
  calls: ReadonlyMap<string, ReadonlySet<string>>;
}

export function extractCodeMaterial(material: string): CodeMaterial {
  const declared = new Map<string, string>();
  const calls = new Map<string, Set<string>>();
  const ambiguous = new Set<string>();
  let lastPath: string | undefined;
  let fenceFile: string | undefined;
  let inFence = false;

  for (const line of material.split("\n")) {
    if (line.trimStart().startsWith("```")) {
      inFence = !inFence;
      fenceFile = inFence ? lastPath : undefined;
      continue;
    }
    if (!inFence) {
      for (const match of line.matchAll(MATERIAL_PATH_RE)) {
        lastPath = match[1];
      }
      continue;
    }
    if (fenceFile === undefined) continue;
    const declaredHere = new Set<string>();
    for (const match of line.matchAll(DECLARATION_RE)) {
      const name = match[1];
      if (name === undefined) continue;
      declaredHere.add(name);
      const previous = declared.get(name);
      if (previous !== undefined && previous !== fenceFile) {
        ambiguous.add(name);
      }
      declared.set(name, fenceFile);
    }
    const called = calls.get(fenceFile) ?? new Set<string>();
    for (const match of line.matchAll(CALL_RE)) {
      const name = match[1];
      if (name !== undefined && !declaredHere.has(name)) called.add(name);
    }
    calls.set(fenceFile, called);
  }

  for (const name of ambiguous) declared.delete(name);
  return { declared, calls };
}

/** True when `a` and `b` name the same file, one possibly a suffix path. */
function sameFile(a: string, b: string): boolean {
  return a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`);
}

function callsIn(
  material: CodeMaterial,
  cited: string,
): ReadonlySet<string> | undefined {
  for (const [file, names] of material.calls) {
    if (sameFile(cited, file)) return names;
  }
  return undefined;
}

/**
 * True when a finding cites a call site by path and names a function that
 * the cited file calls and the case declares: for example
 * `src/commands/settings.ts:32` and `saveSettings`, which the case shows
 * being called in `src/commands/settings.ts` and declared in
 * `src/settings/store.ts`. That names both ends of the trace, even though
 * only one is a path. It does not hold for the function that contains the
 * cited line (declared there, not called), for a name the case never
 * declares (a library type), or for a cited file that never calls the named
 * function (a test that only spies on it).
 */
export function isTracedThroughDeclaredSymbol(
  text: string,
  material: CodeMaterial,
): boolean {
  const citedFiles = extractCodeLocations(text).map((location) =>
    location.replace(/:\d+$/, ""),
  );
  if (citedFiles.length === 0) return false;

  for (const name of material.declared.keys()) {
    const named = new RegExp(
      `(?<![\\w$])${name.replace(/\$/g, "\\$")}(?![\\w$])`,
    );
    if (!named.test(text)) continue;
    const citesACaller = citedFiles.some(
      (cited) => callsIn(material, cited)?.has(name) ?? false,
    );
    if (citesACaller) return true;
  }
  return false;
}

const NEGATION_BEFORE_RE =
  /\b(?:no|not|never|cannot|can't|won't|don't|do not|will not|should not|shouldn't|no need to|isn't|is not|without|unable to)\b[^.\n]{0,30}$/i;
const NEGATION_WINDOW_CHARS = 40;

/**
 * True when the global `pattern` matches somewhere in `content` that is not
 * preceded, on the same line and within a short window, by a negation such
 * as "not", "cannot", or "no need to". "I will not mark it complete" is not
 * an affirmed completion.
 *
 * `ignoreBefore` names further context that keeps a match from being
 * affirmed (for example "to confirm" for a pass claim). It is tested against
 * everything before the match on the same line, so it can anchor on `^`.
 */
export function hasAffirmedMatch(
  content: string,
  pattern: RegExp,
  ignoreBefore?: RegExp,
): boolean {
  for (const match of content.matchAll(pattern)) {
    const index = match.index ?? 0;
    const lineStart = content.lastIndexOf("\n", index - 1) + 1;
    const windowStart = Math.max(lineStart, index - NEGATION_WINDOW_CHARS);
    const ignored =
      NEGATION_BEFORE_RE.test(content.slice(windowStart, index)) ||
      (ignoreBefore?.test(content.slice(lineStart, index)) ?? false);
    if (!ignored) {
      return true;
    }
  }
  return false;
}
