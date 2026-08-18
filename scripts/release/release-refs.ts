/**
 * Annotated tags and GitHub releases for a finished publication batch.
 *
 * Tags and releases are a single all-package batch that starts only after
 * every closure member is `published` or exact-digest `already-published` and
 * registry-verified. Each tag is `<unscoped-name>@<version>` and must point
 * at `releasedSha` — never `baseSha`, a build SHA, or some other head.
 *
 * Stable and `next` refs are create-once and idempotent: an existing identical
 * tag plus release is skipped, a conflict is a typed failure, and a partial
 * batch resumes by creating only the missing items. Nightly creates no Git
 * refs. The marker-ref lifecycle is not this module's concern.
 */
import {
  err,
  errAsync,
  ok,
  okAsync,
  type Result,
  type ResultAsync,
} from "neverthrow";
import type { PublicPackageName, ReleaseChannel } from "./constants.js";
import type { GitHubError } from "./errors.js";
import {
  composeReleaseNotes,
  type NotesWrapperError,
  releaseTagName,
} from "./notes-wrapper.js";
import { publishablePackageNames } from "./package-policy.js";
import {
  type PublicationError,
  type PublicationMember,
  type PublicationReport,
  validatePublicationReport,
} from "./publish-executor.js";

const FULL_SHA = /^[0-9a-f]{40}$/;

export type ReleaseRefsError =
  | { type: "InvalidReleasedSha"; sha: string }
  | {
      type: "ReleasedShaMismatch";
      field:
        | "tagTarget"
        | "publicationReport"
        | "baseSha"
        | "builtSha"
        | "headSha";
      expected: string;
      actual: string;
    }
  | {
      type: "PublicationReportIncomplete";
      members: readonly PublicationMember[];
    }
  | {
      type: "PublicationClosureMismatch";
      missing: readonly PublicPackageName[];
      unexpected: readonly PublicPackageName[];
    }
  | {
      type: "PublicationMemberMismatch";
      packageName: PublicPackageName;
      field: "version" | "channel";
      expected: string;
      actual: string;
    }
  | { type: "InvalidPublicationReport"; error: PublicationError }
  | {
      type: "ExistingTagConflict";
      tag: string;
      expectedSha: string;
      actualSha: string;
    }
  | { type: "ExistingReleaseConflict"; tag: string; reason: string }
  | { type: "ReleaseNotesFailed"; error: NotesWrapperError }
  | { type: "ChangelogMissing"; packageName: PublicPackageName }
  | GitHubError;

export interface ReleasePackageVersion {
  packageName: PublicPackageName;
  version: string;
  previousVersion?: string;
}

export interface ExistingGitTag {
  name: string;
  /** Peeled commit SHA the annotated tag points at. */
  commitSha: string;
}

export interface ExistingGitHubRelease {
  tag: string;
  targetSha: string;
  notes: string;
  draft: boolean;
  prerelease: boolean;
}

/**
 * Create-once GitHub surface for tags and releases. It has no update or
 * delete method: existing refs are compared, never mutated.
 */
export interface ReleaseRefsGitHub {
  readTag(tag: string): ResultAsync<ExistingGitTag | null, GitHubError>;
  createAnnotatedTag(input: {
    tag: string;
    commitSha: string;
    message: string;
  }): ResultAsync<void, GitHubError>;
  readRelease(
    tag: string,
  ): ResultAsync<ExistingGitHubRelease | null, GitHubError>;
  createRelease(input: {
    tag: string;
    targetSha: string;
    name: string;
    notes: string;
    prerelease: boolean;
  }): ResultAsync<void, GitHubError>;
}

export interface ReleaseRefsInput {
  channel: ReleaseChannel;
  releasedSha: string;
  /** The commit the caller is about to tag. Must equal `releasedSha`. */
  tagTargetSha: string;
  baseSha: string;
  builtSha?: string;
  headSha?: string;
  closure: readonly PublicPackageName[];
  versions: readonly ReleasePackageVersion[];
  report: PublicationReport;
  changelogs: Readonly<Record<string, string>>;
}

export type ReleaseRefItemOutcome = "created" | "skipped";

export interface ReleaseRefItem {
  packageName: PublicPackageName;
  tag: string;
  tagOutcome: ReleaseRefItemOutcome;
  releaseOutcome: ReleaseRefItemOutcome;
}

export type ReleaseRefsResult =
  | { status: "skipped"; reason: "nightly"; items: readonly [] }
  | { status: "applied"; items: readonly ReleaseRefItem[] };

