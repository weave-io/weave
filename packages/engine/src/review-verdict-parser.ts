/**
 * Structured result of parsing a review agent's output.
 *
 * - `approve`   — reviewer approved the work
 * - `reject`    — reviewer rejected the work; `reasoning` is the full output
 * - `block`     — reviewer hard-blocked the work; `reasoning` is the full output
 * - `malformed` — no recognisable signal found; `rawOutput` is the full text
 */
export type ReviewVerdict =
  | { verdict: "approve" }
  | { verdict: "reject"; reasoning: string }
  | { verdict: "block"; reasoning: string }
  | { verdict: "malformed"; rawOutput: string };

/** Regex that matches `[APPROVE]`, `[REJECT]`, or `[BLOCK]` (case-insensitive, exact bracket format). */
const VERDICT_RE = /\[(approve|reject|block)\]/gi;

/**
 * Parse a review agent's raw output text into a {@link ReviewVerdict}.
 *
 * Scanning rules:
 * - Searches for `[APPROVE]`, `[REJECT]`, or `[BLOCK]` (case-insensitive).
 * - Only the exact bracket form is recognised — `[APPROVED]`, `[REJECTION]`, etc. are ignored.
 * - If **more than one** verdict signal is present, the output is treated as `malformed`
 *   because ambiguous output cannot be safely interpreted.
 * - For `approve` the signal alone is sufficient; no reasoning is captured.
 * - For `reject` and `block` the full `output` string is returned as `reasoning`
 *   because the reviewer's explanation surrounds the signal token.
 * - Empty or whitespace-only input returns `malformed`.
 *
 * This is a pure function with no side effects and no failure path.
 *
 * @param output - Raw text produced by a review agent.
 * @returns A {@link ReviewVerdict} discriminated union value.
 */
export function parseVerdict(output: string): ReviewVerdict {
  if (!output?.trim()) {
    return { verdict: "malformed", rawOutput: output };
  }

  // Use a global regex to find ALL matches. Multiple distinct signals → malformed.
  const re = new RegExp(VERDICT_RE.source, "gi");
  const matches: string[] = [];
  let m = re.exec(output);
  while (m !== null) {
    matches.push(m[1].toLowerCase());
    m = re.exec(output);
  }

  if (matches.length === 0) {
    return { verdict: "malformed", rawOutput: output };
  }

  if (matches.length > 1) {
    return { verdict: "malformed", rawOutput: output };
  }

  const signal = matches[0];

  if (signal === "approve") {
    return { verdict: "approve" };
  }

  if (signal === "reject") {
    return { verdict: "reject", reasoning: output };
  }

  // signal === "block"
  return { verdict: "block", reasoning: output };
}
