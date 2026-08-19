/**
 * The consumption ledger: which changesets a published version already spent.
 *
 * The stable release PR may touch only two surfaces — package manifests and
 * per-package `CHANGELOG.md` — so it can never delete the `.changeset/*.md`
 * files it consumes. Consumption authority therefore lives in the changelogs
 * themselves: every published version carries one hidden, schema-validated
 * mapping block naming the changeset identities that produced it.
 *
 * ```md
 * ## 0.1.0
 *
 * <!-- weave-release-ledger:1
 * {
 *   "package": "@weaveio/weave-cli",
 *   "version": "0.1.0",
 *   "changesets": [
 *     { "id": "portable-delegation-limits", "sourceDigest": "<64 hex>" }
 *   ]
 * }
 * -->
 * ```
 *
 * A changeset whose ID appears in any block on `main` is *logically consumed*:
 * the file may still sit in `.changeset/` awaiting the cleanup PR, but no
 * release ever bumps a version for it again. That makes correctness
 * independent of cleanup timing.
 *
 * This module owns the block contract in both directions. It renders the
 * canonical block — the changelog-format module renders through
 * {@link renderLedgerBlock} rather than spelling the syntax again — and parses
 * every public changelog back into the consumed set. It has no dependency on
 * the changelog format, so the ledger can be read from a bare `CHANGELOG.md`
 * on any ref.
 *
 * Everything fails closed. A block that cannot be parsed, does not validate,
 * sits under the wrong package or version heading, repeats a consumption, or
 * contradicts another block's digest is a typed error, never a silently
 * smaller consumed set — an under-reported ledger double-bumps a changeset.
 *
 * The heading-only changelog stubs that precede the first canonical stable
 * release contain no blocks, so the empty ledger is a valid, expected state.
 */
import { err, ok, okAsync, type Result, type ResultAsync } from "neverthrow";
import { z } from "zod";
import type { ChangesetIdentity } from "./changeset-policy.js";
import {
  PUBLIC_PACKAGE_NAMES,
  PUBLIC_PACKAGES,
  type PublicPackageName,
} from "./constants.js";
import type { FileSystemError } from "./errors.js";
import { parseJsonValue } from "./json.js";

/** Opening word of every hidden mapping block. */
export const LEDGER_BLOCK_MARKER = "weave-release-ledger" as const;

/** Schema version of the block contract this module reads and writes. */
export const LEDGER_BLOCK_SCHEMA_VERSION = 1 as const;

/** Upper bound on identities in one block, so a block is never unbounded. */
const MAX_LEDGER_BLOCK_CHANGESETS = 256;

const CHANGESET_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const VERSION_HEADING = /^##[ \t]+(\S+)[ \t]*$/;
const BLOCK_HEADER = new RegExp(`^${LEDGER_BLOCK_MARKER}:(\\d+)$`);
const COMMENT_OPEN = "<!--";
const COMMENT_CLOSE = "-->";

export const LedgerPackageNameSchema = z.enum(PUBLIC_PACKAGE_NAMES);

export const LedgerChangesetIdSchema = z.string().regex(CHANGESET_ID);
export const LedgerSourceDigestSchema = z.string().regex(SHA256_HEX);
export const LedgerChangesetIdentitySchema = z
  .object({
    id: LedgerChangesetIdSchema,
    sourceDigest: LedgerSourceDigestSchema,
  })
  .strict();

export const LedgerStableVersionSchema = z.string().regex(STABLE_VERSION);

/** The validated payload of one hidden mapping block. */
export const LedgerBlockSchema = z
  .object({
    package: LedgerPackageNameSchema,
    version: LedgerStableVersionSchema,
    changesets: z
      .array(LedgerChangesetIdentitySchema)
      .min(1)
      .max(MAX_LEDGER_BLOCK_CHANGESETS),
  })
  .strict();

export type LedgerBlock = z.infer<typeof LedgerBlockSchema>;

