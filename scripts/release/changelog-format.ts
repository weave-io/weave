/**
 * The canonical per-package changelog: one format, rendered and read here.
 *
 * A published `CHANGELOG.md` is the human half of the release authority, and
 * the consumption ledger inside it is the machine half. Both halves live in
 * the same file, so this module owns exactly one document shape:
 *
 * ```md
 * # @weaveio/weave-cli
 *
 * ## 0.1.0
 *
 * <!-- weave-release-ledger:1
 * { ... }
 * -->
 *
 * ### Added
 *
 * <!-- weave-changelog-entry:1 ["portable-delegation-limits"] -->
 * - Delegation limits are portable across harnesses (#412)
 * ```
 *
 * Four rules make that shape worth having:
 *
 * 1. **Version headings carry a version and nothing else.** No dates, no
 *    links, no brackets — a heading is `## <semver>`, so the enclosing version
 *    of every ledger block is unambiguous to both readers and parsers.
 * 2. **Sections are a closed, ordered set.** {@link CHANGELOG_SECTIONS} is the
 *    whole vocabulary, always rendered in that order, and a section only
 *    appears when it has entries. An unknown or out-of-order heading is a
 *    typed failure, never a silently ignored line.
 * 3. **Source mapping never lives in prose.** Each entry is preceded by a
 *    hidden marker naming the changeset IDs it covers, and each version
 *    carries exactly one hidden ledger block — rendered by
 *    {@link renderLedgerBlock}, read back by {@link parseConsumptionLedger} —
 *    holding the union of those identities with their digests. A human may
 *    rewrite every word of an entry and the mapping survives byte for byte,
 *    which is what lets release-PR regeneration preserve human edits and lets
 *    the ledger stay consumption authority.
 * 4. **Refs are supplied, never invented.** An entry may cite pull requests
 *    and commits only from the caller's evidence set. Anything else is a typed
 *    failure on both render and parse.
 *
 * Divergence between the two halves fails closed in both directions: an entry
 * naming a changeset the version's ledger block does not record, or a ledger
 * identity no entry claims, is an error rather than a quietly lopsided
 * document — the mapping must always describe exactly the release it sits in.
 *
 * The heading-only stubs that precede the first canonical stable release are
 * valid documents with zero versions, so this parser validates the repository
 * as it stands today and as it will stand after the first release.
 */
import { err, ok, type Result } from "neverthrow";
import { z } from "zod";
import type { ChangesetIdentity } from "./changeset-policy.js";
import type { PublicPackageName } from "./constants.js";
import {
  type ChangelogSource,
  type ConsumptionLedger,
  type ConsumptionLedgerError,
  LEDGER_BLOCK_MARKER,
  LedgerChangesetIdentitySchema,
  LedgerChangesetIdSchema,
  LedgerPackageNameSchema,
  LedgerStableVersionSchema,
  parseConsumptionLedger,
  renderLedgerBlock,
} from "./consumption-ledger.js";
import { parseJsonValue } from "./json.js";

/** Every section a canonical changelog may carry, in render order. */
export const CHANGELOG_SECTIONS = [
  "Breaking Changes",
  "Added",
  "Changed",
  "Fixed",
  "Deprecated",
  "Security",
] as const;

export type ChangelogSectionName = (typeof CHANGELOG_SECTIONS)[number];

/** Opening word of the hidden per-entry source marker. */
export const ENTRY_MARKER = "weave-changelog-entry" as const;

/** Schema version of the entry-marker contract this module reads and writes. */
export const ENTRY_MARKER_SCHEMA_VERSION = 1 as const;

/** Bounds, so no document, entry, or evidence set is unbounded. */
export const CHANGELOG_LIMITS = {
  versions: 512,
  sectionEntries: 256,
  entryChangesets: 64,
  entryRefs: 16,
  proseLength: 2000,
  evidenceRefs: 512,
  pullRequestNumber: 1_000_000,
} as const;

const COMMENT_OPEN = "<!--";
const COMMENT_CLOSE = "-->";
const COMMIT_ID = /^[0-9a-f]{7,40}$/;
const PACKAGE_HEADING = /^#[ \t]+(.+?)[ \t]*$/;
const VERSION_HEADING = /^##[ \t]+(.+?)[ \t]*$/;
const SECTION_HEADING = /^###[ \t]+(.+?)[ \t]*$/;
const ENTRY_LINE = /^-(?:[ \t]+(.*))?$/;
const ENTRY_MARKER_LINE = new RegExp(
  `^${COMMENT_OPEN}[ \\t]*${ENTRY_MARKER}:(\\d+)[ \\t]+(.*?)[ \\t]*${COMMENT_CLOSE}$`,
);
const REF_TOKEN = "(?:#\\d+|`[0-9a-f]{7,40}`)";
const REF_SUFFIX = new RegExp(`[ \\t]\\((${REF_TOKEN}(?:, ${REF_TOKEN})*)\\)$`);
const ISO_DATE = /\d{4}-\d{2}-\d{2}/;

