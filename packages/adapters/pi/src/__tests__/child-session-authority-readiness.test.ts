import { describe, expect, test } from "bun:test";

import {
  DefaultPiCapabilityProber,
  type PiDelegationReadinessReason,
} from "../capability-prober.js";
import { WebCryptoHmacPort, WebCryptoRandomPort } from "../child-crypto.js";
import { redeemPiChildSessionLaunchGrant } from "../child-session-launch.js";
import {
  classifyPiChildSessionRootFailure,
  createPiChildSessionStorageAuthority,
  describeChildSessionStorageUnavailable,
  type PiChildSessionStorageAuthority,
} from "../child-session-storage-authority.js";
import { PiRpcChild, type PiRpcChildSpawnInput } from "../rpc-child.js";
import { FakeChildProcessPort } from "./fakes/fake-child-process-port.js";
import {
  createTestOnlyGrantedSessionStorageAuthority,
  mintTestOnlyLaunchGrant,
} from "./fakes/test-only-session-storage-authority.js";

const ROOT = "/data/weave/adapters/pi/sessions";
const SESSION_MANAGER = { create: () => undefined, open: () => undefined };

function noopLogger() {
  return { debug() {}, info() {}, warn() {}, error() {} };
}

function readyAuthority(): PiChildSessionStorageAuthority {
  return createPiChildSessionStorageAuthority({
    SessionManager: SESSION_MANAGER,
    sessionRoot: { status: "resolved", root: ROOT },
    processAvailable: true,
    scopeId: "generation-1",
  });
}

describe("generation-scoped session authority", () => {
  test("reports exactly one closed reason for each missing fact", () => {
    const cases: readonly [
      PiDelegationReadinessReason,
      Parameters<typeof createPiChildSessionStorageAuthority>[0],
    ][] = [
      [
        "pi-session-api-unavailable",
        {
          sessionRoot: { status: "resolved", root: ROOT },
          processAvailable: true,
        },
      ],
      [
        "pi-session-root-unavailable",
        { SessionManager: SESSION_MANAGER, processAvailable: true },
      ],
      [
        "pi-session-root-unsafe",
        {
          SessionManager: SESSION_MANAGER,
          sessionRoot: { status: "unsafe" },
          processAvailable: true,
        },
      ],
      [
        "pi-process-unavailable",
        {
          SessionManager: SESSION_MANAGER,
          sessionRoot: { status: "resolved", root: ROOT },
        },
      ],
    ];

    for (const [reason, input] of cases) {
      const authority = createPiChildSessionStorageAuthority(input);
      expect(authority.readinessReason()).toBe(reason);
      const launch = authority.requireLaunchAuthority();
      expect(launch._unsafeUnwrapErr()).toEqual({
        type: "SessionStorageUnavailable",
        reason,
      });
      // Bounded and path-free on every public surface.
      expect(
        describeChildSessionStorageUnavailable(launch._unsafeUnwrapErr()),
      ).toBe(`session-storage-unavailable:${reason}`);
      expect(JSON.stringify(launch._unsafeUnwrapErr())).not.toContain(ROOT);
    }
  });

  test("a proven generation reports ready and yields one stable launch authority", () => {
    const authority = readyAuthority();

    expect(authority.readinessReason()).toBeUndefined();
    expect(authority.requireNativeSessionAuthority().isOk()).toBe(true);
    const first = authority.requireLaunchAuthority()._unsafeUnwrap();
    const second = authority.requireLaunchAuthority()._unsafeUnwrap();

    expect(first).toBe(second);
    expect(first.sessionRoot).toBe(ROOT);
    expect(first.scopeId).toBe("generation-1");
  });

  test("a launch grant redeems only against the authority that minted it", () => {
    const generationOne = readyAuthority();
    const generationTwo = readyAuthority();
    const grant = mintTestOnlyLaunchGrant(generationOne, {
      childId: "child-1",
      sessionDir: `${ROOT}/child-1`,
      sessionPath: `${ROOT}/child-1/session.jsonl`,
    });

    expect(
      redeemPiChildSessionLaunchGrant(grant, {
        childId: "child-1",
        authority: generationOne.requireLaunchAuthority()._unsafeUnwrap(),
      }).isOk(),
    ).toBe(true);
    expect(
      redeemPiChildSessionLaunchGrant(grant, {
        childId: "child-1",
        authority: generationTwo.requireLaunchAuthority()._unsafeUnwrap(),
      })._unsafeUnwrapErr(),
    ).toBe("authority-mismatch");
  });

  test("classifies root failures into the two closed root states", () => {
    for (const violation of [
      "foreign-data-root",
      "writable-data-root",
      "non-directory-data-root",
      "symlink-rejected",
      "unsafe-component",
      "path-escape",
    ] as const) {
      expect(classifyPiChildSessionRootFailure(violation)).toEqual({
        status: "unsafe",
      });
    }
    for (const violation of [
      "empty-home",
      "relative-xdg-data-home",
      "unresolvable-data-root",
      undefined,
    ] as const) {
      expect(classifyPiChildSessionRootFailure(violation)).toEqual({
        status: "unavailable",
      });
    }
  });
});

