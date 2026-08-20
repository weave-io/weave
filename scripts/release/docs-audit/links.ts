/**
 * Bounded link and anchor evaluation for the deterministic docs checker.
 *
 * The shared checker caps documents, links, and anchors before it resolves any
 * target and indexes each destination's anchors once. Budget exhaustion becomes
 * a typed `DeterministicDocsBoundExceeded`, never a partial pass.
 */
import { err, ok, Result } from "neverthrow";
import { checkLinks, type LinkCheckBound } from "../../docs/check-links.js";
import {
  boundFailure,
  DETERMINISTIC_DOCS_LIMITS,
  type DeterministicDocsBound,
  type DeterministicDocsCheckError,
  type DeterministicDocsIssue,
  parseFailure,
} from "./contract.js";
import { DOCS_AUDIT_LIMITS } from "./policy.js";
import { type DocsTree, ownPaths } from "./tree.js";

const LINK_CHECK_LIMITS = {
  documents: DETERMINISTIC_DOCS_LIMITS.linkDocuments,
  links: DETERMINISTIC_DOCS_LIMITS.links,
  anchors: DETERMINISTIC_DOCS_LIMITS.anchors,
} as const;

const BOUND_BY_LINK_BOUND: Readonly<
  Record<LinkCheckBound, DeterministicDocsBound>
> = {
  documents: "link-documents",
  links: "link-count",
  anchors: "anchor-count",
};

const LIMIT_BY_LINK_BOUND: Readonly<Record<LinkCheckBound, number>> = {
  documents: LINK_CHECK_LIMITS.documents,
  links: LINK_CHECK_LIMITS.links,
  anchors: LINK_CHECK_LIMITS.anchors,
};

/** Append broken-link and broken-anchor issues for the supplied tree. */
export function collectLinkIssues(
  files: DocsTree,
  issues: DeterministicDocsIssue[],
): Result<void, DeterministicDocsCheckError> {
  const documents: Record<string, string> = {};
  for (const path of ownPaths(files))
    if (path.endsWith(".md") || path.endsWith(".mdx"))
      documents[path] = files[path] ?? "";

  const checked = Result.fromThrowable(
    () => checkLinks({ documents }, LINK_CHECK_LIMITS),
    () =>
      parseFailure(
        "documentation links",
        "malformed-input",
        "link parser rejected bounded input",
      ),
  )();
  if (checked.isErr()) return err(checked.error);
  if (checked.value.isOk()) return ok(undefined);

  const failure = checked.value.error;
  if (failure.type === "LinkBudgetExceeded")
    return err(
      boundFailure(
        BOUND_BY_LINK_BOUND[failure.bound],
        failure.source,
        failure.actual,
        LIMIT_BY_LINK_BOUND[failure.bound],
      ),
    );
  for (const error of failure.errors) {
    if (issues.length >= DOCS_AUDIT_LIMITS.issues) break;
    issues.push({
      kind: error.type === "BrokenAnchor" ? "broken-anchor" : "broken-link",
      path: error.source,
      detail: error.target,
    });
  }
  return ok(undefined);
}
