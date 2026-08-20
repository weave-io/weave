import { describe, expect, it } from "bun:test";
import { resolve } from "node:path";
import { errAsync, okAsync, type Result, type ResultAsync } from "neverthrow";
import { ADAPTER_HOST_MATRICES } from "../acceptance-manifest.js";
import {
  BunChangesetFileSystem,
  ChangesetPolicyValidator,
  type ValidatedChangeset,
} from "../changeset-policy.js";
import { PUBLIC_PACKAGES, type PublicPackageName } from "../constants.js";
import { EMPTY_CONSUMPTION_LEDGER } from "../consumption-ledger.js";
import {
  applyNextPrereleases,
  assertNextProofChain,
  assertSourceFilesUnchanged,
  authorizeNextRoute,
  createNextReleasePlan,
  explainNextClosure,
  type NextInput,
  NextInputSchema,
  type NextRouteEvent,
  type NextWorkspaceManifest,
  parseNextEnvironment,
  parseNextInput,
  parseNextMetadata,
  parseNextRouteEnvironment,
  renderNextPrereleaseNotes,
  renderNextScratchChangelogs,
  type SourceByteSnapshot,
  validateNextRouteEvent,
} from "../next-main.js";
import {
  ATTESTATION_CHECK_NAME,
  type AttestationCheckResult,
  type AttestationExpectation,
} from "../publish-chain.js";
import type {
  PublicationMember,
  PublicationReport,
} from "../publish-executor.js";
import type {
  ExistingGitHubRelease,
  ExistingGitTag,
  ReleaseRefsGitHub,
} from "../release-refs.js";
import { computeSelectionClosure } from "../selection-closure.js";

const CLI = "@weaveio/weave-cli";
const OPENCODE = "@weaveio/weave-adapter-opencode";
const CLAUDE = "@weaveio/weave-adapter-claude-code";
const PI = "@weaveio/weave-adapter-pi";
const SHA = "a".repeat(40);
const DIGEST = `sha256:${"b".repeat(64)}`;
const SOURCE_DIGEST = "c".repeat(64);
const NEXT_VERSION = "0.1.0-next.20260820.aaaaaaaaaaaa";
const packages = Object.keys(PUBLIC_PACKAGES) as PublicPackageName[];
const manifests: readonly NextWorkspaceManifest[] = packages.map((name) => ({
  name,
  dependencies: [],
}));
const packageVersions = Object.fromEntries(
  packages.map((name) => [name, "0.1.0"]),
) as Record<PublicPackageName, string>;

function unwrap<T, E>(result: Result<T, E>): T {
  if (result.isErr())
    throw new Error(`Unexpected error: ${JSON.stringify(result.error)}`);
  return result.value;
}

async function unwrapAsync<T, E>(result: ResultAsync<T, E>): Promise<T> {
  return unwrap(await result);
}

function input(overrides: Partial<NextInput> = {}): NextInput {
  return NextInputSchema.parse({
    cli: true,
    opencode: false,
    claudeCode: false,
    pi: false,
    ...overrides,
  });
}

function validatedChangeset(path: string, source: string): ValidatedChangeset {
  const result = new ChangesetPolicyValidator(
    new BunChangesetFileSystem(),
  ).validateFile(path, new TextEncoder().encode(source));
  return unwrap(result);
}

function sharedChangeset(): ValidatedChangeset {
  return validatedChangeset(
    ".changeset/shared-next.md",
    `---\n"${CLI}": minor\n"${OPENCODE}": minor\n---\n\nShip the shared next closure.\n`,
  );
}

function planInput(
  overrides: Partial<Parameters<typeof createNextReleasePlan>[0]> = {},
) {
  return {
    selection: input(),
    packageVersions,
    changesets: [],
    ledger: EMPTY_CONSUMPTION_LEDGER,
    manifests,
    sourceSha: SHA,
    now: new Date("2026-08-20T12:00:00.000Z"),
    canonicalNotesUrl: "https://github.com/weave-io/weave/releases",
    ...overrides,
  };
}

