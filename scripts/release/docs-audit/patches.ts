/**
 * Allowlisted docs-audit patch proposals.
 *
 * The model never writes files. The controller validates unified diffs against
 * the docs/README allowlist and applies them only after explicit approval.
 */
import { dirname, join } from "node:path";
import { err, ok, type Result, ResultAsync } from "neverthrow";
import {
  DOCS_AUDIT_LIMITS,
  isAllowedDocsPatchPath,
  isSafeRelativePath,
} from "./policy.js";

export interface DocsAuditPatch {
  readonly path: string;
  readonly unifiedDiff: string;
}

export interface DocsAuditPatchApproval {
  readonly approved: true;
  readonly approvedBy: string;
}

export type DocsAuditPatchError =
  | { type: "DocsAuditPatchNotApproved" }
  | { type: "DocsAuditPatchPathRejected"; path: string }
  | { type: "DocsAuditPatchInvalid"; path: string; reason: string }
  | { type: "DocsAuditPatchApplyFailed"; path: string; reason: string }
  | {
      type: "DocsAuditPatchTooLarge";
      path: string;
      bytes: number;
      limit: number;
    }
  | { type: "DocsAuditPatchIoFailed"; path: string; message: string };

export interface AppliedDocsAuditPatch {
  readonly path: string;
  readonly next: string;
}

export interface ParsedUnifiedDiff {
  readonly path: string;
  readonly hunks: readonly ParsedHunk[];
  readonly created: boolean;
}

interface ParsedHunk {
  readonly oldStart: number;
  readonly oldCount: number;
  readonly lines: readonly HunkLine[];
}

type HunkLine =
  | { kind: "context"; text: string }
  | { kind: "delete"; text: string }
  | { kind: "insert"; text: string };

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

export function validateDocsAuditPatch(
  patch: DocsAuditPatch,
  original: string | undefined,
): Result<ParsedUnifiedDiff, DocsAuditPatchError> {
  if (!isAllowedDocsPatchPath(patch.path) || !isSafeRelativePath(patch.path))
    return err({ type: "DocsAuditPatchPathRejected", path: patch.path });
  const bytes = utf8ByteLength(patch.unifiedDiff);
  if (bytes > DOCS_AUDIT_LIMITS.diffBytes)
    return err({
      type: "DocsAuditPatchTooLarge",
      path: patch.path,
      bytes,
      limit: DOCS_AUDIT_LIMITS.diffBytes,
    });
  const parsed = parseUnifiedDiff(patch);
  if (parsed.isErr()) return err(parsed.error);
  const applied = applyParsedDiff(original ?? "", parsed.value);
  if (applied.isErr()) return err(applied.error);
  return ok(parsed.value);
}

/**
 * Applies already-validated patches. Refuses unless explicit approval is
 * present; never writes workflows, scripts, or product source.
 */
export function applyDocsAuditPatches(input: {
  contentRoot: string;
  patches: readonly DocsAuditPatch[];
  originals: ReadonlyMap<string, string | undefined>;
  approval: DocsAuditPatchApproval | { readonly approved: false };
}): Result<readonly AppliedDocsAuditPatch[], DocsAuditPatchError> {
  if (input.approval.approved !== true)
    return err({ type: "DocsAuditPatchNotApproved" });
  if (input.patches.length > DOCS_AUDIT_LIMITS.patches)
    return err({
      type: "DocsAuditPatchInvalid",
      path: "",
      reason: "too_many_patches",
    });
  const applied: AppliedDocsAuditPatch[] = [];
  const seen = new Set<string>();
  for (const patch of input.patches) {
    if (seen.has(patch.path))
      return err({
        type: "DocsAuditPatchInvalid",
        path: patch.path,
        reason: "duplicate_path",
      });
    seen.add(patch.path);
    const parsed = validateDocsAuditPatch(
      patch,
      input.originals.get(patch.path),
    );
    if (parsed.isErr()) return err(parsed.error);
    const next = applyParsedDiff(
      input.originals.get(patch.path) ?? "",
      parsed.value,
    );
    if (next.isErr()) return err(next.error);
    applied.push({ path: patch.path, next: next.value });
  }
  return ok(applied);
}

export function writeAppliedDocsAuditPatches(input: {
  contentRoot: string;
  applied: readonly AppliedDocsAuditPatch[];
}): ResultAsync<void, DocsAuditPatchError> {
  return ResultAsync.fromPromise(
    (async () => {
      for (const patch of input.applied) {
        const destination = join(input.contentRoot, patch.path);
        await Bun.write(destination, patch.next);
      }
    })(),
    (cause) => ({
      type: "DocsAuditPatchIoFailed" as const,
      path: input.applied[0]?.path ?? "",
      message: String(cause),
    }),
  );
}

