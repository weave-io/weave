import { describe, expect, it } from "bun:test";
import { resolve } from "node:path";
import { errAsync, okAsync, type Result } from "neverthrow";
import { ADAPTER_HOST_MATRICES } from "../acceptance-manifest.js";
import {
  BunChangesetFileSystem,
  ChangesetPolicyValidator,
  type ValidatedChangeset,
} from "../changeset-policy.js";
import type { ChannelRegistry } from "../channel-versions.js";
import { PUBLIC_PACKAGES, type PublicPackageName } from "../constants.js";
import { EMPTY_CONSUMPTION_LEDGER } from "../consumption-ledger.js";
import {
  assertNightlyProofChain,
  assertNightlySourceFilesUnchanged,
  authorizeNightlyRoute,
  createNightlyReleasePlan,
  evaluateNightlyRollout,
  explainNightlyClosure,
  type NightlyPlanInput,
  type NightlyRouteEvent,
  NightlyRouteEventSchema,
  parseNightlyInput,
  parseNightlyMetadata,
  parseNightlyRouteEnvironment,
  runNightlyMain,
  serializeNightlyMetadata,
  validateNightlyRouteEvent,
} from "../nightly-main.js";
import {
  ATTESTATION_CHECK_NAME,
  type AttestationCheckResult,
  type AttestationExpectation,
} from "../publish-chain.js";

const CLI = "@weaveio/weave-cli";
const OPENCODE = "@weaveio/weave-adapter-opencode";
const PI = "@weaveio/weave-adapter-pi";
const SHA = "a".repeat(40);
const DIGEST = `sha256:${"b".repeat(64)}`;
const packages = Object.keys(PUBLIC_PACKAGES) as PublicPackageName[];
const versions = Object.fromEntries(
  packages.map((packageName) => [packageName, "0.0.1"]),
) as Record<PublicPackageName, string>;
const manifests = packages.map((name) => ({ name, dependencies: [] }));

function unwrap<T, E>(result: Result<T, E>): T {
  if (result.isErr()) throw new Error(JSON.stringify(result.error));
  return result.value;
}

function changeset(path: string, source: string): ValidatedChangeset {
  return unwrap(
    new ChangesetPolicyValidator(new BunChangesetFileSystem()).validateFile(
      path,
      new TextEncoder().encode(source),
    ),
  );
}

class Registry implements ChannelRegistry {
  listVersions(packageName: string) {
    return packageName in PUBLIC_PACKAGES
      ? okAsync(["0.0.1-nightly.20260819.111111111111"])
      : errAsync({
          type: "RegistryError" as const,
          operation: "listVersions",
          message: "unknown package",
        });
  }
}

const oldTopology = {
  oldWorkflowPresent: true,
  oldWorkflowScheduled: true,
  newWorkflowPresent: true,
  newWorkflowScheduled: false,
  newWorkflowGateDisabled: true,
};