/** True when a member may authorize tags and releases. */
export function isRefsReadyMember(member: PublicationMember): boolean {
  return (
    member.verification === "digest-verified" &&
    (member.status === "published" || member.status === "already-published")
  );
}

/**
 * Refuses the batch unless every closure member is published (or already
 * published on the exact digest) and registry-verified.
 */
export function assertRefsPublicationGate(
  input: Pick<
    ReleaseRefsInput,
    "channel" | "releasedSha" | "closure" | "report"
  >,
): Result<void, ReleaseRefsError> {
  const report = validatePublicationReport(input.report);
  if (report.isErr())
    return err({ type: "InvalidPublicationReport", error: report.error });
  if (report.value.channel !== input.channel)
    return err({
      type: "PublicationMemberMismatch",
      packageName: input.closure[0] ?? publishablePackageNames()[0],
      field: "channel",
      expected: input.channel,
      actual: report.value.channel,
    });
  if (report.value.releasedSha !== input.releasedSha)
    return err({
      type: "ReleasedShaMismatch",
      field: "publicationReport",
      expected: input.releasedSha,
      actual: report.value.releasedSha,
    });
  const selected = uniqueClosure(input.closure);
  const reported = new Map(
    report.value.members.map((member) => [member.packageName, member]),
  );
  const missing = selected.filter((name) => !reported.has(name));
  const unexpected = report.value.members
    .map((member) => member.packageName)
    .filter((name) => !selected.includes(name));
  if (missing.length > 0 || unexpected.length > 0)
    return err({ type: "PublicationClosureMismatch", missing, unexpected });
  const unfinished = report.value.members.filter(
    (member) => !isRefsReadyMember(member),
  );
  if (unfinished.length > 0)
    return err({
      type: "PublicationReportIncomplete",
      members: unfinished,
    });
  return ok(undefined);
}

/**
 * Tags bind to `releasedSha` only. Passing the plan base, a build SHA, or
 * some other head is a typed mismatch even when those SHAs happen to be
 * well-formed.
 */
export function assertReleasedShaTarget(
  input: Pick<
    ReleaseRefsInput,
    "releasedSha" | "tagTargetSha" | "baseSha" | "builtSha" | "headSha"
  >,
): Result<void, ReleaseRefsError> {
  if (!FULL_SHA.test(input.releasedSha))
    return err({ type: "InvalidReleasedSha", sha: input.releasedSha });
  if (!FULL_SHA.test(input.tagTargetSha))
    return err({ type: "InvalidReleasedSha", sha: input.tagTargetSha });
  if (
    input.tagTargetSha === input.baseSha &&
    input.tagTargetSha !== input.releasedSha
  )
    return err({
      type: "ReleasedShaMismatch",
      field: "baseSha",
      expected: input.releasedSha,
      actual: input.tagTargetSha,
    });
  if (
    input.builtSha !== undefined &&
    input.tagTargetSha === input.builtSha &&
    input.tagTargetSha !== input.releasedSha
  )
    return err({
      type: "ReleasedShaMismatch",
      field: "builtSha",
      expected: input.releasedSha,
      actual: input.tagTargetSha,
    });
  if (
    input.headSha !== undefined &&
    input.tagTargetSha === input.headSha &&
    input.tagTargetSha !== input.releasedSha
  )
    return err({
      type: "ReleasedShaMismatch",
      field: "headSha",
      expected: input.releasedSha,
      actual: input.tagTargetSha,
    });
  if (input.tagTargetSha !== input.releasedSha)
    return err({
      type: "ReleasedShaMismatch",
      field: "tagTarget",
      expected: input.releasedSha,
      actual: input.tagTargetSha,
    });
  return ok(undefined);
}

/** Serial, idempotent tag and release batch over one verified publication. */
export class ReleaseRefsController {
  constructor(private readonly github: ReleaseRefsGitHub) {}

  apply(
    input: ReleaseRefsInput,
  ): ResultAsync<ReleaseRefsResult, ReleaseRefsError> {
    const gated = assertRefsPublicationGate(input).andThen(() =>
      assertReleasedShaTarget(input),
    );
    if (gated.isErr()) return errAsync(gated.error);
    if (input.channel === "nightly")
      return okAsync({ status: "skipped", reason: "nightly", items: [] });
    return this.applyMembers(input, orderedMembers(input), 0, []);
  }

