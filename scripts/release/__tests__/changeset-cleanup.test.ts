import { describe, expect, it } from "bun:test";
import { errAsync, okAsync, type Result, type ResultAsync } from "neverthrow";
import {
  CHANGESET_CLEANUP_TITLE,
  ChangesetCleanupController,
  type ChangesetCleanupGitHub,
  type ChangesetCleanupInput,
  changesetCleanupBranch,
  consumedChangesetPath,
  planChangesetCleanup,
} from "../changeset-cleanup.js";
import {
  BunChangesetFileSystem,
  ChangesetPolicyValidator,
  type ValidatedChangeset,
} from "../changeset-policy.js";
import type { PublicPackageName } from "../constants.js";
import {
  type ConsumptionLedger,
  EMPTY_CONSUMPTION_LEDGER,
  parseConsumptionLedger,
  renderLedgerBlock,
} from "../consumption-ledger.js";
import type { GitHubError } from "../errors.js";
import type {
  GitHubPullRequestCreateInput,
  GitHubPullRequestSummary,
  GitHubPullRequestWriteError,
  GitHubRefWriteError,
} from "../github-client.js";
import {
  MAIN_BRANCH,
  RELEASE_CLEANUP_PR_LABEL,
  RELEASE_PR_MARKER_REF,
} from "../release-pr-contract.js";

const CLI = "@weaveio/weave-cli";
const OPENCODE = "@weaveio/weave-adapter-opencode";
const RELEASED_SHA = "c".repeat(40);

const PORTABLE = `---
"${CLI}": minor
"${OPENCODE}": minor
---

Cap delegation with portable limits that every harness can enforce.
`;

const PI_PATCH = `---
"@weaveio/weave-adapter-pi": patch
---

Renew the settlement budget while a child is still reporting activity.
`;

function changesetOf(path: string, source: string): ValidatedChangeset {
  const result = new ChangesetPolicyValidator(
    new BunChangesetFileSystem(),
  ).validateFile(path, new TextEncoder().encode(source));
  if (result.isErr())
    throw new Error(
      `Fixture changeset is invalid: ${JSON.stringify(result.error)}`,
    );
  return result.value;
}

function ledgerOf(
  packageName: PublicPackageName,
  version: string,
  changesets: ValidatedChangeset[],
): ConsumptionLedger {
  const rendered = renderLedgerBlock({
    package: packageName,
    version,
    changesets: changesets.map((changeset) => changeset.identity),
  });
  if (rendered.isErr())
    throw new Error(
      `Fixture ledger is invalid: ${JSON.stringify(rendered.error)}`,
    );
  const parsed = parseConsumptionLedger([
    {
      packageName,
      path: "packages/cli/CHANGELOG.md",
      contents: `# ${packageName}\n\n## ${version}\n\n${rendered.value}\n`,
    },
  ]);
  if (parsed.isErr())
    throw new Error(
      `Fixture ledger parse failed: ${JSON.stringify(parsed.error)}`,
    );
  return parsed.value;
}

function expectOk<T, E>(result: Result<T, E>): T {
  if (result.isErr())
    throw new Error(`Unexpected failure: ${JSON.stringify(result.error)}`);
  return result.value;
}

function expectErr<T, E>(result: Result<T, E>): E {
  if (result.isOk())
    throw new Error(`Unexpected success: ${JSON.stringify(result.value)}`);
  return result.error;
}

async function expectOkAsync<T, E>(result: ResultAsync<T, E>): Promise<T> {
  return expectOk(await result);
}

async function expectErrAsync<T, E>(result: ResultAsync<T, E>): Promise<E> {
  return expectErr(await result);
}

function pullRequest(
  overrides: Partial<GitHubPullRequestSummary> = {},
): GitHubPullRequestSummary {
  return {
    number: 12,
    url: "https://github.com/weave-io/weave/pull/12",
    state: "open",
    merged: false,
    headRef: changesetCleanupBranch(RELEASED_SHA),
    headSha: "f".repeat(40),
    baseRef: MAIN_BRANCH,
    title: CHANGESET_CLEANUP_TITLE,
    body: "cleanup",
    labels: [RELEASE_CLEANUP_PR_LABEL],
    ...overrides,
  };
}

