/**
 * Shared, pattern-based secret redaction for free-text log/diagnostic output
 * (as opposed to `sanitizer.ts`, which is a denylist over structured JSON
 * field names). Used anywhere raw harness/process output — stderr, DEBUG
 * streams, CLI output — might contain an embedded credential and needs to be
 * safe to log or write to a diagnostic file.
 *
 * This is intentionally conservative: patterns are broad (hex blobs, bearer
 * tokens, common provider key prefixes) because false positives (redacting
 * non-secret text) are far preferable to leaking a real credential.
 *
 * @see docs/specs (trajectory eval security notes) and
 * `packages/cli/src/evals/warp-security-runner.ts`, which uses the same
 * pattern set for its own local diagnostic truncation.
 */

/** Replacement text patterns fall back to when no more specific tag applies. */
export const REDACTED_PLACEHOLDER = "[REDACTED]";

/**
 * Ordered list of `[pattern, replacement]` pairs applied in sequence.
 * Order matters: more specific key-prefix patterns run before the generic
 * hex-blob fallback so replacements stay maximally informative without
 * double-redacting.
 */
const SECRET_REDACTION_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  [/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [REDACTED]"],
  // OpenRouter / OpenAI-style project keys: sk-or-v1-..., sk-proj-...
  [/\bsk-(?:or-v1-|or-|proj-)?[A-Za-z0-9_-]{8,}/g, "[REDACTED-KEY]"],
  [/\bsk-ant-[A-Za-z0-9_-]{8,}/g, "[REDACTED-KEY]"],
  // GitHub personal access tokens / fine-grained / OAuth / app / refresh tokens.
  [/\bgh[oprsu]_[A-Za-z0-9]{8,}/g, "[REDACTED-KEY]"],
  [/Authorization:\s*[^\s,;\n]{8,}/gi, "Authorization: [REDACTED]"],
  [/[?&](?:api_key|apikey|key|token)=[^&\s]{4,}/gi, "?[key]=[REDACTED]"],
  [/\b[0-9a-f]{32,}\b/gi, "[REDACTED-HEX]"],
];

/**
 * Redact known secret-shaped substrings from free-text content.
 *
 * @param raw - Untrusted text that may contain embedded credentials (e.g.
 *   raw process stderr, a DEBUG log stream).
 * @param maxChars - Optional cap; if the redacted text exceeds this length it
 *   is truncated with a `… [truncated]` suffix. `undefined` disables
 *   truncation (default).
 */
export function redactSecrets(raw: string, maxChars?: number): string {
  let redacted = raw;
  for (const [pattern, replacement] of SECRET_REDACTION_PATTERNS) {
    redacted = redacted.replace(pattern, replacement);
  }
  if (maxChars !== undefined && redacted.length > maxChars) {
    return `${redacted.slice(0, maxChars)}… [truncated]`;
  }
  return redacted;
}
