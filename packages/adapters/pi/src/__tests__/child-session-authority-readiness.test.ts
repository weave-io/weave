import { describe, expect, test } from "bun:test";
import { errAsync } from "neverthrow";

import {
  DefaultPiCapabilityProber,
  type PiDelegationReadinessReason,
} from "../capability-prober.js";
import { WebCryptoHmacPort, WebCryptoRandomPort } from "../child-crypto.js";
import { redeemPiChildSessionLaunchGrant } from "../child-session-launch.js";
import {
  createPiChildSessionStorageAuthority,
  describeChildSessionStorageUnavailable,
  type PiChildSessionRootProof,
  type PiChildSessionStorageAuthority,
  provePiChildSessionRoot,
} from "../child-session-storage-authority.js";
import { MemoryPiNativeSessionFs } from "../native-session-fs.js";
import { PiRpcChild, type PiRpcChildSpawnInput } from "../rpc-child.js";
import { IdentityPiTrustedDataRootPort } from "../trusted-data-root.js";
import { FakeChildProcessPort } from "./fakes/fake-child-process-port.js";
import {
  createTestOnlyGrantedSessionStorageAuthority,
  mintTestOnlyLaunchGrant,
} from "./fakes/test-only-session-storage-authority.js";

const ROOT = "/data/weave/adapters/pi/sessions";
const SESSION_MANAGER = { create: () => undefined, open: () => undefined };
const PROCESS_LAUNCH = { spawn: () => undefined };

function noopLogger() {
  return { debug() {}, info() {}, warn() {}, error() {} };
}

/** Creates the root in an in-memory tree so a hostile state can be modelled. */
async function seededRoot(
  root: string = ROOT,
): Promise<MemoryPiNativeSessionFs> {
  const fs = new MemoryPiNativeSessionFs();
  (await fs.openDirectory(root, true))._unsafeUnwrap().close();
  return fs;
}

/** A real proof over an in-memory no-follow tree. Never an asserted path. */
async function provenRoot(
  fs: MemoryPiNativeSessionFs = new MemoryPiNativeSessionFs(),
  root: string = ROOT,
): Promise<PiChildSessionRootProof> {
  return (await provePiChildSessionRoot({ root, fs }))._unsafeUnwrap();
}

async function readyAuthority(): Promise<PiChildSessionStorageAuthority> {
  return createPiChildSessionStorageAuthority({
    SessionManager: SESSION_MANAGER,
    sessionRoot: await provenRoot(),
    processLaunch: PROCESS_LAUNCH,
    scopeId: "generation-1",
  });
}

