/**
 * Compact changelog-AI audit metadata.
 *
 * Decision 9: a validated provenance record for the changelog agent — provider,
 * model, prompt version, thinking level, input/output digests, attempt count,
 * and generation time. Per-entry source mapping is *not* duplicated here; it
 * lives in the canonical changelog mapping (Task 7 ledger + entry markers) and
 * is recomputed from those bytes before any consumer trusts this record.
 *
 * This is evidence about prose provenance. It is never an input to version
 * math or publication. Hidden reasoning, credentials, keys, full prompts,
 * evidence payloads, transcripts, and session IDs cannot be represented, and
 * they never appear in errors or summaries.
 */
import { err, ok, Result } from "neverthrow";
import { z } from "zod";
import { type ChangelogDocument, parseChangelog } from "../changelog-format.js";
import type { ChangesetIdentity } from "../changeset-policy.js";
import { NPM_DIGEST_PREFIX, type PublicPackageName } from "../constants.js";
import {
  type ChangelogSource,
  type ConsumptionLedger,
  parseConsumptionLedger,
} from "../consumption-ledger.js";
import { DigestSchema, UtcTimestampSchema } from "../model.js";
import { publishablePackageNames } from "../package-policy.js";
import { CHANGELOG_PROMPT_VERSION } from "./changelog-agent.js";
import {
  CHANGELOG_AGENT_MODEL,
  CHANGELOG_AGENT_PROVIDER,
  HEADLESS_THINKING_LEVELS,
  type HeadlessThinkingLevel,
} from "./headless-session.js";
import type { ChangelogSubmission } from "./submission-schema.js";

/** Schema version of the audit contract this module reads and writes. */
export const AI_AUDIT_SCHEMA_VERSION = 1 as const;

/** Opening word of the hidden release-PR audit metadata block. */
export const AI_AUDIT_MARKER = "weave-release-ai-audit" as const;

/** Bounds, so no carrier, record, or summary is ever unbounded input. */
export const AI_AUDIT_LIMITS = {
  carrierBytes: 16 * 1024,
  jsonDepth: 8,
  jsonNodes: 256,
  providerLength: 64,
  modelLength: 128,
  promptVersion: 1_024,
  attempts: 2,
  summaryBytes: 4 * 1024,
  mappingPackages: 4,
  mappingIdentities: 512,
} as const;

/**
 * Keys that must never appear on an audit record, carrier, error, or summary.
 *
 * `thinking` is the allowed thinking *level* field and is not in this list.
 */
export const FORBIDDEN_AUDIT_FIELDS = [
  "reasoning",
  "hiddenReasoning",
  "hidden_reasoning",
  "chainOfThought",
  "chain_of_thought",
  "cot",
  "thought",
  "thoughts",
  "thinkingText",
  "thinking_text",
  "rawThinking",
  "raw_thinking",
  "credential",
  "credentials",
  "apiKey",
  "api_key",
  "apiKeys",
  "secret",
  "secrets",
  "token",
  "tokens",
  "password",
  "passwd",
  "privateKey",
  "private_key",
  "authorization",
  "bearer",
  "key",
  "prompt",
  "prompts",
  "fullPrompt",
  "full_prompt",
  "systemPrompt",
  "system_prompt",
  "evidence",
  "evidencePayload",
  "evidence_payload",
  "transcript",
  "transcripts",
  "conversation",
  "messages",
  "sessionId",
  "sessionID",
  "session_id",
  "session",
  "sessionKey",
  "session_key",
] as const;

export type ForbiddenAuditField = (typeof FORBIDDEN_AUDIT_FIELDS)[number];

const FORBIDDEN_AUDIT_FIELD_SET = new Set<string>(FORBIDDEN_AUDIT_FIELDS);

const COMMENT_OPEN = "<!--";
const COMMENT_CLOSE = "-->";
const BLOCK_HEADER = new RegExp(`^${AI_AUDIT_MARKER}:(\\d+)$`);
const DIGEST = new RegExp(`^${NPM_DIGEST_PREFIX}[0-9a-f]{64}$`);

