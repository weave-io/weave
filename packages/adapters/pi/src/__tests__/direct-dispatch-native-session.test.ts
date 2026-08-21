/**
 * Direct workflow-step children run in real Pi-native sessions.
 *
 * Task 11 review blocker B: a direct workflow step reused `PiRpcChild` without
 * ever provisioning a session, so `buildSpawnCommand` fell through to its
 * `ephemeral` default and launched the child with `--no-session`. A direct step
 * therefore produced no durable transcript, no reachable authority, and no
 * parent link, unlike ordinary delegation.
 *
 * These tests pin the replacement contract: every production direct step
 * provisions a validated native session through the approved store/ref ports
 * before spawn, RPC receives both `--session-dir` and `--session`, and a
 * provisioning failure produces zero spawn.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { errAsync, okAsync } from "neverthrow";
import { WebCryptoHmacPort, WebCryptoRandomPort } from "../child-crypto.js";
import {
  type CreateNativeChildSessionInput,
  type PiNativeSessionError,
  type PiNativeSessionRecord,
  PiNativeSessionStore,
  type PiNativeThreadMetadataInput,
} from "../child-native-sessions.js";
import type {
  AppendChildRefLifecycleInput,
  AppendChildRefRunInput,
  AppendNewChildRefInput,
  PiChildRefRecord,
} from "../child-session-refs.js";
import { isTrustedChildTitleProvenance } from "../child-title.js";
import type {
  PiThreadRefPort,
  PiThreadSessionPort,
} from "../delegation-controller.js";
import {
  createDirectDispatchTransport,
  validateDirectNativeSession,
} from "../direct-dispatch-transport.js";
import { createBunPiNativeSessionFs } from "../native-session-fs.js";
import { createPiNativeSessionHost } from "../native-session-host.js";
import type { PiChildSessionStorageAuthority } from "../child-session-storage-authority.js";
import { FakeChildProcessPort } from "./fakes/fake-child-process-port.js";
import { FakeIdGenerator } from "./fakes/fake-pi-host.js";
import {
  makeRealTempRoot,
  removeRealTempRoot,
} from "./fakes/real-temp-root.js";
import {
  createTestOnlyGrantedSessionStorageAuthority,
  mintTestOnlyLaunchGrant,
  TEST_ONLY_GRANTED_SESSION_STORAGE_AUTHORITY,
} from "./fakes/test-only-session-storage-authority.js";

const PARENT_SESSION = "parent-session-direct-1";
const GENERATION = "generation-1";
const CHILD_ID = "direct-wf-1-verify-generation-1";

function noopLogger() {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };
}

function baseInput(cwd: string) {
  return {
    workflowInstanceId: "wf-1",
    leaseId: "lease-1",
    stepName: "verify",
    agentName: "smoke-child",
    composedPrompt: "You are the direct step.",
    taskPrompt: "Verify the change.",
    cwd,
    correlationId: "engine-effect-correlation-unrelated",
    models: [],
    delegationTargets: [],
  };
}

/** Records every ref write a direct step performs. */
class RecordingRefPort implements PiThreadRefPort {
  readonly newChildren: AppendNewChildRefInput[] = [];
  failNewChild = false;

  constructor(private readonly parentSession: string = PARENT_SESSION) {}

  liveParentSessionId(): string {
    return this.parentSession;
  }

  readRefs() {
    return okAsync({ refs: [], issues: [] } as never);
  }

  appendNewChild(input: AppendNewChildRefInput) {
    if (this.failNewChild) {
      return errAsync({ type: "RefWriteFailed", reason: "io" } as never);
    }
    this.newChildren.push(input);
    return okAsync({
      childId: input.childId,
      threadId: input.threadId ?? input.childId,
      nativeSessionId: input.nativeSessionId,
      sessionRef: input.sessionRef,
      title: input.title,
      status: input.status ?? "running",
    } as unknown as PiChildRefRecord);
  }

  appendRunDivider(_record: PiChildRefRecord, _input: AppendChildRefRunInput) {
    return okAsync(_record);
  }

  appendLifecycle(
    _record: PiChildRefRecord,
    _input: AppendChildRefLifecycleInput,
  ) {
    return okAsync(_record);
  }
}

/** A session port that fails at a chosen stage, to prove zero spawn. */
class FailingSessionPort implements PiThreadSessionPort {
  readonly tombstones: PiNativeSessionRecord[] = [];

  constructor(private readonly stage: "create" | "leaf") {}

  createChildSession(_input: CreateNativeChildSessionInput) {
    return this.stage === "create"
      ? errAsync<PiNativeSessionRecord, PiNativeSessionError>({
          type: "SessionCreateFailed",
          reason: "not-persisted",
        })
      : okAsync<PiNativeSessionRecord, PiNativeSessionError>({
          childId: _input.childId,
          sessionId: "native-1",
          ref: "child/session.jsonl",
          path: "/data/weave/adapters/pi/sessions/child/session.jsonl",
          parentSession: _input.parentSession,
          cwd: _input.cwd,
        });
  }