function routeEvent(overrides: Partial<NextRouteEvent> = {}): NextRouteEvent {
  return {
    repository: "weave-io/weave",
    eventName: "workflow_dispatch",
    action: "workflow_dispatch",
    ref: "refs/heads/main",
    actor: "maintainer",
    maintainerAuthorized: true,
    channel: "next",
    selection: input(),
    ...overrides,
  };
}

function publicationMember(
  packageName: PublicPackageName,
  version = NEXT_VERSION,
  digest = DIGEST,
): PublicationMember {
  return {
    packageName,
    version,
    tarballSha256: digest,
    status: "published",
    verification: "digest-verified",
  };
}

class FakeRefsGitHub implements ReleaseRefsGitHub {
  readonly tags = new Map<string, ExistingGitTag>();
  readonly releases = new Map<string, ExistingGitHubRelease>();
  readonly createdTags: string[] = [];
  readonly createdReleases: string[] = [];

  readTag(tag: string): ResultAsync<ExistingGitTag | null, never> {
    return okAsync(this.tags.get(tag) ?? null);
  }

  createAnnotatedTag(input: {
    tag: string;
    commitSha: string;
    message: string;
  }): ResultAsync<void, never> {
    this.tags.set(input.tag, { name: input.tag, commitSha: input.commitSha });
    this.createdTags.push(input.tag);
    return okAsync(undefined);
  }

  readRelease(tag: string): ResultAsync<ExistingGitHubRelease | null, never> {
    return okAsync(this.releases.get(tag) ?? null);
  }

  createRelease(input: {
    tag: string;
    targetSha: string;
    name: string;
    notes: string;
    prerelease: boolean;
  }): ResultAsync<void, never> {
    this.releases.set(input.tag, {
      tag: input.tag,
      targetSha: input.targetSha,
      notes: input.notes,
      draft: false,
      prerelease: input.prerelease,
    });
    this.createdReleases.push(input.tag);
    return okAsync(undefined);
  }
}

function attestation(
  expectation: AttestationExpectation,
): AttestationCheckResult {
  return {
    checkRunId: 42,
    name: ATTESTATION_CHECK_NAME,
    status: "completed",
    conclusion: "success",
    releasedSha: expectation.releasedSha,
    planDigest: expectation.planDigest,
    subjects: expectation.tarballDigests.map((entry) => ({
      packageName: entry.packageName,
      subjectDigest: entry.sha256,
    })),
  };
}

describe("next prerelease route", () => {
  it("accepts exactly four booleans and rejects empty or extra inputs", () => {
    expect(parseNextInput(input()).isOk()).toBe(true);
    expect(
      parseNextInput({
        cli: true,
        opencode: false,
        claudeCode: false,
        pi: false,
        thinking: "high",
      })._unsafeUnwrapErr().type,
    ).toBe("InvalidNextInput");
    expect(
      parseNextInput({
        cli: false,
        opencode: false,
        claudeCode: false,
        pi: false,
      })._unsafeUnwrapErr(),
    ).toEqual({ type: "EmptySelection" });
    expect(
      parseNextEnvironment({
        INPUT_CLI: "true",
        INPUT_OPENCODE: "false",
        INPUT_CLAUDE_CODE: "false",
        INPUT_PI: "false",
      }).isOk(),
    ).toBe(true);
    expect(
      parseNextEnvironment({
        INPUT_CLI: "yes",
        INPUT_OPENCODE: "false",
        INPUT_CLAUDE_CODE: "false",
        INPUT_PI: "false",
      })._unsafeUnwrapErr().type,
    ).toBe("InvalidNextInput");
  });

  it("requires the manual event, main ref, next channel, and maintainer", async () => {
    expect(validateNextRouteEvent(routeEvent()).isOk()).toBe(true);
    expect(
      validateNextRouteEvent(
        routeEvent({ eventName: "push" as "workflow_dispatch" }),
      )._unsafeUnwrapErr().type,
    ).toBe("UnsupportedNextEvent");
    expect(
      validateNextRouteEvent(
        routeEvent({ ref: "refs/heads/feature" as "refs/heads/main" }),
      )._unsafeUnwrapErr().type,
    ).toBe("WrongNextMainLineage");
    expect(
      validateNextRouteEvent(
        routeEvent({ maintainerAuthorized: false }),
      )._unsafeUnwrapErr().type,
    ).toBe("UnauthorizedNextRoute");

    const calls: string[] = [];
    const authorized = await authorizeNextRoute(routeEvent(), {
      assertStableRequestAuthorized: (actor) => {
        calls.push(actor);
        return okAsync<unknown, unknown>(actor);
      },
    });
    expect(authorized.isOk()).toBe(true);
    expect(calls).toEqual(["maintainer"]);
    const refused = await authorizeNextRoute(routeEvent(), {
      assertStableRequestAuthorized: () =>
        errAsync<unknown, unknown>(new Error("not a maintainer")),
    });
    expect(refused._unsafeUnwrapErr()).toEqual({
      type: "NextAuthorizationFailed",
      actor: "maintainer",
    });
  });

  it("does not accept a missing manual action in the strict route carrier", () => {
    const result = parseNextRouteEnvironment({
      GITHUB_EVENT_NAME: "workflow_dispatch",
      GITHUB_REPOSITORY: "weave-io/weave",
      GITHUB_REF: "refs/heads/main",
      GITHUB_ACTOR: "maintainer",
      RELEASE_MAINTAINER_AUTHORIZED: "true",
      INPUT_CHANNEL: "next",
      INPUT_CLI: "true",
      INPUT_OPENCODE: "false",
      INPUT_CLAUDE_CODE: "false",
      INPUT_PI: "false",
    });
    expect(result._unsafeUnwrapErr().type).toBe("InvalidNextRoute");
  });
});