/** One public package's `CHANGELOG.md` as read from some ref. */
export interface ChangelogSource {
  packageName: PublicPackageName;
  path: string;
  contents: string;
}

/** One changeset identity, consumed by one package at one version. */
export interface ConsumedChangeset {
  identity: ChangesetIdentity;
  packageName: PublicPackageName;
  version: string;
}

export interface ConsumptionLedger {
  /** Every consumption, ordered by package, then version, then changeset ID. */
  records: readonly ConsumedChangeset[];
  /**
   * The consumed identity of each changeset ID. A shared changeset is
   * recorded once per releasing package, always with the same digest, so the
   * lookup is unambiguous.
   */
  identities: ReadonlyMap<string, ChangesetIdentity>;
}

/** The valid state before the first canonical stable release. */
export const EMPTY_CONSUMPTION_LEDGER: ConsumptionLedger = {
  records: [],
  identities: new Map(),
};

export type ConsumptionLedgerError =
  | { type: "MalformedLedgerBlock"; path: string; reason: string }
  | { type: "UnsupportedLedgerSchema"; path: string; schemaVersion: number }
  | { type: "InvalidLedgerJson"; path: string; reason: string }
  | { type: "InvalidLedgerRecord"; path: string; issues: readonly string[] }
  | {
      type: "LedgerPackageMismatch";
      path: string;
      expected: PublicPackageName;
      actual: PublicPackageName;
    }
  | {
      type: "LedgerVersionMismatch";
      path: string;
      blockVersion: string;
      headingVersion: string | null;
    }
  | {
      type: "DuplicateLedgerBlock";
      path: string;
      packageName: PublicPackageName;
      version: string;
    }
  | {
      type: "DuplicateConsumedChangeset";
      id: string;
      packageName: PublicPackageName;
      versions: readonly string[];
    }
  | {
      type: "ConflictingConsumedChangeset";
      id: string;
      digests: readonly string[];
    }
  | { type: "ChangelogUnreadable"; path: string; message: string };

/** Why a block could not be rendered. Parsing reports its own errors. */
export type LedgerBlockError = {
  type: "InvalidLedgerBlock";
  issues: readonly string[];
};

/**
 * Renders the canonical hidden mapping block for one published version.
 *
 * Identities are sorted by ID and keys are emitted in a fixed order, so the
 * same consumption always renders the same bytes.
 */
export function renderLedgerBlock(
  block: LedgerBlock,
): Result<string, LedgerBlockError> {
  const parsed = LedgerBlockSchema.safeParse(block);
  if (!parsed.success)
    return err({
      type: "InvalidLedgerBlock",
      issues: describeIssues(parsed.error.issues),
    });
  const identities = [...parsed.data.changesets].sort((left, right) =>
    compareText(left.id, right.id),
  );
  const duplicate = findDuplicateId(identities);
  if (duplicate !== null)
    return err({
      type: "InvalidLedgerBlock",
      issues: [`changesets: duplicate changeset id ${duplicate}`],
    });
  const payload = {
    package: parsed.data.package,
    version: parsed.data.version,
    changesets: identities.map((identity) => ({
      id: identity.id,
      sourceDigest: identity.sourceDigest,
    })),
  };
  const body = JSON.stringify(payload, null, 2);
  const header = `${LEDGER_BLOCK_MARKER}:${LEDGER_BLOCK_SCHEMA_VERSION}`;
  return ok(`${COMMENT_OPEN} ${header}\n${body}\n${COMMENT_CLOSE}`);
}

/**
 * Reads every hidden mapping block out of the supplied public changelogs.
 *
 * Blocks are validated against the file they live in: the recorded package
 * must be the changelog's package and the recorded version must be the
 * enclosing `## <version>` heading, so a block can never claim a consumption
 * for a release it does not belong to.
 */
