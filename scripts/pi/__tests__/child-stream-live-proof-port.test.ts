import { describe, expect, it } from "bun:test";
import { errAsync, okAsync } from "neverthrow";
import { EXTENSION_BUILD_IDENTITY_PROOF_ENV } from "../../../packages/adapters/pi/src/extension-build-identity.js";
import {
  LIVE_PROOF_LANE_NAMES,
  type LiveProofArgs,
} from "../child-stream-live-proof-contract.js";
import { createLiveProofPort } from "../child-stream-live-proof-port.js";
import {
  LIVE_PROOF_DETERMINISTIC_CHILD_REQUEST,
  runLiveProof,
} from "../child-stream-live-proof-runner.js";
import type {
  IdentityVerificationSuccess,
  VerifyChildStreamingFailure,
} from "../verify-child-streaming.js";
import {
  bytes,
  createFakeSystem,
  type FakeProcessScript,
  type FakeSystemOptions,
  text,
} from "./live-proof-fakes.js";

const REPO_ROOT = "/repo";
const ARTIFACT = "a".repeat(64);
const FIXTURE_PATH =
  "packages/adapters/pi/src/__fixtures__/pi-0.84.2-child-ui-events.v1.json";
/** The read-tool turn. Dropping it leaves exactly one tool terminal. */
const READ_TURN_ORDINALS = { first: 4, last: 16 } as const;

const args: LiveProofArgs = {
  command: "live",
  pi: "/usr/local/bin/pi",
  requireFreshParent: true,
  requireCurrentBuild: true,
  proofLanes: [...LIVE_PROOF_LANE_NAMES],
  contentFreeReport: "/tmp/live-proof.json",
  noScreenCapture: true,
};

function identitySuccess(): IdentityVerificationSuccess {
  return {
    state: "current",
    evidence: "identity-proven",
    subject: "1".repeat(40),
    dirty: false,
    artifactSha256: ARTIFACT,
    loadTimeMs: 500,
    processStartMs: 400,
  };
}

function proofLine(input: {
  readonly artifactSha256?: string;
  readonly processStartMs: number;
  readonly loadTimeMs: number;
}): string {
  return JSON.stringify({
    weaveExtensionBuildIdentity: {
      schemaVersion: 1,
      artifactSha256: input.artifactSha256 ?? ARTIFACT,
      loadedOutputs: [
        { name: "extension", sha256: ARTIFACT },
        { name: "extension-build-identity", sha256: "c".repeat(64) },
        { name: "extension-impl", sha256: "d".repeat(64) },
        { name: "host-module-loader", sha256: "e".repeat(64) },
      ],
      loadTimeMs: input.loadTimeMs,
      processStartMs: input.processStartMs,
    },
  });
}

interface FixtureEvent {
  readonly ordinalId: number;
  readonly payload: Record<string, unknown>;
}

/**
 * Replay the authoritative Pi 0.84.2 capture as the deterministic child's live
 * output, with controlled in-memory reasoning text. The controlled text is not
 * the port's own leak sentinel, so a clean run must still report isolation.
 */
async function deterministicChildLines(): Promise<readonly string[]> {
  const fixture = (await Bun.file(FIXTURE_PATH).json()) as {
    readonly events: readonly FixtureEvent[];
  };
  const lines: string[] = [];
  for (const event of fixture.events) {
    if (
      event.ordinalId >= READ_TURN_ORDINALS.first &&
      event.ordinalId <= READ_TURN_ORDINALS.last
    ) {
      continue;
    }
    const payload = structuredClone(event.payload) as Record<string, unknown>;
    const assistant = payload.assistantMessageEvent;
    if (
      typeof assistant === "object" &&
      assistant !== null &&
      typeof (assistant as { type?: unknown }).type === "string"
    ) {
      const carrier = assistant as Record<string, unknown>;
      const type = carrier.type as string;
      if (type.startsWith("thinking")) {
        carrier[type === "thinking_delta" ? "delta" : "content"] =
          `LIVE-REASON-${event.ordinalId} `;
      }
    }
    lines.push(JSON.stringify(payload));
  }
  return lines;
}