  establishThreadLeaf(
    _ref: string,
    _metadata: PiNativeThreadMetadataInput,
    _expectedParentSession?: string,
  ) {
    return errAsync({
      type: "SessionCreateFailed" as const,
      reason: "host-threw" as const,
    } as never);
  }

  mintLaunchGrant() {
    return errAsync({
      type: "SessionGrantRefused" as const,
      reason: "authority-unavailable" as const,
    } as never);
  }

  appendTombstone(record: PiNativeSessionRecord) {
    this.tombstones.push(record);
    return okAsync({
      version: 1 as const,
      ref: record.ref,
      childId: record.childId,
      parentSession: record.parentSession,
      deletedAt: "2026-01-01T00:00:00.000Z",
      reason: "explicit-user-deletion" as const,
    } as never);
  }

  openSession(ref: string) {
    return errAsync({ type: "SessionMissing" as const, ref } as never);
  }

  readSessionEntries(ref: string) {
    return errAsync({ type: "SessionMissing" as const, ref } as never);
  }

  readSessionEntryPage(ref: string) {
    return errAsync({ type: "SessionMissing" as const, ref } as never);
  }

  readThreadMetadata(ref: string) {
    return errAsync({ type: "SessionMissing" as const, ref } as never);
  }
}

function transportWith(options: {
  readonly processPort: FakeChildProcessPort;
  readonly sessions?: PiThreadSessionPort;
  readonly refs?: PiThreadRefPort;
  readonly requireNativeSession?: boolean;
  readonly sessionStorageAuthority?: PiChildSessionStorageAuthority;
}) {
  return createDirectDispatchTransport(
    {
      processPort: options.processPort,
      randomPort: new WebCryptoRandomPort(),
      hmacPort: new WebCryptoHmacPort(),
      logger: noopLogger(),
      idGenerator: new FakeIdGenerator(),
      command: ["/fake/bin/pi", "--mode", "rpc"],
      sessionStorageAuthority:
        options.sessionStorageAuthority ??
        TEST_ONLY_GRANTED_SESSION_STORAGE_AUTHORITY,
      threadSessions: () => options.sessions,
      threadRefs: () => options.refs,
      requireNativeSession: () => options.requireNativeSession ?? true,
      now: () => 1_700_000_000_000,
    },
    GENERATION,
  );
}

function argumentValue(
  command: readonly string[],
  flag: string,
): string | undefined {
  const index = command.indexOf(flag);
  return index === -1 ? undefined : command[index + 1];
}

