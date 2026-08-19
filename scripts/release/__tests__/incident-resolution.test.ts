import { describe, expect, it } from "bun:test";
import { okAsync, type Result } from "neverthrow";
import {
  assertIncidentAuthorized,
  completeIncidentResolution,
  generateDeprecationCommand,
  generateIncidentResolution,
  INCIDENT_ENVIRONMENT,
  type IncidentActor,
  type IncidentCompletionPorts,
  type IncidentRegistryPort,
  incidentNoticeFor,
  refuseRegistryMutation,
  shellEscapeDeprecatedMessage,
  validateIncidentAuthorizationRecord,
} from "../incident-resolution.js";
import {
  classifyPostMergeState,
  type PackageMemberAuthority,
  type ReleaseAuthority,
} from "../release-state.js";

const CLI = "@weaveio/weave-cli" as const;
const RELEASED = "c".repeat(40);
const REGISTRY = digest("registry");
const REBUILT_BAD = digest("rebuilt-mismatch");
const NOTICE = incidentNoticeFor(RELEASED);

function digest(seed: string): string {
  return `sha256:${new Bun.CryptoHasher("sha256").update(seed).digest("hex")}`;
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

const actor: IncidentActor = {
  actor: "maintainer",
  maintainerAuthorized: true,
  environment: INCIDENT_ENVIRONMENT,
  environmentApproved: true,
};

function member(
  overrides: Partial<PackageMemberAuthority> = {},
): PackageMemberAuthority {
  return {
    packageName: CLI,
    version: "0.1.0",
    published: true,
    registryDigest: REGISTRY,
    provenanceSubjectDigest: REGISTRY,
    recordedDigest: REGISTRY,
    deprecated: null,
    cacheDigest: REGISTRY,
    cacheValid: true,
    rebuiltDigest: REBUILT_BAD,
    proofChainComplete: true,
    registryVerified: true,
    ...overrides,
  };
}

function authority(
  overrides: Partial<ReleaseAuthority> = {},
): ReleaseAuthority {
  return {
    pullRequest: {
      number: 140,
      url: "https://github.com/weave-io/weave/pull/140",
      merged: true,
      closed: true,
      mergeCommitSha: RELEASED,
      headRef: "release-pr/stable",
    },
    releasedSha: RELEASED,
    channel: "stable",
    members: [member()],
    tags: { "weave-cli@0.1.0": { commitSha: RELEASED } },
    releases: {
      "weave-cli@0.1.0": { targetSha: RELEASED, notes: NOTICE },
    },
    cleanupMerged: true,
    cleanupRequired: true,
    markerPresent: false,
    markerSha: null,
    associatedPullRequestSettled: true,
    incident: {
      requiredMessage: NOTICE,
      affected: [{ packageName: CLI, version: "0.1.0", digest: REGISTRY }],
      checkRunAtReleasedSha: false,
      releasesCarryNotice: false,
      deprecationsMatch: false,
    },
    comments: ["looks complete"],
    ...overrides,
  };
}

function registry(options: {
  deprecated?: string | null;
  digest?: string;
  provenance?: string;
  present?: boolean;
}): IncidentRegistryPort {
  return {
    readPublishedVersion: () =>
      okAsync({
        present: options.present ?? true,
        digest: options.digest ?? REGISTRY,
        provenanceSubjectDigest: options.provenance ?? REGISTRY,
        deprecated: options.deprecated ?? null,
      }),
  };
}

function completion(live: () => ReleaseAuthority): IncidentCompletionPorts {
  return {
    createIncidentRefs: () => okAsync(undefined),
    createIncidentCheckRun: () => okAsync(undefined),
    completeChangesetCleanup: () => okAsync(undefined),
    rereadAuthority: () => okAsync(live()),
  };
}

describe("incident authorization", () => {
  it("requires a maintainer and the protected release environment", () => {
    expect(
      expectErr(
        assertIncidentAuthorized({ ...actor, maintainerAuthorized: false }),
      ),
    ).toEqual({ type: "IncidentUnauthorized", reason: "maintainer" });
    expect(
      expectErr(
        assertIncidentAuthorized({
          ...actor,
          environment: "prerelease",
          environmentApproved: true,
        }),
      ),
    ).toEqual({ type: "IncidentUnauthorized", reason: "environment" });
    expect(assertIncidentAuthorized(actor).isOk()).toBe(true);
  });
});

describe("generateIncidentResolution", () => {
  it("emits a strict authorization record and exact escaped commands, then halts", async () => {
    const generated = await generateIncidentResolution(
      { actor, authority: authority(), now: "2026-08-18T00:00:00.000Z" },
      registry({}),
    );
    const value = generated._unsafeUnwrap();
    expect(value.status).toBe("IncidentDeprecationPending");
    expect(validateIncidentAuthorizationRecord(value.record).isOk()).toBe(true);
    expect(value.record.requiredMessage).toBe(NOTICE);
    expect(JSON.stringify(value.record)).not.toMatch(
      /token|password|secret|authorization/i,
    );
    expect(value.commands).toEqual([
      {
        packageName: CLI,
        version: "0.1.0",
        argv: ["npm", "deprecate", `${CLI}@0.1.0`, NOTICE],
        command: `npm deprecate ${CLI}@0.1.0 ${expectOk(shellEscapeDeprecatedMessage(NOTICE))}`,
      },
    ]);
  });

  it("shell-escapes hostile messages and stays bounded", () => {
    const hostile = '$(rm -rf /) `id` "quoted" $HOME';
    const command = expectOk(
      generateDeprecationCommand({
        packageName: CLI,
        version: "0.1.0",
        message: hostile,
      }),
    );
    expect(command.command.startsWith(`npm deprecate ${CLI}@0.1.0 "`)).toBe(
      true,
    );
    expect(command.command).toContain('\\"quoted\\"');
    expect(command.command).toContain("\\$(rm -rf /)");
    expect(command.command).toContain("\\`id\\`");
    expect(command.command).toContain("\\$HOME");
    expect(
      generateDeprecationCommand({
        packageName: CLI,
        version: "0.1.0",
        message: "x".repeat(600),
      })._unsafeUnwrapErr().type,
    ).toBe("IncidentMessageInvalid");
  });

  it("hard-fails on registry-side digest or provenance divergence", async () => {
    const digestMismatch = await generateIncidentResolution(
      { actor, authority: authority() },
      registry({ digest: digest("other") }),
    );
    expect(digestMismatch._unsafeUnwrapErr().type).toBe(
      "IncidentRegistryDiverged",
    );
    const provenanceMismatch = await generateIncidentResolution(
      { actor, authority: authority() },
      registry({ provenance: digest("other") }),
    );
    expect(provenanceMismatch._unsafeUnwrapErr().type).toBe(
      "IncidentRegistryDiverged",
    );
  });

  it("never invokes deprecate, unpublish, or latest mutation", () => {
    expect(refuseRegistryMutation("deprecate")._unsafeUnwrapErr()).toEqual({
      type: "IncidentMustNotMutate",
      action: "deprecate",
    });
    expect(refuseRegistryMutation("unpublish")._unsafeUnwrapErr()).toEqual({
      type: "IncidentMustNotMutate",
      action: "unpublish",
    });
    expect(refuseRegistryMutation("latest")._unsafeUnwrapErr()).toEqual({
      type: "IncidentMustNotMutate",
      action: "latest",
    });
  });
});

describe("completeIncidentResolution", () => {
  it("refuses completion while deprecated readback is missing or mismatched", async () => {
    const generated = await generateIncidentResolution(
      { actor, authority: authority(), now: "2026-08-18T00:00:00.000Z" },
      registry({}),
    );
    const record = generated._unsafeUnwrap().record;
    const missing = await completeIncidentResolution(
      { actor, authority: authority(), storedRecord: record },
      registry({ deprecated: null }),
      completion(() => authority()),
    );
    expect(missing._unsafeUnwrapErr()).toEqual({
      type: "IncidentDeprecationMismatch",
      packageName: CLI,
      version: "0.1.0",
      expected: NOTICE,
      actual: null,
    });
    const mismatched = await completeIncidentResolution(
      { actor, authority: authority(), storedRecord: record },
      registry({ deprecated: "wrong" }),
      completion(() => authority()),
    );
    expect(mismatched._unsafeUnwrapErr().type).toBe(
      "IncidentDeprecationMismatch",
    );
  });

  it("recomputes CompleteWithIncident only after registry verification plus durable warning and cleanup", async () => {
    const generated = await generateIncidentResolution(
      { actor, authority: authority(), now: "2026-08-18T00:00:00.000Z" },
      registry({}),
    );
    const record = generated._unsafeUnwrap().record;
    const resolved = authority({
      members: [member({ deprecated: NOTICE })],
      incident: {
        requiredMessage: NOTICE,
        affected: [{ packageName: CLI, version: "0.1.0", digest: REGISTRY }],
        checkRunAtReleasedSha: true,
        releasesCarryNotice: true,
        deprecationsMatch: true,
      },
    });
    const completed = await completeIncidentResolution(
      { actor, authority: resolved, storedRecord: record },
      registry({ deprecated: NOTICE }),
      completion(() => resolved),
    );
    const value = completed._unsafeUnwrap();
    expect(value.status).toBe("CompleteWithIncident");
    expect(value.state.primary).toBe("CompleteWithIncident");
    expect(expectOk(classifyPostMergeState(resolved)).primary).toBe(
      "CompleteWithIncident",
    );
    expect(resolved.comments).toEqual(["looks complete"]);
  });

  it("is idempotent across a second authorized dispatch", async () => {
    const generated = await generateIncidentResolution(
      { actor, authority: authority(), now: "2026-08-18T00:00:00.000Z" },
      registry({}),
    );
    const record = generated._unsafeUnwrap().record;
    const resolved = authority({
      members: [member({ deprecated: NOTICE })],
      incident: {
        requiredMessage: NOTICE,
        affected: [{ packageName: CLI, version: "0.1.0", digest: REGISTRY }],
        checkRunAtReleasedSha: true,
        releasesCarryNotice: true,
        deprecationsMatch: true,
      },
    });
    const first = await completeIncidentResolution(
      { actor, authority: resolved, storedRecord: record },
      registry({ deprecated: NOTICE }),
      completion(() => resolved),
    );
    const second = await completeIncidentResolution(
      { actor, authority: resolved, storedRecord: record },
      registry({ deprecated: NOTICE }),
      completion(() => resolved),
    );
    expect(first._unsafeUnwrap().status).toBe("CompleteWithIncident");
    expect(second._unsafeUnwrap().status).toBe("CompleteWithIncident");
  });
});