describe("next planning and scratch staging", () => {
  it("uses the stable closure rules and computes the date/SHA version", async () => {
    const changesets = [sharedChangeset()];
    const result = await unwrapAsync(
      createNextReleasePlan(planInput({ changesets })),
    );
    const stableClosure = unwrap(
      computeSelectionClosure({
        seed: {
          [CLI]: true,
          [OPENCODE]: false,
          [CLAUDE]: false,
          [PI]: false,
        },
        changesets,
        manifests,
      }),
    );
    expect(result.plan.channel).toBe("next");
    expect(result.plan.consumed).toEqual([]);
    expect(result.plan.closure.selected).toEqual([...stableClosure.selected]);
    expect(result.plan.versions[0]?.version).toMatch(
      /^0\.2\.0-next\.20260820\.aaaaaaaaaaaa$/,
    );
    expect(result.metadata.pendingChangesets).toHaveLength(1);
    expect(explainNextClosure(result.plan.closure)).toContain(
      "no changeset is consumed",
    );
    const tamperedMetadata = {
      ...result.metadata,
      changelogs: result.metadata.changelogs.map((entry) => ({
        ...entry,
        documentDigest: DIGEST,
      })),
    };
    expect(parseNextMetadata(tamperedMetadata).isErr()).toBe(true);
  });

  it("renders bounded, deterministic scratch changelogs without AI prose", () => {
    const first = unwrap(
      renderNextScratchChangelogs({
        versions: [{ packageName: CLI, version: NEXT_VERSION }],
        sourceSha: SHA,
        canonicalNotesUrl: "https://github.com/weave-io/weave/releases",
        sourceHistory: [{ subject: "Add the next channel", sha: SHA }],
        pendingChangesets: [
          { id: "pending-next", sourceDigest: SOURCE_DIGEST },
        ],
      }),
    );
    const second = unwrap(
      renderNextScratchChangelogs({
        versions: [{ packageName: CLI, version: NEXT_VERSION }],
        sourceSha: SHA,
        canonicalNotesUrl: "https://github.com/weave-io/weave/releases",
        sourceHistory: [{ subject: "Add the next channel", sha: SHA }],
        pendingChangesets: [
          { id: "pending-next", sourceDigest: SOURCE_DIGEST },
        ],
      }),
    );
    const content = first[0]?.content ?? "";
    expect(first).toEqual(second);
    expect(content).toContain(
      "deterministic current prerelease scratch changelog",
    );
    expect(content).toContain("pending-next");
    expect(content).toContain(
      "Canonical notes: https://github.com/weave-io/weave/releases",
    );
    expect(new TextEncoder().encode(content).byteLength).toBeLessThanOrEqual(
      16 * 1024,
    );
    expect(content).not.toMatch(
      /AI-generated|generated by an AI|language model/i,
    );
  });

  it("proves source manifest and changelog bytes remain unchanged", () => {
    const before: SourceByteSnapshot = {
      "packages/cli/package.json": new TextEncoder().encode("manifest"),
      "packages/cli/CHANGELOG.md": "changelog",
    };
    expect(
      assertSourceFilesUnchanged({ before, after: { ...before } }).isOk(),
    ).toBe(true);
    const changed = assertSourceFilesUnchanged({
      before,
      after: {
        ...before,
        "packages/cli/package.json": new TextEncoder().encode("changed"),
      },
    });
    expect(changed._unsafeUnwrapErr()).toMatchObject({
      type: "SourceMutationDetected",
      path: "packages/cli/package.json",
    });
    expect(
      assertSourceFilesUnchanged({ before, after: {} })._unsafeUnwrapErr().type,
    ).toBe("SourceFileRemoved");
  });
});

