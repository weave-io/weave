import { err, ok, Result } from "neverthrow";
import { PUBLIC_PACKAGES, type PublicPackageName } from "./constants.js";

/** The bounded byte budget for a packed scratch changelog. */
export const SCRATCH_CHANGELOG_BYTE_BUDGET = 16 * 1024;

export const SCRATCH_CHANGELOG_PURPOSES = [
  "next",
  "nightly",
  "candidate-readiness",
  "bootstrap",
] as const;

export type ScratchChangelogPurpose =
  (typeof SCRATCH_CHANGELOG_PURPOSES)[number];

export interface ScratchHistoryEntry {
  /** Commit subject supplied by the deterministic source-history reader. */
  readonly subject: string;
  /** Optional commit identity. It is metadata, not generated prose. */
  readonly sha?: string;
}

export interface ScratchChangesetIdentity {
  readonly id: string;
  readonly sourceDigest?: string;
}

/** Inputs are deliberately limited to deterministic, caller-supplied facts. */
export interface ScratchChangelogInput {
  readonly purpose: ScratchChangelogPurpose;
  readonly packageName: PublicPackageName;
  readonly version: string;
  readonly sourceSha: string;
  /** Canonical release-note location. It is never replaced by AI output. */
  readonly canonicalNotesUrl: string;
  readonly sourceHistory?: readonly ScratchHistoryEntry[];
  readonly pendingChangesets?: readonly ScratchChangesetIdentity[];
  readonly byteBudget?: number;
}

export type ScratchChangelogError =
  | { readonly type: "InvalidScratchChangelogInput"; readonly field: string }
  | {
      readonly type: "ScratchChangelogTooLarge";
      readonly bytes: number;
      readonly budget: number;
    };

const FULL_SHA = /^[0-9a-f]{40}$/;
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const MAX_HISTORY = 128;
const MAX_CHANGESETS = 512;
const MAX_SUBJECT_BYTES = 512;
const MAX_ID_BYTES = 256;
const MAX_URL_BYTES = 2048;

/**
 * Renders a useful scratch changelog without invoking a model or reading any
 * ambient clock. The same facts always produce the same bytes.
 */
export function renderScratchChangelog(
  input: ScratchChangelogInput,
): Result<string, ScratchChangelogError> {
  const valid = validateInput(input);
  if (valid.isErr()) return err(valid.error);

  const history = normalizeHistory(input.sourceHistory ?? []);
  const changesets = normalizeChangesets(input.pendingChangesets ?? []);
  const lines = [
    `# ${input.packageName}`,
    "",
    `## ${input.version}`,
    "",
    notice(input.purpose),
    "",
    "### Identity",
    "",
    `- Package: ${input.packageName}`,
    `- Version: ${input.version}`,
    `- Source SHA: ${input.sourceSha}`,
    `- Purpose: ${input.purpose}`,
    `- Canonical notes: ${input.canonicalNotesUrl}`,
    "",
    "### Source history",
    "",
    ...(history.length === 0
      ? ["- No source commits were supplied for this covered range."]
      : history.map((entry) =>
          entry.sha === undefined
            ? `- ${entry.subject}`
            : `- ${entry.subject} (${entry.sha})`,
        )),
    "",
    "### Pending changesets",
    "",
    ...(changesets.length === 0
      ? ["- No pending changesets were supplied for this covered range."]
      : changesets.map((entry) =>
          entry.sourceDigest === undefined
            ? `- ${entry.id}`
            : `- ${entry.id} (${entry.sourceDigest})`,
        )),
    "",
  ];
  const rendered = `${lines.join("\n")}\n`;
  const bytes = new TextEncoder().encode(rendered).byteLength;
  const budget = input.byteBudget ?? SCRATCH_CHANGELOG_BYTE_BUDGET;
  if (bytes > budget)
    return err({ type: "ScratchChangelogTooLarge", bytes, budget });
  return ok(rendered);
}

/** Short alias for callers that treat the renderer as a pure value function. */
export const scratchChangelog = renderScratchChangelog;

/** Returns the fixed notice used for a purpose. */
export function scratchChangelogNotice(
  purpose: ScratchChangelogPurpose,
): string {
  return notice(purpose);
}