describe("readiness probing consumes the same authority", () => {
  const context = (
    delegationAuthority:
      | { readonly status: "ready" }
      | {
          readonly status: "unavailable";
          readonly reason: PiDelegationReadinessReason;
        },
  ) =>
    ({
      mode: "tui" as const,
      trust: "trusted" as const,
      commands: [],
      candidatePlan: {
        configLoaded: true,
        materializationErrorCount: 0,
        primaryDescriptorFound: true,
        primaryModelDryResolved: true,
        delegationToolPlanned: true,
      },
      delegationAuthority,
    }) as const;

  test("reports delegation unavailable for each closed authority reason", () => {
    const prober = new DefaultPiCapabilityProber({
      enforceCommandProvenance: false,
    });

    for (const reason of [
      "pi-session-api-unavailable",
      "pi-session-root-unavailable",
      "pi-session-root-unsafe",
      "pi-process-unavailable",
    ] as const) {
      const probe = prober
        .probe(context({ status: "unavailable", reason }))
        .find(
          (entry) => entry.capabilityId === "delegated-specialist-execution",
        );

      expect(probe).toEqual({
        capabilityId: "delegated-specialist-execution",
        probeStatus: "unavailable",
        details: reason,
      });
    }
  });

  test("reports delegation ready only when the authority is ready", () => {
    const probe = new DefaultPiCapabilityProber({
      enforceCommandProvenance: false,
    })
      .probe(context({ status: "ready" }))
      .find((entry) => entry.capabilityId === "delegated-specialist-execution");

    expect(probe?.probeStatus).toBe("ok");
  });
});

describe("no launch effect before the authority is proven", () => {
  const spawnInput = (
    session: PiRpcChildSpawnInput["session"],
  ): PiRpcChildSpawnInput => ({
    childId: "child-1",
    parentId: "root",
    generationId: "gen-1",
    agentName: "shuttle",
    depth: 1,
    cwd: "/repo",
    env: {},
    task: "task",
    ...(session === undefined ? {} : { session }),
  });

  test("a generation without a process surface refuses every launch", async () => {
    const processPort = new FakeChildProcessPort();
    const storageOnly = createPiChildSessionStorageAuthority({
      SessionManager: SESSION_MANAGER,
      sessionRoot: { status: "resolved", root: ROOT },
    });
    const child = new PiRpcChild("child-1", "root", "gen-1", "shuttle", 1, {
      processPort,
      sessionStorageAuthority: storageOnly,
      randomPort: new WebCryptoRandomPort(),
      hmacPort: new WebCryptoHmacPort(),
      logger: noopLogger(),
    });

    const result = await child.spawnAndHandshake(spawnInput(undefined));

    expect(result._unsafeUnwrapErr().correlation).toEqual({
      reason: "session-storage-unavailable:pi-process-unavailable",
    });
    expect(processPort.spawnInputs).toHaveLength(0);
    expect(processPort.spawnedProcesses).toHaveLength(0);
  });

  test("a grant from another generation cannot launch in this one", async () => {
    const processPort = new FakeChildProcessPort();
    const thisGeneration = createTestOnlyGrantedSessionStorageAuthority(ROOT);
    const otherGeneration = createTestOnlyGrantedSessionStorageAuthority(ROOT);
    const child = new PiRpcChild("child-1", "root", "gen-1", "shuttle", 1, {
      processPort,
      sessionStorageAuthority: thisGeneration,
      randomPort: new WebCryptoRandomPort(),
      hmacPort: new WebCryptoHmacPort(),
      logger: noopLogger(),
    });

    const result = await child.spawnAndHandshake(
      spawnInput({
        mode: "native",
        grant: mintTestOnlyLaunchGrant(otherGeneration, {
          childId: "child-1",
          sessionDir: `${ROOT}/child-1`,
          sessionPath: `${ROOT}/child-1/session.jsonl`,
        }),
      }),
    );

    const failure = JSON.stringify(result._unsafeUnwrapErr());
    expect(failure).toContain("authority-mismatch");
    expect(failure).not.toContain(ROOT);
    expect(processPort.spawnInputs).toHaveLength(0);
  });
});