export function parseConsumptionLedger(
  sources: readonly ChangelogSource[],
): Result<ConsumptionLedger, ConsumptionLedgerError> {
  const records: ConsumedChangeset[] = [];
  const seenBlocks = new Set<string>();
  for (const source of sources) {
    const scanned = scanLedgerBlocks(source);
    if (scanned.isErr()) return err(scanned.error);
    for (const block of scanned.value) {
      const key = `${block.package}\u0000${block.version}`;
      if (seenBlocks.has(key))
        return err({
          type: "DuplicateLedgerBlock",
          path: source.path,
          packageName: block.package,
          version: block.version,
        });
      seenBlocks.add(key);
      for (const identity of block.changesets)
        records.push({
          identity,
          packageName: block.package,
          version: block.version,
        });
    }
  }
  return indexRecords(records);
}

/** Reads the two changelog operations the ledger needs from a tree. */
export interface ChangelogReader {
  exists(path: string): ResultAsync<boolean, FileSystemError>;
  readText(path: string): ResultAsync<string, FileSystemError>;
}

/**
 * Loads the ledger from every public package's `CHANGELOG.md` under `root`.
 *
 * A package without a changelog contributes nothing: before the first stable
 * release the file may be a heading-only stub, and its absence is not a
 * consumption claim.
 */
export function loadConsumptionLedger(
  reader: ChangelogReader,
  root: string,
): ResultAsync<ConsumptionLedger, ConsumptionLedgerError> {
  let loaded: ResultAsync<readonly ChangelogSource[], ConsumptionLedgerError> =
    okAsync([]);
  for (const packageName of PUBLIC_PACKAGE_NAMES) {
    const path = `${root}/${PUBLIC_PACKAGES[packageName].directory}/CHANGELOG.md`;
    loaded = loaded.andThen((sources) =>
      reader
        .exists(path)
        .mapErr(toUnreadable)
        .andThen((exists) => {
          if (!exists) return okAsync(sources);
          return reader
            .readText(path)
            .mapErr(toUnreadable)
            .map((contents) => [...sources, { packageName, path, contents }]);
        }),
    );
  }
  return loaded.andThen(parseConsumptionLedger);
}

function toUnreadable(error: FileSystemError): ConsumptionLedgerError {
  return {
    type: "ChangelogUnreadable",
    path: error.path,
    message: error.message,
  };
}

interface HeadingMark {
  offset: number;
  version: string;
}

/**
 * Extracts every ledger block from one changelog, in document order.
 *
 * Comments that are not ledger blocks are skipped, so hand-written changelog
 * comments never become parse failures.
 */
function scanLedgerBlocks(
  source: ChangelogSource,
): Result<readonly LedgerBlock[], ConsumptionLedgerError> {
  const headings = collectHeadings(source.contents);
  const blocks: LedgerBlock[] = [];
  let cursor = 0;
  while (cursor < source.contents.length) {
    const open = source.contents.indexOf(COMMENT_OPEN, cursor);
    if (open === -1) break;
    const close = source.contents.indexOf(
      COMMENT_CLOSE,
      open + COMMENT_OPEN.length,
    );
    if (close === -1) {
      const rest = source.contents.slice(open);
      if (!rest.includes(LEDGER_BLOCK_MARKER)) break;
      return err({
        type: "MalformedLedgerBlock",
        path: source.path,
        reason: "a ledger block comment is never closed",
      });
    }
    const inner = source.contents.slice(open + COMMENT_OPEN.length, close);
    cursor = close + COMMENT_CLOSE.length;
    if (!inner.trim().startsWith(LEDGER_BLOCK_MARKER)) continue;
    const block = readLedgerBlock(source, inner, headingBefore(headings, open));
    if (block.isErr()) return err(block.error);
    blocks.push(block.value);
  }
  return ok(blocks);
}

