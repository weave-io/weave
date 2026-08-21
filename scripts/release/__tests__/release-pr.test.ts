import { describe, expect, it } from "bun:test";
import { errAsync, okAsync, type ResultAsync } from "neverthrow";
import type { ChangelogEntry, ChangelogEvidence } from "../changelog-format.js";
import type { ChangesetIdentity } from "../changeset-policy.js";
import { RELEASE_PR_MARKER_REF } from "../constants.js";
import type { GitHubError } from "../errors.js";
import type {
  GitHubCommitFile,
  GitHubComparisonStatus,
  GitHubPullRequestCreateInput,
  GitHubPullRequestSummary,
  GitHubPullRequestUpdateInput,
  GitHubPullRequestWriteError,
  GitHubRefWriteError,
} from "../github-client.js";
import {
  type AbortOwnedCreationOutcome,
  type CreatedReleasePr,
  type CreationPreparer,
  type CreationStage,
  classifyReleaseCompletionState,
  entryIdentityKey,
  evidenceDigest,
  type MergedReleaseObservation,
  markerRefPath,
  OWNERSHIP_MARKER_SUBJECT,
  type PreparationFailure,
  type PreparedRelease,
  parseReleasePrEnvelope,
  planProseReuse,
  preparationBlock,
  RELEASE_PR_BOUNDS,
  RELEASE_PR_ENVELOPE_MARKER,
  RELEASE_PR_ENVELOPE_SCHEMA_VERSION,
  RELEASE_PR_LABEL,
  type RegenerationBuilder,
  type RegenerationDraft,
  type ReleasePrEnvelope,
  type ReleasePrError,
  type ReleasePrOwnership,
  type ReleasePrPorts,
  type ReleasePrState,
  renderReleasePrEnvelope,
  resolveRegeneratedEntries,
  StableReleasePrManager,
  validateCleanupPrDiff,
  validateReleasePrDiff,
} from "../release-pr.js";

const REF_PATH = markerRefPath();
const ENVELOPE_BYTES = RELEASE_PR_BOUNDS.envelopeBytes;
const CLI_MANIFEST = "packages/cli/package.json";
const CLI_CHANGELOG = "packages/cli/CHANGELOG.md";

function hex(seed: string): string {
  return new Bun.CryptoHasher("sha256").update(seed).digest("hex");
}

/** The evidence every prepared release in these tests cites. */
const EVIDENCE: ChangelogEvidence = { pullRequests: [412] };
const EVIDENCE_DIGEST = evidenceDigest(EVIDENCE);

/** Builds a valid envelope whose rendered form is exactly `bytes` long. */
function envelopeSized(bytes: number) {
  const digest = `sha256:${hex("pad")}`;
  const records: { key: string; digest: string }[] = [{ key: "x", digest }];
  const build = (): ReleasePrEnvelope => ({
    schemaVersion: RELEASE_PR_ENVELOPE_SCHEMA_VERSION,
    ref: RELEASE_PR_MARKER_REF,
    ownerGeneration: hex("owner"),
    plannedBaseSha: sha("base"),
    baseSha: sha("base"),
    regeneratedFrom: [],
    entryProse: records.map((record) => ({ ...record })),
    evidenceDigest: EVIDENCE_DIGEST,
  });
  const measure = (): number => {
    const rendered = renderReleasePrEnvelope(build());
    if (rendered.isOk())
      return new TextEncoder().encode(rendered.value).byteLength;
    if (rendered.error.type === "ReleasePrEnvelopeTooLarge")
      return rendered.error.bytes;
    throw new Error(
      `envelope did not render: ${JSON.stringify(rendered.error)}`,
    );
  };
  while (measure() < bytes) {
    const last = records[records.length - 1];
    if (last !== undefined && last.key.length < 8_000) {
      last.key += "x".repeat(
        Math.min(8_000 - last.key.length, bytes - measure()),
      );
      continue;
    }
    records.push({ key: `p${records.length}`, digest });
  }
  const last = records[records.length - 1];
  if (last === undefined) throw new Error("expected a pad record");
  while (measure() > bytes && last.key.length > 1)
    last.key = last.key.slice(0, -1);
  if (measure() !== bytes)
    throw new Error(`sized envelope was ${measure()}, wanted ${bytes}`);
  return build();
}

/** Adds metadata whose UTF-8 width exceeds its UTF-16 code-unit width. */
function unicodeEnvelopeSized(bytes: number) {
  const ascii = envelopeSized(bytes - 3);
  return {
    ...ascii,
    entryProse: ascii.entryProse.map((record, index) =>
      index === 0 ? { ...record, key: `😀${record.key.slice(1)}` } : record,
    ),
  };
}

function sha(seed: string): string {
  return hex(seed).slice(0, 40);
}
function digest(seed: string): string {
  return `sha256:${hex(seed)}`;
}

function identity(id: string, seed = id): ChangesetIdentity {
  return { id, sourceDigest: hex(seed) };
}

function entry(
  prose: string,
  sources: readonly ChangesetIdentity[],
): ChangelogEntry {
  return { prose, sourceChangesets: sources };
}

// ---------------------------------------------------------------------------
// A whole fake GitHub: refs, commits, pull requests, trunk, and team reads.
// Every failure mode the state machine must survive is injectable, and every
// mutation is recorded so a test can prove what did *not* happen.
// ---------------------------------------------------------------------------

interface FakeCommit {
  message: string;
  parent: string;
  files: readonly GitHubCommitFile[];
}

interface FakeFaults {
  createCommit: number;
  readRef: number;
  updateRef: number;
  deleteRef: number;
  listPulls: number;
  readCommitMessage: number;
  compareCommits: number;
  createPullRequest: null | "definite" | "ambiguous" | "unlabeled";
  createPullRequestServerSide: boolean;
  updatePullRequest: number;
  addLabels: number;
  completion: number;
  team: number;
  readMain: number;
}

type NumericFaultKey =
  | "createCommit"
  | "readRef"
  | "updateRef"
  | "deleteRef"
  | "listPulls"
  | "readCommitMessage"
  | "compareCommits"
  | "updatePullRequest"
  | "addLabels"
  | "completion"
  | "team"
  | "readMain";

interface FakeHooks {
  beforeCreateRef?: () => void;
  beforeCreateCommit?: () => void;
  beforeUpdateRef?: () => void;
  beforeCreatePullRequest?: () => void;
  afterCreatePullRequest?: () => void;
  afterUpdatePullRequest?: () => void;
  beforeListOpenPullRequestsByLabel?: (count: number) => void;
  beforeReadMain?: (count: number) => void;
}

class FakeGitHub {
  readonly refs = new Map<string, string>();
  readonly commits = new Map<string, FakeCommit>();
  pulls: GitHubPullRequestSummary[] = [];
  mainHistory: string[] = [sha("main-0")];
  members = new Set<string>(["maintainer"]);
  merged: MergedReleaseObservation | null = null;
  readonly log: string[] = [];
  readonly createdRefs: { ref: string; sha: string }[] = [];
  mainReads = 0;
  labeledPullReads = 0;
  private commitCounter = 0;
  private generationCounter = 0;
  private pullCounter = 0;

  readonly faults: FakeFaults = {
    createCommit: 0,
    readRef: 0,
    updateRef: 0,
    deleteRef: 0,
    listPulls: 0,
    readCommitMessage: 0,
    compareCommits: 0,
    createPullRequest: null,
    createPullRequestServerSide: false,
    updatePullRequest: 0,
    addLabels: 0,
    completion: 0,
    team: 0,
    readMain: 0,
  };
  hooks: FakeHooks = {};

  get mainHead(): string {
    return this.mainHistory[this.mainHistory.length - 1] ?? "";
  }

  advanceMain(): string {
    const next = sha(`main-${this.mainHistory.length}`);
    this.mainHistory.push(next);
    return next;
  }

  nextGeneration(): string {
    this.generationCounter += 1;
    return hex(`generation-${this.generationCounter}`);
  }

  markerSha(): string | null {
    return this.refs.get(REF_PATH) ?? null;
  }

  // --- ref port ------------------------------------------------------------

  readRefOptional(ref: string): ResultAsync<string | null, GitHubError> {
    if (this.consume("readRef")) return errAsync(failure("readRefOptional"));
    return okAsync(this.refs.get(ref) ?? null);
  }

  createRefAtomic(
    ref: string,
    value: string,
  ): ResultAsync<void, GitHubRefWriteError> {
    this.hooks.beforeCreateRef?.();
    if (this.refs.has(ref))
      return errAsync({ type: "ReferenceAlreadyExists", ref });
    this.refs.set(ref, value);
    this.createdRefs.push({ ref, sha: value });
    this.log.push(`createRef ${ref}=${value}`);
    return okAsync(void 0);
  }

  updateRefWithLease(
    ref: string,
    value: string,
    expectedSha: string,
  ): ResultAsync<void, GitHubRefWriteError> {
    this.hooks.beforeUpdateRef?.();
    if (this.consume("updateRef")) return errAsync(failure("updateRef"));
    const current = this.refs.get(ref) ?? null;
    if (current !== expectedSha)
      return errAsync({
        type: "ReferenceLeaseLost",
        ref,
        expectedSha,
        actualSha: current,
      });
    this.refs.set(ref, value);
    this.log.push(`updateRef ${ref}=${value}`);
    return okAsync(void 0);
  }

  deleteRefWithLease(
    ref: string,
    expectedSha: string,
  ): ResultAsync<void, GitHubRefWriteError> {
    if (this.consume("deleteRef")) return errAsync(failure("deleteRef"));
    const current = this.refs.get(ref) ?? null;
    if (current !== expectedSha)
      return errAsync({
        type: "ReferenceLeaseLost",
        ref,
        expectedSha,
        actualSha: current,
      });
    this.refs.delete(ref);
    this.log.push(`deleteRef ${ref}`);
    return okAsync(void 0);
  }

  createCommitOnBase(input: {
    baseSha: string;
    message: string;
    files?: readonly GitHubCommitFile[];
  }): ResultAsync<string, GitHubError> {
    this.hooks.beforeCreateCommit?.();
    if (this.consume("createCommit"))
      return errAsync(failure("createCommitOnBase"));
    this.commitCounter += 1;
    const created = sha(`commit-${this.commitCounter}`);
    this.commits.set(created, {
      message: input.message,
      parent: input.baseSha,
      files: input.files ?? [],
    });
    return okAsync(created);
  }

  readCommitMessage(value: string): ResultAsync<string, GitHubError> {
    if (this.consume("readCommitMessage"))
      return errAsync(failure("readCommitMessage"));
    const commit = this.commits.get(value);
    if (commit === undefined) return errAsync(failure("readCommitMessage"));
    return okAsync(commit.message);
  }

  compareCommits(
    base: string,
    head: string,
  ): ResultAsync<GitHubComparisonStatus, GitHubError> {
    if (this.consume("compareCommits"))
      return errAsync(failure("compareCommits"));
    if (base === head) return okAsync("identical");
    const left = this.mainHistory.indexOf(base);
    const right = this.mainHistory.indexOf(head);
    if (left === -1 || right === -1) return okAsync("diverged");
    return okAsync(right > left ? "ahead" : "behind");
  }

  // --- trunk port ----------------------------------------------------------

  readGreenMainHead(): ResultAsync<string, GitHubError> {
    this.mainReads += 1;
    this.hooks.beforeReadMain?.(this.mainReads);
    if (this.consume("readMain")) return errAsync(failure("readGreenMainHead"));
    return okAsync(this.mainHead);
  }

  // --- pull-request port ---------------------------------------------------

  listOpenPullRequestsByLabel(
    label: string,
  ): ResultAsync<readonly GitHubPullRequestSummary[], GitHubError> {
    this.labeledPullReads += 1;
    this.hooks.beforeListOpenPullRequestsByLabel?.(this.labeledPullReads);
    if (this.consume("listPulls"))
      return errAsync(failure("listOpenPullRequestsByLabel"));
    return okAsync(
      this.pulls.filter(
        (pull) => pull.state === "open" && pull.labels.includes(label),
      ),
    );
  }

  listPullRequestsForHead(
    headRef: string,
    state: GitHubPullRequestSummary["state"],
  ): ResultAsync<readonly GitHubPullRequestSummary[], GitHubError> {
    if (this.consume("listPulls"))
      return errAsync(failure("listPullRequestsForHead"));
    return okAsync(
      this.pulls.filter(
        (pull) => pull.headRef === headRef && pull.state === state,
      ),
    );
  }

  createPullRequest(
    input: GitHubPullRequestCreateInput,
  ): ResultAsync<GitHubPullRequestSummary, GitHubPullRequestWriteError> {
    this.hooks.beforeCreatePullRequest?.();
    const fault = this.faults.createPullRequest;
    if (fault !== null) {
      this.faults.createPullRequest = null;
      if (fault === "unlabeled") {
        this.openPullRequest({ ...input, labels: [] });
        this.hooks.afterCreatePullRequest?.();
        return errAsync({
          type: "PullRequestWriteAmbiguous",
          operation: "addLabels",
          message: "label apply failed",
        });
      }
      if (this.faults.createPullRequestServerSide) this.openPullRequest(input);
      this.hooks.afterCreatePullRequest?.();
      if (fault === "ambiguous")
        return errAsync({
          type: "PullRequestWriteAmbiguous",
          operation: "createPullRequest",
          message: "socket hang up",
        });
      return errAsync(failure("createPullRequest", 500));
    }
    const created = this.openPullRequest(input);
    this.hooks.afterCreatePullRequest?.();
    return okAsync(created);
  }