function routeEvent(
  overrides: Partial<NightlyRouteEvent> = {},
): NightlyRouteEvent {
  return NightlyRouteEventSchema.parse({
    repository: "weave-io/weave",
    eventName: "workflow_dispatch",
    action: "workflow_dispatch",
    ref: "refs/heads/main",
    actor: "maintainer",
    maintainerAuthorized: true,
    channel: "nightly",
    ...overrides,
  });
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

function nightlyInput(
  overrides: Partial<NightlyPlanInput> = {},
): NightlyPlanInput {
  return {
    packageVersions: versions,
    changesets: [
      changeset(
        ".changeset/nightly-feature.md",
        `---\n"${OPENCODE}": minor\n---\n\nShip a nightly feature.\n`,
      ),
    ],
    ledger: EMPTY_CONSUMPTION_LEDGER,
    manifests,
    sourceSha: SHA,
    now: new Date("2026-08-20T12:00:00.000Z"),
    canonicalNotesUrl: "https://github.com/weave-io/weave/releases",
    registry: new Registry(),
    changedPathsSince: (fromSha, toSha) => {
      expect(fromSha).toBe("111111111111");
      expect(toSha).toBe(SHA);
      return okAsync(["packages/adapters/pi/src/index.ts"]);
    },
    sourceHistory: [{ sha: SHA, subject: "Add nightly channel" }],
    ...overrides,
  };
}

describe("nightly route", () => {
  it("accepts only authorized dispatches and the exact protected schedule", () => {
    expect(validateNightlyRouteEvent(routeEvent()).isOk()).toBe(true);
    expect(
      validateNightlyRouteEvent({
        ...routeEvent(),
        eventName: "schedule",
        action: "schedule",
      }).isOk(),
    ).toBe(true);
    expect(
      validateNightlyRouteEvent({
        ...routeEvent(),
        eventName: "schedule",
        action: "workflow_dispatch",
      })._unsafeUnwrapErr().type,
    ).toBe("InvalidNightlyRoute");
    expect(
      validateNightlyRouteEvent({
        ...routeEvent(),
        ref: "refs/heads/feature",
      })._unsafeUnwrapErr().type,
    ).toBe("WrongNightlyMainLineage");
    expect(
      validateNightlyRouteEvent(
        routeEvent({ maintainerAuthorized: false }),
      )._unsafeUnwrapErr().type,
    ).toBe("UnauthorizedNightlyRoute");
    expect(parseNightlyInput({ cli: true }).isOk()).toBe(true);
    expect(parseNightlyInput({ extra: true }).isErr()).toBe(true);
    const scheduled = parseNightlyRouteEnvironment({
      GITHUB_EVENT_NAME: "schedule",
      GITHUB_EVENT_ACTION: "schedule",
      GITHUB_REPOSITORY: "weave-io/weave",
      GITHUB_REF: "refs/heads/main",
      GITHUB_ACTOR: "weave-io",
      INPUT_CHANNEL: "stable",
    });
    expect(scheduled.isOk()).toBe(true);
    if (scheduled.isOk()) expect(scheduled.value.channel).toBe("nightly");
    expect(
      parseNightlyRouteEnvironment({
        GITHUB_EVENT_NAME: "schedule",
        GITHUB_REPOSITORY: "weave-io/weave",
        GITHUB_REF: "refs/heads/main",
        GITHUB_ACTOR: "weave-io",
      }).isErr(),
    ).toBe(true);
    expect(
      parseNightlyRouteEnvironment({
        GITHUB_EVENT_NAME: "schedule",
        GITHUB_EVENT_ACTION: "schedule",
        GITHUB_REPOSITORY: "attacker/weave",
        GITHUB_REF: "refs/heads/main",
        GITHUB_ACTOR: "weave-io",
      }).isErr(),
    ).toBe(true);
  });

  it("fails the current pre-cutover schedule closed before chain work", async () => {
    // The cutover removed publish.yml and added the new schedule, but the
    // checked-in stage is still `pre-cutover`. The exact schedule therefore
    // reaches the nightly route and fails on the invalid tuple before any
    // plan, proof, OIDC, or publish job can run.
    const result = await runNightlyMain(
      { phase: "route" },
      {
        GITHUB_EVENT_NAME: "schedule",
        GITHUB_EVENT_ACTION: "schedule",
        GITHUB_REPOSITORY: "weave-io/weave",
        GITHUB_REF: "refs/heads/main",
        GITHUB_ACTOR: "weave-io",
        RELEASE_ROLLOUT_MODE: "disabled",
      },
    );
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe("RolloutInvalidState");
      expect(result.error).toMatchObject({
        type: "RolloutInvalidState",
        reason: "pre-cutover requires the old scheduled workflow",
      });
    }
  });

  it("uses the shared maintainer authorization port", async () => {
    const actors: string[] = [];
    const accepted = await authorizeNightlyRoute(routeEvent(), {
      assertStableRequestAuthorized: (actor) => {
        actors.push(actor);
        return okAsync<unknown, unknown>(actor);
      },
    });
    expect(accepted.isOk()).toBe(true);
    expect(actors).toEqual(["maintainer"]);
    const refused = await authorizeNightlyRoute(routeEvent(), {
      assertStableRequestAuthorized: () =>
        errAsync<unknown, unknown>(new Error("not authorized")),
    });
    expect(refused._unsafeUnwrapErr().type).toBe("NightlyAuthorizationFailed");
  });
});