export function parseUnifiedDiff(
  patch: DocsAuditPatch,
): Result<ParsedUnifiedDiff, DocsAuditPatchError> {
  const lines = patch.unifiedDiff.replaceAll("\r\n", "\n").split("\n");
  if (lines.length > DOCS_AUDIT_LIMITS.diffLines)
    return err({
      type: "DocsAuditPatchInvalid",
      path: patch.path,
      reason: "too_many_lines",
    });
  let oldPath: string | undefined;
  let newPath: string | undefined;
  const hunks: ParsedHunk[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (line.length === 0 && index === lines.length - 1) {
      index += 1;
      continue;
    }
    if (line.startsWith("diff --git ")) {
      index += 1;
      continue;
    }
    if (line.startsWith("index ") || line.startsWith("similarity ")) {
      index += 1;
      continue;
    }
    if (line.startsWith("--- ")) {
      oldPath = stripDiffPath(line.slice(4));
      index += 1;
      continue;
    }
    if (line.startsWith("+++ ")) {
      newPath = stripDiffPath(line.slice(4));
      index += 1;
      continue;
    }
    if (line.startsWith("@@ ")) {
      const hunk = readHunk(patch.path, lines, index);
      if (hunk.isErr()) return err(hunk.error);
      hunks.push(hunk.value.hunk);
      index = hunk.value.nextIndex;
      continue;
    }
    return err({
      type: "DocsAuditPatchInvalid",
      path: patch.path,
      reason: "unexpected_line",
    });
  }
  const created = oldPath === "/dev/null";
  const deleted = newPath === "/dev/null";
  if (deleted)
    return err({
      type: "DocsAuditPatchInvalid",
      path: patch.path,
      reason: "delete_not_allowed",
    });
  const declared = created ? newPath : (newPath ?? oldPath);
  if (declared === undefined || hunks.length === 0)
    return err({
      type: "DocsAuditPatchInvalid",
      path: patch.path,
      reason: "missing_hunks",
    });
  if (
    !created &&
    oldPath !== undefined &&
    newPath !== undefined &&
    oldPath !== newPath
  )
    return err({
      type: "DocsAuditPatchInvalid",
      path: patch.path,
      reason: "rename_not_allowed",
    });
  if (declared !== patch.path)
    return err({
      type: "DocsAuditPatchInvalid",
      path: patch.path,
      reason: "path_mismatch",
    });
  return ok({ path: patch.path, hunks, created });
}

function readHunk(
  path: string,
  lines: readonly string[],
  start: number,
): Result<{ hunk: ParsedHunk; nextIndex: number }, DocsAuditPatchError> {
  const header = lines[start] ?? "";
  const match = HUNK_HEADER.exec(header);
  if (match === null)
    return err({
      type: "DocsAuditPatchInvalid",
      path,
      reason: "bad_hunk_header",
    });
  const oldStart = Number(match[1]);
  const oldCount = Number(match[2] ?? "1");
  const hunkLines: HunkLine[] = [];
  let index = start + 1;
  while (index < lines.length) {
    const line = lines[index];
    if (line === undefined) break;
    if (
      line.startsWith("@@ ") ||
      line.startsWith("--- ") ||
      line.startsWith("diff --git ")
    )
      break;
    if (line.length === 0 && index === lines.length - 1) {
      index += 1;
      break;
    }
    const marker = line[0];
    const text = line.slice(1);
    if (marker === " ") hunkLines.push({ kind: "context", text });
    else if (marker === "-") hunkLines.push({ kind: "delete", text });
    else if (marker === "+") hunkLines.push({ kind: "insert", text });
    else if (marker === "\\") {
      index += 1;
      continue;
    } else
      return err({
        type: "DocsAuditPatchInvalid",
        path,
        reason: "bad_hunk_line",
      });
    index += 1;
  }
  return ok({
    hunk: { oldStart, oldCount, lines: hunkLines },
    nextIndex: index,
  });
}

export function applyParsedDiff(
  original: string,
  parsed: ParsedUnifiedDiff,
): Result<string, DocsAuditPatchError> {
  if (parsed.created && original.length > 0)
    return err({
      type: "DocsAuditPatchApplyFailed",
      path: parsed.path,
      reason: "target_exists",
    });
  const source = original.replaceAll("\r\n", "\n");
  const endedWithNewline = source.endsWith("\n") || source.length === 0;
  let oldLines: string[];
  if (source.length === 0) oldLines = [];
  else if (source.endsWith("\n")) oldLines = source.slice(0, -1).split("\n");
  else oldLines = source.split("\n");
  const next: string[] = [];
  let cursor = 0;
  for (const hunk of parsed.hunks) {
    const start = Math.max(hunk.oldStart - 1, 0);
    if (start < cursor)
      return err({
        type: "DocsAuditPatchApplyFailed",
        path: parsed.path,
        reason: "hunk_overlap",
      });
    next.push(...oldLines.slice(cursor, start));
    cursor = start;
    for (const line of hunk.lines) {
      if (line.kind === "insert") {
        next.push(line.text);
        continue;
      }
      const current = oldLines[cursor];
      if (current === undefined || current !== line.text)
        return err({
          type: "DocsAuditPatchApplyFailed",
          path: parsed.path,
          reason: "context_mismatch",
        });
      if (line.kind === "context") next.push(current);
      cursor += 1;
    }
  }
  next.push(...oldLines.slice(cursor));
  const joined = next.join("\n");
  if (endedWithNewline) return ok(next.length === 0 ? "" : `${joined}\n`);
  return ok(joined);
}

function stripDiffPath(value: string): string {
  const trimmed = value.trim().split("\t", 1)[0] ?? "";
  if (trimmed === "/dev/null") return trimmed;
  if (trimmed.startsWith("a/") || trimmed.startsWith("b/"))
    return trimmed.slice(2);
  return trimmed;
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function patchParentDirectory(path: string): string {
  return dirname(path);
}
