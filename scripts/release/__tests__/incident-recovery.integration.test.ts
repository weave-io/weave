/**
 * Two-root local incident-recovery walk.
 *
 * Root 1 is the production incident controller. Root 2 is the test-only
 * local-registry deprecation seam. The controller runs to
 * `IncidentDeprecationPending`, the harness mutates fixture metadata
 * through the seam, and the controller then verifies readback to
 * `CompleteWithIncident`. The controller never imports the seam.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { errAsync, okAsync, ResultAsync } from "neverthrow";
import {
  completeIncidentResolution,
  generateIncidentResolution,
  INCIDENT_ENVIRONMENT,
  type IncidentActor,
  type IncidentCompletionPorts,
  type IncidentRegistryPort,
  incidentNoticeFor,
} from "../incident-resolution.js";
import {
  blocksPreparation,
  classifyPostMergeState,
  type ReleaseAuthority,
} from "../release-state.js";
import { resumeRelease } from "../resume.js";
import { setDeprecated } from "./fixtures/local-registry/deprecation-seam.js";
import { startLocalRegistry } from "./fixtures/local-registry/server.js";
import { putVersion } from "./fixtures/local-registry/store.js";

const CLI = "@weaveio/weave-cli" as const;
const RELEASED = "c".repeat(40);
const REGISTRY = digest("registry");
const REBUILT_BAD = digest("rebuilt-mismatch");
const NOTICE = incidentNoticeFor(RELEASED);
const CONTROLLER = resolve(import.meta.dir, "../incident-resolution.ts");
const SEAM = resolve(
  import.meta.dir,
  "fixtures/local-registry/deprecation-seam.ts",
);

function digest(seed: string): string {
  return `sha256:${new Bun.CryptoHasher("sha256").update(seed).digest("hex")}`;
}

const actor: IncidentActor = {
  actor: "maintainer",
  maintainerAuthorized: true,
  environment: INCIDENT_ENVIRONMENT,
  environmentApproved: true,
};

function authority(deprecated: string | null): ReleaseAuthority {
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
    members: [
      {
        packageName: CLI,
        version: "0.1.0",
        published: true,
        registryDigest: REGISTRY,
        provenanceSubjectDigest: REGISTRY,
        recordedDigest: REGISTRY,
        deprecated,
        cacheDigest: REGISTRY,
        cacheValid: true,
        rebuiltDigest: REBUILT_BAD,
        proofChainComplete: true,
        registryVerified: true,
      },
    ],
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
      checkRunAtReleasedSha: deprecated === NOTICE,
      releasesCarryNotice: deprecated === NOTICE,
      deprecationsMatch: deprecated === NOTICE,
    },
    comments: [],
  };
}

describe("incident-recovery local walk", () => {
  let server: ReturnType<typeof startLocalRegistry> | undefined;

  afterAll(() => {
    server?.stop();
  });

  it("walks generate → seam mutation → readback → CompleteWithIncident", async () => {
    const storeRoot = join(
      tmpdir(),
      `weave-local-registry-${Bun.randomUUIDv7()}`,
    );
    await putVersion(storeRoot, {
      name: CLI,
      version: "0.1.0",
      digest: REGISTRY,
      provenanceSubjectDigest: REGISTRY,
      deprecated: null,
    });
    server = startLocalRegistry(storeRoot);
    const registry = server;
    expect(new URL(registry.url).hostname).toBe("127.0.0.1");
    const requested: string[] = [];
    const registryPort = httpRegistry(registry.url, requested);
    const incident = authority(null);
    const classified = classifyPostMergeState(incident);
    expect(classified._unsafeUnwrap().primary).toBe("IntegrityIncident");
    expect(classified._unsafeUnwrap().unreproducible[0]?.rebuiltDigest).toBe(
      REBUILT_BAD,
    );
    expect(blocksPreparation("IntegrityIncident")).toBe(true);

    const refused = await resumeRelease(
      {
        discovered: {
          kind: "merged-release",
          case: "integrity-incident",
          state: classified._unsafeUnwrap(),
        },
      },
      {
        rereadAuthority: () => okAsync(incident),
        readCache: () => okAsync(null),
        rebuildAt: () => errAsync({ type: "NothingToResume" }),
        publishRemaining: () =>
          errAsync({
            type: "InvalidPublicationInput",
            issues: ["unreachable"],
          }),
        verifyRegistry: () => errAsync({ type: "NothingToResume" }),
        applyRefs: () =>
          errAsync({ type: "InvalidReleasedSha", sha: RELEASED }),
        applyCleanup: () =>
          errAsync({ type: "InvalidCleanupReleasedSha", sha: RELEASED }),
        deleteSettledMarker: () =>
          errAsync({
            type: "MarkerCleanupPending",
            ref: "release-pr/stable",
            markerSha: "d".repeat(40),
            reason: "delete-failed",
          }),
        abortOwnedCreation: () =>
          errAsync({
            type: "CreationCleanupPending",
            ref: "release-pr/stable",
            ownerGeneration: "a".repeat(64),
            expectedMarkerSha: "d".repeat(40),
            plannedBaseSha: "b".repeat(40),
            reason: "ownership-changed",
          }),
        recomputePlan: () =>
          errAsync({ type: "InvalidRecomputeRef", ref: RELEASED }),
      },
    );
    expect(refused._unsafeUnwrapErr()).toEqual({
      type: "IntegrityIncidentBlocksResume",
      primary: "IntegrityIncident",
      recovery: "incident-resolution",
    });

    const generated = await generateIncidentResolution(
      { actor, authority: incident, now: "2026-08-18T00:00:00.000Z" },
      registryPort,
    );
    const pending = generated._unsafeUnwrap();
    expect(pending.status).toBe("IncidentDeprecationPending");
    expect(pending.commands[0]?.command.startsWith("npm deprecate ")).toBe(
      true,
    );
    expect(pending.commands[0]?.command.includes("unpublish")).toBe(false);
    expect(pending.commands[0]?.command.includes("dist-tag")).toBe(false);

    const controllerSource = await Bun.file(CONTROLLER).text();
    expect(controllerSource.includes("deprecation-seam")).toBe(false);
    expect(controllerSource.includes("fixtures/local-registry")).toBe(false);

    const premature = await completeIncidentResolution(
      { actor, authority: incident, storedRecord: pending.record },
      registryPort,
      countingCompletion(() => incident),
    );
    expect(premature._unsafeUnwrapErr().type).toBe(
      "IncidentDeprecationMismatch",
    );

    await setDeprecated({
      root: storeRoot,
      name: CLI,
      version: "0.1.0",
      message: "wrong-notice",
    });
    const wrong = await completeIncidentResolution(
      { actor, authority: incident, storedRecord: pending.record },
      registryPort,
      countingCompletion(() => incident),
    );
    expect(wrong._unsafeUnwrapErr().type).toBe("IncidentDeprecationMismatch");

    await setDeprecated({
      root: storeRoot,
      name: CLI,
      version: "0.1.0",
      message: NOTICE,
    });

    const resolved = authority(NOTICE);
    const completed = await completeIncidentResolution(
      { actor, authority: resolved, storedRecord: pending.record },
      registryPort,
      {
        createIncidentRefs: () => okAsync(undefined),
        createIncidentCheckRun: () => okAsync(undefined),
        completeChangesetCleanup: () => okAsync(undefined),
        rereadAuthority: () => okAsync(resolved),
      } satisfies IncidentCompletionPorts,
    );
    expect(completed._unsafeUnwrap().status).toBe("CompleteWithIncident");
    expect(blocksPreparation("CompleteWithIncident")).toBe(false);
    expect(requested.every((url) => url.startsWith(registry.url))).toBe(true);
    expect(requested.some((url) => url.includes("registry.npmjs.org"))).toBe(
      false,
    );
    expect(await Bun.file(SEAM).exists()).toBe(true);
  });
});

function httpRegistry(
  baseUrl: string,
  requested: string[] = [],
): IncidentRegistryPort {
  return {
    readPublishedVersion: ({ packageName, version }) => {
      const url = `${baseUrl}/${packageName}/${version}`;
      requested.push(url);
      return ResultAsync.fromPromise(fetch(url), () => ({
        type: "GitHubError" as const,
        operation: "readPublishedVersion",
        message: "fetch failed",
      })).andThen((response) => {
        if (!response.ok)
          return errAsync({
            type: "GitHubError" as const,
            operation: "readPublishedVersion",
            message: `${packageName}@${version} missing`,
          });
        return ResultAsync.fromPromise(
          response.json() as Promise<unknown>,
          () => ({
            type: "GitHubError" as const,
            operation: "readPublishedVersion",
            message: "invalid JSON",
          }),
        ).map((body) => {
          const record = asRecord(body);
          const dist = asRecord(record?.dist);
          const provenance = asRecord(record?.provenance);
          return {
            present: true,
            digest: stringField(dist, "integrity"),
            provenanceSubjectDigest: stringField(provenance, "subjectDigest"),
            deprecated:
              typeof record?.deprecated === "string" ? record.deprecated : null,
          };
        });
      });
    },
  };
}

function countingCompletion(
  live: () => ReleaseAuthority,
): IncidentCompletionPorts {
  return {
    createIncidentRefs: () =>
      errAsync({
        type: "IncidentMustNotMutate",
        action: "deprecate",
      }),
    createIncidentCheckRun: () =>
      errAsync({
        type: "IncidentMustNotMutate",
        action: "deprecate",
      }),
    completeChangesetCleanup: () =>
      errAsync({
        type: "IncidentMustNotMutate",
        action: "deprecate",
      }),
    rereadAuthority: () => okAsync(live()),
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return undefined;
  return value as Record<string, unknown>;
}

function stringField(
  record: Record<string, unknown> | undefined,
  key: string,
): string | null {
  const value = record?.[key];
  return typeof value === "string" ? value : null;
}