const PublicPackageNameSchema = z.enum(
  publishablePackageNames() as [PublicPackageName, ...PublicPackageName[]],
);
const ChangesetIdentitySchema = z
  .object({
    id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
    sourceDigest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

/** The only fields an audit record may carry. */
export const AiAuditMetadataSchema = z
  .object({
    provider: z.literal(CHANGELOG_AGENT_PROVIDER),
    model: z.literal(CHANGELOG_AGENT_MODEL),
    promptVersion: z
      .number()
      .int()
      .positive()
      .max(AI_AUDIT_LIMITS.promptVersion),
    thinking: z.enum(HEADLESS_THINKING_LEVELS),
    evidenceDigest: DigestSchema,
    submissionDigest: DigestSchema,
    attempts: z.union([z.literal(1), z.literal(2)]),
    generatedAt: UtcTimestampSchema,
  })
  .strict();

export type AiAuditMetadata = z.infer<typeof AiAuditMetadataSchema>;

/** One package version's changeset identities from the canonical mapping. */
export interface ChangelogSourceMappingRecord {
  packageName: PublicPackageName;
  version: string;
  identities: readonly ChangesetIdentity[];
}

/** Canonical, prose-free source mapping used to verify the audit. */
export interface ChangelogSourceMapping {
  records: readonly ChangelogSourceMappingRecord[];
}

export const ChangelogSourceMappingRecordSchema = z
  .object({
    packageName: PublicPackageNameSchema,
    version: z.string().min(1).max(64),
    identities: z
      .array(ChangesetIdentitySchema)
      .min(1)
      .max(AI_AUDIT_LIMITS.mappingIdentities),
  })
  .strict();

export const ChangelogSourceMappingSchema = z
  .object({
    records: z
      .array(ChangelogSourceMappingRecordSchema)
      .min(1)
      .max(AI_AUDIT_LIMITS.mappingPackages),
  })
  .strict();

export type AiAuditError =
  | { type: "InvalidAiAuditMetadata"; issues: readonly string[] }
  | { type: "ForbiddenAuditField"; field: string }
  | { type: "AiAuditTooLarge"; bytes: number; limit: number }
  | { type: "AiAuditTooDeep"; depth: number; limit: number }
  | { type: "MalformedAiAuditJson"; reason: string }
  | { type: "DuplicateAiAuditKey"; path: string; key: string }
  | { type: "MissingAiAuditMetadataBlock" }
  | { type: "MultipleAiAuditMetadataBlocks"; count: number }
  | { type: "UnsupportedAiAuditSchema"; schemaVersion: number }
  | { type: "AiAuditSummaryRejected" }
  | { type: "AuditEvidenceDigestMismatch"; expected: string; actual: string }
  | { type: "AuditSubmissionDigestMismatch"; expected: string; actual: string }
  | {
      type: "AuditChangelogMappingDivergence";
      path: string;
    }
  | { type: "InvalidChangelogSourceMapping"; issues: readonly string[] }
  | { type: "ChangelogMappingUnreadable"; path: string };

/** Inputs a caller may use to build a validated audit record. */
export interface AiAuditProvenance {
  promptVersion?: number;
  thinking: HeadlessThinkingLevel;
  attempts: 1 | 2;
  evidenceDigest: string;
  submission: ChangelogSubmission;
  generatedAt: string | Date;
}

/** Merged-tree facts the audit is recomputed against before trust. */
export interface MergedAuditSource {
  /** Evidence digest recomputed at the merged tree. */
  evidenceDigest: string;
  /** Mapping extracted from the merged tree's canonical changelogs. */
  changelogMapping: ChangelogSourceMappingInput;
  /** Mapping recorded at generation, or the expected merged mapping. */
  expectedChangelogMapping: ChangelogSourceMappingInput;
  /** Optional original submission, used only for digest comparison. */
  submission?: ChangelogSubmission;
}

export type ChangelogSourceMappingInput =
  | ChangelogSourceMapping
  | ConsumptionLedger
  | readonly ChangelogDocument[]
  | readonly ChangelogSource[];

const parseJson = Result.fromThrowable(
  (source: string) => JSON.parse(source) as unknown,
  (): AiAuditError => ({
    type: "MalformedAiAuditJson",
    reason: "unreadable",
  }),
);

/** Validates an untrusted value as audit metadata. Values never appear. */
export function validateAiAuditMetadata(
  input: unknown,
): Result<AiAuditMetadata, AiAuditError> {
  const forbidden = findForbiddenAuditField(input);
  if (forbidden !== null)
    return err({ type: "ForbiddenAuditField", field: forbidden });
  const parsed = AiAuditMetadataSchema.safeParse(input);
  if (!parsed.success)
    return err({
      type: "InvalidAiAuditMetadata",
      issues: describeIssues(parsed.error.issues),
    });
  return ok(parsed.data);
}

/**
 * Builds a validated audit record from agent provenance.
 *
 * The submission is hashed and then discarded; only the digest is kept.
 */
export function createAiAuditMetadata(
  provenance: AiAuditProvenance,
): Result<AiAuditMetadata, AiAuditError> {
  const generatedAt =
    provenance.generatedAt instanceof Date
      ? provenance.generatedAt.toISOString()
      : provenance.generatedAt;
  return validateAiAuditMetadata({
    provider: CHANGELOG_AGENT_PROVIDER,
    model: CHANGELOG_AGENT_MODEL,
    promptVersion: provenance.promptVersion ?? CHANGELOG_PROMPT_VERSION,
    thinking: provenance.thinking,
    evidenceDigest: provenance.evidenceDigest,
    submissionDigest: digestChangelogSubmission(provenance.submission),
    attempts: provenance.attempts,
    generatedAt,
  });
}

/** Canonical SHA-256 of a changelog submission. Prose is hashed, never kept. */
export function digestChangelogSubmission(
  submission: ChangelogSubmission,
): string {
  return digestOf(canonicalJson(submission));
}

/** Canonical SHA-256 of a validated audit record. */
export function aiAuditDigest(audit: AiAuditMetadata): string {
  return digestOf(canonicalJson(audit));
}

/** Renders canonical audit bytes: keys sorted at every depth. */
export function serializeAiAuditMetadata(
  audit: AiAuditMetadata,
): Result<string, AiAuditError> {
  return validateAiAuditMetadata(audit).andThen((validated) => {
    const text = JSON.stringify(sortValue(validated), null, 2);
    const bytes = utf8ByteLength(text);
    if (bytes > AI_AUDIT_LIMITS.carrierBytes)
      return err<never, AiAuditError>({
        type: "AiAuditTooLarge",
        bytes,
        limit: AI_AUDIT_LIMITS.carrierBytes,
      });
    return ok(text);
  });
}

/** Reads canonical audit bytes back, bounded and duplicate-key intolerant. */
export function parseAiAuditMetadata(
  text: string,
): Result<AiAuditMetadata, AiAuditError> {
  return parseBoundedAuditJson(text).andThen(validateAiAuditMetadata);
}

/** Renders the hidden metadata block a release PR body embeds. */
export function renderAiAuditMetadataBlock(
  audit: AiAuditMetadata,
): Result<string, AiAuditError> {
  return serializeAiAuditMetadata(audit).andThen((body) => {
    const text = `${COMMENT_OPEN} ${AI_AUDIT_MARKER}:${AI_AUDIT_SCHEMA_VERSION}\n${body}\n${COMMENT_CLOSE}`;
    const bytes = utf8ByteLength(text);
    if (bytes > AI_AUDIT_LIMITS.carrierBytes)
      return err<never, AiAuditError>({
        type: "AiAuditTooLarge",
        bytes,
        limit: AI_AUDIT_LIMITS.carrierBytes,
      });
    return ok(text);
  });
}

/**
 * Reads the one hidden audit block out of a release-PR body.
 *
 * Ordinary HTML comments are skipped. Two audit blocks are a typed failure:
 * a body that claims two provenance records has no single identity.
 */
export function parseAiAuditMetadataBlock(
  body: string,
): Result<AiAuditMetadata, AiAuditError> {
  const collected = collectAuditBlocks(body);
  if (collected.isErr()) return err(collected.error);
  const blocks = collected.value;
  if (blocks.length === 0) return err({ type: "MissingAiAuditMetadataBlock" });
  if (blocks.length > 1)
    return err({ type: "MultipleAiAuditMetadataBlocks", count: blocks.length });
  const block = blocks[0] ?? "";
  if (utf8ByteLength(block) > AI_AUDIT_LIMITS.carrierBytes)
    return err({
      type: "AiAuditTooLarge",
      bytes: utf8ByteLength(block),
      limit: AI_AUDIT_LIMITS.carrierBytes,
    });
  return readAuditBlock(block);
}

export const readAiAuditFromPrBody = parseAiAuditMetadataBlock;

/**
 * Appends a validated hidden audit block to a PR body.
 *
 * A body that already carries an audit block is refused rather than silently
 * replaced. `undefined` leaves the body unchanged.
 */
export function appendAiAuditMetadata(
  body: string,
  audit: AiAuditMetadata | undefined,
): Result<string, AiAuditError> {
  if (audit === undefined) return ok(body);
  const existing = collectAuditBlocks(body);
  if (existing.isErr()) return err(existing.error);
  if (existing.value.length > 0)
    return err({
      type: "MultipleAiAuditMetadataBlocks",
      count: existing.value.length + 1,
    });
  return renderAiAuditMetadataBlock(audit).andThen((block) => {
    const next = body.endsWith("\n")
      ? `${body}${block}\n`
      : `${body}\n${block}\n`;
    return parseAiAuditMetadataBlock(next).map(() => next);
  });
}

/**
 * Deterministic, non-secret workflow summary of a validated audit record.
 *
 * The summary names only the eight allowed fields. A rendered summary that
 * nevertheless matches a forbidden token is refused rather than emitted.
 */
export function renderAiAuditSummary(
  audit: AiAuditMetadata,
): Result<string, AiAuditError> {
  return validateAiAuditMetadata(audit).andThen((validated) => {
    const lines = [
      "Changelog AI audit",
      `provider: ${validated.provider}`,
      `model: ${validated.model}`,
      `promptVersion: ${String(validated.promptVersion)}`,
      `thinking: ${validated.thinking}`,
      `attempts: ${String(validated.attempts)}`,
      `evidenceDigest: ${validated.evidenceDigest}`,
      `submissionDigest: ${validated.submissionDigest}`,
      `generatedAt: ${validated.generatedAt}`,
    ];
    const text = `${lines.join("\n")}\n`;
    const bytes = utf8ByteLength(text);
    if (bytes > AI_AUDIT_LIMITS.summaryBytes)
      return err<never, AiAuditError>({
        type: "AiAuditTooLarge",
        bytes,
        limit: AI_AUDIT_LIMITS.summaryBytes,
      });
    if (summaryLooksForbidden(text))
      return err<never, AiAuditError>({ type: "AiAuditSummaryRejected" });
    return ok(text);
  });
}

/**
 * Recomputes evidence digest and changelog mapping from merged source.
 *
 * Divergence is a typed failure. Errors name only field paths and digests —
 * never prose, prompts, evidence, transcripts, or credentials.
 */
export function verifyAuditAgainstMergedSource(
  audit: unknown,
  source: MergedAuditSource,
): Result<AiAuditMetadata, AiAuditError> {
  return validateAiAuditMetadata(audit).andThen((validated) => {
    if (!DIGEST.test(source.evidenceDigest))
      return err<never, AiAuditError>({
        type: "InvalidAiAuditMetadata",
        issues: ["evidenceDigest"],
      });
    if (validated.evidenceDigest !== source.evidenceDigest)
      return err<never, AiAuditError>({
        type: "AuditEvidenceDigestMismatch",
        expected: validated.evidenceDigest,
        actual: source.evidenceDigest,
      });
    if (source.submission !== undefined) {
      const actual = digestChangelogSubmission(source.submission);
      if (validated.submissionDigest !== actual)
        return err<never, AiAuditError>({
          type: "AuditSubmissionDigestMismatch",
          expected: validated.submissionDigest,
          actual,
        });
    }
    return normalizeChangelogSourceMapping(source.expectedChangelogMapping)
      .andThen((expected) =>
        normalizeChangelogSourceMapping(source.changelogMapping).map(
          (actual) => ({ expected, actual }),
        ),
      )
      .andThen(({ expected, actual }) => {
        const divergence = firstMappingDivergence(expected, actual);
        if (divergence !== null)
          return err<never, AiAuditError>({
            type: "AuditChangelogMappingDivergence",
            path: divergence,
          });
        return ok(validated);
      });
  });
}

/** Extracts the canonical, prose-free mapping from changelog documents. */
export function changelogSourceMappingFromDocuments(
  documents: readonly ChangelogDocument[],
): Result<ChangelogSourceMapping, AiAuditError> {
  const records: ChangelogSourceMappingRecord[] = [];
  for (const document of documents) {
    const version = document.versions[0];
    if (version === undefined) continue;
    const identities = collectDocumentIdentities(version);
    if (identities.length === 0) continue;
    records.push({
      packageName: document.packageName,
      version: version.version,
      identities,
    });
  }
  return canonicalizeChangelogSourceMapping({ records });
}

/** Extracts the canonical mapping from a consumption ledger. */
export function changelogSourceMappingFromLedger(
  ledger: ConsumptionLedger,
): Result<ChangelogSourceMapping, AiAuditError> {
  const grouped = new Map<string, ChangelogSourceMappingRecord>();
  for (const record of ledger.records) {
    const key = `${record.packageName}\u0000${record.version}`;
    const existing = grouped.get(key);
    if (existing === undefined) {
      grouped.set(key, {
        packageName: record.packageName,
        version: record.version,
        identities: [record.identity],
      });
      continue;
    }
    grouped.set(key, {
      ...existing,
      identities: [...existing.identities, record.identity],
    });
  }
  return canonicalizeChangelogSourceMapping({
    records: [...grouped.values()],
  });
}

/** Parses changelog sources through Task 7 and returns the canonical mapping. */
export function changelogSourceMappingFromSources(
  sources: readonly ChangelogSource[],
): Result<ChangelogSourceMapping, AiAuditError> {
  if (sources.length === 0)
    return err<never, AiAuditError>({
      type: "InvalidChangelogSourceMapping",
      issues: ["records"],
    });
  const documents: ChangelogDocument[] = [];
  for (const source of sources) {
    const parsed = parseChangelog(source);
    if (parsed.isErr())
      return err<never, AiAuditError>({
        type: "ChangelogMappingUnreadable",
        path: source.path,
      });
    documents.push(parsed.value.document);
  }
  const fromDocuments = changelogSourceMappingFromDocuments(documents);
  if (fromDocuments.isErr()) return err(fromDocuments.error);
  const ledger = parseConsumptionLedger([...sources]);
  if (ledger.isErr())
    return err<never, AiAuditError>({
      type: "ChangelogMappingUnreadable",
      path: sources[0]?.path ?? "changelog",
    });
  const fromLedger = changelogSourceMappingFromLedger(ledger.value);
  if (fromLedger.isErr()) return err(fromLedger.error);
  const divergence = firstMappingDivergence(
    fromDocuments.value,
    fromLedger.value,
  );
  if (divergence !== null)
    return err<never, AiAuditError>({
      type: "AuditChangelogMappingDivergence",
      path: divergence,
    });
  return ok(fromDocuments.value);
}

/** Sorts mapping records and identities into the one comparable form. */
export function canonicalizeChangelogSourceMapping(
  mapping: ChangelogSourceMapping,
): Result<ChangelogSourceMapping, AiAuditError> {
  const parsed = ChangelogSourceMappingSchema.safeParse({
    records: mapping.records.map((record) => ({
      packageName: record.packageName,
      version: record.version,
      identities: [...record.identities]
        .map((identity) => ({
          id: identity.id,
          sourceDigest: identity.sourceDigest,
        }))
        .sort(compareIdentity),
    })),
  });
  if (!parsed.success)
    return err({
      type: "InvalidChangelogSourceMapping",
      issues: describeIssues(parsed.error.issues),
    });
  const catalog = publishablePackageNames();
  const records = [...parsed.data.records].sort((left, right) => {
    const packageOrder =
      catalog.indexOf(left.packageName) - catalog.indexOf(right.packageName);
    if (packageOrder !== 0) return packageOrder;
    return compareText(left.version, right.version);
  });
  return ok({ records });
}

export function changelogSourceMappingDigest(
  mapping: ChangelogSourceMapping,
): Result<string, AiAuditError> {
  return canonicalizeChangelogSourceMapping(mapping).map((canonical) =>
    digestOf(canonicalJson(canonical)),
  );
}

export function normalizeChangelogSourceMapping(
  input: ChangelogSourceMappingInput,
): Result<ChangelogSourceMapping, AiAuditError> {
  if (isChangelogSourceMapping(input))
    return canonicalizeChangelogSourceMapping(input);
  if (isConsumptionLedger(input))
    return changelogSourceMappingFromLedger(input);
  if (isChangelogDocumentList(input))
    return changelogSourceMappingFromDocuments(input);
  if (isChangelogSourceList(input))
    return changelogSourceMappingFromSources(input);
  return err({
    type: "InvalidChangelogSourceMapping",
    issues: ["shape"],
  });
}

/** Safe, non-content-bearing message for Task 8/9 error mapping. */
export function describeAiAuditError(error: AiAuditError): string {
  switch (error.type) {
    case "InvalidAiAuditMetadata":
      return "ai audit metadata was rejected";
    case "ForbiddenAuditField":
      return "ai audit metadata named a forbidden field";
    case "AiAuditTooLarge":
      return "ai audit metadata exceeded its bound";
    case "AiAuditTooDeep":
      return "ai audit metadata exceeded its depth bound";
    case "MalformedAiAuditJson":
      return "ai audit metadata was not readable json";
    case "DuplicateAiAuditKey":
      return "ai audit metadata named a field twice";
    case "MissingAiAuditMetadataBlock":
      return "ai audit metadata block is missing";
    case "MultipleAiAuditMetadataBlocks":
      return "ai audit metadata block is not unique";
    case "UnsupportedAiAuditSchema":
      return "ai audit metadata schema is unsupported";
    case "AiAuditSummaryRejected":
      return "ai audit summary was rejected";
    case "AuditEvidenceDigestMismatch":
      return "ai audit evidence digest diverged";
    case "AuditSubmissionDigestMismatch":
      return "ai audit submission digest diverged";
    case "AuditChangelogMappingDivergence":
      return "ai audit changelog mapping diverged";
    case "InvalidChangelogSourceMapping":
      return "ai audit changelog mapping was rejected";
    case "ChangelogMappingUnreadable":
      return "ai audit changelog mapping was unreadable";
  }
}

// ---------------------------------------------------------------------------
// Carrier internals
// ---------------------------------------------------------------------------

function collectAuditBlocks(text: string): Result<string[], AiAuditError> {
  const blocks: string[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const open = text.indexOf(COMMENT_OPEN, cursor);
    if (open === -1) break;
    const close = text.indexOf(COMMENT_CLOSE, open + COMMENT_OPEN.length);
    if (close === -1) {
      const rest = text.slice(open);
      if (rest.includes(AI_AUDIT_MARKER))
        return err({
          type: "MalformedAiAuditJson",
          reason: "unclosed",
        });
      break;
    }
    const inner = text.slice(open + COMMENT_OPEN.length, close).trim();
    cursor = close + COMMENT_CLOSE.length;
    if (inner.startsWith(AI_AUDIT_MARKER)) blocks.push(inner);
  }
  return ok(blocks);
}

function readAuditBlock(block: string): Result<AiAuditMetadata, AiAuditError> {
  const newline = block.indexOf("\n");
  const header = (newline === -1 ? block : block.slice(0, newline)).trim();
  const match = BLOCK_HEADER.exec(header);
  if (match === null)
    return err({
      type: "MalformedAiAuditJson",
      reason: "header",
    });
  const schemaVersion = Number(match[1]);
  if (schemaVersion !== AI_AUDIT_SCHEMA_VERSION)
    return err({ type: "UnsupportedAiAuditSchema", schemaVersion });
  return parseAiAuditMetadata(newline === -1 ? "" : block.slice(newline + 1));
}

function parseBoundedAuditJson(text: string): Result<unknown, AiAuditError> {
  const bytes = utf8ByteLength(text);
  if (bytes > AI_AUDIT_LIMITS.carrierBytes)
    return err({
      type: "AiAuditTooLarge",
      bytes,
      limit: AI_AUDIT_LIMITS.carrierBytes,
    });
  return parseJson(text).andThen((value) =>
    scanJsonStructure(text).map(() => value),
  );
}

interface ScanFrame {
  object: boolean;
  keys: Set<string>;
  path: string;
  awaitingKey: boolean;
  lastKey: string;
}

function scanJsonStructure(text: string): Result<void, AiAuditError> {
  const stack: ScanFrame[] = [];
  let index = 0;
  let nodes = 0;
  while (index < text.length) {
    const char = text[index] ?? "";
    if (char === "{" || char === "[") {
      if (stack.length >= AI_AUDIT_LIMITS.jsonDepth)
        return err({
          type: "AiAuditTooDeep",
          depth: stack.length + 1,
          limit: AI_AUDIT_LIMITS.jsonDepth,
        });
      nodes += 1;
      if (nodes > AI_AUDIT_LIMITS.jsonNodes)
        return err({
          type: "AiAuditTooLarge",
          bytes: text.length,
          limit: AI_AUDIT_LIMITS.carrierBytes,
        });
      stack.push({
        object: char === "{",
        keys: new Set(),
        path: framePath(stack[stack.length - 1]),
        awaitingKey: char === "{",
        lastKey: "",
      });
      index += 1;
      continue;
    }
    if (char === "}" || char === "]") {
      stack.pop();
      index += 1;
      continue;
    }
    if (char === "," || char === ":") {
      const frame = stack[stack.length - 1];
      if (frame?.object) frame.awaitingKey = char === ",";
      index += 1;
      continue;
    }
    if (char === '"') {
      const read = readJsonString(text, index);
      if (read === null)
        return err({
          type: "MalformedAiAuditJson",
          reason: "unterminated",
        });
      const frame = stack[stack.length - 1];
      if (frame?.object && frame.awaitingKey) {
        if (FORBIDDEN_AUDIT_FIELD_SET.has(read.value))
          return err({ type: "ForbiddenAuditField", field: read.value });
        if (frame.keys.has(read.value))
          return err({
            type: "DuplicateAiAuditKey",
            path: join(frame.path, read.value) || read.value,
            key: read.value,
          });
        frame.keys.add(read.value);
        frame.lastKey = read.value;
      }
      index = read.next;
      continue;
    }
    index += 1;
  }
  return ok(undefined);
}

function framePath(parent: ScanFrame | undefined): string {
  if (parent === undefined) return "";
  return parent.object ? join(parent.path, parent.lastKey) : `${parent.path}[]`;
}

const JSON_ESCAPES: Readonly<Record<string, string>> = {
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
};

function readJsonString(
  text: string,
  start: number,
): { value: string; next: number } | null {
  let index = start + 1;
  let value = "";
  while (index < text.length) {
    const char = text[index] ?? "";
    if (char === "\\") {
      const escaped = text[index + 1];
      if (escaped === undefined) return null;
      if (escaped === "u") {
        const hex = text.slice(index + 2, index + 6);
        if (hex.length < 4) return null;
        value += String.fromCharCode(Number.parseInt(hex, 16));
        index += 6;
        continue;
      }
      value += JSON_ESCAPES[escaped] ?? escaped;
      index += 2;
      continue;
    }
    if (char === '"') return { value, next: index + 1 };
    value += char;
    index += 1;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Mapping and comparison
// ---------------------------------------------------------------------------

function collectDocumentIdentities(
  version: ChangelogDocument["versions"][number],
): ChangesetIdentity[] {
  const identities: ChangesetIdentity[] = [];
  const seen = new Set<string>();
  for (const section of version.sections) {
    for (const entry of section.entries) {
      for (const identity of entry.sourceChangesets) {
        const key = `${identity.id}\u0000${identity.sourceDigest}`;
        if (seen.has(key)) continue;
        seen.add(key);
        identities.push(identity);
      }
    }
  }
  return identities;
}

function firstMappingDivergence(
  expected: ChangelogSourceMapping,
  actual: ChangelogSourceMapping,
): string | null {
  if (expected.records.length !== actual.records.length)
    return "records.length";
  for (const [index, record] of expected.records.entries()) {
    const other = actual.records[index];
    if (other === undefined) return `records.${String(index)}`;
    if (record.packageName !== other.packageName)
      return `records.${String(index)}.packageName`;
    if (record.version !== other.version)
      return `records.${String(index)}.version`;
    if (record.identities.length !== other.identities.length)
      return `records.${String(index)}.identities.length`;
    for (const [identityIndex, identity] of record.identities.entries()) {
      const otherIdentity = other.identities[identityIndex];
      if (otherIdentity === undefined)
        return `records.${String(index)}.identities.${String(identityIndex)}`;
      if (identity.id !== otherIdentity.id)
        return `records.${String(index)}.identities.${String(identityIndex)}.id`;
      if (identity.sourceDigest !== otherIdentity.sourceDigest)
        return `records.${String(index)}.identities.${String(identityIndex)}.sourceDigest`;
    }
  }
  return null;
}

function isChangelogSourceMapping(
  input: ChangelogSourceMappingInput,
): input is ChangelogSourceMapping {
  return (
    typeof input === "object" &&
    input !== null &&
    !Array.isArray(input) &&
    "records" in input &&
    Array.isArray(input.records) &&
    !("identities" in input)
  );
}

function isConsumptionLedger(
  input: ChangelogSourceMappingInput,
): input is ConsumptionLedger {
  return (
    typeof input === "object" &&
    input !== null &&
    !Array.isArray(input) &&
    "records" in input &&
    "identities" in input
  );
}

function isChangelogDocumentList(
  input: ChangelogSourceMappingInput,
): input is readonly ChangelogDocument[] {
  return (
    Array.isArray(input) &&
    input.every(
      (item) =>
        typeof item === "object" &&
        item !== null &&
        "packageName" in item &&
        "versions" in item &&
        !("path" in item) &&
        !("contents" in item),
    )
  );
}

function isChangelogSourceList(
  input: ChangelogSourceMappingInput,
): input is readonly ChangelogSource[] {
  return (
    Array.isArray(input) &&
    input.every(
      (item) =>
        typeof item === "object" &&
        item !== null &&
        "packageName" in item &&
        "path" in item &&
        "contents" in item,
    )
  );
}

function compareIdentity(
  left: ChangesetIdentity,
  right: ChangesetIdentity,
): number {
  return (
    compareText(left.id, right.id) ||
    compareText(left.sourceDigest, right.sourceDigest)
  );
}

// ---------------------------------------------------------------------------
// Forbidden-field and secret-absence guards
// ---------------------------------------------------------------------------

function findForbiddenAuditField(value: unknown): string | null {
  return findForbiddenAuditFieldInner(value, 0, new Set<object>());
}

function findForbiddenAuditFieldInner(
  value: unknown,
  depth: number,
  seen: Set<object>,
): string | null {
  if (value === null || typeof value !== "object") return null;
  if (depth > AI_AUDIT_LIMITS.jsonDepth) return null;
  if (seen.has(value)) return null;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      const nested = findForbiddenAuditFieldInner(item, depth + 1, seen);
      if (nested !== null) return nested;
    }
    return null;
  }
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_AUDIT_FIELD_SET.has(key)) return key;
    const nested = findForbiddenAuditFieldInner(
      (value as Record<string, unknown>)[key],
      depth + 1,
      seen,
    );
    if (nested !== null) return nested;
  }
  return null;
}