describe("next prerelease notes and refs", () => {
  it("wraps notes as prereleases with a canonical digest identity", async () => {
    const changelog = unwrap(
      renderNextScratchChangelogs({
        versions: [{ packageName: CLI, version: NEXT_VERSION }],
        sourceSha: SHA,
        canonicalNotesUrl: "https://github.com/weave-io/weave/releases",
        pendingChangesets: [
          { id: "pending-next", sourceDigest: SOURCE_DIGEST },
        ],
      }),
    )[0]?.content;
    if (changelog === undefined) throw new Error("missing scratch changelog");
    const notes = unwrap(
      renderNextPrereleaseNotes({
        releasedSha: SHA,
        versions: [
          { packageName: CLI, version: NEXT_VERSION, previousVersion: "0.1.0" },
        ],
        tarballDigests: [{ packageName: CLI, sha256: DIGEST }],
        changelogs: { [CLI]: changelog },
      }),
    );
    expect(notes[0]?.prerelease).toBe(true);
    expect(notes[0]?.tag).toBe(`weave-cli@${NEXT_VERSION}`);
    expect(notes[0]?.notes).toContain(DIGEST);
    expect(notes[0]?.notes).toContain("deterministic current prerelease");

    const report: PublicationReport = {
      schemaVersion: 1,
      channel: "next",
      tag: "next",
      releasedSha: SHA,
      members: [publicationMember(CLI)],
    };
    const github = new FakeRefsGitHub();
    const refs = await applyNextPrereleases(
      {
        releasedSha: SHA,
        tagTargetSha: SHA,
        baseSha: "b".repeat(40),
        builtSha: "c".repeat(40),
        headSha: "d".repeat(40),
        closure: [CLI],
        versions: [
          { packageName: CLI, version: NEXT_VERSION, previousVersion: "0.1.0" },
        ],
        report,
        changelogs: { [CLI]: changelog },
      },
      github,
    );
    expect(unwrap(await refs).status).toBe("applied");
    const release = github.releases.get(`weave-cli@${NEXT_VERSION}`);
    expect(release?.prerelease).toBe(true);
    expect(release?.draft).toBe(false);
    expect(release?.notes).toContain("pending-next");
  });
});

