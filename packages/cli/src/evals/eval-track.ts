/**
 * Eval tracks: which kind of case a run executes (`--track`).
 *
 * Weave has two eval tracks (ADR 0008, Spec 33): the text-only track, one
 * chat completion per case, and the harness trajectory track, a real harness
 * session in a Podman sandbox per case. A run without `--track` runs both,
 * which is what a local `weave eval run` has always done. CI runs them in
 * separate jobs, because only the trajectory job builds the sandbox image:
 * the text job passes `--track text` so it never starts a sandbox it cannot
 * run, and the trajectory job passes `--track trajectory`.
 *
 * Pure helpers; no I/O.
 */

import type { EvalCase, EvalSuiteMetadata } from "./types.js";

/** The tracks `--track` accepts. */
export const EVAL_TRACKS = ["text", "trajectory"] as const;

export type EvalTrack = (typeof EVAL_TRACKS)[number];

/** The track a case belongs to, from its expected outcome kind. */
export function caseTrack(evalCase: EvalCase): EvalTrack {
  if (evalCase.expected_outcome.kind === "harness_trajectory") {
    return "trajectory";
  }
  return "text";
}

/**
 * The cases of `cases` that belong to `track`. `undefined` (no `--track`)
 * keeps every case.
 */
export function selectCasesForTrack(
  cases: readonly EvalCase[],
  track: EvalTrack | undefined,
): EvalCase[] {
  if (track === undefined) return [...cases];
  return cases.filter((evalCase) => caseTrack(evalCase) === track);
}

/**
 * True when a suite can hold cases of `track`. Every suite has text-only
 * cases; only suites whose registry entry allows `harness_trajectory` can
 * hold trajectory cases.
 */
export function suiteSupportsTrack(
  suite: EvalSuiteMetadata,
  track: EvalTrack | undefined,
): boolean {
  if (track !== "trajectory") return true;
  return suite.allowedExpectedOutcomeKinds.includes("harness_trajectory");
}