describe("nightly rollout and planning", () => {
  it("returns typed RolloutDisabled for final frozen state before chain work", () => {
    const disabled = evaluateNightlyRollout({
      declaration: {
        schemaVersion: 1,
        stage: "frozen",
        freezeRecord: {
          schemaVersion: 1,
          commitSha: "c".repeat(40),
          committedAt: "2026-08-20T00:00:00.000Z",
          quiescenceEvidence: "old publisher quiescent",
        },
        activationRecord: null,
      },
      mode: "disabled",
      topology: {
        oldWorkflowPresent: false,
        oldWorkflowScheduled: false,
        newWorkflowPresent: true,
        newWorkflowScheduled: true,
        newWorkflowGateDisabled: true,
      },
    });
    expect(disabled.isErr()).toBe(true);
    expect(disabled._unsafeUnwrapErr()).toEqual({
      type: "RolloutDisabled",
      channel: "nightly",
    });

    const dryRun = evaluateNightlyRollout({
      declaration: {
        schemaVersion: 1,
        stage: "pre-cutover",
        freezeRecord: null,
        activationRecord: null,
      },
      mode: "dry-run",
      topology: oldTopology,
    });
    expect(dryRun._unsafeUnwrap()).toMatchObject({
      work: true,
      publish: false,
      outcome: "dry-run",
    });
  });

  it("computes the affected closure, nightly versions, and deterministic notes", async () => {
    const result = await createNightlyReleasePlan(nightlyInput());
    const value = unwrap(result);
    expect(value.plan.channel).toBe("nightly");
    expect(value.plan.consumed).toEqual([]);
    expect(value.plan.closure.selected).toEqual([OPENCODE, PI]);
    expect(value.plan.versions.map((entry) => entry.version)).toEqual([
      `0.1.0-nightly.20260820.${SHA.slice(0, 12)}`,
      `0.0.1-nightly.20260820.${SHA.slice(0, 12)}`,
    ]);
    expect(value.metadata.sinceSha).toBe("111111111111");
    expect(explainNightlyClosure(value.plan.closure)).toContain("last nightly");
    const content = value.metadata.changelogs[0]?.content ?? "";
    expect(content).toContain(
      "deterministic nightly snapshot scratch changelog",
    );
    expect(content).not.toMatch(
      /AI-generated|generated by an AI|language model/i,
    );
    const serialized = unwrap(serializeNightlyMetadata(value.metadata));
    expect(unwrap(parseNightlyMetadata(JSON.parse(serialized))).sinceSha).toBe(
      "111111111111",
    );
  });

  it("returns NothingToPublish for a clean affected range", async () => {
    const result = await createNightlyReleasePlan(
      nightlyInput({
        changesets: [],
        changedPathsSince: () => [],
      }),
    );
    expect(result._unsafeUnwrapErr()).toMatchObject({
      type: "NightlyVersionFailed",
      error: { type: "NothingToPublish" },
    });
  });

  it("keeps source bytes unchanged during the staging proof", () => {
    const before = {
      "packages/cli/package.json": "manifest",
      "packages/cli/CHANGELOG.md": "canonical",
    };
    expect(
      assertNightlySourceFilesUnchanged({ before, after: before }).isOk(),
    ).toBe(true);
    expect(
      assertNightlySourceFilesUnchanged({
        before,
        after: { ...before, "packages/cli/package.json": "changed" },
      })._unsafeUnwrapErr().type,
    ).toBe("SourceMutationDetected");
  });
});