  updatePullRequest(
    input: GitHubPullRequestUpdateInput,
  ): ResultAsync<GitHubPullRequestSummary, GitHubPullRequestWriteError> {
    if (this.consume("updatePullRequest"))
      return errAsync(failure("updatePullRequest", 500));
    const index = this.pulls.findIndex((pull) => pull.number === input.number);
    const existing = this.pulls[index];
    if (existing === undefined)
      return errAsync(failure("updatePullRequest", 404));
    const updated: GitHubPullRequestSummary = {
      ...existing,
      title: input.title,
      body: input.body,
      headSha: this.refs.get(REF_PATH) ?? existing.headSha,
    };
    this.pulls[index] = updated;
    this.log.push(`updatePullRequest ${input.number}`);
    this.hooks.afterUpdatePullRequest?.();
    return okAsync(updated);
  }

  addPullRequestLabels(
    number: number,
    labels: readonly string[],
  ): ResultAsync<readonly string[], GitHubPullRequestWriteError> {
    if (this.consume("addLabels"))
      return errAsync(failure("addPullRequestLabels", 500));
    const index = this.pulls.findIndex((pull) => pull.number === number);
    const existing = this.pulls[index];
    if (existing === undefined)
      return errAsync(failure("addPullRequestLabels", 404));
    const next = [...new Set([...existing.labels, ...labels])];
    this.pulls[index] = { ...existing, labels: next };
    this.log.push(`addPullRequestLabels ${number}`);
    return okAsync(next);
  }

  openPullRequest(
    input: GitHubPullRequestCreateInput,
  ): GitHubPullRequestSummary {
    this.pullCounter += 1;
    const created: GitHubPullRequestSummary = {
      number: this.pullCounter,
      url: `https://github.com/weave-io/weave/pull/${this.pullCounter}`,
      state: "open",
      merged: false,
      headRef: input.headRef,
      headSha: this.refs.get(REF_PATH) ?? "",
      baseRef: input.baseRef,
      title: input.title,
      body: input.body,
      labels: [...input.labels],
    };
    this.pulls.push(created);
    this.log.push(`createPullRequest ${created.number}`);
    return created;
  }

  settlePullRequest(number: number, state: "merged" | "closed"): void {
    const index = this.pulls.findIndex((pull) => pull.number === number);
    const existing = this.pulls[index];
    if (existing === undefined) return;
    this.pulls[index] = {
      ...existing,
      state: "closed",
      merged: state === "merged",
    };
  }

  // --- completion and team ports -------------------------------------------

  readMergedReleaseCompletion(): ResultAsync<
    MergedReleaseObservation | null,
    GitHubError
  > {
    if (this.consume("completion"))
      return errAsync(failure("readMergedReleaseCompletion"));
    return okAsync(this.merged);
  }

  isTeamMember(input: {
    organization: string;
    teamSlug: string;
    login: string;
  }): ResultAsync<boolean, GitHubError> {
    if (this.consume("team")) return errAsync(failure("isTeamMember"));
    return okAsync(this.members.has(input.login));
  }

  private consume(key: NumericFaultKey): boolean {
    const remaining = this.faults[key];
    if (remaining <= 0) return false;
    this.faults[key] = remaining - 1;
    return true;
  }
}

function failure(operation: string, status?: number): GitHubError {
  return {
    type: "GitHubError",
    operation,
    status,
    message: `${operation} failed`,
  };
}

function ports(world: FakeGitHub): ReleasePrPorts {
  return {
    refs: world,
    pullRequests: world,
    main: world,
    completion: world,
    team: world,
  };
}

function manager(
  world: FakeGitHub,
  overrides: {
    sleep?: (milliseconds: number) => Promise<void>;
    bounds?: Partial<{
      creationPollAttempts: number;
      reconciliationAttempts: number;
      freshnessAttempts: number;
      regenerationAttempts: number;
      metadataRepairAttempts: number;
    }>;
  } = {},
): StableReleasePrManager {
  return new StableReleasePrManager(ports(world), {
    generateOwnerGeneration: () => world.nextGeneration(),
    sleep: overrides.sleep ?? (() => Promise.resolve()),
    bounds: {
      creationPollAttempts: 3,
      reconciliationAttempts: 2,
      freshnessAttempts: 3,
      regenerationAttempts: 3,
      metadataRepairAttempts: 2,
      pollDelayMs: 0,
      ...overrides.bounds,
    },
  });
}

function preparedRelease(
  baseSha: string,
  overrides: Partial<PreparedRelease> = {},
): PreparedRelease {
  return {
    baseSha,
    title: "chore(release): publish stable",
    body: "Seed: @weaveio/weave-cli",
    commitSubject: "chore(release): version packages",
    files: [
      { path: CLI_MANIFEST, contents: '{ "version": "0.1.0" }' },
      { path: CLI_CHANGELOG, contents: "# @weaveio/weave-cli\n" },
    ],
    changes: [
      { path: CLI_MANIFEST, status: "modified", manifestFields: ["version"] },
      { path: CLI_CHANGELOG, status: "modified" },
    ],
    docsAuditedSha: baseSha,
    entries: [entry("Delegation limits are portable", [identity("limits")])],
    evidence: EVIDENCE,
    ...overrides,
  };
}

function preparerFor(
  build: (baseSha: string) => PreparedRelease = (baseSha) =>
    preparedRelease(baseSha),
): CreationPreparer {
  return {
    prepare: (input) => okAsync(build(input.baseSha)),
  };
}

function failingPreparer(stage: CreationStage): CreationPreparer {
  return {
    prepare: () =>
      errAsync<PreparedRelease, PreparationFailure>({
        stage,
        message: `${stage} failed`,
      }),
  };
}

/** Drives the whole creation event, including the bounded replan loop. */
async function createRelease(
  world: FakeGitHub,
  options: {
    preparer?: CreationPreparer;
    sleep?: (milliseconds: number) => Promise<void>;
    bounds?: Partial<{ freshnessAttempts: number }>;
  } = {},
): Promise<
  { ok: true; value: CreatedReleasePr } | { ok: false; error: ReleasePrError }
> {
  const result = await manager(world, {
    sleep: options.sleep,
    bounds: options.bounds,
  }).createStableReleasePr({
    plannedBaseSha: world.mainHead,
    preparer: options.preparer ?? preparerFor(),
  });
  return result.match(
    (value) => ({ ok: true as const, value }),
    (error) => ({ ok: false as const, error }),
  );
}

async function acquire(
  world: FakeGitHub,
  plannedBaseSha = world.mainHead,
): Promise<ReleasePrOwnership> {
  const result = await manager(world).acquireCreationOwnership({
    plannedBaseSha,
  });
  return result.match(
    (ownership) => ownership,
    (error) => {
      throw new Error(`ownership failed: ${JSON.stringify(error)}`);
    },
  );
}

function envelopeAt(world: FakeGitHub, commitSha: string) {
  const commit = world.commits.get(commitSha);
  expect(commit).toBeDefined();
  return parseReleasePrEnvelope(commit?.message ?? "");
}

function ownershipEnvelope(ownership: ReleasePrOwnership): string {
  return renderReleasePrEnvelope({
    schemaVersion: RELEASE_PR_ENVELOPE_SCHEMA_VERSION,
    ref: RELEASE_PR_MARKER_REF,
    ownerGeneration: ownership.ownerGeneration,
    plannedBaseSha: ownership.plannedBaseSha,
    baseSha: ownership.plannedBaseSha,
    regeneratedFrom: [],
    entryProse: [],
    evidenceDigest: EVIDENCE_DIGEST,
  })._unsafeUnwrap();
}

// ---------------------------------------------------------------------------
// Envelope contract
// ---------------------------------------------------------------------------

describe("release-pr ownership envelope", () => {
  const base = sha("base");
  const owner = hex("owner");

  it("round-trips the ownership identity and audit trail", () => {
    const rendered = renderReleasePrEnvelope({
      schemaVersion: RELEASE_PR_ENVELOPE_SCHEMA_VERSION,
      ref: RELEASE_PR_MARKER_REF,
      ownerGeneration: owner,
      plannedBaseSha: base,
      baseSha: base,
      regeneratedFrom: [sha("older")],
      entryProse: [{ key: "limits@abc", digest: digest("prose") }],
      evidenceDigest: EVIDENCE_DIGEST,
    });
    expect(rendered.isOk()).toBe(true);
    const parsed = parseReleasePrEnvelope(rendered._unsafeUnwrap());
    expect(parsed._unsafeUnwrap()).toEqual({
      schemaVersion: 1,
      ref: RELEASE_PR_MARKER_REF,
      ownerGeneration: owner,
      plannedBaseSha: base,
      baseSha: base,
      regeneratedFrom: [sha("older")],
      entryProse: [{ key: "limits@abc", digest: digest("prose") }],
      evidenceDigest: EVIDENCE_DIGEST,
    });
  });

  it("survives surrounding human prose and ordinary comments", () => {
    const rendered = renderReleasePrEnvelope({
      schemaVersion: 1,
      ref: RELEASE_PR_MARKER_REF,
      ownerGeneration: owner,
      plannedBaseSha: base,
      baseSha: base,
      regeneratedFrom: [],
      entryProse: [],
      evidenceDigest: EVIDENCE_DIGEST,
    })._unsafeUnwrap();
    const body = `## Release\n\n<!-- a human note -->\n\n${rendered}\n`;
    expect(parseReleasePrEnvelope(body)._unsafeUnwrap().ownerGeneration).toBe(
      owner,
    );
  });

  it("refuses a body with no envelope, two envelopes, or a tampered one", () => {
    expect(
      parseReleasePrEnvelope("no envelope here")._unsafeUnwrapErr(),
    ).toEqual({ type: "MissingReleasePrEnvelope" });
    const rendered = renderReleasePrEnvelope({
      schemaVersion: 1,
      ref: RELEASE_PR_MARKER_REF,
      ownerGeneration: owner,
      plannedBaseSha: base,
      baseSha: base,
      regeneratedFrom: [],
      entryProse: [],
      evidenceDigest: EVIDENCE_DIGEST,
    })._unsafeUnwrap();
    expect(
      parseReleasePrEnvelope(`${rendered}\n${rendered}`)._unsafeUnwrapErr(),
    ).toEqual({ type: "MultipleReleasePrEnvelopes", count: 2 });
    const tampered = rendered.replace(owner, "not-a-generation");
    expect(parseReleasePrEnvelope(tampered)._unsafeUnwrapErr().type).toBe(
      "InvalidReleasePrEnvelope",
    );
    const future = `<!-- ${RELEASE_PR_ENVELOPE_MARKER}:2\n{}\n-->`;
    expect(parseReleasePrEnvelope(future)._unsafeUnwrapErr()).toEqual({
      type: "UnsupportedReleasePrEnvelope",
      schemaVersion: 2,
    });
  });

  it("refuses an unbounded carrier", () => {
    const error = parseReleasePrEnvelope(
      "x".repeat(200_000),
    )._unsafeUnwrapErr();
    expect(error.type).toBe("ReleasePrEnvelopeTooLarge");
  });

  it("renders an exact-bound envelope that still parses", () => {
    const exact = envelopeSized(ENVELOPE_BYTES);
    const rendered = renderReleasePrEnvelope(exact);
    expect(rendered.isOk()).toBe(true);
    expect(new TextEncoder().encode(rendered._unsafeUnwrap()).byteLength).toBe(
      ENVELOPE_BYTES,
    );
    expect(parseReleasePrEnvelope(rendered._unsafeUnwrap()).isOk()).toBe(true);
  });

  it("counts Unicode metadata as UTF-8 bytes at the exact bound", () => {
    const exact = unicodeEnvelopeSized(ENVELOPE_BYTES);
    const rendered = renderReleasePrEnvelope(exact);
    expect(rendered.isOk()).toBe(true);
    const text = rendered._unsafeUnwrap();
    expect(text.length).toBeLessThan(ENVELOPE_BYTES);
    expect(new TextEncoder().encode(text).byteLength).toBe(ENVELOPE_BYTES);
    expect(parseReleasePrEnvelope(text).isOk()).toBe(true);
  });

  it("rejects Unicode metadata over the bound during render and parse", () => {
    const exact = unicodeEnvelopeSized(ENVELOPE_BYTES);
    const exactText = renderReleasePrEnvelope(exact)._unsafeUnwrap();
    const overText = exactText.replace("😀", "😀😀");
    const over = {
      ...exact,
      entryProse: exact.entryProse.map((record, index) =>
        index === 0
          ? { ...record, key: record.key.replace("😀", "😀😀") }
          : record,
      ),
    };
    const expectedBytes = ENVELOPE_BYTES + 4;
    expect(overText.length).toBe(ENVELOPE_BYTES);
    expect(new TextEncoder().encode(overText).byteLength).toBe(expectedBytes);
    expect(renderReleasePrEnvelope(over)._unsafeUnwrapErr()).toEqual({
      type: "ReleasePrEnvelopeTooLarge",
      bytes: expectedBytes,
      limit: ENVELOPE_BYTES,
    });
    expect(parseReleasePrEnvelope(overText)._unsafeUnwrapErr()).toEqual({
      type: "ReleasePrEnvelopeTooLarge",
      bytes: expectedBytes,
      limit: ENVELOPE_BYTES,
    });
  });

  it("refuses to render an over-bound envelope", () => {
    const over = envelopeSized(ENVELOPE_BYTES + 1);
    const rendered = renderReleasePrEnvelope(over);
    expect(rendered._unsafeUnwrapErr()).toEqual({
      type: "ReleasePrEnvelopeTooLarge",
      bytes: ENVELOPE_BYTES + 1,
      limit: ENVELOPE_BYTES,
    });
  });
});