class FakeCleanupGitHub implements ChangesetCleanupGitHub {
  readonly deletedPaths: string[] = [];
  readonly createdRefs: string[] = [];
  readonly createdPulls: GitHubPullRequestCreateInput[] = [];
  openPulls: GitHubPullRequestSummary[] = [];
  refs = new Map<string, string>();

  readRefOptional(ref: string): ResultAsync<string | null, GitHubError> {
    return okAsync(this.refs.get(ref) ?? null);
  }

  createDeletionCommit(input: {
    baseSha: string;
    message: string;
    deletedPaths: readonly string[];
  }): ResultAsync<string, GitHubError> {
    this.deletedPaths.push(...input.deletedPaths);
    return okAsync("1".repeat(40));
  }

  createRefAtomic(
    ref: string,
    sha: string,
  ): ResultAsync<void, GitHubRefWriteError> {
    if (this.refs.has(ref))
      return errAsync({ type: "ReferenceAlreadyExists", ref });
    this.refs.set(ref, sha);
    this.createdRefs.push(ref);
    return okAsync(undefined);
  }

  listOpenPullRequestsByLabel(
    label: string,
  ): ResultAsync<readonly GitHubPullRequestSummary[], GitHubError> {
    return okAsync(
      this.openPulls.filter((pull) => pull.labels.includes(label)),
    );
  }

  createPullRequest(
    input: GitHubPullRequestCreateInput,
  ): ResultAsync<GitHubPullRequestSummary, GitHubPullRequestWriteError> {
    this.createdPulls.push(input);
    const created = pullRequest({
      headRef: input.headRef,
      title: input.title,
      body: input.body,
      labels: input.labels,
    });
    this.openPulls.push(created);
    return okAsync(created);
  }
}

function cleanupInput(
  overrides: Partial<ChangesetCleanupInput> = {},
): ChangesetCleanupInput {
  const consumed = changesetOf(".changeset/portable-limits.md", PORTABLE);
  return {
    channel: "stable",
    releasedSha: RELEASED_SHA,
    changesets: [
      consumed,
      changesetOf(".changeset/pi-settlement-budget.md", PI_PATCH),
    ],
    ledger: ledgerOf(CLI, "0.1.0", [consumed]),
    ...overrides,
  };
}

describe("planChangesetCleanup", () => {
  it("computes only ledger-consumed files that are still present", () => {
    const consumed = changesetOf(".changeset/portable-limits.md", PORTABLE);
    const pending = changesetOf(".changeset/pi-settlement-budget.md", PI_PATCH);
    const planned = expectOk(
      planChangesetCleanup({
        changesets: [consumed, pending],
        ledger: ledgerOf(CLI, "0.1.0", [consumed]),
      }),
    );
    expect(planned).toEqual({
      status: "ready",
      paths: [consumedChangesetPath("portable-limits")],
      changes: [{ path: ".changeset/portable-limits.md", status: "removed" }],
    });
  });

  it("blocks when a consumed file was edited after publication", () => {
    const consumed = changesetOf(".changeset/portable-limits.md", PORTABLE);
    const edited = changesetOf(
      ".changeset/portable-limits.md",
      `${PORTABLE}\nEdited after publication.\n`,
    );
    const error = expectErr(
      planChangesetCleanup({
        changesets: [edited],
        ledger: ledgerOf(CLI, "0.1.0", [consumed]),
      }),
    );
    expect(error.type).toBe("ConsumedChangesetModified");
    if (error.type !== "ConsumedChangesetModified") return;
    expect(error.changesets).toEqual([
      {
        id: "portable-limits",
        path: ".changeset/portable-limits.md",
        consumedDigest: consumed.identity.sourceDigest,
        currentDigest: edited.identity.sourceDigest,
      },
    ]);
  });

  it("rejects a consumed file that is not a cleanup-surface path", () => {
    const consumed = changesetOf(".changeset/portable-limits.md", PORTABLE);
    const misplaced: ValidatedChangeset = {
      ...consumed,
      path: "docs/portable-limits.md",
    };
    expect(
      expectErr(
        planChangesetCleanup({
          changesets: [misplaced],
          ledger: ledgerOf(CLI, "0.1.0", [consumed]),
        }),
      ),
    ).toEqual({
      type: "InvalidConsumedChangesetPath",
      path: "docs/portable-limits.md",
    });
  });

  it("treats an empty remainder as a no-op", () => {
    expect(
      expectOk(
        planChangesetCleanup({
          changesets: [
            changesetOf(".changeset/pi-settlement-budget.md", PI_PATCH),
          ],
          ledger: EMPTY_CONSUMPTION_LEDGER,
        }),
      ),
    ).toEqual({ status: "empty" });
    expect(
      expectOk(
        planChangesetCleanup({
          changesets: [],
          ledger: ledgerOf(CLI, "0.1.0", [
            changesetOf(".changeset/portable-limits.md", PORTABLE),
          ]),
        }),
      ),
    ).toEqual({ status: "empty" });
  });
});