async function greenScripts(): Promise<readonly FakeProcessScript[]> {
  return [
    { lines: [proofLine({ processStartMs: 5_000, loadTimeMs: 5_100 })] },
    { lines: await deterministicChildLines() },
  ];
}

function port(input: {
  readonly scripts: readonly FakeProcessScript[];
  readonly identity?: () => ReturnType<
    NonNullable<Parameters<typeof createLiveProofPort>[0]["verifyIdentity"]>
  >;
  readonly systemOptions?: FakeSystemOptions;
  readonly guarded?: readonly { readonly path: string }[];
  readonly childRunTimeoutMs?: number;
}) {
  const fake = createFakeSystem({
    ...input.systemOptions,
    processes: input.scripts,
  });
  const created = createLiveProofPort({
    repoRoot: REPO_ROOT,
    system: fake.system,
    ...(input.guarded === undefined ? {} : { guardedResources: input.guarded }),
    ...(input.childRunTimeoutMs === undefined
      ? {}
      : { childRunTimeoutMs: input.childRunTimeoutMs }),
    verifyIdentity:
      input.identity ??
      (() =>
        okAsync<IdentityVerificationSuccess, VerifyChildStreamingFailure>(
          identitySuccess(),
        )),
  });
  return { fake, port: created };
}

describe("createLiveProofPort", () => {
  it("runs the documented proof to a fully green content-free report", async () => {
    const scripts = await greenScripts();
    const created = port({ scripts });

    const report = (
      await runLiveProof({ args, port: created.port })
    )._unsafeUnwrap();

    expect(report.identity).toEqual({
      currentBuild: "current",
      freshParent: "fresh",
    });
    expect(report.lanes.map((lane) => lane.status)).toEqual([
      "pass",
      "pass",
      "pass",
      "pass",
    ]);
    expect(report.isolation).toBe("isolated");
    expect(report.settlement).toBe("settled");
    expect(report.registry).toBe("empty");
    expect(report.diagnostics).toBe("clean");
    expect(report.cleanup).toBe("complete");
    expect(report.failures).toEqual([]);
    expect(report.counters.events).toBeGreaterThan(0);
  });

  it("launches one fresh parent and exactly one deterministic child", async () => {
    const scripts = await greenScripts();
    const created = port({ scripts });

    await runLiveProof({ args, port: created.port });

    expect(created.fake.spawns).toHaveLength(2);
    const parent = created.fake.spawns[0];
    const child = created.fake.spawns[1];
    expect(parent?.input.cmd).toContain("--mode");
    expect(parent?.input.cmd.join(" ")).toContain(
      "packages/adapters/pi/dist/extension.js",
    );
    expect(parent?.input.env[EXTENSION_BUILD_IDENTITY_PROOF_ENV]).toBe("1");
    expect(parent?.input.env.OPENAI_API_KEY).toBeUndefined();
    expect(child?.input.cmd).toContain("weave-live-proof-deterministic");
    expect(child?.written).toHaveLength(1);
    expect(
      created.fake.removed.some((path) => path.includes("live-proof")),
    ).toBe(true);
  });

  it("refuses a stale artifact before any process starts", async () => {
    const created = port({
      scripts: [],
      identity: () =>
        errAsync<IdentityVerificationSuccess, VerifyChildStreamingFailure>({
          type: "stale-on-disk",
          state: "stale-on-disk",
          evidence: "blocked",
        }),
    });

    const report = (
      await runLiveProof({ args, port: created.port })
    )._unsafeUnwrap();

    expect(report.identity.currentBuild).toBe("stale-on-disk");
    expect(report.failures).toContain("identity-current-failed");
    expect(report.lanes.every((lane) => lane.status === "blocked")).toBe(true);
    expect(created.fake.spawns).toHaveLength(0);
  });

  it("maps an unverifiable identity without inventing a current build", async () => {
    const created = port({
      scripts: [],
      identity: () =>
        errAsync<IdentityVerificationSuccess, VerifyChildStreamingFailure>({
          type: "probe-failed",
          evidence: "blocked",
        }),
    });

    const report = (
      await runLiveProof({ args, port: created.port })
    )._unsafeUnwrap();

    expect(report.identity.currentBuild).toBe("unverifiable");
    expect(created.fake.spawns).toHaveLength(0);
  });

  it("rejects a reload-only parent that started before the proven artifact", async () => {
    const created = port({
      scripts: [
        { lines: [proofLine({ processStartMs: 10, loadTimeMs: 5_100 })] },
      ],
    });

    const report = (
      await runLiveProof({ args, port: created.port })
    )._unsafeUnwrap();

    expect(report.identity.currentBuild).toBe("current");
    expect(report.identity.freshParent).toBe("stale");
    expect(report.failures).toContain("fresh-parent-failed");
    expect(created.fake.spawns).toHaveLength(1);
  });

  it("rejects a parent that loaded a different artifact", async () => {
    const created = port({
      scripts: [
        {
          lines: [
            proofLine({
              artifactSha256: "f".repeat(64),
              processStartMs: 5_000,
              loadTimeMs: 5_100,
            }),
          ],
        },
      ],
    });

    const report = (
      await runLiveProof({ args, port: created.port })
    )._unsafeUnwrap();

    expect(report.identity.freshParent).toBe("stale");
    expect(report.failures).toContain("fresh-parent-failed");
  });

  it("fails closed when the parent never emits an identity proof", async () => {
    const created = port({ scripts: [{ lines: ["starting up"] }] });

    const report = (
      await runLiveProof({ args, port: created.port })
    )._unsafeUnwrap();

    expect(report.identity.freshParent).toBe("unverifiable");
    expect(report.failures).toContain("fresh-parent-failed");
  });

  it("fails closed when the child process cannot be spawned", async () => {
    const created = port({
      scripts: [
        { lines: [proofLine({ processStartMs: 5_000, loadTimeMs: 5_100 })] },
        { lines: [], spawnFails: true },
      ],
    });

    const report = (
      await runLiveProof({ args, port: created.port })
    )._unsafeUnwrap();

    expect(report.failures).toContain("spawn-failed");
    expect(report.lanes.every((lane) => lane.status === "blocked")).toBe(true);
    expect(report.cleanup).toBe("complete");
  });

  it("refuses a second deterministic child", async () => {
    const scripts = await greenScripts();
    const created = port({ scripts });

    await created.port.readCurrentIdentity({
      pi: args.pi,
      requireCurrentBuild: true,
    });
    const parent = (
      await created.port.launchFreshParent({
        pi: args.pi,
        requireFreshParent: true,
        requireCurrentBuild: true,
        noScreenCapture: true,
      })
    )._unsafeUnwrap();
    const first = await created.port.delegateDeterministicChild(
      parent.parent,
      LIVE_PROOF_DETERMINISTIC_CHILD_REQUEST,
    );
    const second = await created.port.delegateDeterministicChild(
      parent.parent,
      LIVE_PROOF_DETERMINISTIC_CHILD_REQUEST,
    );

    expect(first.isOk()).toBe(true);
    expect(second._unsafeUnwrapErr().code).toBe("spawn-failed");
    expect(created.fake.spawns).toHaveLength(2);
  });

  it("refuses inspector selection once the child is no longer running", async () => {
    const scripts = await greenScripts();
    const created = port({ scripts });

    await created.port.readCurrentIdentity({
      pi: args.pi,
      requireCurrentBuild: true,
    });
    const parent = (
      await created.port.launchFreshParent({
        pi: args.pi,
        requireFreshParent: true,
        requireCurrentBuild: true,
        noScreenCapture: true,
      })
    )._unsafeUnwrap();
    const child = (
      await created.port.delegateDeterministicChild(
        parent.parent,
        LIVE_PROOF_DETERMINISTIC_CHILD_REQUEST,
      )
    )._unsafeUnwrap();
    await created.port.cleanupRuntime({ parent: parent.parent, child });

    const selected = await created.port.selectLiveInspector(
      parent.parent,
      child,
    );

    expect(selected._unsafeUnwrapErr().code).toBe("lane-failed");
  });

  it("reports cleanup failure while an execution lease remains", async () => {
    const scripts = await greenScripts();
    const created = port({
      scripts,
      systemOptions: {
        runOutput: { exitCode: 0, stdout: "  Lease ID: abc\n" },
      },
    });

    const report = (
      await runLiveProof({ args, port: created.port })
    )._unsafeUnwrap();

    expect(report.cleanup).toBe("incomplete");
    expect(report.failures).toContain("cleanup-failed");
    expect(created.fake.runs.length).toBeGreaterThan(1);
  });

  it("reports cleanup failure when a process survives termination", async () => {
    const scripts = await greenScripts();
    const created = port({
      scripts: [
        { ...scripts[0], lines: scripts[0]?.lines ?? [] },
        {
          lines: scripts[1]?.lines ?? [],
          survivesTermination: true,
        },
      ],
    });

    const report = (
      await runLiveProof({ args, port: created.port })
    )._unsafeUnwrap();

    expect(report.cleanup).toBe("incomplete");
    expect(report.failures).toContain("cleanup-failed");
  });

  it("reports cleanup failure when the temporary workspace cannot be removed", async () => {
    const scripts = await greenScripts();
    const created = port({ scripts, systemOptions: { failRemove: true } });

    const report = (
      await runLiveProof({ args, port: created.port })
    )._unsafeUnwrap();

    expect(report.cleanup).toBe("incomplete");
    expect(report.failures).toContain("cleanup-failed");
  });

  it("stops observing when the child exceeds its deadline", async () => {
    const scripts = await greenScripts();
    const created = port({
      scripts: [{ lines: scripts[0]?.lines ?? [] }, { lines: [], hang: true }],
      childRunTimeoutMs: 0,
    });

    const report = (
      await runLiveProof({ args, port: created.port })
    )._unsafeUnwrap();

    expect(report.settlement).toBe("unsettled");
    expect(report.failures).toContain("settlement-failed");
    expect(report.lanes.every((lane) => lane.status !== "pass")).toBe(true);
    expect(report.cleanup).toBe("complete");
  });

  it("restores a guarded host resource from its exact bytes", async () => {
    const guardedPath = "/home/user/.weave/config.weave";
    const original = bytes("agent loom {}\n");
    const scripts = await greenScripts();
    const created = port({
      scripts,
      guarded: [{ path: guardedPath }],
      systemOptions: { files: new Map([[guardedPath, original]]) },
    });

    await created.port.readCurrentIdentity({
      pi: args.pi,
      requireCurrentBuild: true,
    });
    created.fake.files.set(guardedPath, bytes("tampered\n"));
    const cleaned = await created.port.cleanupPane({});

    expect(cleaned.isOk()).toBe(true);
    expect(text(created.fake.files.get(guardedPath))).toBe("agent loom {}\n");
  });

  it("leaves an untouched guarded resource alone", async () => {
    const guardedPath = "/home/user/.pi/agent/bin/pi";
    const scripts = await greenScripts();
    const created = port({
      scripts,
      guarded: [{ path: guardedPath }],
      systemOptions: { files: new Map([[guardedPath, bytes("#!/bin/sh\n")]]) },
    });

    await runLiveProof({ args, port: created.port });

    expect(text(created.fake.files.get(guardedPath))).toBe("#!/bin/sh\n");
  });
});