// ---------------------------------------------------------------------------
// Diff surfaces
// ---------------------------------------------------------------------------

describe("release-pr diff surfaces", () => {
  it("accepts exactly versions plus changelogs", () => {
    const result = validateReleasePrDiff([
      { path: CLI_MANIFEST, status: "modified", manifestFields: ["version"] },
      { path: CLI_CHANGELOG, status: "modified" },
      {
        path: "packages/adapters/pi/package.json",
        status: "modified",
        manifestFields: ["version"],
      },
      { path: "packages/adapters/pi/CHANGELOG.md", status: "added" },
    ]);
    expect(result.isOk()).toBe(true);
  });

  it("rejects any changeset touch inside a release PR", () => {
    expect(
      validateReleasePrDiff([
        { path: CLI_MANIFEST, status: "modified", manifestFields: ["version"] },
        { path: ".changeset/portable-limits.md", status: "removed" },
      ])._unsafeUnwrapErr(),
    ).toEqual({
      type: "ChangesetTouchedInReleasePr",
      path: ".changeset/portable-limits.md",
    });
  });

  it("rejects non-version manifest fields, undeclared fields, and other paths", () => {
    expect(
      validateReleasePrDiff([
        {
          path: CLI_MANIFEST,
          status: "modified",
          manifestFields: ["version", "dependencies"],
        },
      ])._unsafeUnwrapErr(),
    ).toEqual({
      type: "ForbiddenManifestField",
      path: CLI_MANIFEST,
      field: "dependencies",
    });
    expect(
      validateReleasePrDiff([
        { path: CLI_MANIFEST, status: "modified" },
      ])._unsafeUnwrapErr(),
    ).toEqual({ type: "UndeclaredManifestFields", path: CLI_MANIFEST });
    expect(
      validateReleasePrDiff([
        { path: "docs/reference/cli.md", status: "modified" },
      ])._unsafeUnwrapErr(),
    ).toEqual({
      type: "ForbiddenReleasePrPath",
      path: "docs/reference/cli.md",
    });
    expect(
      validateReleasePrDiff([
        { path: CLI_CHANGELOG, status: "removed" },
      ])._unsafeUnwrapErr(),
    ).toEqual({
      type: "ForbiddenReleaseChangeStatus",
      surface: "release",
      path: CLI_CHANGELOG,
      status: "removed",
    });
    expect(validateReleasePrDiff([])._unsafeUnwrapErr()).toEqual({
      type: "EmptyReleaseDiff",
      surface: "release",
    });
  });

  it("lets the cleanup PR delete only ledger-consumed changesets", () => {
    const consumedPaths = [".changeset/portable-limits.md"];
    expect(
      validateCleanupPrDiff({
        changes: [{ path: consumedPaths[0] ?? "", status: "removed" }],
        consumedPaths,
      }).isOk(),
    ).toBe(true);
    expect(
      validateCleanupPrDiff({
        changes: [{ path: ".changeset/pending.md", status: "removed" }],
        consumedPaths,
      })._unsafeUnwrapErr(),
    ).toEqual({
      type: "UnconsumedChangesetDeletion",
      path: ".changeset/pending.md",
    });
    expect(
      validateCleanupPrDiff({
        changes: [{ path: consumedPaths[0] ?? "", status: "modified" }],
        consumedPaths,
      })._unsafeUnwrapErr(),
    ).toEqual({
      type: "ForbiddenReleaseChangeStatus",
      surface: "cleanup",
      path: ".changeset/portable-limits.md",
      status: "modified",
    });
    expect(
      validateCleanupPrDiff({
        changes: [{ path: CLI_MANIFEST, status: "removed" }],
        consumedPaths,
      })._unsafeUnwrapErr(),
    ).toEqual({ type: "ForbiddenCleanupPrPath", path: CLI_MANIFEST });
  });
});

// ---------------------------------------------------------------------------
// Completion-state contract
// ---------------------------------------------------------------------------

describe("merged-release completion contract", () => {
  it("classifies every known state and refuses unknown ones", () => {
    expect(classifyReleaseCompletionState("Complete")._unsafeUnwrap()).toBe(
      "terminal",
    );
    expect(
      classifyReleaseCompletionState("CompleteWithIncident")._unsafeUnwrap(),
    ).toBe("terminal");
    for (const state of [
      "PendingArtifactsOrProof",
      "PendingNpm",
      "PendingRegistryVerification",
      "PendingTagsOrReleases",
      "PendingChangesetCleanup",
      "IntegrityIncident",
    ])
      expect(classifyReleaseCompletionState(state)._unsafeUnwrap()).toBe(
        "blocking",
      );
    expect(
      classifyReleaseCompletionState("Published")._unsafeUnwrapErr(),
    ).toEqual({ type: "UnknownReleaseCompletionState", state: "Published" });
  });
});

// ---------------------------------------------------------------------------
// Authorization
// ---------------------------------------------------------------------------

describe("assertStableRequestAuthorized", () => {
  it("admits a release maintainer", async () => {
    const world = new FakeGitHub();
    const result =
      await manager(world).assertStableRequestAuthorized("maintainer");
    expect(result._unsafeUnwrap()).toBe("maintainer");
  });

  it("rejects a non-member, an unreadable membership, and a malformed actor", async () => {
    const world = new FakeGitHub();
    const outsider =
      await manager(world).assertStableRequestAuthorized("outsider");
    expect(outsider._unsafeUnwrapErr()).toEqual({
      type: "UnauthorizedStableRequest",
      actor: "outsider",
      team: "weave-io/release-maintainers",
      reason: "not-a-member",
    });
    world.faults.team = 1;
    const unreadable =
      await manager(world).assertStableRequestAuthorized("maintainer");
    expect(unreadable._unsafeUnwrapErr()).toMatchObject({
      reason: "membership-unverifiable",
    });
    const malformed =
      await manager(world).assertStableRequestAuthorized("not a login!");
    expect(malformed._unsafeUnwrapErr()).toMatchObject({
      reason: "invalid-actor",
    });
  });
});

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

async function discover(
  world: FakeGitHub,
  request: Parameters<StableReleasePrManager["discover"]>[0] = {},
): Promise<ReleasePrState> {
  const state = await manager(world).discover(request);
  return state.match(
    (value) => value,
    (error) => {
      throw new Error(`discovery failed: ${JSON.stringify(error)}`);
    },
  );
}

describe("discovery", () => {
  it("reports the absent state", async () => {
    const world = new FakeGitHub();
    expect((await discover(world)).kind).toBe("absent");
  });

  it("stabilizes a marker and PR created between the initial reads", async () => {
    const world = new FakeGitHub();
    const ownership = await acquire(world);
    const markerCommit = world.commits.get(ownership.expectedMarkerSha);
    const markerEnvelope = parseReleasePrEnvelope(
      markerCommit?.message ?? "",
    )._unsafeUnwrap();
    const markerBody = renderReleasePrEnvelope(markerEnvelope)._unsafeUnwrap();
    world.refs.delete(REF_PATH);
    world.labeledPullReads = 0;
    let interleaved = false;
    world.hooks.beforeListOpenPullRequestsByLabel = (count) => {
      if (count !== 1 || interleaved) return;
      interleaved = true;
      world.refs.set(REF_PATH, ownership.expectedMarkerSha);
      world.openPullRequest({
        title: "release",
        body: markerBody,
        headRef: RELEASE_PR_MARKER_REF,
        baseRef: "main",
        labels: [RELEASE_PR_LABEL],
      });
    };

    const result = await manager(world).discover();
    expect(interleaved).toBe(true);
    expect(result._unsafeUnwrap()).toMatchObject({
      kind: "live",
      marker: { sha: ownership.expectedMarkerSha },
      pullRequest: { number: 1 },
    });
    expect(world.createdRefs).toHaveLength(1);
  });

  it("keeps a genuine orphan PR anomalous after the authoritative re-read", async () => {
    const world = new FakeGitHub();
    world.openPullRequest({
      title: "release",
      body: "",
      headRef: RELEASE_PR_MARKER_REF,
      baseRef: "main",
      labels: [RELEASE_PR_LABEL],
    });
    const result = await manager(world).discover();
    expect(result._unsafeUnwrapErr()).toEqual({
      type: "ReleasePrProtocolAnomaly",
      ref: RELEASE_PR_MARKER_REF,
      url: "https://github.com/weave-io/weave/pull/1",
    });
    expect(world.labeledPullReads).toBe(2);
  });

  it("reports creation in progress, then live, then marker cleanup pending", async () => {
    const world = new FakeGitHub();
    await acquire(world);
    expect((await discover(world)).kind).toBe("creation-in-progress");

    const created = await createRelease(world);
    expect(created.ok).toBe(false); // the marker is already owned by the first run

    const second = new FakeGitHub();
    const release = await createRelease(second);
    expect(release.ok).toBe(true);
    expect((await discover(second)).kind).toBe("live");

    second.settlePullRequest(1, "merged");
    expect((await discover(second)).kind).toBe("marker-cleanup-pending");
  });

  it("reports an orphan marker once the creation poll bound is spent", async () => {
    const world = new FakeGitHub();
    await acquire(world);
    const state = await discover(world, { creationPollExhausted: true });
    expect(state.kind).toBe("orphan-marker");
  });

  it("reports creation cleanup pending and flags a generation mismatch", async () => {
    const world = new FakeGitHub();
    const ownership = await acquire(world);
    const matching = await discover(world, { recordedCleanup: ownership });
    expect(matching).toMatchObject({
      kind: "creation-cleanup-pending",
      generationMatches: true,
    });
    const stale = await discover(world, {
      recordedCleanup: { ...ownership, ownerGeneration: hex("other") },
    });
    expect(stale).toMatchObject({
      kind: "creation-cleanup-pending",
      generationMatches: false,
    });
  });

  it("blocks discovery on a stable-labeled PR from a noncanonical head", async () => {
    const world = new FakeGitHub();
    world.openPullRequest({
      title: "release",
      body: "",
      headRef: "release-pr/not-stable",
      baseRef: "main",
      labels: [RELEASE_PR_LABEL],
    });
    const result = await manager(world).discover();
    expect(result._unsafeUnwrapErr()).toMatchObject({
      type: "ReleasePrProtocolAnomaly",
      url: "https://github.com/weave-io/weave/pull/1",
    });
  });

  it("reports a canonical and noncanonical stable PR as duplicate identities", async () => {
    const world = new FakeGitHub();
    for (const headRef of [RELEASE_PR_MARKER_REF, "release-pr/not-stable"])
      world.openPullRequest({
        title: "release",
        body: "",
        headRef,
        baseRef: "main",
        labels: [RELEASE_PR_LABEL],
      });
    const result = await manager(world).discover();
    expect(result._unsafeUnwrapErr()).toMatchObject({
      type: "DuplicateReleasePr",
      urls: [
        "https://github.com/weave-io/weave/pull/1",
        "https://github.com/weave-io/weave/pull/2",
      ],
    });
  });

  it("refuses two open release PRs", async () => {
    const world = new FakeGitHub();
    for (const _ of [0, 1])
      world.openPullRequest({
        title: "release",
        body: "",
        headRef: RELEASE_PR_MARKER_REF,
        baseRef: "main",
        labels: [RELEASE_PR_LABEL],
      });
    const state = await manager(world).discover();
    expect(state._unsafeUnwrapErr().type).toBe("DuplicateReleasePr");
  });

  it("blocks preparation on every non-terminal merged state and admits CompleteWithIncident", async () => {
    for (const state of [
      "PendingArtifactsOrProof",
      "PendingNpm",
      "PendingRegistryVerification",
      "PendingTagsOrReleases",
      "PendingChangesetCleanup",
      "IntegrityIncident",
    ]) {
      const world = new FakeGitHub();
      world.merged = {
        url: "https://github.com/weave-io/weave/pull/9",
        state,
        markerCleanupPending: false,
      };
      const discovered = await discover(world);
      expect(discovered.kind).toBe("pending-merged-release");
      const result = await createRelease(world);
      expect(result.ok).toBe(false);
      expect(result.ok === false && result.error).toEqual({
        type: "PendingReleaseBlocksPrep",
        url: "https://github.com/weave-io/weave/pull/9",
        state,
      });
      expect(world.markerSha()).toBeNull();
    }
    const world = new FakeGitHub();
    world.merged = {
      url: "https://github.com/weave-io/weave/pull/9",
      state: "CompleteWithIncident",
      markerCleanupPending: false,
    };
    const result = await createRelease(world);
    expect(result.ok).toBe(true);
  });

  it("keeps a terminal release discoverable while its marker cleanup is pending", async () => {
    const world = new FakeGitHub();
    const created = await createRelease(world);
    expect(created.ok).toBe(true);
    world.settlePullRequest(1, "merged");
    world.merged = {
      url: "https://github.com/weave-io/weave/pull/1",
      state: "Complete",
      markerCleanupPending: true,
    };
    const state = await discover(world);
    expect(state).toMatchObject({
      kind: "marker-cleanup-pending",
      mergedRelease: { markerCleanupPending: true },
    });
  });

  it("fails closed on a completion state it cannot classify", async () => {
    const world = new FakeGitHub();
    world.merged = {
      url: "https://github.com/weave-io/weave/pull/9",
      state: "AlmostDone",
      markerCleanupPending: false,
    };
    const state = await manager(world).discover();
    expect(state._unsafeUnwrapErr()).toEqual({
      type: "UnknownReleaseCompletionState",
      state: "AlmostDone",
    });
  });

  it("types an unlabeled creation PR as pr-metadata-pending, not a stall", async () => {
    const world = new FakeGitHub();
    world.faults.createPullRequest = "unlabeled";
    const created = await createRelease(world);
    expect(created.ok).toBe(false);
    if (created.ok) return;
    expect(created.error).toMatchObject({ type: "ReleasePrExists" });
    const state = await discover(world);
    expect(state).toMatchObject({
      kind: "pr-metadata-pending",
      pending: ["label"],
    });
    expect(preparationBlock(state)).toMatchObject({
      type: "ReleasePrExists",
      url: "https://github.com/weave-io/weave/pull/1",
    });
  });
});