/**
 * Identity, package, and version contracts come from the ledger block, so the
 * two formats can never drift apart on what a changeset or a version is.
 */
const ChangesetIdentitySchema = LedgerChangesetIdentitySchema;
const ChangesetIdSchema = LedgerChangesetIdSchema;
const PublicPackageNameSchema = LedgerPackageNameSchema;
const StableVersionSchema = LedgerStableVersionSchema;

/** A ref an entry may cite: only what the controller supplied as evidence. */
export const ChangelogRefSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("pull-request"),
      number: z
        .number()
        .int()
        .positive()
        .max(CHANGELOG_LIMITS.pullRequestNumber),
    })
    .strict(),
  z
    .object({ kind: z.literal("commit"), commit: z.string().regex(COMMIT_ID) })
    .strict(),
]);

export type ChangelogRef = z.infer<typeof ChangelogRefSchema>;

/** One user-impact statement and the changesets that produced it. */
export interface ChangelogEntry {
  /** User-impact prose, on one line, with no mapping encoded in it. */
  prose: string;
  /** The changesets this entry speaks for; more than one means grouping. */
  sourceChangesets: readonly ChangesetIdentity[];
  /** Supplied refs only; omitted when the entry cites none. */
  refs?: readonly ChangelogRef[];
}

export interface ChangelogSection {
  name: ChangelogSectionName;
  entries: readonly ChangelogEntry[];
}

export interface ChangelogVersion {
  version: string;
  sections: readonly ChangelogSection[];
}

/** One public package's whole changelog history. */
export interface ChangelogDocument {
  packageName: PublicPackageName;
  /** Newest first; an empty history is the valid pre-release stub. */
  versions: readonly ChangelogVersion[];
}

const ChangelogEntrySchema = z
  .object({
    prose: z.string().min(1).max(CHANGELOG_LIMITS.proseLength),
    sourceChangesets: z
      .array(ChangesetIdentitySchema)
      .min(1)
      .max(CHANGELOG_LIMITS.entryChangesets),
    refs: z
      .array(ChangelogRefSchema)
      .max(CHANGELOG_LIMITS.entryRefs)
      .optional(),
  })
  .strict();

const ChangelogSectionSchema = z
  .object({
    name: z.enum(CHANGELOG_SECTIONS),
    entries: z
      .array(ChangelogEntrySchema)
      .min(1)
      .max(CHANGELOG_LIMITS.sectionEntries),
  })
  .strict();

const ChangelogVersionSchema = z
  .object({
    version: StableVersionSchema,
    sections: z
      .array(ChangelogSectionSchema)
      .min(1)
      .max(CHANGELOG_SECTIONS.length),
  })
  .strict();

/** The whole document contract, enforced on render input and parse output. */
export const ChangelogDocumentSchema = z
  .object({
    packageName: PublicPackageNameSchema,
    versions: z.array(ChangelogVersionSchema).max(CHANGELOG_LIMITS.versions),
  })
  .strict();

/** The refs a caller has proven exist. Anything else is uncitable. */
export interface ChangelogEvidence {
  pullRequests?: readonly number[];
  commits?: readonly string[];
}

const ChangelogEvidenceSchema = z
  .object({
    pullRequests: z
      .array(
        z.number().int().positive().max(CHANGELOG_LIMITS.pullRequestNumber),
      )
      .max(CHANGELOG_LIMITS.evidenceRefs)
      .optional(),
    commits: z
      .array(z.string().regex(COMMIT_ID))
      .max(CHANGELOG_LIMITS.evidenceRefs)
      .optional(),
  })
  .strict();

/** A parsed changelog: the human document and the ledger it carries. */
export interface ParsedChangelog {
  document: ChangelogDocument;
  /**
   * Byte-for-byte what {@link parseConsumptionLedger} reports for this source:
   * the ledger is read through that parser, never re-implemented here.
   */
  ledger: ConsumptionLedger;
}