function readLedgerBlock(
  source: ChangelogSource,
  inner: string,
  heading: string | null,
): Result<LedgerBlock, ConsumptionLedgerError> {
  const trimmed = inner.trim();
  const newline = trimmed.indexOf("\n");
  const header = newline === -1 ? trimmed : trimmed.slice(0, newline);
  const headerMatch = BLOCK_HEADER.exec(header.trim());
  if (headerMatch === null)
    return err({
      type: "MalformedLedgerBlock",
      path: source.path,
      reason: `expected ${LEDGER_BLOCK_MARKER}:<schema version>`,
    });
  const schemaVersion = Number(headerMatch[1]);
  if (schemaVersion !== LEDGER_BLOCK_SCHEMA_VERSION)
    return err({
      type: "UnsupportedLedgerSchema",
      path: source.path,
      schemaVersion,
    });
  const payload = newline === -1 ? "" : trimmed.slice(newline + 1);
  const decoded = parseJsonValue(payload).mapErr((error) => error.message);
  if (decoded.isErr())
    return err({
      type: "InvalidLedgerJson",
      path: source.path,
      reason: decoded.error,
    });
  const parsed = LedgerBlockSchema.safeParse(decoded.value);
  if (!parsed.success)
    return err({
      type: "InvalidLedgerRecord",
      path: source.path,
      issues: describeIssues(parsed.error.issues),
    });
  if (parsed.data.package !== source.packageName)
    return err({
      type: "LedgerPackageMismatch",
      path: source.path,
      expected: source.packageName,
      actual: parsed.data.package,
    });
  if (heading !== parsed.data.version)
    return err({
      type: "LedgerVersionMismatch",
      path: source.path,
      blockVersion: parsed.data.version,
      headingVersion: heading,
    });
  return ok(parsed.data);
}

function collectHeadings(contents: string): readonly HeadingMark[] {
  const marks: HeadingMark[] = [];
  let offset = 0;
  for (const line of contents.split("\n")) {
    const match = VERSION_HEADING.exec(line.replace(/\r$/, ""));
    if (match !== null) marks.push({ offset, version: match[1] ?? "" });
    offset += line.length + 1;
  }
  return marks;
}

/** The version heading a block sits under, or `null` when it precedes all. */
function headingBefore(
  headings: readonly HeadingMark[],
  offset: number,
): string | null {
  let found: string | null = null;
  for (const heading of headings) {
    if (heading.offset >= offset) break;
    found = heading.version;
  }
  return found;
}

/**
 * Indexes the flat record list, rejecting the two impossible states: one
 * package consuming a changeset twice, and one changeset recorded under two
 * different digests.
 */
function indexRecords(
  records: readonly ConsumedChangeset[],
): Result<ConsumptionLedger, ConsumptionLedgerError> {
  const identities = new Map<string, ChangesetIdentity>();
  const consumers = new Map<string, string>();
  for (const record of records) {
    const known = identities.get(record.identity.id);
    if (
      known !== undefined &&
      known.sourceDigest !== record.identity.sourceDigest
    )
      return err({
        type: "ConflictingConsumedChangeset",
        id: record.identity.id,
        digests: [known.sourceDigest, record.identity.sourceDigest],
      });
    identities.set(record.identity.id, record.identity);
    const key = `${record.identity.id}\u0000${record.packageName}`;
    const previous = consumers.get(key);
    if (previous !== undefined)
      return err({
        type: "DuplicateConsumedChangeset",
        id: record.identity.id,
        packageName: record.packageName,
        versions: [previous, record.version],
      });
    consumers.set(key, record.version);
  }
  return ok({ records: orderRecords(records), identities });
}

function orderRecords(
  records: readonly ConsumedChangeset[],
): readonly ConsumedChangeset[] {
  const catalog = PUBLIC_PACKAGE_NAMES;
  return [...records].sort((left, right) => {
    const byPackage =
      catalog.indexOf(left.packageName) - catalog.indexOf(right.packageName);
    if (byPackage !== 0) return byPackage;
    const byVersion = compareVersions(left.version, right.version);
    if (byVersion !== 0) return byVersion;
    return compareText(left.identity.id, right.identity.id);
  });
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

function findDuplicateId(
  identities: readonly ChangesetIdentity[],
): string | null {
  const seen = new Set<string>();
  for (const identity of identities) {
    if (seen.has(identity.id)) return identity.id;
    seen.add(identity.id);
  }
  return null;
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

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
