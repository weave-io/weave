import { describe, expect, it } from "bun:test";
import { errAsync, okAsync } from "neverthrow";
import {
  cleanupSettledMarker,
  type MarkerCleanupPort,
  runStableRoute,
} from "../release-route-main.js";
import {
  evaluateRolloutGate,
  guardStableRoute,
  type StableRoute,
} from "../rollout-gate.js";
import {
  createRolloutActivationRecord,
  createRolloutFreezeRecord,
} from "../rollout-stage.js";

const SHA = "a".repeat(40);
const OTHER = "b".repeat(40);
const mergedRoute: StableRoute = {
  channel: "stable-merge",
  eventName: "pull_request",
  merged: true,
  releasedSha: SHA,
  pullRequestNumber: 12,
  markerCleanupRequired: true,
};
const preTopology = {
  oldWorkflowPresent: true,
  oldWorkflowScheduled: true,
  newWorkflowPresent: true,
  newWorkflowScheduled: false,
  newWorkflowGateDisabled: true,
  attestationWorkflowPresent: true,
  attestationWorkflowCalls: false,
};
const readyTopology = {
  oldWorkflowPresent: false,
  oldWorkflowScheduled: false,
  newWorkflowPresent: true,
  newWorkflowScheduled: true,
  newWorkflowGateDisabled: true,
};
const freeze = createRolloutFreezeRecord({
  commitSha: SHA,
  committedAt: "2026-01-01T00:00:00.000Z",
  quiescenceEvidence: "old publisher stopped",
})._unsafeUnwrap();
const activation = createRolloutActivationRecord({
  commitSha: OTHER,
  committedAt: "2026-01-02T00:00:00.000Z",
  greenReport: "all gates passed",
})._unsafeUnwrap();
const readyDeclaration = {
  schemaVersion: 1 as const,
  stage: "ready" as const,
  freezeRecord: freeze,
  activationRecord: activation,
};

function event(overrides: Record<string, unknown> = {}) {
  return {
    repository: "weave-io/weave",
    eventName: "pull_request",
    action: "closed",
    ref: "refs/pull/12/merge",
    actor: "maintainer",
    pullRequest: {
      number: 12,
      action: "closed",
      merged: true,
      baseRef: "main",
      baseRepository: "weave-io/weave",
      labels: ["release:stable"],
      mergeCommitSha: SHA,
    },
    ...overrides,
  };
}

describe("rollout and route gate", () => {
  it("fails closed for wrong repository, base, label, and schedule", () => {
    expect(
      guardStableRoute({
        event: event({ repository: "evil/repo" }),
        mode: "disabled",
        topology: preTopology,
      }).isErr(),
    ).toBe(true);
    expect(
      guardStableRoute({
        event: event({
          pullRequest: { ...event().pullRequest, baseRef: "dev" },
        }),
        mode: "disabled",
        topology: preTopology,
      }).isErr(),
    ).toBe(true);
    expect(
      guardStableRoute({
        event: event({ pullRequest: { ...event().pullRequest, labels: [] } }),
        mode: "disabled",
        topology: preTopology,
      }).isErr(),
    ).toBe(true);
    expect(
      guardStableRoute({
        event: { ...event(), eventName: "schedule", pullRequest: null },
        mode: "disabled",
        topology: preTopology,
      }).isErr(),
    ).toBe(true);
  });

  it("uses disabled as an early no-work decision", () => {
    const result = evaluateRolloutGate({
      route: mergedRoute,
      mode: "disabled",
      topology: preTopology,
    });
    expect(result._unsafeUnwrap()).toMatchObject({
      work: false,
      publish: false,
      outcome: "RolloutDisabled",
    });
  });

  it("runs proof work in dry-run but never authorizes publish", () => {
    const result = evaluateRolloutGate({
      route: mergedRoute,
      mode: "dry-run",
      topology: preTopology,
    });
    expect(result._unsafeUnwrap()).toMatchObject({
      work: true,
      publish: false,
      outcome: "dry-run",
    });
  });

  it("allows publication only at ready plus enabled and correct topology", () => {
    const result = evaluateRolloutGate({
      route: mergedRoute,
      declaration: readyDeclaration,
      mode: "enabled",
      topology: readyTopology,
    });
    expect(result._unsafeUnwrap()).toMatchObject({
      work: true,
      publish: true,
      outcome: "ready",
    });
    expect(
      evaluateRolloutGate({
        route: mergedRoute,
        declaration: readyDeclaration,
        mode: "dry-run",
        topology: readyTopology,
      }).isErr(),
    ).toBe(true);
    expect(
      evaluateRolloutGate({
        route: mergedRoute,
        declaration: {
          ...readyDeclaration,
          stage: "frozen",
          activationRecord: null,
        },
        mode: "enabled",
        topology: readyTopology,
      }).isErr(),
    ).toBe(true);
  });

  it.each([
    ["unmerged", false],
    ["merged", true],
  ] as const)("attempts marker cleanup on the %s closed path", async (_name, merged) => {
    const calls: string[] = [];
    const marker: MarkerCleanupPort = {
      readMarker: () => {
        calls.push("read");
        return okAsync(SHA);
      },
      deleteMarker: (expected) => {
        calls.push(`delete:${expected}`);
        return okAsync(undefined);
      },
    };
    const route = { ...mergedRoute, merged };
    const result = await cleanupSettledMarker(route, marker);
    expect(result._unsafeUnwrap()).toMatchObject({
      attempted: true,
      pending: false,
      markerSha: SHA,
    });
    expect(calls).toEqual(["read", `delete:${SHA}`]);
  });

  it("records MarkerCleanupPending without stopping a merged route", async () => {
    const marker: MarkerCleanupPort = {
      readMarker: () => okAsync(SHA),
      deleteMarker: () =>
        errAsync({ type: "MarkerDeleteFailed" as const, reason: "lease lost" }),
    };
    const result = await runStableRoute(
      { event: event(), mode: "disabled", topology: preTopology },
      marker,
    );
    expect(result.isOk()).toBe(true);
    if (result.isOk())
      expect(result.value.markerCleanup).toMatchObject({
        pending: true,
        markerSha: SHA,
      });
  });
});