describe("generation-scoped session authority", () => {
  test("reports exactly one closed reason for each missing fact", async () => {
    const unsafeFs = await seededRoot();
    unsafeFs.simulateDirectorySymlink(ROOT);
    const cases: readonly [
      PiDelegationReadinessReason,
      Parameters<typeof createPiChildSessionStorageAuthority>[0],
    ][] = [
      [
        "pi-session-api-unavailable",
        {
          sessionRoot: await provenRoot(),
          processLaunch: PROCESS_LAUNCH,
        },
      ],
      [
        "pi-session-root-unavailable",
        { SessionManager: SESSION_MANAGER, processLaunch: PROCESS_LAUNCH },
      ],
      [
        "pi-session-root-unsafe",
        {
          SessionManager: SESSION_MANAGER,
          sessionRoot: await provenRoot(unsafeFs),
          processLaunch: PROCESS_LAUNCH,
        },
      ],
      [
        "pi-process-unavailable",
        {
          SessionManager: SESSION_MANAGER,
          sessionRoot: await provenRoot(),
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

  test("a proven generation reports ready and yields one stable launch authority", async () => {
    const authority = await readyAuthority();

    expect(authority.readinessReason()).toBeUndefined();
    expect(authority.requireNativeSessionAuthority().isOk()).toBe(true);
    const first = authority.requireLaunchAuthority()._unsafeUnwrap();
    const second = authority.requireLaunchAuthority()._unsafeUnwrap();

    expect(first).toBe(second);
    expect(first.sessionRoot).toBe(ROOT);
    expect(first.scopeId).toBe("generation-1");
  });

  test("a launch grant redeems only against the authority that minted it", async () => {
    const generationOne = await readyAuthority();
    const generationTwo = await readyAuthority();
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

  test("an asserted root proof is refused; only a minted proof is honored", () => {
    const asserted = createPiChildSessionStorageAuthority({
      SessionManager: SESSION_MANAGER,
      // Structurally identical to a minted proof, but this module never
      // minted it, so it carries no root at all.
      sessionRoot: { status: "resolved" } as PiChildSessionRootProof,
      processLaunch: PROCESS_LAUNCH,
    });

    expect(asserted.readinessReason()).toBe("pi-session-root-unavailable");
    expect(asserted.requireSessionRoot().isErr()).toBe(true);
    expect(asserted.requireLaunchAuthority().isErr()).toBe(true);
  });

  test("an asserted process surface is refused; spawn must be callable", async () => {
    const asserted = createPiChildSessionStorageAuthority({
      SessionManager: SESSION_MANAGER,
      sessionRoot: await provenRoot(),
      processLaunch: { spawn: true },
    });

    expect(asserted.readinessReason()).toBe("pi-process-unavailable");
  });

  test("proves the root by really opening it, and closes each closed state", async () => {
    const identityRoot = new IdentityPiTrustedDataRootPort();

    // Absent and uncreatable: the port refuses to create the root.
    const uncreatable = await provePiChildSessionRoot({
      root: ROOT,
      fs: {
        openDirectory: () =>
          errAsync({ type: "unavailable", operation: "open" as const }),
      },
    });
    expect(uncreatable._unsafeUnwrap().status).toBe("unavailable");

    // Symlinked root: no-follow refuses it as hostile.
    const symlinked = await seededRoot();
    symlinked.simulateDirectorySymlink(ROOT);
    expect(
      (
        await provePiChildSessionRoot({ root: ROOT, fs: symlinked })
      )._unsafeUnwrap().status,
    ).toBe("unsafe");

    // Permissive mode: the root exists but is not 0700.
    const permissive = await seededRoot();
    permissive.simulatePermissiveDirectory(ROOT);
    expect(
      (
        await provePiChildSessionRoot({ root: ROOT, fs: permissive })
      )._unsafeUnwrap().status,
    ).toBe("unsafe");

    // Identity change under us between open and use.
    const swapped = await seededRoot();
    swapped.simulateDirectoryReplacement(ROOT);
    expect(
      (
        await provePiChildSessionRoot({ root: ROOT, fs: swapped })
      )._unsafeUnwrap().status,
    ).toBe("unsafe");

    // An escaping or unresolvable base never reaches the filesystem at all.
    const relative = await provePiChildSessionRoot({
      env: { XDG_DATA_HOME: "relative/data" },
      fs: new MemoryPiNativeSessionFs(),
    });
    expect(relative._unsafeUnwrap().status).toBe("unavailable");

    // The derived production path is proven end to end.
    const derived = await provePiChildSessionRoot({
      env: { XDG_DATA_HOME: "/data" },
      trustedRoot: identityRoot,
      fs: new MemoryPiNativeSessionFs(),
    });
    const proven = createPiChildSessionStorageAuthority({
      SessionManager: SESSION_MANAGER,
      sessionRoot: derived._unsafeUnwrap(),
      processLaunch: PROCESS_LAUNCH,
    });
    expect(proven.readinessReason()).toBeUndefined();
    expect(proven.requireSessionRoot()._unsafeUnwrap()).toBe(ROOT);
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
      sessionRoot: await provenRoot(),
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
    const thisGeneration =
      await createTestOnlyGrantedSessionStorageAuthority(ROOT);
    const otherGeneration =
      await createTestOnlyGrantedSessionStorageAuthority(ROOT);
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