describe("nightly proof gate", () => {
  it("blocks missing attestation and consumer proof before OIDC", () => {
    const expectation: AttestationExpectation = {
      releasedSha: SHA,
      planDigest: DIGEST,
      tarballDigests: [{ packageName: CLI, sha256: DIGEST }],
    };
    expect(
      assertNightlyProofChain({
        expectation,
        attestation: undefined,
        closure: { selected: [CLI] },
        consumerProofs: [],
        harnessProofs: [],
      })._unsafeUnwrapErr(),
    ).toMatchObject({ type: "NightlyProofBlocked", stage: "attestation" });
    expect(
      assertNightlyProofChain({
        expectation,
        attestation: attestation(expectation),
        closure: { selected: [CLI] },
        consumerProofs: [],
        harnessProofs: [],
      })._unsafeUnwrapErr(),
    ).toMatchObject({ type: "NightlyProofBlocked", stage: "consumer" });
  });

  it("requires minimum and latest harness proof for every affected adapter", () => {
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
      summary: "nightly harness proof passed",
    });
    const matrix = ADAPTER_HOST_MATRICES[PI];
    const result = assertNightlyProofChain({
      expectation,
      attestation: attestation(expectation),
      closure: { selected: [PI] },
      consumerProofs: [
        {
          packageName: PI,
          version: "0.0.2-nightly.20260820.aaaaaaaaaaaa",
          tarballDigest: DIGEST,
          status: "passed",
          summary: "clean consumer passed",
        },
      ],
      harnessProofs: [proof(matrix.minimum), proof(matrix.latest)],
    });
    expect(result.isOk()).toBe(true);
  });
});

describe("nightly workflow shape", () => {
  it("routes the protected schedule to nightly before the gated chain", async () => {
    const workflow = await Bun.file(
      resolve(
        import.meta.dir,
        "../../../.github/workflows/release-publish.yml",
      ),
    ).text();
    expect(workflow).toContain("- nightly");
    expect(workflow).toContain(
      "bun scripts/release/nightly-main.ts --phase route",
    );
    expect(workflow).toContain(
      'if [[ "$' + '{GITHUB_EVENT_NAME:-}" == "schedule" ]]',
    );
    expect(workflow).toContain(
      "INPUT_CHANNEL: $" +
        "{{ inputs.channel || (github.event_name == 'schedule' && 'nightly' || '') }}",
    );
    expect(workflow).toContain("needs.route.outputs.work == 'true'");
    expect(workflow).toContain(
      "bun scripts/release/nightly-main.ts --phase plan",
    );
    expect(workflow).toContain(
      "bun scripts/release/nightly-main.ts --phase build",
    );
    // Task 35's cutover moves the nightly cron onto this workflow. The route
    // job maps the protected schedule explicitly to nightly, but the
    // schedule cannot reach the nightly chain while the rollout stays gated.
    expect(workflow).toMatch(/^\s+schedule:/m);
    expect(workflow).toContain('- cron: "17 0 * * *"');
    expect(
      parseNightlyRouteEnvironment({
        GITHUB_REPOSITORY: "weave-io/weave",
        GITHUB_REF: "refs/heads/main",
        GITHUB_EVENT_NAME: "schedule",
        GITHUB_EVENT_ACTION: "schedule",
        GITHUB_ACTOR: "weave-io",
      }).isOk(),
    ).toBe(true);
    expect(workflow).not.toContain("npm deprecate");
    expect(workflow).toContain("--tag nightly");
    expect(workflow).toContain("channel != 'nightly'");
    const order = [
      "\n  route:",
      "\n  recompute:",
      "\n  build-bind:",
      "\n  await-attest:",
      "\n  consumer-proof:",
      "\n  harness-proof:",
      "\n  release-approval:",
      "\n  publish:",
      "\n  registry-verification:",
      "\n  refs-cleanup:",
    ].map((job) => workflow.indexOf(job));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((left, right) => left - right));
  });
});