describe("next proof gate", () => {
  it("blocks before publish when attestation, consumers, or harness proof is absent", () => {
    const expectation: AttestationExpectation = {
      releasedSha: SHA,
      planDigest: DIGEST,
      tarballDigests: [{ packageName: CLI, sha256: DIGEST }],
    };
    const missingAttestation = assertNextProofChain({
      expectation,
      attestation: undefined,
      closure: { selected: [CLI] },
      consumerProofs: [],
      harnessProofs: [],
    });
    expect(missingAttestation._unsafeUnwrapErr()).toEqual({
      type: "NextProofBlocked",
      stage: "attestation",
      reason: "attestation result is missing",
    });

    const missingConsumer = assertNextProofChain({
      expectation,
      attestation: attestation(expectation),
      closure: { selected: [CLI] },
      consumerProofs: [],
      harnessProofs: [],
    });
    expect(missingConsumer._unsafeUnwrapErr()).toMatchObject({
      type: "NextProofBlocked",
      stage: "consumer",
    });

    const adapterExpectation: AttestationExpectation = {
      releasedSha: SHA,
      planDigest: DIGEST,
      tarballDigests: [{ packageName: OPENCODE, sha256: DIGEST }],
    };
    const missingHarness = assertNextProofChain({
      expectation: adapterExpectation,
      attestation: attestation(adapterExpectation),
      closure: { selected: [OPENCODE] },
      consumerProofs: [
        {
          packageName: OPENCODE,
          version: NEXT_VERSION,
          tarballDigest: DIGEST,
          status: "passed",
          summary: "clean consumer passed",
        },
      ],
      harnessProofs: [],
    });
    expect(missingHarness._unsafeUnwrapErr()).toMatchObject({
      type: "NextProofBlocked",
      stage: "harness",
    });
  });

  it("requires both minimum and latest host slots for a changed adapter", () => {
    const matrix = ADAPTER_HOST_MATRICES[PI];
    expect(matrix.minimum).not.toBe(matrix.latest);
    const expectation: AttestationExpectation = {
      releasedSha: SHA,
      planDigest: DIGEST,
      tarballDigests: [{ packageName: PI, sha256: DIGEST }],
    };
    const proof = (version: string) => ({
      adapter: PI,
      version,
      tarballDigest: DIGEST,
      stages: [
        "bound-artifact-digest",
        "install-entry-digest",
        "fresh-host-process",
        "inventory-readiness",
        "adapter-action",
      ],
      status: "passed",
      summary: "five-stage harness proof passed",
    });
    const result = assertNextProofChain({
      expectation,
      attestation: attestation(expectation),
      closure: { selected: [PI] },
      consumerProofs: [
        {
          packageName: PI,
          version: NEXT_VERSION,
          tarballDigest: DIGEST,
          status: "passed",
          summary: "clean consumer passed",
        },
      ],
      harnessProofs: [proof(matrix.minimum), proof(matrix.latest)],
    });
    expect(result.isOk()).toBe(true);
    if (result.isOk()) expect(result.value.harness).toHaveLength(2);
  });
});

describe("next workflow shape", () => {
  it("keeps next inside the ordered trusted chain and before OIDC", async () => {
    const workflow = await Bun.file(
      resolve(
        import.meta.dir,
        "../../../.github/workflows/release-publish.yml",
      ),
    ).text();
    expect(workflow).toContain("- next");
    expect(workflow).toContain("claude-code:");
    expect(workflow).toContain(
      "bun scripts/release/next-main.ts --phase route",
    );
    expect(workflow).toContain("bun scripts/release/next-main.ts --phase plan");
    expect(workflow).toContain(
      "bun scripts/release/next-main.ts --phase build",
    );
    expect(workflow).toContain(
      "bun scripts/release/next-main.ts --phase prerelease",
    );
    expect(workflow).toContain(
      "environment: $" +
        "{{ inputs.channel == 'next' && 'prerelease' || 'release' }}",
    );
    expect(workflow).not.toContain("workflow_call:");
    // Task 35's cutover schedule lands here. It does not add a next entry:
    // the next channel is reachable only through maintainer dispatch.
    expect(workflow).toMatch(/^\s+schedule:/m);
    expect(workflow).toContain('- cron: "17 0 * * *"');
    expect((workflow.match(/id-token:\s*write/g) ?? []).length).toBe(1);
    const order = [
      "  route:",
      "  recompute:",
      "  build-bind:",
      "  await-attest:",
      "  consumer-proof:",
      "  harness-proof:",
      "  release-approval:",
      "  publish:",
      "  registry-verification:",
      "  refs-cleanup:",
    ].map((job) => workflow.indexOf(`\n${job}`));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((left, right) => left - right));
    expect(workflow.indexOf("id-token: write")).toBeGreaterThan(
      workflow.indexOf("  harness-proof:"),
    );
  });
});