const ENTRY_MARKER_PAYLOAD = z
  .array(ChangesetIdSchema)
  .min(1)
  .max(CHANGELOG_LIMITS.entryChangesets);

export type ChangelogFormatError =
  /** Shared: an entry cites a ref the caller never supplied. */
  | {
      type: "UnsupportedEntryRef";
      path: string | null;
      version: string;
      ref: string;
    }
  /** Shared: an entry cites the same ref twice. */
  | {
      type: "DuplicateEntryRef";
      path: string | null;
      version: string;
      ref: string;
    }
  /** Shared: two entries (or one entry twice) claim the same changeset. */
  | {
      type: "DuplicateEntryChangeset";
      path: string | null;
      version: string;
      id: string;
    }
  /** Render: the supplied model does not satisfy the document contract. */
  | { type: "InvalidChangelogDocument"; issues: readonly string[] }
  | { type: "InvalidChangelogEvidence"; issues: readonly string[] }
  | { type: "DuplicateDocumentVersion"; version: string }
  | {
      type: "DuplicateDocumentSection";
      version: string;
      section: ChangelogSectionName;
    }
  | { type: "InvalidEntryProse"; version: string; reason: string }
  | {
      type: "UnrenderableLedgerBlock";
      version: string;
      issues: readonly string[];
    }
  /** Parse: the document's shape is not the canonical one. */
  | { type: "MissingPackageHeading"; path: string }
  | {
      type: "PackageHeadingMismatch";
      path: string;
      expected: PublicPackageName;
      actual: string;
    }
  | { type: "InvalidVersionHeading"; path: string; heading: string }
  | { type: "DatedVersionHeading"; path: string; heading: string }
  | { type: "DuplicateVersionHeading"; path: string; version: string }
  | {
      type: "VersionHeadingOutOfOrder";
      path: string;
      version: string;
      previous: string;
    }
  | { type: "MissingLedgerBlock"; path: string; version: string }
  | { type: "MultipleLedgerBlocks"; path: string; version: string }
  | { type: "MisplacedLedgerBlock"; path: string; version: string | null }
  | { type: "SectionOutsideVersion"; path: string; heading: string }
  | {
      type: "UnknownSectionHeading";
      path: string;
      version: string;
      heading: string;
    }
  | {
      type: "DuplicateSectionHeading";
      path: string;
      version: string;
      section: ChangelogSectionName;
    }
  | {
      type: "SectionHeadingOutOfOrder";
      path: string;
      version: string;
      section: ChangelogSectionName;
      previous: ChangelogSectionName;
    }
  | {
      type: "EmptySectionBody";
      path: string;
      version: string;
      section: ChangelogSectionName;
    }
  | { type: "EntryOutsideSection"; path: string; line: number }
  | { type: "MissingEntryMarker"; path: string; version: string; line: number }
  | { type: "MissingEntryProse"; path: string; version: string; line: number }
  | {
      type: "MalformedEntryMarker";
      path: string;
      version: string;
      line: number;
      issues: readonly string[];
    }
  | { type: "EmptyEntryProse"; path: string; version: string; line: number }
  | {
      type: "UnexpectedChangelogContent";
      path: string;
      line: number;
      text: string;
    }
  | {
      type: "EntrySourceNotInLedger";
      path: string;
      version: string;
      id: string;
    }
  | {
      type: "LedgerSourceNotInEntries";
      path: string;
      version: string;
      id: string;
    }
  | {
      type: "ChangelogLedgerUnreadable";
      path: string;
      error: ConsumptionLedgerError;
    };

/**
 * Renders one package's whole history in canonical form.
 *
 * Versions are emitted newest first and sections in {@link CHANGELOG_SECTIONS}
 * order, so the same model always renders the same bytes; entry order inside a
 * section is the model's, because that ordering is editorial and belongs to
 * whoever wrote the entries. Every version gets exactly one ledger block, built
 * from the union of its entries' source identities.
 */
export function renderChangelog(
  document: ChangelogDocument,
  evidence: ChangelogEvidence = {},
): Result<string, ChangelogFormatError> {
  const validated = ChangelogDocumentSchema.safeParse(document);
  if (!validated.success)
    return err({
      type: "InvalidChangelogDocument",
      issues: describeIssues(validated.error.issues),
    });
  const allowed = normalizeEvidence(evidence);
  if (allowed.isErr()) return err(allowed.error);
  const ordered = orderDocumentVersions(document.versions);
  if (ordered.isErr()) return err(ordered.error);
  const blocks: string[] = [`# ${document.packageName}`];
  for (const version of ordered.value) {
    const rendered = renderVersion(
      document.packageName,
      version,
      allowed.value,
    );
    if (rendered.isErr()) return err(rendered.error);
    blocks.push(...rendered.value);
  }
  return ok(`${blocks.join("\n\n")}\n`);
}