const FORBIDDEN_SUMMARY_PATTERNS = [
  /-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----/i,
  /\b(?:ghp|github_pat|gho|ghs|ghr)_[A-Za-z0-9_]{10,}\b/,
  /\b(?:sk|rk|pk)-live-[A-Za-z0-9]{8,}\b/i,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bnpm_[A-Za-z0-9]{20,}\b/,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/i,
  /\b(?:transcript|sessionId|session_id|api[_-]?key|hiddenReasoning)\b/i,
];

function summaryLooksForbidden(text: string): boolean {
  return FORBIDDEN_SUMMARY_PATTERNS.some((pattern) => pattern.test(text));
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function describeIssues(
  issues: readonly { path: readonly PropertyKey[]; code: string }[],
): readonly string[] {
  return issues.map((issue) => {
    const path = issue.path.map(String).join(".");
    return path.length === 0 ? issue.code : `${path}:${issue.code}`;
  });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function join(path: string, segment: string | number): string {
  return path === "" ? String(segment) : `${path}.${segment}`;
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort(compareText)
      .map((key) => [key, sortValue(value[key])]),
  );
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object")
    return JSON.stringify(value) ?? "null";
  if (Array.isArray(value))
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort(compareText)
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

function digestOf(value: string): string {
  return `${NPM_DIGEST_PREFIX}${new Bun.CryptoHasher("sha256")
    .update(value)
    .digest("hex")}`;
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function compareText(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

export type { HeadlessThinkingLevel };