// ---------------------------------------------------------------------------
// Creation
// ---------------------------------------------------------------------------

describe("create", () => {
  it("claims a unique marker commit, never the shared base, then opens the PR", async () => {
    const world = new FakeGitHub();
    const base = world.mainHead;
    const created = await createRelease(world);
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const claim = world.createdRefs[0];
    expect(claim?.ref).toBe(REF_PATH);
    expect(claim?.sha).not.toBe(base);
    const markerCommit = world.commits.get(claim?.sha ?? "");
    expect(markerCommit?.parent).toBe(base);
    expect(markerCommit?.message.startsWith(OWNERSHIP_MARKER_SUBJECT)).toBe(
      true,
    );
    const markerEnvelope = envelopeAt(world, claim?.sha ?? "")._unsafeUnwrap();
    expect(markerEnvelope.plannedBaseSha).toBe(base);
    expect(markerEnvelope.ownerGeneration).toBe(
      created.value.ownership.ownerGeneration,
    );

    // The branch head moved onto the release commit, and ownership stays
    // provable from its validated metadata.
    const head = world.markerSha();
    expect(head).toBe(created.value.ownership.expectedMarkerSha);
    expect(head).not.toBe(claim?.sha);
    const headEnvelope = envelopeAt(world, head ?? "")._unsafeUnwrap();
    expect(headEnvelope.ownerGeneration).toBe(markerEnvelope.ownerGeneration);
    expect(headEnvelope.baseSha).toBe(base);
    expect(headEnvelope.entryProse).toHaveLength(1);
    expect(
      parseReleasePrEnvelope(created.value.pullRequest.body)._unsafeUnwrap()
        .ownerGeneration,
    ).toBe(markerEnvelope.ownerGeneration);
    expect(created.value.pullRequest.labels).toContain(RELEASE_PR_LABEL);
    expect(
      world.commits.get(head ?? "")?.files.map((file) => file.path),
    ).toEqual([CLI_MANIFEST, CLI_CHANGELOG]);
  });

  it("mints a fresh cryptographically random generation per attempt", async () => {
    const generations = new Set<string>();
    for (const _ of [0, 1, 2]) {
      const world = new FakeGitHub();
      // No injected generator: this exercises the production source.
      const production = new StableReleasePrManager(ports(world), {
        sleep: () => Promise.resolve(),
      });
      const ownership = await production.acquireCreationOwnership({
        plannedBaseSha: world.mainHead,
      });
      const value = ownership._unsafeUnwrap().ownerGeneration;
      expect(value).toMatch(/^[0-9a-f]{64}$/);
      generations.add(value);
    }
    expect(generations.size).toBe(3);
  });

  it("rejects a second request with the existing PR's URL", async () => {
    const world = new FakeGitHub();
    const first = await createRelease(world);
    expect(first.ok).toBe(true);
    const second = await createRelease(world);
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.error).toEqual({
      type: "ReleasePrExists",
      url: "https://github.com/weave-io/weave/pull/1",
    });
    expect(world.pulls).toHaveLength(1);
  });

  it("makes the losing racer poll and mutate nothing", async () => {
    const world = new FakeGitHub();
    const winner = await acquire(world);
    const markerBefore = world.markerSha();
    // The winner's PR only becomes visible while the loser is polling.
    const loser = manager(world, {
      sleep: () => {
        world.openPullRequest({
          title: "release",
          body: "",
          headRef: RELEASE_PR_MARKER_REF,
          baseRef: "main",
          labels: [RELEASE_PR_LABEL],
        });
        return Promise.resolve();
      },
    });
    const result = await loser.acquireCreationOwnership({
      plannedBaseSha: world.mainHead,
    });
    expect(result._unsafeUnwrapErr()).toEqual({
      type: "ReleasePrExists",
      url: "https://github.com/weave-io/weave/pull/1",
    });
    expect(world.markerSha()).toBe(markerBefore);
    expect(world.markerSha()).toBe(winner.expectedMarkerSha);
    expect(world.log.filter((line) => line.startsWith("deleteRef"))).toEqual(
      [],
    );
    expect(world.log.filter((line) => line.startsWith("updateRef"))).toEqual(
      [],
    );
  });

  it("reports a stalled creation when no PR ever appears", async () => {
    const world = new FakeGitHub();
    await acquire(world);
    const result = await manager(world).acquireCreationOwnership({
      plannedBaseSha: world.mainHead,
    });
    expect(result._unsafeUnwrapErr()).toEqual({
      type: "ReleasePrCreationStalled",
      ref: RELEASE_PR_MARKER_REF,
      attempts: 3,
    });
    expect(world.pulls).toHaveLength(0);
  });

  it("refuses a docs-audit outcome bound to another SHA", async () => {
    const world = new FakeGitHub();
    const ownership = await acquire(world);
    const result = await manager(world).finalizeCreation({
      ownership,
      prepared: preparedRelease(world.mainHead, {
        docsAuditedSha: sha("older-head"),
      }),
    });
    expect(result._unsafeUnwrapErr().type).toBe("DocsAuditNotBoundToBase");
    expect(world.markerSha()).toBeNull(); // cleaned up transactionally
  });

  it("refuses a prepared commit whose files were never declared", async () => {
    const world = new FakeGitHub();
    const ownership = await acquire(world);
    const result = await manager(world).finalizeCreation({
      ownership,
      prepared: preparedRelease(world.mainHead, {
        files: [{ path: "docs/reference/cli.md", contents: "x" }],
      }),
    });
    expect(result._unsafeUnwrapErr()).toEqual({
      type: "UndeclaredCommitFile",
      path: "docs/reference/cli.md",
    });
  });
});

// ---------------------------------------------------------------------------
// Creation freshness
// ---------------------------------------------------------------------------

describe("creation freshness", () => {
  it("returns PreparationStale without pushing, and keeps the marker", async () => {
    const world = new FakeGitHub();
    const base = world.mainHead;
    const ownership = await acquire(world);
    const newHead = world.advanceMain();
    const result = await manager(world).finalizeCreation({
      ownership,
      prepared: preparedRelease(base),
    });
    expect(result._unsafeUnwrapErr()).toEqual({
      type: "PreparationStale",
      newHead,
      baseSha: base,
      ownership,
    });
    expect(world.markerSha()).toBe(ownership.expectedMarkerSha);
    expect(world.pulls).toHaveLength(0);
    expect(world.log.filter((line) => line.startsWith("updateRef"))).toEqual(
      [],
    );
  });

  it("discards a built commit when main advances between build and swap", async () => {
    const world = new FakeGitHub();
    const base = world.mainHead;
    const ownership = await acquire(world);
    let newHead = "";
    world.hooks.beforeReadMain = (count) => {
      if (count === 2) newHead = world.advanceMain();
    };
    const result = await manager(world).finalizeCreation({
      ownership,
      prepared: preparedRelease(base),
    });
    expect(result._unsafeUnwrapErr()).toEqual({
      type: "PreparationStale",
      newHead,
      baseSha: base,
      ownership,
    });
    expect(world.markerSha()).toBe(ownership.expectedMarkerSha);
    expect(world.log.filter((line) => line.startsWith("updateRef"))).toEqual(
      [],
    );
  });

  it("opens no PR when main advances after the branch swap", async () => {
    const world = new FakeGitHub();
    const base = world.mainHead;
    const ownership = await acquire(world);
    let newHead = "";
    // The third trunk read is the one immediately before the PR is opened.
    world.hooks.beforeReadMain = (count) => {
      if (count === 3) newHead = world.advanceMain();
    };
    const result = await manager(world).finalizeCreation({
      ownership,
      prepared: preparedRelease(base),
    });
    const error = result._unsafeUnwrapErr();
    expect(error.type).toBe("PreparationStale");
    if (error.type !== "PreparationStale") return;
    expect(error.newHead).toBe(newHead);
    expect(error.baseSha).toBe(base);
    // No PR exists, the swap did happen, and the handed-back ownership leases
    // against the *new* head rather than the superseded marker object.
    expect(world.pulls).toHaveLength(0);
    const head = world.markerSha() ?? "";
    expect(head).not.toBe(ownership.expectedMarkerSha);
    expect(error.ownership.expectedMarkerSha).toBe(head);
    expect(error.ownership.ownerGeneration).toBe(ownership.ownerGeneration);
    expect(error.ownership.plannedBaseSha).toBe(ownership.plannedBaseSha);
    // Ownership stays provable from the new head's validated metadata.
    expect(envelopeAt(world, head)._unsafeUnwrap().ownerGeneration).toBe(
      ownership.ownerGeneration,
    );
  });

  it("aborts owned creation when a freshness read fails after ownership", async () => {
    const world = new FakeGitHub();
    const ownership = await acquire(world);
    world.faults.readMain = 1;
    const result = await manager(world).finalizeCreation({
      ownership,
      prepared: preparedRelease(world.mainHead),
    });
    const error = result._unsafeUnwrapErr();
    expect(error.type).not.toBe("PreparationStale");
    if (error.type === "CreationCleanupPending") {
      expect(error.reason).toBe("unverifiable-pull-request");
      expect(world.markerSha()).toBe(ownership.expectedMarkerSha);
      return;
    }
    expect(error).toMatchObject({
      type: "ReleasePrPortFailed",
      port: "readGreenMainHead",
    });
    expect(world.markerSha()).toBeNull();
    expect(world.pulls).toHaveLength(0);
  });

  it("aborts through cleanup when a post-swap freshness read fails", async () => {
    const world = new FakeGitHub();
    const ownership = await acquire(world);
    world.hooks.beforeReadMain = (count) => {
      if (count === 3) world.faults.readMain = 1;
    };
    const result = await manager(world).finalizeCreation({
      ownership,
      prepared: preparedRelease(world.mainHead),
    });
    const error = result._unsafeUnwrapErr();
    expect(error.type).not.toBe("PreparationStale");
    expect(world.pulls).toHaveLength(0);
    if (error.type === "CreationCleanupPending") {
      expect(world.markerSha()).not.toBeNull();
      return;
    }
    expect(error).toMatchObject({
      type: "ReleasePrPortFailed",
      port: "readGreenMainHead",
    });
    expect(world.markerSha()).toBeNull();
  });

  it.each([
    1, 2, 3,
  ])("replans to the newest accepted base when main advances at boundary %i", async (boundary) => {
    const world = new FakeGitHub();
    let advanced = false;
    world.hooks.beforeReadMain = (count) => {
      if (advanced || count !== boundary) return;
      advanced = true;
      world.advanceMain();
    };
    const created = await createRelease(world);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.value.baseSha).toBe(world.mainHead);
    const head = world.markerSha() ?? "";
    expect(head).toBe(created.value.ownership.expectedMarkerSha);
    expect(envelopeAt(world, head)._unsafeUnwrap().baseSha).toBe(
      world.mainHead,
    );
    expect(world.pulls.filter((pull) => pull.state === "open")).toHaveLength(1);
  });

  it("exhausts the budget with a generation-verified cleanup after a swap", async () => {
    const world = new FakeGitHub();
    // Every attempt swaps the branch and only then observes a moved trunk, so
    // each cleanup must delete a marker it no longer created itself.
    world.hooks.beforeReadMain = (count) => {
      if (count % 3 === 0) world.advanceMain();
    };
    const result = await createRelease(world);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toEqual({
      type: "PreparationFreshnessExhausted",
      attempts: 3,
      retryable: true,
      cleanup: "marker-deleted",
    });
    expect(world.markerSha()).toBeNull();
    expect(world.pulls).toHaveLength(0);
  });

  it("replans against the new head and embeds the newest accepted base", async () => {
    const world = new FakeGitHub();
    let advanced = false;
    world.hooks.beforeReadMain = () => {
      if (advanced) return;
      advanced = true;
      world.advanceMain();
    };
    const created = await createRelease(world);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.value.baseSha).toBe(world.mainHead);
    const head = world.markerSha() ?? "";
    expect(envelopeAt(world, head)._unsafeUnwrap().baseSha).toBe(
      world.mainHead,
    );
  });

  it("exhausts the replan budget through cleanup, leaving no marker and no PR", async () => {
    const world = new FakeGitHub();
    world.hooks.beforeReadMain = () => {
      world.advanceMain();
    };
    const result = await createRelease(world);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toEqual({
      type: "PreparationFreshnessExhausted",
      attempts: 3,
      retryable: true,
      cleanup: "marker-deleted",
    });
    expect(world.markerSha()).toBeNull();
    expect(world.pulls).toHaveLength(0);
  });

  it("reuses prose only for an unchanged identity set and unchanged evidence", () => {
    const limits = identity("limits");
    const settlement = identity("settlement");
    const previous = [
      entry("Delegation limits are portable", [limits]),
      entry("Settlement budget renews", [settlement]),
    ];
    const evidence = { pullRequests: [412] };
    const unchanged = planProseReuse({
      previous,
      previousEvidence: evidence,
      candidates: [[limits], [settlement]],
      evidence,
    });
    expect(unchanged.reused).toHaveLength(2);
    expect(unchanged.regenerate).toHaveLength(0);

    const redigested = planProseReuse({
      previous,
      previousEvidence: evidence,
      candidates: [[limits], [identity("settlement", "settlement-v2")]],
      evidence,
    });
    expect(redigested.reused.map((item) => item.index)).toEqual([0]);
    expect(redigested.regenerate.map((item) => item.index)).toEqual([1]);

    const unseen = planProseReuse({
      previous,
      previousEvidence: evidence,
      candidates: [[limits], [settlement], [identity("new-thing")]],
      evidence,
    });
    expect(unseen.regenerate.map((item) => item.index)).toEqual([2]);

    const movedEvidence = planProseReuse({
      previous,
      previousEvidence: evidence,
      candidates: [[limits], [settlement]],
      evidence: { pullRequests: [412, 413] },
    });
    expect(movedEvidence.reused).toHaveLength(0);
    expect(movedEvidence.regenerate).toHaveLength(2);
    expect(evidenceDigest(evidence)).not.toBe(
      evidenceDigest({ pullRequests: [412, 413] }),
    );
  });

  it("keys reuse on the whole identity set, order independent", () => {
    const first = identity("a");
    const second = identity("b");
    expect(entryIdentityKey([first, second])).toBe(
      entryIdentityKey([second, first]),
    );
    expect(entryIdentityKey([first])).not.toBe(
      entryIdentityKey([first, second]),
    );
  });
});