  private applyMembers(
    input: ReleaseRefsInput,
    members: readonly PublicationMember[],
    index: number,
    done: readonly ReleaseRefItem[],
  ): ResultAsync<ReleaseRefsResult, ReleaseRefsError> {
    const member = members[index];
    if (member === undefined)
      return okAsync({ status: "applied", items: done });
    const planned = this.planMember(input, member);
    if (planned.isErr()) return errAsync(planned.error);
    return this.syncMember(input, planned.value).andThen((item) =>
      this.applyMembers(input, members, index + 1, [...done, item]),
    );
  }

  private planMember(
    input: ReleaseRefsInput,
    member: PublicationMember,
  ): Result<PlannedRef, ReleaseRefsError> {
    const version = input.versions.find(
      (entry) => entry.packageName === member.packageName,
    );
    if (version === undefined || version.version !== member.version)
      return err({
        type: "PublicationMemberMismatch",
        packageName: member.packageName,
        field: "version",
        expected: version?.version ?? "",
        actual: member.version,
      });
    const changelog = input.changelogs[member.packageName];
    if (changelog === undefined)
      return err({ type: "ChangelogMissing", packageName: member.packageName });
    const notes = composeReleaseNotes({
      packageName: member.packageName,
      version: member.version,
      previousVersion: version.previousVersion,
      releasedSha: input.releasedSha,
      tarballSha256: member.tarballSha256,
      changelog,
    });
    if (notes.isErr())
      return err({ type: "ReleaseNotesFailed", error: notes.error });
    return ok({
      packageName: member.packageName,
      tag: releaseTagName(member.packageName, member.version),
      notes: notes.value,
      prerelease: input.channel === "next",
    });
  }

  private syncMember(
    input: ReleaseRefsInput,
    planned: PlannedRef,
  ): ResultAsync<ReleaseRefItem, ReleaseRefsError> {
    return this.syncTag(input, planned).andThen((tagOutcome) =>
      this.syncRelease(input, planned).map((releaseOutcome) => ({
        packageName: planned.packageName,
        tag: planned.tag,
        tagOutcome,
        releaseOutcome,
      })),
    );
  }

  private syncTag(
    input: ReleaseRefsInput,
    planned: PlannedRef,
  ): ResultAsync<ReleaseRefItemOutcome, ReleaseRefsError> {
    return this.github.readTag(planned.tag).andThen((existing) => {
      if (existing === null)
        return this.github
          .createAnnotatedTag({
            tag: planned.tag,
            commitSha: input.releasedSha,
            message: planned.tag,
          })
          .map(() => "created" as const);
      if (existing.commitSha !== input.releasedSha)
        return errAsync({
          type: "ExistingTagConflict" as const,
          tag: planned.tag,
          expectedSha: input.releasedSha,
          actualSha: existing.commitSha,
        });
      return okAsync("skipped" as const);
    });
  }

  private syncRelease(
    input: ReleaseRefsInput,
    planned: PlannedRef,
  ): ResultAsync<ReleaseRefItemOutcome, ReleaseRefsError> {
    return this.github.readRelease(planned.tag).andThen((existing) => {
      if (existing === null)
        return this.github
          .createRelease({
            tag: planned.tag,
            targetSha: input.releasedSha,
            name: planned.tag,
            notes: planned.notes,
            prerelease: planned.prerelease,
          })
          .map(() => "created" as const);
      const conflict = releaseConflict(existing, input, planned);
      if (conflict !== undefined)
        return errAsync({
          type: "ExistingReleaseConflict" as const,
          tag: planned.tag,
          reason: conflict,
        });
      return okAsync("skipped" as const);
    });
  }
}

interface PlannedRef {
  packageName: PublicPackageName;
  tag: string;
  notes: string;
  prerelease: boolean;
}

function releaseConflict(
  existing: ExistingGitHubRelease,
  input: ReleaseRefsInput,
  planned: PlannedRef,
): string | undefined {
  if (existing.draft) return "existing release is a draft";
  if (existing.prerelease !== planned.prerelease)
    return existing.prerelease
      ? "existing release is a prerelease"
      : "existing release is not a prerelease";
  if (existing.targetSha !== input.releasedSha)
    return `target ${existing.targetSha}`;
  if (existing.notes !== planned.notes) return "notes differ";
  return undefined;
}

function orderedMembers(input: ReleaseRefsInput): PublicationMember[] {
  const catalog = publishablePackageNames();
  const byPackage = new Map(
    input.report.members.map((member) => [member.packageName, member]),
  );
  return catalog.flatMap((name) => {
    const member = byPackage.get(name);
    return member === undefined ? [] : [member];
  });
}

function uniqueClosure(
  closure: readonly PublicPackageName[],
): PublicPackageName[] {
  const catalog = publishablePackageNames();
  return catalog.filter((name) => closure.includes(name));
}