/**
 * Reads a `CHANGELOG.md` back into the model, fail-closed on any divergence.
 *
 * The ledger half is read by {@link parseConsumptionLedger} rather than by a
 * second block parser, so what this returns as `ledger` is exactly what every
 * consumption computation sees on the same bytes. The human half is validated
 * against it: entries and ledger must name the same changesets.
 */
export function parseChangelog(
  source: ChangelogSource,
  evidence: ChangelogEvidence = {},
): Result<ParsedChangelog, ChangelogFormatError> {
  const allowed = normalizeEvidence(evidence);
  if (allowed.isErr()) return err(allowed.error);
  const drafts = readVersionDrafts(source, allowed.value);
  if (drafts.isErr()) return err(drafts.error);
  const ledger = parseConsumptionLedger([source]);
  if (ledger.isErr())
    return err({
      type: "ChangelogLedgerUnreadable",
      path: source.path,
      error: ledger.error,
    });
  const versions = resolveVersions(source, drafts.value, ledger.value);
  if (versions.isErr()) return err(versions.error);
  const document: ChangelogDocument = {
    packageName: source.packageName,
    versions: versions.value,
  };
  const validated = ChangelogDocumentSchema.safeParse(document);
  if (!validated.success)
    return err({
      type: "InvalidChangelogDocument",
      issues: describeIssues(validated.error.issues),
    });
  return ok({ document, ledger: ledger.value });
}

function renderVersion(
  packageName: PublicPackageName,
  version: ChangelogVersion,
  allowed: ReadonlySet<string>,
): Result<readonly string[], ChangelogFormatError> {
  const sections = orderSections(version);
  if (sections.isErr()) return err(sections.error);
  const identities: ChangesetIdentity[] = [];
  const claimed = new Set<string>();
  const body: string[] = [];
  for (const section of sections.value) {
    body.push(`### ${section.name}`);
    for (const entry of section.entries) {
      const rendered = renderEntry(version.version, entry, allowed);
      if (rendered.isErr()) return err(rendered.error);
      for (const identity of entry.sourceChangesets) {
        if (claimed.has(identity.id))
          return err({
            type: "DuplicateEntryChangeset",
            path: null,
            version: version.version,
            id: identity.id,
          });
        claimed.add(identity.id);
        identities.push(identity);
      }
      body.push(rendered.value);
    }
  }
  const block = renderLedgerBlock({
    package: packageName,
    version: version.version,
    changesets: identities,
  });
  if (block.isErr())
    return err({
      type: "UnrenderableLedgerBlock",
      version: version.version,
      issues: block.error.issues,
    });
  return ok([`## ${version.version}`, block.value, ...body]);
}

function renderEntry(
  version: string,
  entry: ChangelogEntry,
  allowed: ReadonlySet<string>,
): Result<string, ChangelogFormatError> {
  const prose = checkProse(version, entry.prose);
  if (prose.isErr()) return err(prose.error);
  const refs = entry.refs ?? [];
  const seen = new Set<string>();
  const tokens: string[] = [];
  for (const ref of refs) {
    const key = refKey(ref);
    if (seen.has(key))
      return err({
        type: "DuplicateEntryRef",
        path: null,
        version,
        ref: describeRef(ref),
      });
    seen.add(key);
    if (!allowed.has(key))
      return err({
        type: "UnsupportedEntryRef",
        path: null,
        version,
        ref: describeRef(ref),
      });
    tokens.push(renderRef(ref));
  }
  const marker = renderEntryMarker(entry.sourceChangesets);
  const suffix = tokens.length === 0 ? "" : ` (${tokens.join(", ")})`;
  return ok(`${marker}\n- ${prose.value}${suffix}`);
}

/**
 * Rejects prose that would not survive a round trip.
 *
 * Prose is one line, already trimmed, and must not end in something a reader
 * would read as a ref list — otherwise rendering and reading disagree on where
 * the sentence stops and the citations begin.
 */