// ---------------------------------------------------------------------------
// Transactional cleanup
// ---------------------------------------------------------------------------

async function abort(
  world: FakeGitHub,
  ownership: ReleasePrOwnership,
  reconcile = false,
): Promise<
  | { ok: true; value: AbortOwnedCreationOutcome }
  | { ok: false; error: ReleasePrError }
> {
  const result = await manager(world).abortOwnedCreation({
    ownership,
    reconcile,
  });
  return result.match(
    (value) => ({ ok: true as const, value }),
    (error) => ({ ok: false as const, error }),
  );
}

describe("abortOwnedCreation", () => {
  it("CAS-deletes only its own marker when no PR exists", async () => {
    const world = new FakeGitHub();
    const ownership = await acquire(world);
    const result = await abort(world, ownership);
    expect(result.ok && result.value.kind).toBe("marker-deleted");
    expect(world.markerSha()).toBeNull();
  });

  it("keeps the marker and surfaces the URL when a PR is visible", async () => {
    const world = new FakeGitHub();
    const ownership = await acquire(world);
    world.openPullRequest({
      title: "release",
      body: ownershipEnvelope(ownership),
      headRef: RELEASE_PR_MARKER_REF,
      baseRef: "main",
      labels: [RELEASE_PR_LABEL],
    });
    const result = await abort(world, ownership);
    expect(result.ok && result.value).toMatchObject({
      kind: "pull-request-visible",
      url: "https://github.com/weave-io/weave/pull/1",
    });
    expect(world.markerSha()).toBe(ownership.expectedMarkerSha);
  });

  it("never deletes a successor's marker at the same planned base (ABA)", async () => {
    const world = new FakeGitHub();
    const base = world.mainHead;
    const creatorA = await acquire(world, base);
    // A's marker is deleted, then B claims a new one at the *same* base.
    world.refs.delete(REF_PATH);
    const creatorB = await acquire(world, base);
    expect(creatorB.plannedBaseSha).toBe(creatorA.plannedBaseSha);
    expect(creatorB.ownerGeneration).not.toBe(creatorA.ownerGeneration);
    expect(creatorB.expectedMarkerSha).not.toBe(creatorA.expectedMarkerSha);

    const delayed = await abort(world, creatorA);
    expect(delayed.ok).toBe(false);
    if (delayed.ok) return;
    expect(delayed.error).toEqual({
      type: "CreationCleanupPending",
      ref: RELEASE_PR_MARKER_REF,
      ownerGeneration: creatorA.ownerGeneration,
      expectedMarkerSha: creatorA.expectedMarkerSha,
      plannedBaseSha: base,
      reason: "ownership-changed",
    });
    expect(world.markerSha()).toBe(creatorB.expectedMarkerSha);
  });

  it("refuses a marker whose generation is foreign even at the expected head", async () => {
    const world = new FakeGitHub();
    const ownership = await acquire(world);
    const result = await abort(world, {
      ...ownership,
      ownerGeneration: hex("someone-else"),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({
      type: "CreationCleanupPending",
      reason: "ownership-changed",
    });
    expect(world.markerSha()).toBe(ownership.expectedMarkerSha);
  });

  it("refuses a marker whose ownership metadata is unreadable or tampered", async () => {
    const world = new FakeGitHub();
    const ownership = await acquire(world);
    const commit = world.commits.get(ownership.expectedMarkerSha);
    world.commits.set(ownership.expectedMarkerSha, {
      message: "chore(release): claim stable release-pr marker",
      parent: commit?.parent ?? "",
      files: [],
    });
    const tampered = await abort(world, ownership);
    expect(tampered.ok).toBe(false);
    if (tampered.ok) return;
    expect(tampered.error).toMatchObject({
      type: "CreationCleanupPending",
      reason: "unverifiable-ownership",
    });
    expect(world.markerSha()).toBe(ownership.expectedMarkerSha);

    world.faults.readCommitMessage = 1;
    const unreadable = await abort(world, ownership);
    expect(unreadable.ok === false && unreadable.error).toMatchObject({
      type: "CreationCleanupPending",
      reason: "unverifiable-ownership",
    });
  });

  it("reports a failed CAS delete and an unverifiable PR query without claiming cleanup", async () => {
    const world = new FakeGitHub();
    const ownership = await acquire(world);
    world.faults.deleteRef = 1;
    const casFailure = await abort(world, ownership);
    expect(casFailure.ok === false && casFailure.error).toMatchObject({
      type: "CreationCleanupPending",
      reason: "cas-delete-failed",
    });
    expect(world.markerSha()).toBe(ownership.expectedMarkerSha);

    world.faults.listPulls = 10;
    const unverifiable = await abort(world, ownership, true);
    expect(unverifiable.ok === false && unverifiable.error).toMatchObject({
      type: "CreationCleanupPending",
      reason: "unverifiable-pull-request",
    });
    expect(world.markerSha()).toBe(ownership.expectedMarkerSha);
  });

  it("treats an already-absent marker as a non-orphan terminal", async () => {
    const world = new FakeGitHub();
    const ownership = await acquire(world);
    world.refs.delete(REF_PATH);
    const result = await abort(world, ownership);
    expect(result.ok && result.value.kind).toBe("marker-absent");
  });

  it("reconciles an ambiguous create that actually succeeded", async () => {
    const world = new FakeGitHub();
    const ownership = await acquire(world);
    let opened = false;
    const result = await manager(world, {
      sleep: () => {
        if (!opened) {
          opened = true;
          world.openPullRequest({
            title: "release",
            body: ownershipEnvelope(ownership),
            headRef: RELEASE_PR_MARKER_REF,
            baseRef: "main",
            labels: [RELEASE_PR_LABEL],
          });
        }
        return Promise.resolve();
      },
    }).abortOwnedCreation({ ownership, reconcile: true });
    expect(result._unsafeUnwrap()).toMatchObject({
      kind: "pull-request-visible",
    });
    expect(world.markerSha()).toBe(ownership.expectedMarkerSha);
  });

  it("finds an unlabeled PR on the owner-qualified head and keeps the marker", async () => {
    const world = new FakeGitHub();
    const ownership = await acquire(world);
    world.openPullRequest({
      title: "release",
      body: ownershipEnvelope(ownership),
      headRef: RELEASE_PR_MARKER_REF,
      baseRef: "main",
      labels: [],
    });
    const result = await abort(world, ownership);
    expect(result.ok && result.value).toMatchObject({
      kind: "pull-request-visible",
      url: "https://github.com/weave-io/weave/pull/1",
    });
    expect(world.markerSha()).toBe(ownership.expectedMarkerSha);
    expect(
      (
        await world.listOpenPullRequestsByLabel(RELEASE_PR_LABEL)
      )._unsafeUnwrap(),
    ).toEqual([]);
  });

  it("keeps the marker when a live PR fails the head or envelope check", async () => {
    const world = new FakeGitHub();
    const ownership = await acquire(world);
    world.openPullRequest({
      title: "release",
      body: "no envelope",
      headRef: RELEASE_PR_MARKER_REF,
      baseRef: "main",
      labels: [],
    });
    const missingEnvelope = await abort(world, ownership);
    expect(missingEnvelope.ok).toBe(false);
    if (missingEnvelope.ok) return;
    expect(missingEnvelope.error).toMatchObject({
      type: "CreationCleanupPending",
      reason: "unverifiable-pull-request",
    });
    expect(world.markerSha()).toBe(ownership.expectedMarkerSha);

    const existing = world.pulls[0];
    expect(existing).toBeDefined();
    if (existing === undefined) return;
    world.pulls[0] = {
      ...existing,
      body: ownershipEnvelope(ownership),
      headSha: sha("other-head"),
    };
    const wrongHead = await abort(world, ownership);
    expect(wrongHead.ok === false && wrongHead.error).toMatchObject({
      type: "CreationCleanupPending",
      reason: "unverifiable-pull-request",
    });
    expect(world.markerSha()).toBe(ownership.expectedMarkerSha);
  });

  it("sees an older open PR even when a newer closed same-head PR exists", async () => {
    const world = new FakeGitHub();
    const ownership = await acquire(world);
    world.openPullRequest({
      title: "release",
      body: ownershipEnvelope(ownership),
      headRef: RELEASE_PR_MARKER_REF,
      baseRef: "main",
      labels: [RELEASE_PR_LABEL],
    });
    world.pulls.push({
      number: 99,
      url: "https://github.com/weave-io/weave/pull/99",
      state: "closed",
      merged: false,
      headRef: RELEASE_PR_MARKER_REF,
      headSha: sha("unrelated-closed"),
      baseRef: "main",
      title: "stale",
      body: "unrelated",
      labels: [],
    });
    const result = await abort(world, ownership);
    expect(result.ok && result.value).toMatchObject({
      kind: "pull-request-visible",
      url: "https://github.com/weave-io/weave/pull/1",
    });
    expect(world.markerSha()).toBe(ownership.expectedMarkerSha);
  });
});

describe("transactional creation faults", () => {
  interface FaultCase {
    name: string;
    apply: (world: FakeGitHub) => void;
    preparer?: CreationPreparer;
  }

  const cases: FaultCase[] = [
    {
      name: "plan rebinding",
      apply: () => void 0,
      preparer: failingPreparer("plan-rebinding"),
    },
    {
      name: "docs gate",
      apply: () => void 0,
      preparer: failingPreparer("docs-gate"),
    },
    {
      name: "changelog AI",
      apply: () => void 0,
      preparer: failingPreparer("changelog-ai"),
    },
    {
      name: "prepared-commit construction",
      apply: (world) => {
        world.faults.createCommit = 1;
      },
    },
    {
      name: "branch push",
      apply: (world) => {
        world.faults.updateRef = 1;
      },
    },
    {
      name: "definite PR-create failure",
      apply: (world) => {
        world.faults.createPullRequest = "definite";
      },
    },
    {
      name: "create succeeded but labeling failed",
      apply: (world) => {
        world.faults.createPullRequest = "unlabeled";
      },
    },
    {
      name: "freshness read failed after ownership",
      apply: (world) => {
        world.faults.readMain = 1;
      },
    },
    {
      name: "ambiguous PR-create timeout with no PR",
      apply: (world) => {
        world.faults.createPullRequest = "ambiguous";
      },
    },
    {
      name: "ambiguous PR-create timeout with the PR created",
      apply: (world) => {
        world.faults.createPullRequest = "ambiguous";
        world.faults.createPullRequestServerSide = true;
      },
    },
    {
      name: "post-create verification failure",
      apply: (world) => {
        world.hooks.afterCreatePullRequest = () => {
          world.faults.listPulls = 10;
        };
      },
    },
    {
      name: "ownership changed before cleanup",
      apply: (world) => {
        world.faults.updateRef = 1;
        world.hooks.beforeUpdateRef = () => {
          const head = world.markerSha();
          if (head === null) return;
          world.refs.set(REF_PATH, sha("successor-marker"));
        };
      },
    },
    {
      name: "cleanup CAS delete fails",
      apply: (world) => {
        world.faults.updateRef = 1;
        world.faults.deleteRef = 1;
      },
    },
    {
      name: "cleanup PR query unverifiable",
      apply: (world) => {
        world.faults.updateRef = 1;
        world.hooks.beforeUpdateRef = () => {
          world.faults.listPulls = 20;
        };
      },
    },
  ];

  it.each(cases)("never leaves (marker, no PR) silently: $name", async ({
    apply,
    preparer,
  }) => {
    const world = new FakeGitHub();
    apply(world);
    const result = await createRelease(world, { preparer });
    const markerSha = world.markerSha();
    const openPulls = world.pulls.filter((pull) => pull.state === "open");

    if (result.ok) {
      expect(openPulls).toHaveLength(1);
      expect(markerSha).not.toBeNull();
      return;
    }
    const error = result.error;
    if (error.type === "CreationCleanupPending") {
      // Explicitly unproven: doctor and resume own the recovery, and the
      // full ownership identity travels with the report.
      expect(error.ref).toBe(RELEASE_PR_MARKER_REF);
      expect(error.ownerGeneration).toMatch(/^[0-9a-f]{64}$/);
      expect(error.expectedMarkerSha).toMatch(/^[0-9a-f]{40}$/);
      expect(error.plannedBaseSha).toMatch(/^[0-9a-f]{40}$/);
      return;
    }
    if (
      error.type === "ReleasePrExists" ||
      error.type === "ReleasePrVerificationPending"
    ) {
      expect(error.url).toContain("/pull/");
      expect(openPulls.length).toBeGreaterThan(0);
      return;
    }
    // Every remaining terminal must have cleaned its own marker.
    expect(markerSha).toBeNull();
    expect(openPulls).toHaveLength(0);
  });

  it("surfaces the URL when an ambiguous create actually succeeded", async () => {
    const world = new FakeGitHub();
    world.faults.createPullRequest = "ambiguous";
    world.faults.createPullRequestServerSide = true;
    const result = await createRelease(world);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({ type: "ReleasePrExists" });
    expect(world.markerSha()).not.toBeNull();
  });

  it("deletes the marker when an ambiguous create provably did not happen", async () => {
    const world = new FakeGitHub();
    world.faults.createPullRequest = "ambiguous";
    const result = await createRelease(world);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({
      type: "ReleasePreparationFailed",
      stage: "pull-request-create",
      retryable: true,
    });
    expect(world.markerSha()).toBeNull();
    expect(world.pulls).toHaveLength(0);
  });

  it("keeps the marker and reports the URL when post-create verification fails", async () => {
    const world = new FakeGitHub();
    world.hooks.afterCreatePullRequest = () => {
      world.faults.listPulls = 10;
    };
    const result = await createRelease(world);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({
      type: "ReleasePrVerificationPending",
      url: "https://github.com/weave-io/weave/pull/1",
    });
    expect(world.markerSha()).not.toBeNull();
  });

  it("keeps the marker when create succeeds but labeling fails", async () => {
    const world = new FakeGitHub();
    world.faults.createPullRequest = "unlabeled";
    const result = await createRelease(world);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({ type: "ReleasePrExists" });
    expect(world.markerSha()).not.toBeNull();
    expect(world.pulls).toHaveLength(1);
    expect(world.pulls[0]?.labels).toEqual([]);
    expect(
      (
        await world.listOpenPullRequestsByLabel(RELEASE_PR_LABEL)
      )._unsafeUnwrap(),
    ).toEqual([]);
  });

  it("still reports DuplicateReleasePr when two labeled PRs exist", async () => {
    const world = new FakeGitHub();
    world.hooks.afterCreatePullRequest = () => {
      world.hooks.afterCreatePullRequest = undefined;
      world.openPullRequest({
        title: "impostor",
        body: "",
        headRef: RELEASE_PR_MARKER_REF,
        baseRef: "main",
        labels: [RELEASE_PR_LABEL],
      });
    };
    const result = await createRelease(world);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.type).toBe("DuplicateReleasePr");
  });
});

// ---------------------------------------------------------------------------
// Edit preservation
// ---------------------------------------------------------------------------

describe("edit preservation", () => {
  const limits = identity("limits");
  const generated = entry("Delegation limits are portable", [limits]);
  const recorded = [
    {
      key: entryIdentityKey([limits]),
      digest: `sha256:${hex(generated.prose)}`,
    },
  ];

  it("preserves human prose whose identity set is unchanged", () => {
    const human = entry("Delegation limits now travel with you", [limits]);
    const resolved = resolveRegeneratedEntries({
      generated: [generated],
      current: [human],
      recorded,
      recordedEvidenceDigest: EVIDENCE_DIGEST,
      evidence: EVIDENCE,
    })._unsafeUnwrap();
    expect(resolved.entries).toEqual([human]);
    expect(resolved.preserved).toEqual([entryIdentityKey([limits])]);
    expect(resolved.entryProse).toEqual(recorded);
  });

  it("blocks with both renderings when a re-digested changeset was hand edited", () => {
    const human = entry("Delegation limits now travel with you", [limits]);
    const rewritten = entry("Delegation limits are portable everywhere", [
      identity("limits", "limits-v2"),
    ]);
    const conflict = resolveRegeneratedEntries({
      generated: [rewritten],
      current: [human],
      recorded,
      recordedEvidenceDigest: EVIDENCE_DIGEST,
      evidence: EVIDENCE,
    })._unsafeUnwrapErr();
    expect(conflict).toEqual({
      type: "EditConflict",
      entries: [
        {
          key: entryIdentityKey([limits]),
          changesetId: "limits",
          human: human.prose,
          generated: rewritten.prose,
        },
      ],
    });
  });

  it("regenerates silently when a re-digested changeset was never edited", () => {
    const rewritten = entry("Delegation limits are portable everywhere", [
      identity("limits", "limits-v2"),
    ]);
    const resolved = resolveRegeneratedEntries({
      generated: [rewritten],
      current: [generated],
      recorded,
      recordedEvidenceDigest: EVIDENCE_DIGEST,
      evidence: EVIDENCE,
    })._unsafeUnwrap();
    expect(resolved.entries).toEqual([rewritten]);
  });

  it("treats an unrecorded entry as human-written and blocks", () => {
    const rewritten = entry("Delegation limits are portable everywhere", [
      identity("limits", "limits-v2"),
    ]);
    const conflict = resolveRegeneratedEntries({
      generated: [rewritten],
      current: [generated],
      recorded: [],
      recordedEvidenceDigest: EVIDENCE_DIGEST,
      evidence: EVIDENCE,
    })._unsafeUnwrapErr();
    expect(conflict.type).toBe("EditConflict");
  });

  it("adds new entries for new changesets", () => {
    const addition = entry("Settlement budget renews", [
      identity("settlement"),
    ]);
    const resolved = resolveRegeneratedEntries({
      generated: [generated, addition],
      current: [generated],
      recorded,
      recordedEvidenceDigest: EVIDENCE_DIGEST,
      evidence: EVIDENCE,
    })._unsafeUnwrap();
    expect(resolved.entries).toEqual([generated, addition]);
    expect(resolved.entryProse).toHaveLength(2);
  });

  const movedEvidence: ChangelogEvidence = { pullRequests: [412, 413] };

  it("preserves a human edit only while the evidence is unchanged", () => {
    const human = entry("Delegation limits now travel with you", [limits]);
    const resolved = resolveRegeneratedEntries({
      generated: [generated],
      current: [human],
      recorded,
      recordedEvidenceDigest: EVIDENCE_DIGEST,
      evidence: EVIDENCE,
    })._unsafeUnwrap();
    expect(resolved.entries).toEqual([human]);
    expect(resolved.evidenceDigest).toBe(EVIDENCE_DIGEST);
    expect(evidenceDigest(movedEvidence)).not.toBe(EVIDENCE_DIGEST);
  });

  it("blocks with both renderings when the evidence moved under a human edit", () => {
    const human = entry("Delegation limits now travel with you", [limits]);
    const conflict = resolveRegeneratedEntries({
      generated: [generated],
      current: [human],
      recorded,
      recordedEvidenceDigest: EVIDENCE_DIGEST,
      evidence: movedEvidence,
    })._unsafeUnwrapErr();
    expect(conflict).toEqual({
      type: "EditConflict",
      entries: [
        {
          key: entryIdentityKey([limits]),
          changesetId: "limits",
          human: human.prose,
          generated: generated.prose,
        },
      ],
    });
  });

  it("regenerates untouched prose when only the evidence moved", () => {
    const rewritten = entry("Delegation limits are portable, with receipts", [
      limits,
    ]);
    const resolved = resolveRegeneratedEntries({
      generated: [rewritten],
      current: [generated],
      recorded,
      recordedEvidenceDigest: EVIDENCE_DIGEST,
      evidence: movedEvidence,
    })._unsafeUnwrap();
    expect(resolved.entries).toEqual([rewritten]);
    expect(resolved.preserved).toEqual([]);
    expect(resolved.evidenceDigest).toBe(evidenceDigest(movedEvidence));
    expect(resolved.entryProse).toEqual([
      {
        key: entryIdentityKey([limits]),
        digest: `sha256:${hex(rewritten.prose)}`,
      },
    ]);
  });

  it("treats an unrecorded evidence digest as moved evidence", () => {
    const human = entry("Delegation limits now travel with you", [limits]);
    const conflict = resolveRegeneratedEntries({
      generated: [generated],
      current: [human],
      recorded,
      recordedEvidenceDigest: null,
      evidence: EVIDENCE,
    })._unsafeUnwrapErr();
    expect(conflict.type).toBe("EditConflict");
  });
});

// ---------------------------------------------------------------------------
// Regeneration
// ---------------------------------------------------------------------------

interface BuilderOptions {
  generated?: readonly ChangelogEntry[];
  current?: readonly ChangelogEntry[];
  evidence?: ChangelogEvidence;
  docsAuditedSha?: string;
  failBuild?: PreparationFailure;
}

function builderFor(
  world: FakeGitHub,
  options: BuilderOptions = {},
): RegenerationBuilder & { rendered: PreparedRelease[] } {
  const rendered: PreparedRelease[] = [];
  return {
    rendered,
    build: (input) => {
      if (options.failBuild !== undefined)
        return errAsync<RegenerationDraft, PreparationFailure>(
          options.failBuild,
        );
      return okAsync<RegenerationDraft, PreparationFailure>({
        generated: options.generated ?? [
          entry("Delegation limits are portable", [identity("limits")]),
        ],
        current: options.current ?? [
          entry("Delegation limits are portable", [identity("limits")]),
        ],
        evidence: options.evidence ?? EVIDENCE,
        docsAuditedSha: options.docsAuditedSha ?? input.baseSha,
      });
    },
    render: (input) => {
      const prepared = preparedRelease(input.baseSha, {
        entries: input.entries,
        body: `Seed: @weaveio/weave-cli at ${world.mainHead}`,
      });
      rendered.push(prepared);
      return okAsync<PreparedRelease, PreparationFailure>(prepared);
    },
  };
}

describe("regenerate", () => {
  it("is a typed green no-op with no marker and no PR", async () => {
    const world = new FakeGitHub();
    const result = await manager(world).regenerate({
      builder: builderFor(world),
    });
    expect(result._unsafeUnwrap()).toEqual({ kind: "NoReleasePrToRegenerate" });
    expect(world.log).toEqual([]);
  });

  it("converges as superseded when the live PR already matches the green trunk", async () => {
    const world = new FakeGitHub();
    const created = await createRelease(world);
    expect(created.ok).toBe(true);
    const result = await manager(world).regenerate({
      builder: builderFor(world),
    });
    expect(result._unsafeUnwrap()).toMatchObject({
      kind: "RegenerationSuperseded",
      survivingBaseSha: world.mainHead,
      baseSha: world.mainHead,
    });
    expect(
      world.log.filter((line) => line.startsWith("updatePullRequest")),
    ).toEqual([]);
  });

  it("never creates: a stalled creation is typed and mutates nothing", async () => {
    const world = new FakeGitHub();
    const ownership = await acquire(world);
    const result = await manager(world).regenerate({
      builder: builderFor(world),
    });
    expect(result._unsafeUnwrapErr()).toEqual({
      type: "ReleasePrCreationStalled",
      ref: RELEASE_PR_MARKER_REF,
      attempts: 3,
    });
    expect(world.markerSha()).toBe(ownership.expectedMarkerSha);
    expect(world.pulls).toHaveLength(0);
  });

  it("waits for a creation in progress, then updates the PR that appears", async () => {
    const world = new FakeGitHub();
    const base = world.mainHead;
    const ownership = await acquire(world);
    const creator = manager(world);
    let finalized = false;
    const regenerator = new StableReleasePrManager(ports(world), {
      generateOwnerGeneration: () => world.nextGeneration(),
      sleep: async () => {
        if (finalized) return;
        finalized = true;
        const created = await creator.finalizeCreation({
          ownership,
          prepared: preparedRelease(base),
        });
        expect(created.isOk()).toBe(true);
        world.advanceMain();
      },
      bounds: {
        creationPollAttempts: 3,
        regenerationAttempts: 3,
        pollDelayMs: 0,
      },
    });
    const result = await regenerator.regenerate({ builder: builderFor(world) });
    expect(result._unsafeUnwrap()).toMatchObject({ kind: "Regenerated" });
    expect(world.pulls).toHaveLength(1);
  });

  it("rebuilds against the newest trunk, preserves ownership, and appends the audit trail", async () => {
    const world = new FakeGitHub();
    const created = await createRelease(world);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const firstBase = created.value.baseSha;
    const newHead = world.advanceMain();

    const builder = builderFor(world);
    const result = await manager(world).regenerate({ builder });
    const outcome = result._unsafeUnwrap();
    expect(outcome).toMatchObject({
      kind: "Regenerated",
      baseSha: newHead,
      regeneratedFrom: [firstBase],
    });
    const head = world.markerSha() ?? "";
    const envelope = envelopeAt(world, head)._unsafeUnwrap();
    expect(envelope.baseSha).toBe(newHead);
    expect(envelope.ownerGeneration).toBe(
      created.value.ownership.ownerGeneration,
    );
    expect(envelope.plannedBaseSha).toBe(firstBase);
    expect(envelope.regeneratedFrom).toEqual([firstBase]);
    expect(world.pulls).toHaveLength(1);
    expect(world.pulls[0]?.body).toContain(RELEASE_PR_ENVELOPE_MARKER);
  });

  it("carries preserved human prose into the rendered content", async () => {
    const world = new FakeGitHub();
    const human = entry("Delegation limits now travel with you", [
      identity("limits"),
    ]);
    const created = await createRelease(world);
    expect(created.ok).toBe(true);
    world.advanceMain();
    const builder = builderFor(world, { current: [human] });
    const result = await manager(world).regenerate({ builder });
    expect(result._unsafeUnwrap()).toMatchObject({ kind: "Regenerated" });
    expect(builder.rendered[0]?.entries).toEqual([human]);
  });

  it("blocks on an edit conflict without mutating the ref or the PR", async () => {
    const world = new FakeGitHub();
    const created = await createRelease(world);
    expect(created.ok).toBe(true);
    const headBefore = world.markerSha();
    world.advanceMain();
    const builder = builderFor(world, {
      current: [
        entry("Delegation limits now travel with you", [identity("limits")]),
      ],
      generated: [
        entry("Delegation limits are portable everywhere", [
          identity("limits", "limits-v2"),
        ]),
      ],
    });
    const result = await manager(world).regenerate({ builder });
    const error = result._unsafeUnwrapErr();
    expect(error.type).toBe("EditConflict");
    if (error.type !== "EditConflict") return;
    expect(error.entries[0]?.human).toBe(
      "Delegation limits now travel with you",
    );
    expect(error.entries[0]?.generated).toBe(
      "Delegation limits are portable everywhere",
    );
    expect(world.markerSha()).toBe(headBefore);
  });

  it("refuses a docs-audit outcome that is not bound to the rebuilt head", async () => {
    const world = new FakeGitHub();
    await createRelease(world);
    world.advanceMain();
    const result = await manager(world).regenerate({
      builder: builderFor(world, { docsAuditedSha: sha("stale-audit") }),
    });
    expect(result._unsafeUnwrapErr().type).toBe("DocsAuditNotBoundToBase");
  });

  it("converges as superseded when the surviving head already covers a newer base", async () => {
    const world = new FakeGitHub();
    const created = await createRelease(world);
    expect(created.ok).toBe(true);
    world.advanceMain();
    // Another writer lands a newer regeneration while this one is building.
    world.hooks.beforeUpdateRef = () => {
      world.hooks.beforeUpdateRef = undefined;
      const newest = world.advanceMain();
      const envelope = renderReleasePrEnvelope({
        schemaVersion: 1,
        ref: RELEASE_PR_MARKER_REF,
        ownerGeneration: created.ok
          ? created.value.ownership.ownerGeneration
          : hex("x"),
        plannedBaseSha: created.ok ? created.value.baseSha : sha("base"),
        baseSha: newest,
        regeneratedFrom: [],
        entryProse: [],
        evidenceDigest: EVIDENCE_DIGEST,
      })._unsafeUnwrap();
      const winner = sha("winning-regeneration");
      world.commits.set(winner, {
        message: `chore(release): version packages\n\n${envelope}\n`,
        parent: newest,
        files: [],
      });
      world.refs.set(REF_PATH, winner);
      const existing = world.pulls[0];
      if (existing !== undefined)
        world.pulls[0] = {
          ...existing,
          body: `Seed: @weaveio/weave-cli\n\n${envelope}\n`,
        };
    };
    const result = await manager(world).regenerate({
      builder: builderFor(world),
    });
    // The winner already covered a newer base. This run must not overwrite
    // that head, but it must still repair the PR that still describes the old
    // one.
    expect(result._unsafeUnwrap()).toMatchObject({
      kind: "PrMetadataReconciled",
      baseSha: envelopeAt(world, sha("winning-regeneration"))._unsafeUnwrap()
        .baseSha,
    });
    expect(world.markerSha()).toBe(sha("winning-regeneration"));
    expect(
      parseReleasePrEnvelope(world.pulls[0]?.body ?? "")._unsafeUnwrap()
        .baseSha,
    ).toBe(
      envelopeAt(world, sha("winning-regeneration"))._unsafeUnwrap().baseSha,
    );
  });

  it("retries after losing the lease to an older writer and lands the newer base", async () => {
    const world = new FakeGitHub();
    const created = await createRelease(world);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const newest = world.advanceMain();
    // The lease is lost once to a writer whose base is older than this run's.
    world.hooks.beforeUpdateRef = () => {
      world.hooks.beforeUpdateRef = undefined;
      const envelope = renderReleasePrEnvelope({
        schemaVersion: 1,
        ref: RELEASE_PR_MARKER_REF,
        ownerGeneration: created.value.ownership.ownerGeneration,
        plannedBaseSha: created.value.baseSha,
        baseSha: created.value.baseSha,
        regeneratedFrom: [],
        entryProse: [],
        evidenceDigest: EVIDENCE_DIGEST,
      })._unsafeUnwrap();
      const stale = sha("older-regeneration");
      world.commits.set(stale, {
        message: `chore(release): version packages\n\n${envelope}\n`,
        parent: created.value.baseSha,
        files: [],
      });
      world.refs.set(REF_PATH, stale);
    };
    const result = await manager(world).regenerate({
      builder: builderFor(world),
    });
    expect(result._unsafeUnwrap()).toMatchObject({
      kind: "Regenerated",
      baseSha: newest,
    });
    const head = world.markerSha() ?? "";
    expect(envelopeAt(world, head)._unsafeUnwrap().baseSha).toBe(newest);
  });

  it("discards a built commit when main advances while it is being created", async () => {
    const world = new FakeGitHub();
    const created = await createRelease(world);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const contested = world.advanceMain();
    let newest = "";
    // The trunk moves inside the commit-creation round trip, so the freshness
    // recheck must sit after it and before the compare-and-swap.
    world.hooks.beforeCreateCommit = () => {
      world.hooks.beforeCreateCommit = undefined;
      newest = world.advanceMain();
    };
    const swapsBefore = world.log.filter((line) =>
      line.startsWith("updateRef"),
    ).length;
    const result = await manager(world).regenerate({
      builder: builderFor(world),
    });
    expect(result._unsafeUnwrap()).toMatchObject({
      kind: "Regenerated",
      baseSha: newest,
    });
    expect(newest).not.toBe(contested);
    // Exactly one swap landed, and it carried the newest base, never the
    // commit built against the contested one.
    const swaps = world.log.filter((line) => line.startsWith("updateRef"));
    expect(swaps).toHaveLength(swapsBefore + 1);
    const head = world.markerSha() ?? "";
    expect(envelopeAt(world, head)._unsafeUnwrap().baseSha).toBe(newest);
  });

  it("exhausts bounded retries typed when the trunk never settles", async () => {
    const world = new FakeGitHub();
    await createRelease(world);
    world.advanceMain();
    let reads = 0;
    world.hooks.beforeReadMain = () => {
      reads += 1;
      if (reads % 2 === 0) world.advanceMain();
    };
    const result = await manager(world).regenerate({
      builder: builderFor(world),
    });
    expect(result._unsafeUnwrapErr()).toEqual({
      type: "RegenerationRetriesExhausted",
      attempts: 3,
    });
  });

  it("propagates a typed build failure without mutating", async () => {
    const world = new FakeGitHub();
    await createRelease(world);
    const headBefore = world.markerSha();
    world.advanceMain();
    const result = await manager(world).regenerate({
      builder: builderFor(world, {
        failBuild: { stage: "docs-gate", message: "hard finding" },
      }),
    });
    expect(result._unsafeUnwrapErr()).toEqual({
      type: "ReleasePreparationFailed",
      stage: "docs-gate",
      message: "hard finding",
      retryable: true,
    });
    expect(world.markerSha()).toBe(headBefore);
  });

  it("refuses to regenerate while a marker cleanup is pending", async () => {
    const world = new FakeGitHub();
    await createRelease(world);
    world.settlePullRequest(1, "merged");
    const result = await manager(world).regenerate({
      builder: builderFor(world),
    });
    expect(result._unsafeUnwrapErr().type).toBe("MarkerCleanupPending");
  });

  it("repairs PR metadata on the rerun after a PATCH-after-CAS failure", async () => {
    const world = new FakeGitHub();
    const created = await createRelease(world);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const newest = world.advanceMain();
    const staleBody = world.pulls[0]?.body ?? "";
    world.faults.updatePullRequest = 2;
    const first = await manager(world).regenerate({
      builder: builderFor(world),
    });
    expect(first._unsafeUnwrapErr()).toMatchObject({
      type: "ReleasePrMetadataPending",
      pending: ["envelope"],
    });
    expect(
      envelopeAt(world, world.markerSha() ?? "")._unsafeUnwrap().baseSha,
    ).toBe(newest);
    expect(world.pulls[0]?.body).toBe(staleBody);
    expect((await discover(world)).kind).toBe("pr-metadata-pending");

    const second = await manager(world).regenerate({
      builder: builderFor(world),
    });
    expect(second._unsafeUnwrap()).toMatchObject({
      kind: "PrMetadataReconciled",
      baseSha: newest,
    });
    const repaired = parseReleasePrEnvelope(world.pulls[0]?.body ?? "");
    expect(repaired._unsafeUnwrap().baseSha).toBe(newest);
    expect(world.pulls[0]?.title).toBe("chore(release): publish stable");
    expect((await discover(world)).kind).toBe("live");
  });

  it("discovers an unlabeled creation PR and repairs the label on regenerate", async () => {
    const world = new FakeGitHub();
    world.faults.createPullRequest = "unlabeled";
    const created = await createRelease(world);
    expect(created.ok).toBe(false);
    expect(world.pulls[0]?.labels).toEqual([]);
    expect((await discover(world)).kind).toBe("pr-metadata-pending");

    const result = await manager(world).regenerate({
      builder: builderFor(world),
    });
    expect(result._unsafeUnwrap()).toMatchObject({
      kind: "PrMetadataReconciled",
      pending: ["label"],
    });
    expect(world.pulls[0]?.labels).toContain(RELEASE_PR_LABEL);
    expect(
      world.log.some((line) => line.startsWith("addPullRequestLabels")),
    ).toBe(true);
    expect((await discover(world)).kind).toBe("live");
  });
});

// ---------------------------------------------------------------------------
// Marker lifecycle
// ---------------------------------------------------------------------------

describe("marker lifecycle", () => {
  it("deletes the marker after merge and after close alike", async () => {
    for (const state of ["merged", "closed"] as const) {
      const world = new FakeGitHub();
      await createRelease(world);
      world.settlePullRequest(1, state);
      const result = await manager(world).deleteMarkerRef();
      expect(result._unsafeUnwrap()).toMatchObject({ kind: "deleted" });
      expect(world.markerSha()).toBeNull();
    }
  });

  it("is idempotent when the marker is already gone", async () => {
    const world = new FakeGitHub();
    const result = await manager(world).deleteMarkerRef();
    expect(result._unsafeUnwrap()).toEqual({
      kind: "already-absent",
      ref: RELEASE_PR_MARKER_REF,
    });
  });

  it("refuses to delete the lock of an open PR", async () => {
    const world = new FakeGitHub();
    await createRelease(world);
    const result = await manager(world).deleteMarkerRef();
    expect(result._unsafeUnwrapErr()).toEqual({
      type: "MarkerDeletionNotAuthorized",
      ref: RELEASE_PR_MARKER_REF,
      reason: "pull-request-open",
    });
    expect(world.markerSha()).not.toBeNull();
  });

  it("refuses to delete when no settled PR authorizes the lock", async () => {
    const world = new FakeGitHub();
    const ownership = await acquire(world);
    const result = await manager(world).deleteMarkerRef();
    expect(result._unsafeUnwrapErr()).toEqual({
      type: "MarkerDeletionNotAuthorized",
      ref: RELEASE_PR_MARKER_REF,
      reason: "no-settled-pull-request",
    });
    expect(world.markerSha()).toBe(ownership.expectedMarkerSha);
  });

  it("refuses to delete when an older open PR is hidden by a newer closed PR", async () => {
    const world = new FakeGitHub();
    await createRelease(world);
    const marker = world.markerSha();
    world.pulls.push({
      number: 99,
      url: "https://github.com/weave-io/weave/pull/99",
      state: "closed",
      merged: true,
      headRef: RELEASE_PR_MARKER_REF,
      headSha: marker ?? sha("closed-head"),
      baseRef: "main",
      title: "stale",
      body: "unrelated",
      labels: [RELEASE_PR_LABEL],
    });
    const result = await manager(world).deleteMarkerRef();
    expect(result._unsafeUnwrapErr()).toEqual({
      type: "MarkerDeletionNotAuthorized",
      ref: RELEASE_PR_MARKER_REF,
      reason: "pull-request-open",
    });
    expect(world.markerSha()).toBe(marker);
  });

  it("refuses to delete from an unrelated closed same-head PR", async () => {
    const world = new FakeGitHub();
    const ownership = await acquire(world);
    world.pulls.push({
      number: 99,
      url: "https://github.com/weave-io/weave/pull/99",
      state: "closed",
      merged: true,
      headRef: RELEASE_PR_MARKER_REF,
      headSha: ownership.expectedMarkerSha,
      baseRef: "develop",
      title: "unrelated",
      body: "no envelope",
      labels: [],
    });
    const result = await manager(world).deleteMarkerRef();
    expect(result._unsafeUnwrapErr()).toEqual({
      type: "MarkerDeletionNotAuthorized",
      ref: RELEASE_PR_MARKER_REF,
      reason: "missing-stable-label",
    });
    expect(world.markerSha()).toBe(ownership.expectedMarkerSha);

    const unlabeled = world.pulls[0];
    expect(unlabeled).toBeDefined();
    if (unlabeled === undefined) return;
    world.pulls[0] = {
      ...unlabeled,
      labels: [RELEASE_PR_LABEL],
    };
    const wrongBase = await manager(world).deleteMarkerRef();
    expect(wrongBase._unsafeUnwrapErr()).toEqual({
      type: "MarkerDeletionNotAuthorized",
      ref: RELEASE_PR_MARKER_REF,
      reason: "unexpected-base",
    });

    const labeled = world.pulls[0];
    expect(labeled).toBeDefined();
    if (labeled === undefined) return;
    world.pulls[0] = {
      ...labeled,
      baseRef: "main",
    };
    const wrongEnvelope = await manager(world).deleteMarkerRef();
    expect(wrongEnvelope._unsafeUnwrapErr()).toEqual({
      type: "MarkerDeletionNotAuthorized",
      ref: RELEASE_PR_MARKER_REF,
      reason: "ownership-mismatch",
    });
    expect(world.markerSha()).toBe(ownership.expectedMarkerSha);
  });

  it("refuses to delete when the settled PR head does not match the marker", async () => {
    const world = new FakeGitHub();
    await createRelease(world);
    world.settlePullRequest(1, "merged");
    const marker = world.markerSha();
    expect(marker).not.toBeNull();
    const existing = world.pulls[0];
    expect(existing).toBeDefined();
    if (existing === undefined) return;
    world.pulls[0] = {
      ...existing,
      headSha: sha("other-marker"),
    };
    const result = await manager(world).deleteMarkerRef();
    expect(result._unsafeUnwrapErr()).toEqual({
      type: "MarkerDeletionNotAuthorized",
      ref: RELEASE_PR_MARKER_REF,
      reason: "marker-head-mismatch",
    });
    expect(world.markerSha()).toBe(marker);
  });

  it("records a failed deletion as typed MarkerCleanupPending", async () => {
    const world = new FakeGitHub();
    await createRelease(world);
    world.settlePullRequest(1, "merged");
    world.faults.deleteRef = 1;
    const result = await manager(world).deleteMarkerRef();
    expect(result._unsafeUnwrapErr()).toMatchObject({
      type: "MarkerCleanupPending",
      ref: RELEASE_PR_MARKER_REF,
      reason: "delete-failed",
    });
    expect(world.markerSha()).not.toBeNull();
  });

  it("classifies cleanup-pending and orphan markers apart", async () => {
    const cleanup = new FakeGitHub();
    await createRelease(cleanup);
    cleanup.settlePullRequest(1, "merged");
    expect((await discover(cleanup)).kind).toBe("marker-cleanup-pending");

    const orphan = new FakeGitHub();
    await acquire(orphan);
    expect((await discover(orphan, { creationPollExhausted: true })).kind).toBe(
      "orphan-marker",
    );
  });
});

// ---------------------------------------------------------------------------
// Race model
// ---------------------------------------------------------------------------

describe("race model", () => {
  it("prepare vs prepare yields exactly one PR and one typed rejection", async () => {
    const world = new FakeGitHub();
    const base = world.mainHead;
    const winner = manager(world);
    const loser = manager(world);
    // Interleave: the loser attempts its claim while the winner holds the ref.
    const ownership = await acquire(world, base);
    const rejection = await loser.acquireCreationOwnership({
      plannedBaseSha: base,
    });
    const created = await winner.finalizeCreation({
      ownership,
      prepared: preparedRelease(base),
    });
    expect(created.isOk()).toBe(true);
    expect(rejection._unsafeUnwrapErr().type).toBe("ReleasePrCreationStalled");

    // A retried request now sees the winner's PR and gets its URL.
    const retried = await loser.acquireCreationOwnership({
      plannedBaseSha: base,
    });
    expect(retried._unsafeUnwrapErr()).toEqual({
      type: "ReleasePrExists",
      url: created._unsafeUnwrap().pullRequest.url,
    });
    expect(world.pulls.filter((pull) => pull.state === "open")).toHaveLength(1);
  });

  it("prepare vs regenerate never yields a second PR", async () => {
    const world = new FakeGitHub();
    const base = world.mainHead;
    const ownership = await acquire(world, base);
    const regeneration = await manager(world).regenerate({
      builder: builderFor(world),
    });
    expect(regeneration._unsafeUnwrapErr().type).toBe(
      "ReleasePrCreationStalled",
    );
    expect(world.pulls).toHaveLength(0);

    const created = await manager(world).finalizeCreation({
      ownership,
      prepared: preparedRelease(base),
    });
    expect(created.isOk()).toBe(true);
    world.advanceMain();
    const second = await manager(world).regenerate({
      builder: builderFor(world),
    });
    expect(second._unsafeUnwrap()).toMatchObject({ kind: "Regenerated" });
    expect(world.pulls).toHaveLength(1);

    // A prepare request during the live PR is rejected, never a second create.
    const rejected = await createRelease(world);
    expect(rejected.ok === false && rejected.error.type).toBe(
      "ReleasePrExists",
    );
    expect(world.pulls).toHaveLength(1);
  });

  it("regenerate vs regenerate always ends on the newest accepted base", async () => {
    const world = new FakeGitHub();
    const created = await createRelease(world);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    world.advanceMain();
    let newest = "";

    // This event was triggered for `older`; a newer event lands mid-flight.
    world.hooks.beforeUpdateRef = () => {
      world.hooks.beforeUpdateRef = undefined;
      newest = world.advanceMain();
      const envelope = renderReleasePrEnvelope({
        schemaVersion: 1,
        ref: RELEASE_PR_MARKER_REF,
        ownerGeneration: created.value.ownership.ownerGeneration,
        plannedBaseSha: created.value.baseSha,
        baseSha: newest,
        regeneratedFrom: [created.value.baseSha],
        entryProse: [],
        evidenceDigest: EVIDENCE_DIGEST,
      })._unsafeUnwrap();
      const winner = sha("newest-regeneration");
      world.commits.set(winner, {
        message: `chore(release): version packages\n\n${envelope}\n`,
        parent: newest,
        files: [],
      });
      world.refs.set(REF_PATH, winner);
      const existing = world.pulls[0];
      if (existing !== undefined)
        world.pulls[0] = {
          ...existing,
          body: `Seed: @weaveio/weave-cli\n\n${envelope}\n`,
        };
    };
    const stale = await manager(world).regenerate({
      builder: builderFor(world),
    });
    // The older writer must not overwrite the newer head, and must repair the
    // PR so it describes that surviving head.
    expect(stale._unsafeUnwrap()).toMatchObject({
      kind: "PrMetadataReconciled",
      baseSha: newest,
    });
    const head = world.markerSha() ?? "";
    expect(head).toBe(sha("newest-regeneration"));
    expect(envelopeAt(world, head)._unsafeUnwrap().baseSha).toBe(newest);
  });

  it("repairs an older PATCH after a newer marker writer and never returns false Regenerated", async () => {
    const world = new FakeGitHub();
    const created = await createRelease(world);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const olderBase = world.advanceMain();
    let newest = "";
    world.hooks.afterUpdatePullRequest = () => {
      world.hooks.afterUpdatePullRequest = undefined;
      newest = world.advanceMain();
      const envelope = renderReleasePrEnvelope({
        schemaVersion: 1,
        ref: RELEASE_PR_MARKER_REF,
        ownerGeneration: created.value.ownership.ownerGeneration,
        plannedBaseSha: created.value.ownership.plannedBaseSha,
        baseSha: newest,
        regeneratedFrom: [olderBase],
        entryProse: [],
        evidenceDigest: EVIDENCE_DIGEST,
      })._unsafeUnwrap();
      const winner = sha("metadata-race-winner");
      world.commits.set(winner, {
        message: `chore(release): version packages\n\n${envelope}\n`,
        parent: newest,
        files: [],
      });
      world.refs.set(REF_PATH, winner);
      const existing = world.pulls[0];
      if (existing !== undefined)
        world.pulls[0] = {
          ...existing,
          body: `Seed: @weaveio/weave-cli\n\n${envelope}\n`,
        };
    };

    const result = await manager(world).regenerate({
      builder: builderFor(world),
    });
    const outcome = result._unsafeUnwrap();
    expect(outcome.kind).toBe("PrMetadataReconciled");
    expect(outcome.kind).not.toBe("Regenerated");
    const marker = world.markerSha() ?? "";
    const markerEnvelope = envelopeAt(world, marker)._unsafeUnwrap();
    const pullEnvelope = parseReleasePrEnvelope(
      world.pulls[0]?.body ?? "",
    )._unsafeUnwrap();
    expect(markerEnvelope).toEqual(pullEnvelope);
    expect(markerEnvelope.baseSha).toBe(newest);
    expect(markerEnvelope.baseSha).not.toBe(olderBase);
  });

  it("main-advance before the marker still produces a PR on the newest base", async () => {
    const world = new FakeGitHub();
    const advanced = world.advanceMain();
    const created = await createRelease(world);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.value.baseSha).toBe(advanced);
    const head = world.markerSha() ?? "";
    expect(envelopeAt(world, head)._unsafeUnwrap().baseSha).toBe(advanced);
  });

  it("main-advance after the marker replans instead of rebasing stale prose", async () => {
    const world = new FakeGitHub();
    const first = world.mainHead;
    const seen: string[] = [];
    let advanced = false;
    world.hooks.beforeReadMain = () => {
      if (advanced) return;
      advanced = true;
      world.advanceMain();
    };
    const preparer: CreationPreparer = {
      prepare: (input) => {
        seen.push(input.baseSha);
        return okAsync(preparedRelease(input.baseSha));
      },
    };
    const created = await createRelease(world, { preparer });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(seen[0]).toBe(first);
    expect(seen[1]).toBe(world.mainHead);
    expect(created.value.baseSha).toBe(world.mainHead);
    const head = world.markerSha() ?? "";
    expect(envelopeAt(world, head)._unsafeUnwrap().baseSha).toBe(
      world.mainHead,
    );
  });
});