describe("direct workflow steps provision Pi-native sessions", () => {
  let root: string;

  beforeEach(async () => {
    root = await makeRealTempRoot("weave-direct-session");
  });

  afterEach(async () => {
    await removeRealTempRoot(root);
  });

  it("creates a real native session through the store's create/open/header bridge and launches with both session arguments", async () => {
    // One authority for the whole step: the store mints its launch grant from
    // it, and the RPC child redeems the same grant against the same object.
    const sessionStorageAuthority =
      await createTestOnlyGrantedSessionStorageAuthority(root);
    const launchAuthority = sessionStorageAuthority.requireLaunchAuthority();
    if (launchAuthority.isErr()) {
      throw new Error(`unexpected: ${launchAuthority.error.reason}`);
    }
    const store = new PiNativeSessionStore({
      launch: { mode: "authorized", authority: launchAuthority.value },
      root,
      fs: createBunPiNativeSessionFs(),
      host: createPiNativeSessionHost(SessionManager),
    });
    const refs = new RecordingRefPort();
    const processPort = new FakeChildProcessPort();
    const transport = transportWith({
      processPort,
      sessions: store,
      refs,
      sessionStorageAuthority,
    });

    const settlement = transport(baseInput(root));
    await processPort.spawnCalled;
    const spawned = processPort.spawnInputs[0];
    if (spawned === undefined) throw new Error("expected exactly one spawn");
    const sessionDir = argumentValue(spawned.command, "--session-dir");
    const sessionPath = argumentValue(spawned.command, "--session");
    const appended = refs.newChildren[0];
    // The session Pi will open really exists on disk, carrying the host's own
    // v3 header plus the thread metadata leaf, before the child launches.
    const persisted = await Bun.file(sessionPath ?? "").text();
    const header = JSON.parse(persisted.split("\n")[0] ?? "{}") as {
      type?: string;
      version?: number;
      cwd?: string;
      parentSession?: string;
      id?: string;
    };

    expect({
      spawnCount: processPort.spawnInputs.length,
      hasSessionDir: sessionDir !== undefined,
      hasSessionPath: sessionPath !== undefined,
      sessionFileInsideDir: sessionPath?.startsWith(`${sessionDir}/`) ?? false,
      sessionUnderRoot: sessionPath?.startsWith(`${root}/`) ?? false,
      noEphemeralFlag: spawned.command.includes("--no-session"),
      headerType: header.type ?? "",
      headerVersion: header.version ?? 0,
      // Session identity, parent link, and cwd all come from the trusted
      // dispatch input, never from the child.
      headerParent: header.parentSession ?? "",
      headerCwd: header.cwd ?? "",
      refSessionId: appended?.nativeSessionId ?? "",
      refChildId: appended?.childId ?? "",
      refStatus: appended?.status ?? "",
      trustedTitleProvenance: isTrustedChildTitleProvenance(
        appended?.titleProvenance,
      ),
      titleCarriesTask: (appended?.title ?? "").includes("Verify the change"),
    }).toEqual({
      spawnCount: 1,
      hasSessionDir: true,
      hasSessionPath: true,
      sessionFileInsideDir: true,
      sessionUnderRoot: true,
      noEphemeralFlag: false,
      headerType: "session",
      headerVersion: 3,
      headerParent: PARENT_SESSION,
      headerCwd: root,
      refSessionId: header.id ?? "",
      refChildId: CHILD_ID,
      refStatus: "running",
      trustedTitleProvenance: true,
      titleCarriesTask: false,
    });

    processPort.spawnedProcesses[0]?.exit(0);
    await settlement;
  });

  it("refuses before spawn when the native session store is absent", async () => {
    const processPort = new FakeChildProcessPort();
    const transport = transportWith({ processPort });

    const result = await transport(baseInput("/project"));

    expect({
      spawnCount: processPort.spawnInputs.length,
      failed: result.isErr(),
      code: result.isErr() ? result.error.code : undefined,
      leakedPath: JSON.stringify(result.isErr() ? result.error : {}).includes(
        "/",
      ),
    }).toEqual({
      spawnCount: 0,
      failed: true,
      code: "ChildSpawnFailed",
      leakedPath: false,
    });
  });

  it("refuses before spawn when the ref authority is absent", async () => {
    const store = new PiNativeSessionStore({
      launch: { mode: "read-only" },
      root,
      fs: createBunPiNativeSessionFs(),
      host: createPiNativeSessionHost(SessionManager),
    });
    const processPort = new FakeChildProcessPort();
    const transport = transportWith({ processPort, sessions: store });

    const result = await transport(baseInput(root));

    expect({
      spawnCount: processPort.spawnInputs.length,
      failed: result.isErr(),
      code: result.isErr() ? result.error.code : undefined,
    }).toEqual({ spawnCount: 0, failed: true, code: "ChildSpawnFailed" });
  });

  it("refuses before spawn when session creation fails", async () => {
    const processPort = new FakeChildProcessPort();
    const transport = transportWith({
      processPort,
      sessions: new FailingSessionPort("create"),
      refs: new RecordingRefPort(),
    });

    const result = await transport(baseInput("/project"));

    expect({
      spawnCount: processPort.spawnInputs.length,
      failed: result.isErr(),
      code: result.isErr() ? result.error.code : undefined,
    }).toEqual({ spawnCount: 0, failed: true, code: "ChildSpawnFailed" });
  });

  it("tombstones the unreachable session and never spawns when the thread leaf fails", async () => {
    const processPort = new FakeChildProcessPort();
    const sessions = new FailingSessionPort("leaf");
    const refs = new RecordingRefPort();
    const transport = transportWith({ processPort, sessions, refs });

    const result = await transport(baseInput("/project"));

    expect({
      spawnCount: processPort.spawnInputs.length,
      failed: result.isErr(),
      tombstoned: sessions.tombstones.length,
      refsWritten: refs.newChildren.length,
    }).toEqual({
      spawnCount: 0,
      failed: true,
      tombstoned: 1,
      refsWritten: 0,
    });
  });

  it("refuses before spawn when the parent session identity is unavailable", async () => {
    const store = new PiNativeSessionStore({
      launch: { mode: "read-only" },
      root,
      fs: createBunPiNativeSessionFs(),
      host: createPiNativeSessionHost(SessionManager),
    });
    const processPort = new FakeChildProcessPort();
    const transport = transportWith({
      processPort,
      sessions: store,
      refs: new RecordingRefPort(""),
    });

    const result = await transport(baseInput(root));

    expect({
      spawnCount: processPort.spawnInputs.length,
      failed: result.isErr(),
      code: result.isErr() ? result.error.code : undefined,
    }).toEqual({ spawnCount: 0, failed: true, code: "ChildSpawnFailed" });
  });

  it("rejects every non-launchable direct session selector before it can reach a spawn", () => {
    const grant = mintTestOnlyLaunchGrant(
      TEST_ONLY_GRANTED_SESSION_STORAGE_AUTHORITY,
      {
        childId: CHILD_ID,
        sessionDir: "/data/weave/adapters/pi/sessions/child",
        sessionPath:
          "/data/weave/adapters/pi/sessions/child/session.jsonl",
      },
    );
    const reasons = {
      absent: validateDirectNativeSession(CHILD_ID, undefined),
      ephemeral: validateDirectNativeSession(CHILD_ID, { mode: "ephemeral" }),
      valid: validateDirectNativeSession(CHILD_ID, { mode: "native", grant }),
    };

    expect({
      absent: reasons.absent.isErr(),
      ephemeral: reasons.ephemeral.isErr(),
      valid: reasons.valid.isOk(),
    }).toEqual({
      absent: true,
      ephemeral: true,
      valid: true,
    });
  });
});