function checkProse(
  version: string,
  prose: string,
): Result<string, ChangelogFormatError> {
  if (prose.trim() !== prose)
    return err({
      type: "InvalidEntryProse",
      version,
      reason: "prose carries leading or trailing whitespace",
    });
  if (prose.includes("\n") || prose.includes("\r"))
    return err({
      type: "InvalidEntryProse",
      version,
      reason: "prose spans more than one line",
    });
  if (prose.includes(COMMENT_OPEN) || prose.includes(COMMENT_CLOSE))
    return err({
      type: "InvalidEntryProse",
      version,
      reason: "prose contains an HTML comment delimiter",
    });
  if (REF_SUFFIX.test(prose))
    return err({
      type: "InvalidEntryProse",
      version,
      reason: "prose ends with text that reads as a reference list",
    });
  return ok(prose);
}

function renderEntryMarker(identities: readonly ChangesetIdentity[]): string {
  const ids = JSON.stringify(identities.map((identity) => identity.id));
  return `${COMMENT_OPEN} ${ENTRY_MARKER}:${ENTRY_MARKER_SCHEMA_VERSION} ${ids} ${COMMENT_CLOSE}`;
}

function renderRef(ref: ChangelogRef): string {
  if (ref.kind === "pull-request") return `#${ref.number}`;
  return `\`${ref.commit}\``;
}

function describeRef(ref: ChangelogRef): string {
  if (ref.kind === "pull-request") return `#${ref.number}`;
  return ref.commit;
}

function refKey(ref: ChangelogRef): string {
  if (ref.kind === "pull-request") return `pull-request:${ref.number}`;
  return `commit:${ref.commit}`;
}

function normalizeEvidence(
  evidence: ChangelogEvidence,
): Result<ReadonlySet<string>, ChangelogFormatError> {
  const validated = ChangelogEvidenceSchema.safeParse(evidence);
  if (!validated.success)
    return err({
      type: "InvalidChangelogEvidence",
      issues: describeIssues(validated.error.issues),
    });
  const allowed = new Set<string>();
  for (const number of validated.data.pullRequests ?? [])
    allowed.add(refKey({ kind: "pull-request", number }));
  for (const commit of validated.data.commits ?? [])
    allowed.add(refKey({ kind: "commit", commit }));
  return ok(allowed);
}

function orderDocumentVersions(
  versions: readonly ChangelogVersion[],
): Result<readonly ChangelogVersion[], ChangelogFormatError> {
  const seen = new Set<string>();
  for (const version of versions) {
    if (seen.has(version.version))
      return err({
        type: "DuplicateDocumentVersion",
        version: version.version,
      });
    seen.add(version.version);
  }
  return ok(
    [...versions].sort((left, right) =>
      compareVersions(right.version, left.version),
    ),
  );
}

function orderSections(
  version: ChangelogVersion,
): Result<readonly ChangelogSection[], ChangelogFormatError> {
  const seen = new Set<ChangelogSectionName>();
  for (const section of version.sections) {
    if (seen.has(section.name))
      return err({
        type: "DuplicateDocumentSection",
        version: version.version,
        section: section.name,
      });
    seen.add(section.name);
  }
  return ok(
    [...version.sections].sort(
      (left, right) => sectionOrder(left.name) - sectionOrder(right.name),
    ),
  );
}

function sectionOrder(name: ChangelogSectionName): number {
  return CHANGELOG_SECTIONS.indexOf(name);
}

interface EntryDraft {
  ids: readonly string[];
  prose: string;
  refs: readonly ChangelogRef[];
}

interface SectionDraft {
  name: ChangelogSectionName;
  entries: EntryDraft[];
}

interface VersionDraft {
  version: string;
  sections: SectionDraft[];
  ledgerBlocks: number;
}

interface ScanState {
  versions: VersionDraft[];
  pending: readonly string[] | null;
  pendingLine: number;
}

/**
 * Walks the document line by line and rebuilds its structure.
 *
 * Nothing is skipped: a line is a package heading, a version heading, a
 * section heading, a hidden block, an entry marker, an entry, or a typed
 * failure. Silent tolerance is what lets a changelog drift away from its
 * mapping, so this parser has none.
 */