function validateInput(
  input: ScratchChangelogInput,
): Result<void, ScratchChangelogError> {
  if (!Object.hasOwn(PUBLIC_PACKAGES, input.packageName))
    return err({ type: "InvalidScratchChangelogInput", field: "packageName" });
  if (!SEMVER.test(input.version))
    return err({ type: "InvalidScratchChangelogInput", field: "version" });
  if (input.purpose === "bootstrap" && input.version !== "0.0.0")
    return err({ type: "InvalidScratchChangelogInput", field: "version" });
  if (!FULL_SHA.test(input.sourceSha))
    return err({ type: "InvalidScratchChangelogInput", field: "sourceSha" });
  if (!isSafeNotesUrl(input.canonicalNotesUrl))
    return err({
      type: "InvalidScratchChangelogInput",
      field: "canonicalNotesUrl",
    });
  const history = input.sourceHistory ?? [];
  if (history.length > MAX_HISTORY)
    return err({
      type: "InvalidScratchChangelogInput",
      field: "sourceHistory",
    });
  for (const entry of history) {
    if (!boundedText(entry.subject, MAX_SUBJECT_BYTES))
      return err({
        type: "InvalidScratchChangelogInput",
        field: "sourceHistory.subject",
      });
    if (entry.sha !== undefined && !FULL_SHA.test(entry.sha))
      return err({
        type: "InvalidScratchChangelogInput",
        field: "sourceHistory.sha",
      });
  }
  const changesets = input.pendingChangesets ?? [];
  if (changesets.length > MAX_CHANGESETS)
    return err({
      type: "InvalidScratchChangelogInput",
      field: "pendingChangesets",
    });
  for (const entry of changesets) {
    if (!boundedText(entry.id, MAX_ID_BYTES))
      return err({
        type: "InvalidScratchChangelogInput",
        field: "pendingChangesets.id",
      });
    if (entry.sourceDigest !== undefined && !DIGEST.test(entry.sourceDigest))
      return err({
        type: "InvalidScratchChangelogInput",
        field: "pendingChangesets.sourceDigest",
      });
  }
  const budget = input.byteBudget ?? SCRATCH_CHANGELOG_BYTE_BUDGET;
  if (
    !Number.isInteger(budget) ||
    budget < 1 ||
    budget > SCRATCH_CHANGELOG_BYTE_BUDGET
  )
    return err({ type: "InvalidScratchChangelogInput", field: "byteBudget" });
  return ok(undefined);
}

function notice(purpose: ScratchChangelogPurpose): string {
  switch (purpose) {
    case "next":
      return "This is a deterministic current prerelease scratch changelog. Canonical next notes are published only at the canonical notes location above.";
    case "nightly":
      return "This is a deterministic nightly snapshot scratch changelog. Release notes are not generated for this artifact.";
    case "candidate-readiness":
      return "This is a deterministic candidate-readiness scratch changelog used to validate release bytes before stable publication.";
    case "bootstrap":
      return "This unsupported 0.0.0 package exists only to establish trusted publishing. It is not a supported release.";
  }
}

function normalizeHistory(
  entries: readonly ScratchHistoryEntry[],
): readonly ScratchHistoryEntry[] {
  return [...entries].sort((left, right) => {
    const leftKey = `${left.sha ?? ""}\u0000${left.subject}`;
    const rightKey = `${right.sha ?? ""}\u0000${right.subject}`;
    return compareText(leftKey, rightKey);
  });
}

function normalizeChangesets(
  entries: readonly ScratchChangesetIdentity[],
): readonly ScratchChangesetIdentity[] {
  return [...entries].sort((left, right) => {
    const leftKey = `${left.id}\u0000${left.sourceDigest ?? ""}`;
    const rightKey = `${right.id}\u0000${right.sourceDigest ?? ""}`;
    return compareText(leftKey, rightKey);
  });
}

function isSafeNotesUrl(value: string): boolean {
  if (!boundedText(value, MAX_URL_BYTES)) return false;
  const parsed = Result.fromThrowable(
    () => new URL(value),
    () => undefined,
  )();
  return (
    parsed.isOk() &&
    parsed.value.protocol === "https:" &&
    parsed.value.username === "" &&
    parsed.value.password === ""
  );
}

function boundedText(value: string, bytes: number): boolean {
  const hasControlCharacter = [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
  return (
    value.length > 0 &&
    !hasControlCharacter &&
    new TextEncoder().encode(value).byteLength <= bytes
  );
}

function compareText(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}