describe("ChangesetCleanupController", () => {
  it("opens one App-token PR that deletes only the consumed files", async () => {
    const github = new FakeCleanupGitHub();
    const result = await expectOkAsync(
      new ChangesetCleanupController(github).apply(cleanupInput()),
    );
    expect(result.status).toBe("opened");
    if (result.status !== "opened") return;
    expect(result.paths).toEqual([".changeset/portable-limits.md"]);
    expect(github.deletedPaths).toEqual([".changeset/portable-limits.md"]);
    expect(github.createdRefs).toEqual([
      `refs/heads/${changesetCleanupBranch(RELEASED_SHA)}`,
    ]);
    expect(github.createdPulls).toEqual([
      {
        title: CHANGESET_CLEANUP_TITLE,
        body: expect.stringContaining(".changeset/portable-limits.md") as never,
        headRef: changesetCleanupBranch(RELEASED_SHA),
        baseRef: MAIN_BRANCH,
        labels: [RELEASE_CLEANUP_PR_LABEL],
      },
    ]);
    expect(github.createdRefs[0]).not.toContain(RELEASE_PR_MARKER_REF);
  });

  it("reuses an identical open cleanup PR instead of opening a second", async () => {
    const github = new FakeCleanupGitHub();
    github.openPulls = [pullRequest()];
    const result = await expectOkAsync(
      new ChangesetCleanupController(github).apply(cleanupInput()),
    );
    expect(result.status).toBe("existing");
    expect(github.createdPulls).toEqual([]);
    expect(github.deletedPaths).toEqual([]);
  });

  it("does not open a PR when the consumed set is empty", async () => {
    const github = new FakeCleanupGitHub();
    const result = await expectOkAsync(
      new ChangesetCleanupController(github).apply(
        cleanupInput({
          changesets: [
            changesetOf(".changeset/pi-settlement-budget.md", PI_PATCH),
          ],
          ledger: EMPTY_CONSUMPTION_LEDGER,
        }),
      ),
    );
    expect(result).toEqual({ status: "skipped", reason: "empty" });
    expect(github.createdPulls).toEqual([]);
  });

  it("does not open a cleanup PR for next or nightly", async () => {
    const github = new FakeCleanupGitHub();
    expect(
      await expectOkAsync(
        new ChangesetCleanupController(github).apply(
          cleanupInput({ channel: "next" }),
        ),
      ),
    ).toEqual({ status: "skipped", reason: "not-stable" });
    expect(
      await expectOkAsync(
        new ChangesetCleanupController(github).apply(
          cleanupInput({ channel: "nightly" }),
        ),
      ),
    ).toEqual({ status: "skipped", reason: "not-stable" });
    expect(github.createdPulls).toEqual([]);
  });

  it("returns ConsumedChangesetModified without opening a PR", async () => {
    const github = new FakeCleanupGitHub();
    const consumed = changesetOf(".changeset/portable-limits.md", PORTABLE);
    const error = await expectErrAsync(
      new ChangesetCleanupController(github).apply(
        cleanupInput({
          changesets: [
            changesetOf(
              ".changeset/portable-limits.md",
              `${PORTABLE}\nEdited after publication.\n`,
            ),
          ],
          ledger: ledgerOf(CLI, "0.1.0", [consumed]),
        }),
      ),
    );
    expect(error.type).toBe("ConsumedChangesetModified");
    expect(github.createdPulls).toEqual([]);
  });
});