function readVersionDrafts(
  source: ChangelogSource,
  allowed: ReadonlySet<string>,
): Result<readonly VersionDraft[], ChangelogFormatError> {
  const lines = source.contents.split("\n").map((line) => line.trimEnd());
  const start = readPackageHeading(source, lines);
  if (start.isErr()) return err(start.error);
  const state: ScanState = { versions: [], pending: null, pendingLine: 0 };
  let index = start.value;
  while (index < lines.length) {
    const line = (lines[index] ?? "").trim();
    const lineNumber = index + 1;
    if (line === "") {
      if (state.pending !== null)
        return err(pendingWithoutEntry(source, state, state.pendingLine));
      index += 1;
      continue;
    }
    if (line.startsWith(COMMENT_OPEN)) {
      const consumed = readComment(source, lines, index, state);
      if (consumed.isErr()) return err(consumed.error);
      index = consumed.value;
      continue;
    }
    const step = readStructuralLine(source, line, lineNumber, state, allowed);
    if (step.isErr()) return err(step.error);
    index += 1;
  }
  if (state.pending !== null)
    return err(pendingWithoutEntry(source, state, state.pendingLine));
  const closed = closeVersion(source, state);
  if (closed.isErr()) return err(closed.error);
  return ok(state.versions);
}

function readPackageHeading(
  source: ChangelogSource,
  lines: readonly string[],
): Result<number, ChangelogFormatError> {
  let index = 0;
  while (index < lines.length && (lines[index] ?? "").trim() === "") index += 1;
  const heading = lines[index] ?? null;
  const match = heading === null ? null : PACKAGE_HEADING.exec(heading.trim());
  if (match === null)
    return err({ type: "MissingPackageHeading", path: source.path });
  const actual = match[1] ?? "";
  if (actual !== source.packageName)
    return err({
      type: "PackageHeadingMismatch",
      path: source.path,
      expected: source.packageName,
      actual,
    });
  return ok(index + 1);
}

/** Reads one comment: a version's ledger block, or an entry's source marker. */
function readComment(
  source: ChangelogSource,
  lines: readonly string[],
  index: number,
  state: ScanState,
): Result<number, ChangelogFormatError> {
  const line = (lines[index] ?? "").trim();
  const lineNumber = index + 1;
  if (line.slice(COMMENT_OPEN.length).trim().startsWith(LEDGER_BLOCK_MARKER)) {
    const claimed = claimLedgerBlock(source, state);
    if (claimed.isErr()) return err(claimed.error);
    let cursor = index;
    while (
      cursor < lines.length &&
      !(lines[cursor] ?? "").includes(COMMENT_CLOSE)
    )
      cursor += 1;
    return ok(cursor + 1);
  }
  if (line.slice(COMMENT_OPEN.length).trim().startsWith(ENTRY_MARKER)) {
    const read = readEntryMarker(source, line, lineNumber, state);
    if (read.isErr()) return err(read.error);
    return ok(index + 1);
  }
  return err({
    type: "UnexpectedChangelogContent",
    path: source.path,
    line: lineNumber,
    text: line,
  });
}

function readStructuralLine(
  source: ChangelogSource,
  line: string,
  lineNumber: number,
  state: ScanState,
  allowed: ReadonlySet<string>,
): Result<void, ChangelogFormatError> {
  const entry = ENTRY_LINE.exec(line);
  if (entry !== null)
    return readEntryLine(source, entry[1] ?? "", lineNumber, state, allowed);
  if (state.pending !== null)
    return err(pendingWithoutEntry(source, state, state.pendingLine));
  const section = SECTION_HEADING.exec(line);
  if (section !== null)
    return readSectionHeading(source, section[1] ?? "", state);
  const version = VERSION_HEADING.exec(line);
  if (version !== null)
    return readVersionHeading(source, version[1] ?? "", state);
  return err({
    type: "UnexpectedChangelogContent",
    path: source.path,
    line: lineNumber,
    text: line,
  });
}

function readVersionHeading(
  source: ChangelogSource,
  heading: string,
  state: ScanState,
): Result<void, ChangelogFormatError> {
  const closed = closeVersion(source, state);
  if (closed.isErr()) return err(closed.error);
  const parsed = StableVersionSchema.safeParse(heading);
  if (!parsed.success) {
    if (ISO_DATE.test(heading))
      return err({
        type: "DatedVersionHeading",
        path: source.path,
        heading,
      });
    return err({ type: "InvalidVersionHeading", path: source.path, heading });
  }
  const previous = state.versions.at(-1) ?? null;
  if (state.versions.some((draft) => draft.version === parsed.data))
    return err({
      type: "DuplicateVersionHeading",
      path: source.path,
      version: parsed.data,
    });
  if (previous !== null && compareVersions(parsed.data, previous.version) > 0)
    return err({
      type: "VersionHeadingOutOfOrder",
      path: source.path,
      version: parsed.data,
      previous: previous.version,
    });
  state.versions.push({
    version: parsed.data,
    sections: [],
    ledgerBlocks: 0,
  });
  return ok();
}

