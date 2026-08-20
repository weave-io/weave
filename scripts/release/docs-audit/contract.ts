/**
 * Shared contract for the deterministic docs checker: issue and error shapes,
 * the work budgets applied before any expensive processing, and the canonical
 * result/digest helpers.
 *
 * This module holds no policy and reads no files. Loading lives in `tree.ts`,
 * navigation authority in `navigation.ts`, link work in `links.ts`, and policy
 * evaluation in `deterministic.ts`.
 */
import { err, ok, type Result } from "neverthrow";
import { NPM_DIGEST_PREFIX } from "../constants.js";
import { DOCS_AUDIT_LIMITS } from "./policy.js";

export const DETERMINISTIC_DOCS_CHECK_VERSION = 1 as const;

/** Bounds applied before reading, parsing, or resolving docs input. */
export const DETERMINISTIC_DOCS_LIMITS = {
  fileCount: 512,
  perFileBytes: 512 * 1024,
  aggregateBytes: 8 * 1024 * 1024,
  parserWork: 256 * 1024,
  linkDocuments: 512,
  links: 4_096,
  anchors: 8_192,
} as const;

export type DeterministicDocsIssueKind =
  | "broken-link"
  | "broken-anchor"
  | "sidebar-missing-page"
  | "sidebar-unknown-entry"
  | "search-missing-page"
  | "search-unknown-entry"
  | "missing-readme"
  | "missing-tarball-doc"
  | "empty-readme"
  | "missing-files-entry"
  | "deterministic-input-invalid";

export interface DeterministicDocsIssue {
  readonly kind: DeterministicDocsIssueKind;
  readonly path: string;
  readonly detail: string;
}

export interface DeterministicDocsCheckResult {
  readonly schemaVersion: typeof DETERMINISTIC_DOCS_CHECK_VERSION;
  readonly passed: boolean;
  readonly issues: readonly DeterministicDocsIssue[];
  readonly digest: string;
}

export type DeterministicDocsBound =
  | "file-count"
  | "file-bytes"
  | "aggregate-bytes"
  | "parser-work"
  | "link-documents"
  | "link-count"
  | "anchor-count";

export type DeterministicDocsParseReason =
  | "malformed-input"
  | "repeated-input"
  | "conflicting-input";

export type DeterministicDocsCheckError =
  | { type: "DeterministicDocsRootInvalid"; path: string }
  | { type: "DeterministicDocsIoFailed"; path: string; message: string }
  | {
      type: "DeterministicDocsBoundExceeded";
      bound: DeterministicDocsBound;
      path: string;
      limit: number;
      actual: number;
    }
  | {
      type: "DeterministicDocsParseFailed";
      path: string;
      reason: DeterministicDocsParseReason;
      detail: string;
    };

export function boundFailure(
  bound: DeterministicDocsBound,
  path: string,
  actual: number,
  limit: number,
): DeterministicDocsCheckError {
  return {
    type: "DeterministicDocsBoundExceeded",
    bound,
    path: boundText(path, DOCS_AUDIT_LIMITS.pathChars),
    limit,
    actual,
  };
}

export function parseFailure(
  path: string,
  reason: DeterministicDocsParseReason,
  detail: string,
): DeterministicDocsCheckError {
  return {
    type: "DeterministicDocsParseFailed",
    path: boundText(path, DOCS_AUDIT_LIMITS.pathChars),
    reason,
    detail: boundText(detail, DOCS_AUDIT_LIMITS.issuePathChars),
  };
}

/** Remaining structural-parsing work shared across the checked data files. */
export interface ParserBudget {
  used: number;
}

export function createParserBudget(): ParserBudget {
  return { used: 0 };
}

/** Reject an input whose size alone would exhaust the remaining budget. */
export function ensureParserInput(
  budget: ParserBudget,
  path: string,
  inputLength: number,
): Result<void, DeterministicDocsCheckError> {
  if (inputLength > DETERMINISTIC_DOCS_LIMITS.parserWork - budget.used)
    return err(
      boundFailure(
        "parser-work",
        path,
        budget.used + inputLength,
        DETERMINISTIC_DOCS_LIMITS.parserWork,
      ),
    );
  return ok(undefined);
}

export function consumeParserWork(
  budget: ParserBudget,
  path: string,
  units = 1,
): Result<void, DeterministicDocsCheckError> {
  if (units < 0 || !Number.isSafeInteger(units))
    return err(parseFailure(path, "malformed-input", "invalid parser work"));
  if (budget.used > DETERMINISTIC_DOCS_LIMITS.parserWork - units)
    return err(
      boundFailure(
        "parser-work",
        path,
        budget.used + units,
        DETERMINISTIC_DOCS_LIMITS.parserWork,
      ),
    );
  budget.used += units;
  return ok(undefined);
}

export function buildResult(
  issues: readonly DeterministicDocsIssue[],
): DeterministicDocsCheckResult {
  const sorted = [...issues].sort(compareIssue);
  const payload = {
    schemaVersion: DETERMINISTIC_DOCS_CHECK_VERSION,
    passed: sorted.length === 0,
    issues: sorted.slice(0, DOCS_AUDIT_LIMITS.issues).map((issue) => ({
      ...issue,
      path: boundText(issue.path, DOCS_AUDIT_LIMITS.issuePathChars),
      detail: boundText(issue.detail, DOCS_AUDIT_LIMITS.issuePathChars),
    })),
  };
  return { ...payload, digest: docsAuditDigest(payload) };
}

export function failureResult(
  error: DeterministicDocsCheckError,
): DeterministicDocsCheckResult {
  const path = "path" in error ? error.path : "deterministic docs input";
  return buildResult([
    { kind: "deterministic-input-invalid", path, detail: error.type },
  ]);
}

function compareIssue(
  left: DeterministicDocsIssue,
  right: DeterministicDocsIssue,
): number {
  if (left.kind !== right.kind) return left.kind < right.kind ? -1 : 1;
  if (left.path !== right.path) return left.path < right.path ? -1 : 1;
  if (left.detail !== right.detail) return left.detail < right.detail ? -1 : 1;
  return 0;
}

export function normalizeRel(path: string): string {
  return path.replaceAll("\\", "/");
}

export function boundText(value: string, limit: number): string {
  return value.length <= limit ? value : value.slice(0, limit);
}

export function docsAuditDigest(value: unknown): string {
  return docsAuditBytesDigest(canonicalJson(value));
}

export function docsAuditBytesDigest(value: string): string {
  return `${NPM_DIGEST_PREFIX}${Bun.CryptoHasher.hash("sha256", value, "hex")}`;
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object")
    return JSON.stringify(value) ?? "null";
  if (Array.isArray(value))
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}
