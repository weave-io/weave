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
 * from and where it is used, not just the line that looks suspicious.
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