function readSectionHeading(
  source: ChangelogSource,
  heading: string,
  state: ScanState,
): Result<void, ChangelogFormatError> {
  const version = state.versions.at(-1) ?? null;
  if (version === null)
    return err({
      type: "SectionOutsideVersion",
      path: source.path,
      heading,
    });
  const previous = version.sections.at(-1) ?? null;
  if (previous !== null && previous.entries.length === 0)
    return err({
      type: "EmptySectionBody",
      path: source.path,
      version: version.version,
      section: previous.name,
    });
  const name = CHANGELOG_SECTIONS.find((candidate) => candidate === heading);
  if (name === undefined)
    return err({
      type: "UnknownSectionHeading",
      path: source.path,
      version: version.version,
      heading,
    });
  if (version.sections.some((draft) => draft.name === name))
    return err({
      type: "DuplicateSectionHeading",
      path: source.path,
      version: version.version,
      section: name,
    });
  if (previous !== null && sectionOrder(name) < sectionOrder(previous.name))
    return err({
      type: "SectionHeadingOutOfOrder",
      path: source.path,
      version: version.version,
      section: name,
      previous: previous.name,
    });
  version.sections.push({ name, entries: [] });
  return ok();
}

function readEntryMarker(
  source: ChangelogSource,
  line: string,
  lineNumber: number,
  state: ScanState,
): Result<void, ChangelogFormatError> {
  const version = state.versions.at(-1) ?? null;
  const section = version?.sections.at(-1) ?? null;
  if (version === null || section === null)
    return err({
      type: "EntryOutsideSection",
      path: source.path,
      line: lineNumber,
    });
  if (state.pending !== null)
    return err(pendingWithoutEntry(source, state, state.pendingLine));
  const match = ENTRY_MARKER_LINE.exec(line);
  if (match === null)
    return err({
      type: "MalformedEntryMarker",
      path: source.path,
      version: version.version,
      line: lineNumber,
      issues: [`expected ${ENTRY_MARKER}:<schema version> <changeset ids>`],
    });
  const schemaVersion = Number(match[1]);
  if (schemaVersion !== ENTRY_MARKER_SCHEMA_VERSION)
    return err({
      type: "MalformedEntryMarker",
      path: source.path,
      version: version.version,
      line: lineNumber,
      issues: [`unsupported entry marker schema ${schemaVersion}`],
    });
  const decoded = parseJsonValue(match[2] ?? "").mapErr(
    (error) => error.message,
  );
  if (decoded.isErr())
    return err({
      type: "MalformedEntryMarker",
      path: source.path,
      version: version.version,
      line: lineNumber,
      issues: [decoded.error],
    });
  const ids = ENTRY_MARKER_PAYLOAD.safeParse(decoded.value);
  if (!ids.success)
    return err({
      type: "MalformedEntryMarker",
      path: source.path,
      version: version.version,
      line: lineNumber,
      issues: describeIssues(ids.error.issues),
    });
  state.pending = ids.data;
  state.pendingLine = lineNumber;
  return ok();
}

function readEntryLine(
  source: ChangelogSource,
  body: string,
  lineNumber: number,
  state: ScanState,
  allowed: ReadonlySet<string>,
): Result<void, ChangelogFormatError> {
  const version = state.versions.at(-1) ?? null;
  const section = version?.sections.at(-1) ?? null;
  if (version === null || section === null)
    return err({
      type: "EntryOutsideSection",
      path: source.path,
      line: lineNumber,
    });
  const ids = state.pending;
  if (ids === null)
    return err({
      type: "MissingEntryMarker",
      path: source.path,
      version: version.version,
      line: lineNumber,
    });
  state.pending = null;
  const split = splitRefs(body);
  if (split.prose.trim() === "")
    return err({
      type: "EmptyEntryProse",
      path: source.path,
      version: version.version,
      line: lineNumber,
    });
  const seen = new Set<string>();
  for (const ref of split.refs) {
    const key = refKey(ref);
    if (seen.has(key))
      return err({
        type: "DuplicateEntryRef",
        path: source.path,
        version: version.version,
        ref: describeRef(ref),
      });
    seen.add(key);
    if (!allowed.has(key))
      return err({
        type: "UnsupportedEntryRef",
        path: source.path,
        version: version.version,
        ref: describeRef(ref),
      });
  }
  section.entries.push({ ids, prose: split.prose, refs: split.refs });
  return ok();
}

/** Splits an entry line into prose and the trailing supplied-ref list. */
interface ChangelogRefSplit {
  readonly prose: string;
  readonly refs: readonly ChangelogRef[];
}

function splitRefs(body: string): ChangelogRefSplit {
  const match = REF_SUFFIX.exec(body);
  if (match === null) return { prose: body.trim(), refs: [] };
  const refs = (match[1] ?? "").split(", ").map(readRefToken);
  return { prose: body.slice(0, match.index).trim(), refs };
}

function readRefToken(token: string): ChangelogRef {
  if (token.startsWith("#"))
    return { kind: "pull-request", number: Number(token.slice(1)) };
  return { kind: "commit", commit: token.slice(1, -1) };
}

function claimLedgerBlock(
  source: ChangelogSource,
  state: ScanState,
): Result<void, ChangelogFormatError> {
  const version = state.versions.at(-1) ?? null;
  if (version === null)
    return err({
      type: "MisplacedLedgerBlock",
      path: source.path,
      version: null,
    });
  if (state.pending !== null)
    return err(pendingWithoutEntry(source, state, state.pendingLine));
  if (version.sections.length > 0)
    return err({
      type: "MisplacedLedgerBlock",
      path: source.path,
      version: version.version,
    });
  version.ledgerBlocks += 1;
  if (version.ledgerBlocks > 1)
    return err({
      type: "MultipleLedgerBlocks",
      path: source.path,
      version: version.version,
    });
  return ok();
}

/** Checks a finished version: one ledger block, no trailing empty section. */
function closeVersion(
  source: ChangelogSource,
  state: ScanState,
): Result<void, ChangelogFormatError> {
  const version = state.versions.at(-1) ?? null;
  if (version === null) return ok();
  const section = version.sections.at(-1) ?? null;
  if (section !== null && section.entries.length === 0)
    return err({
      type: "EmptySectionBody",
      path: source.path,
      version: version.version,
      section: section.name,
    });
  if (version.ledgerBlocks === 0)
    return err({
      type: "MissingLedgerBlock",
      path: source.path,
      version: version.version,
    });
  return ok();
}

function pendingWithoutEntry(
  source: ChangelogSource,
  state: ScanState,
  line: number,
): ChangelogFormatError {
  return {
    type: "MissingEntryProse",
    path: source.path,
    version: state.versions.at(-1)?.version ?? "",
    line,
  };
}

/**
 * Joins the human half to the machine half.
 *
 * Every changeset an entry names must be recorded by its version's ledger
 * block, and every identity the block records must be claimed by exactly one
 * entry. Digests come from the block, so an entry never restates one.
 */
function resolveVersions(
  source: ChangelogSource,
  drafts: readonly VersionDraft[],
  ledger: ConsumptionLedger,
): Result<readonly ChangelogVersion[], ChangelogFormatError> {
  const versions: ChangelogVersion[] = [];
  for (const draft of drafts) {
    const recorded = new Map<string, ChangesetIdentity>();
    for (const record of ledger.records)
      if (record.version === draft.version)
        recorded.set(record.identity.id, record.identity);
    const claimed = new Set<string>();
    const sections: ChangelogSection[] = [];
    for (const section of draft.sections) {
      const entries: ChangelogEntry[] = [];
      for (const entry of section.entries) {
        const identities: ChangesetIdentity[] = [];
        for (const id of entry.ids) {
          const identity = recorded.get(id);
          if (identity === undefined)
            return err({
              type: "EntrySourceNotInLedger",
              path: source.path,
              version: draft.version,
              id,
            });
          if (claimed.has(id))
            return err({
              type: "DuplicateEntryChangeset",
              path: source.path,
              version: draft.version,
              id,
            });
          claimed.add(id);
          identities.push(identity);
        }
        entries.push(
          entry.refs.length === 0
            ? { prose: entry.prose, sourceChangesets: identities }
            : {
                prose: entry.prose,
                sourceChangesets: identities,
                refs: entry.refs,
              },
        );
      }
      sections.push({ name: section.name, entries });
    }
    for (const id of recorded.keys())
      if (!claimed.has(id))
        return err({
          type: "LedgerSourceNotInEntries",
          path: source.path,
          version: draft.version,
          id,
        });
    versions.push({ version: draft.version, sections });
  }
  return ok(versions);
}

function compareVersions(left: string, right: string): number {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function describeIssues(
  issues: readonly { path: readonly PropertyKey[]; message: string }[],
): readonly string[] {
  return issues.map((issue) => {
    const path = issue.path.map(String).join(".");
    if (path.length === 0) return issue.message;
    return `${path}: ${issue.message}`;
  });
}
