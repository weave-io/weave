/**
 * Production `children.delete` really deletes.
 *
 * Task 11 review blocker C: the CLI dispatch seam opened production ports in
 * `accessMode: "read"` for every action, and the production registry passed no
 * `sessionMutationGate`, so the one mutating route always failed closed as
 * unwired. Deletion could never dispatch in production.
 *
 * These tests pin the replacement contract: write access is selected only for
 * `children.delete`, the route is gated on the same proved Pi-native
 * session/root/process readiness activation uses, an unproved gate refuses with
 * a closed path-free reason, read routes stay read-only, and a proved deletion
 * actually removes the session file and tombstones the record.
 */

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { dispatchAdapterCommand } from "@weaveio/weave-engine";
import { okAsync } from "neverthrow";
import {
  PI_ADAPTER_COMMAND_NAMES,
  PI_ADAPTER_NAME,
} from "../adapter-cli-commands.js";
import {
  accessModeForAdapterAction,
  createProductionPiAdapterCommandRegistry,
  createProductionPorts,
  resolveProductionAdapterCliRegistry,
} from "../adapter-cli-production.js";
import {
  BunPiChildMetadataCacheFs,
  openPiChildMetadataCache,
  PI_CHILD_METADATA_CACHE_LAYOUT,
  resolvePiChildMetadataCacheRoot,
} from "../child-metadata-cache.js";
import {
  PiNativeSessionStore,
  resolvePiNativeSessionRoot,
} from "../child-native-sessions.js";
import { createNativeChildRefSourceAuthority } from "../child-session-refs.js";
import { PI_CHILD_TITLE_PROVENANCE } from "../child-title.js";
import { createBunPiNativeSessionFs } from "../native-session-fs.js";
import {
  createBlockedPiNativeSessionReadinessProbe,
  createReadyPiNativeSessionReadinessProbe,
} from "../native-session-readiness.js";
import {
  makeRealTempRoot,
  removeRealTempRoot,
} from "./fakes/real-temp-root.js";
import { createTestOnlyDescriptorSafeNativeSessionHost } from "./fakes/test-only-descriptor-safe-host.js";

const WORKSPACE = "/tmp/weave-workspace-delete";
const PARENT_SESSION = "weave-cli";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => removeRealTempRoot(root)));
});

async function tempXdg(): Promise<string> {
  const root = await makeRealTempRoot("weave-pi-delete");
  roots.push(root);
  return root;
}

/**
 * Seeds one real native child session inside the canonical private root the
 * production ports will resolve, then registers it in the production cache so
 * `children.delete` has a real record and a real session file to remove.
 */
type SeededChildStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "tombstoned";

async function seedChild(
  xdg: string,
  childId: string,
  status: SeededChildStatus = "completed",
): Promise<{ readonly sessionPath: string; readonly sessionRef: string }> {
  const root = (
    await resolvePiNativeSessionRoot({
      env: { XDG_DATA_HOME: xdg, HOME: xdg },
      homeDir: xdg,
    })
  )._unsafeUnwrap();
  const store = new PiNativeSessionStore({
    root,
    fs: createBunPiNativeSessionFs(),
    host: createTestOnlyDescriptorSafeNativeSessionHost(SessionManager),
  });
  const record = (
    await store.createChildSession({
      childId,
      parentSession: PARENT_SESSION,
      cwd: xdg,
    })
  )._unsafeUnwrap();
  (
    await store.establishThreadLeaf(
      record.ref,
      {
        threadId: childId,
        agentName: "shuttle-mini",
        parentId: "root",
        parentAgentName: "loom",
        parentDepth: 0,
        ownerParentSessionId: PARENT_SESSION,
        cwd: xdg,
        createdAt: 1_700_000_000_000,
      },
      PARENT_SESSION,
    )
  )._unsafeUnwrap();

  // Register the seeded session in the production cache the same way the
  // adapter does at runtime: from an authoritative ref record, never invented
  // from a path.
  const cacheRoot = (
    await resolvePiChildMetadataCacheRoot({
      env: { XDG_DATA_HOME: xdg, HOME: xdg },
      homeDir: xdg,
    })
  )._unsafeUnwrap();
  const opened = (
    await openPiChildMetadataCache({
      root: cacheRoot,
      fs: new BunPiChildMetadataCacheFs(),
      authority: createNativeChildRefSourceAuthority(store),
      source: {
        workspaceKey: WORKSPACE,
        parentSessionId: PARENT_SESSION,
        readRefs: () => okAsync([]),
      },
    })
  )._unsafeUnwrap();
  if (opened.mode !== "active") throw new Error("cache degraded while seeding");
  opened.cache
    .upsertRef(
      {
        childId,
        threadId: childId,
        nativeSessionId: record.sessionId,
        sessionRef: record.ref,
        originParentSessionId: PARENT_SESSION,
        originEntryId: `entry-${childId}`,
        title: "shuttle-mini",
        titleProvenance: PI_CHILD_TITLE_PROVENANCE,
        status,
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_000_000,
        runs: [],
      },
      WORKSPACE,
    )
    ._unsafeUnwrap();

  return { sessionPath: record.path, sessionRef: record.ref };
}

describe("production children.delete is readiness-gated and really dispatches", () => {
  it("selects write access only for the mutating route", () => {
    expect({
      delete: accessModeForAdapterAction("children.delete"),
      list: accessModeForAdapterAction("children.list"),
      show: accessModeForAdapterAction("children.show"),
      resolve: accessModeForAdapterAction("children.resolve"),
      doctor: accessModeForAdapterAction("doctor"),
      unknown: accessModeForAdapterAction("children.delete.extra"),
    }).toEqual({
      delete: "write",
      list: "read",
      show: "read",
      resolve: "read",
      doctor: "read",
      unknown: "read",
    });
  });

  it("refuses deletion with a closed reason when native readiness is unproven", async () => {
    const xdg = await tempXdg();
    const portOptions = {
      workspaceKey: WORKSPACE,
      env: { XDG_DATA_HOME: xdg, HOME: xdg },
      homeDir: xdg,
      SessionManager,
      accessMode: "write" as const,
      readinessProbe: createBlockedPiNativeSessionReadinessProbe(
        "pi-session-root-unsafe",
      ),
    };
    const ports = (await createProductionPorts(portOptions))._unsafeUnwrap();
    const gate = ports.sessionMutationGate.evaluate();
    const registry = (
      await createProductionPiAdapterCommandRegistry(portOptions)
    )._unsafeUnwrap();

    const attempted = await dispatchAdapterCommand(registry, {
      adapter: PI_ADAPTER_NAME,
      command: PI_ADAPTER_COMMAND_NAMES.childrenDelete,
      payloadJson: JSON.stringify({
        workspaceKey: WORKSPACE,
        childId: "child-1",
        parentSessionId: PARENT_SESSION,
        confirmed: true,
      }),
    });
    const rendered = attempted.isErr()
      ? JSON.stringify(attempted.error)
      : "unexpected-success";
    const gateRendered = gate.isErr() ? JSON.stringify(gate.error) : "";

    expect({
      gateRefused: gate.isErr(),
      // The gate carries the readiness class verbatim, drawn from the closed
      // readiness reason set and nothing else.
      gateNamesClosedReason: gateRendered.includes("pi-session-root-unsafe"),
      gateLeakedPath: gateRendered.includes(xdg),
      refused: attempted.isErr(),
      namesCapability: rendered.includes("delegated-specialist-execution"),
      leakedXdgPath: rendered.includes(xdg),
    }).toEqual({
      gateRefused: true,
      gateNamesClosedReason: true,
      gateLeakedPath: false,
      refused: true,
      namesCapability: true,
      leakedXdgPath: false,
    });
  });

  it("opens no writable cache database when readiness is unproven", async () => {
    const xdg = await tempXdg();
    const cacheRoot = (
      await resolvePiChildMetadataCacheRoot({
        env: { XDG_DATA_HOME: xdg, HOME: xdg },
        homeDir: xdg,
      })
    )._unsafeUnwrap();
    const databasePath = join(
      cacheRoot,
      PI_CHILD_METADATA_CACHE_LAYOUT.databaseFile,
    );

    const ports = (
      await createProductionPorts({
        workspaceKey: WORKSPACE,
        env: { XDG_DATA_HOME: xdg, HOME: xdg },
        homeDir: xdg,
        SessionManager,
        accessMode: "write" as const,
        readinessProbe: createBlockedPiNativeSessionReadinessProbe(
          "pi-process-unavailable",
        ),
      })
    )._unsafeUnwrap();

    // The gate is consulted before any writable cache/database effect, so a
    // denied write route leaves the cache root and database absent.
    expect({
      gateRefused: ports.sessionMutationGate.evaluate().isErr(),
      cacheMode: ports.cacheMode,
      databaseCreated: await Bun.file(databasePath).exists(),
      cacheRootCreated: existsSync(cacheRoot),
      deleteRefused: (
        await ports.children.delete({
          workspaceKey: WORKSPACE,
          childId: "child-1",
          parentSessionId: PARENT_SESSION,
          confirmed: true,
        })
      ).isErr(),
    }).toEqual({
      gateRefused: true,
      cacheMode: "degraded",
      databaseCreated: false,
      cacheRootCreated: false,
      deleteRefused: true,
    });
  });

  it("refuses deletion through a read-only route even when readiness is proved", async () => {
    const xdg = await tempXdg();
    const registry = (
      await resolveProductionAdapterCliRegistry({
        action: "children.list",
        workspaceKey: WORKSPACE,
        env: { XDG_DATA_HOME: xdg, HOME: xdg },
        homeDir: xdg,
        SessionManager,
        readinessProbe: createReadyPiNativeSessionReadinessProbe(),
      })
    )._unsafeUnwrap();

    const attempted = await dispatchAdapterCommand(registry, {
      adapter: PI_ADAPTER_NAME,
      command: PI_ADAPTER_COMMAND_NAMES.childrenDelete,
      payloadJson: JSON.stringify({
        workspaceKey: WORKSPACE,
        childId: "child-1",
        parentSessionId: PARENT_SESSION,
        confirmed: true,
      }),
    });

    expect({
      refused: attempted.isErr(),
      leakedXdgPath: JSON.stringify(
        attempted.isErr() ? attempted.error : {},
      ).includes(xdg),
    }).toEqual({ refused: true, leakedXdgPath: false });
  });

  it("keeps read routes dispatchable while the mutating route is gated", async () => {
    const xdg = await tempXdg();
    const registry = (
      await resolveProductionAdapterCliRegistry({
        action: "children.list",
        workspaceKey: WORKSPACE,
        env: { XDG_DATA_HOME: xdg, HOME: xdg },
        homeDir: xdg,
        SessionManager,
      })
    )._unsafeUnwrap();

    const listed = await dispatchAdapterCommand(registry, {
      adapter: PI_ADAPTER_NAME,
      command: PI_ADAPTER_COMMAND_NAMES.childrenList,
      payloadJson: JSON.stringify({ workspaceKey: WORKSPACE }),
    });

    expect(listed.isOk()).toBe(true);
  });

  it("dispatches a real deletion that removes the session file and tombstones the record", async () => {
    const xdg = await tempXdg();
    const seeded = await seedChild(xdg, "child-delete-1");
    const existedBefore = await Bun.file(seeded.sessionPath).exists();

    const registry = (
      await resolveProductionAdapterCliRegistry({
        action: "children.delete",
        workspaceKey: WORKSPACE,
        env: { XDG_DATA_HOME: xdg, HOME: xdg },
        homeDir: xdg,
        SessionManager,
        readinessProbe: createReadyPiNativeSessionReadinessProbe(),
      })
    )._unsafeUnwrap();

    const deleted = await dispatchAdapterCommand(registry, {
      adapter: PI_ADAPTER_NAME,
      command: PI_ADAPTER_COMMAND_NAMES.childrenDelete,
      payloadJson: JSON.stringify({
        workspaceKey: WORKSPACE,
        childId: "child-delete-1",
        parentSessionId: PARENT_SESSION,
        confirmed: true,
      }),
    });
    const body = deleted.isOk()
      ? (JSON.parse(deleted.value.resultJson) as {
          kind?: string;
          childId?: string;
          tombstoned?: boolean;
        })
      : undefined;
    const existsAfter = await Bun.file(seeded.sessionPath).exists();
    // The tombstone is appended beside the session, never rewritten in place.
    const tombstoneFile = join(
      seeded.sessionPath.slice(0, seeded.sessionPath.lastIndexOf("/child")),
      "tombstones.jsonl",
    );
    const tombstoneText = (await Bun.file(tombstoneFile).exists())
      ? await Bun.file(tombstoneFile).text()
      : "";
    const rendered = deleted.isOk() ? deleted.value.resultJson : "";

    expect({
      existedBefore,
      dispatched: deleted.isOk(),
      kind: body?.kind,
      childId: body?.childId,
      tombstoned: body?.tombstoned,
      sessionFileRemoved: !existsAfter,
      tombstoneRecordsChild: tombstoneText.includes("child-delete-1"),
      // No operator-visible surface names a filesystem location.
      leakedXdgPath: rendered.includes(xdg),
    }).toEqual({
      existedBefore: true,
      dispatched: true,
      kind: "children.delete",
      childId: "child-delete-1",
      tombstoned: true,
      sessionFileRemoved: true,
      tombstoneRecordsChild: true,
      leakedXdgPath: false,
    });
  });

  it("refuses an unconfirmed deletion after the gate passes", async () => {
    const xdg = await tempXdg();
    await seedChild(xdg, "child-delete-2");

    const registry = (
      await resolveProductionAdapterCliRegistry({
        action: "children.delete",
        workspaceKey: WORKSPACE,
        env: { XDG_DATA_HOME: xdg, HOME: xdg },
        homeDir: xdg,
        SessionManager,
        readinessProbe: createReadyPiNativeSessionReadinessProbe(),
      })
    )._unsafeUnwrap();

    const attempted = await dispatchAdapterCommand(registry, {
      adapter: PI_ADAPTER_NAME,
      command: PI_ADAPTER_COMMAND_NAMES.childrenDelete,
      payloadJson: JSON.stringify({
        workspaceKey: WORKSPACE,
        childId: "child-delete-2",
        parentSessionId: PARENT_SESSION,
        confirmed: false,
      }),
    });

    expect(attempted.isErr()).toBe(true);
  });

  it("never resurrects authority for a child that was already deleted", async () => {
    const xdg = await tempXdg();
    const seeded = await seedChild(xdg, "child-delete-3");

    const registry = (
      await resolveProductionAdapterCliRegistry({
        action: "children.delete",
        workspaceKey: WORKSPACE,
        env: { XDG_DATA_HOME: xdg, HOME: xdg },
        homeDir: xdg,
        SessionManager,
        readinessProbe: createReadyPiNativeSessionReadinessProbe(),
      })
    )._unsafeUnwrap();
    const payloadJson = JSON.stringify({
      workspaceKey: WORKSPACE,
      childId: "child-delete-3",
      parentSessionId: PARENT_SESSION,
      confirmed: true,
    });

    const first = await dispatchAdapterCommand(registry, {
      adapter: PI_ADAPTER_NAME,
      command: PI_ADAPTER_COMMAND_NAMES.childrenDelete,
      payloadJson,
    });
    const second = await dispatchAdapterCommand(registry, {
      adapter: PI_ADAPTER_NAME,
      command: PI_ADAPTER_COMMAND_NAMES.childrenDelete,
      payloadJson,
    });

    expect({
      firstDispatched: first.isOk(),
      secondRefused: second.isErr(),
      sessionStillAbsent: !(await Bun.file(seeded.sessionPath).exists()),
      leakedXdgPath: JSON.stringify(
        second.isErr() ? second.error : {},
      ).includes(xdg),
    }).toEqual({
      firstDispatched: true,
      secondRefused: true,
      sessionStillAbsent: true,
      leakedXdgPath: false,
    });
  });

  it("refuses queued and running children with zero writable effects", async () => {
    const xdg = await tempXdg();
    const queued = await seedChild(xdg, "child-queued", "queued");
    const running = await seedChild(xdg, "child-running", "running");
    const other = await seedChild(xdg, "child-other", "completed");
    const cacheRoot = (
      await resolvePiChildMetadataCacheRoot({
        env: { XDG_DATA_HOME: xdg, HOME: xdg },
        homeDir: xdg,
      })
    )._unsafeUnwrap();
    const databasePath = join(
      cacheRoot,
      PI_CHILD_METADATA_CACHE_LAYOUT.databaseFile,
    );
    const cacheBytesBefore = await Bun.file(databasePath).arrayBuffer();
    const tombstoneFile = join(
      queued.sessionPath.slice(0, queued.sessionPath.lastIndexOf("/child")),
      "tombstones.jsonl",
    );
    const tombstoneBefore = (await Bun.file(tombstoneFile).exists())
      ? await Bun.file(tombstoneFile).text()
      : "";

    const registry = (
      await resolveProductionAdapterCliRegistry({
        action: "children.delete",
        workspaceKey: WORKSPACE,
        env: { XDG_DATA_HOME: xdg, HOME: xdg },
        homeDir: xdg,
        SessionManager,
        readinessProbe: createReadyPiNativeSessionReadinessProbe(),
      })
    )._unsafeUnwrap();

    const queuedAttempt = await dispatchAdapterCommand(registry, {
      adapter: PI_ADAPTER_NAME,
      command: PI_ADAPTER_COMMAND_NAMES.childrenDelete,
      payloadJson: JSON.stringify({
        workspaceKey: WORKSPACE,
        childId: "child-queued",
        parentSessionId: PARENT_SESSION,
        confirmed: true,
      }),
    });
    const runningAttempt = await dispatchAdapterCommand(registry, {
      adapter: PI_ADAPTER_NAME,
      command: PI_ADAPTER_COMMAND_NAMES.childrenDelete,
      payloadJson: JSON.stringify({
        workspaceKey: WORKSPACE,
        childId: "child-running",
        parentSessionId: PARENT_SESSION,
        confirmed: true,
      }),
    });
    const queuedRendered = queuedAttempt.isErr()
      ? JSON.stringify(queuedAttempt.error)
      : "unexpected-success";
    const runningRendered = runningAttempt.isErr()
      ? JSON.stringify(runningAttempt.error)
      : "unexpected-success";
    const cacheBytesAfter = await Bun.file(databasePath).arrayBuffer();
    const tombstoneAfter = (await Bun.file(tombstoneFile).exists())
      ? await Bun.file(tombstoneFile).text()
      : "";

    expect({
      queuedRefused: queuedAttempt.isErr(),
      queuedConflict: queuedRendered.includes("child-not-terminal:queued"),
      runningRefused: runningAttempt.isErr(),
      runningConflict: runningRendered.includes("child-not-terminal:running"),
      queuedSessionIntact: await Bun.file(queued.sessionPath).exists(),
      runningSessionIntact: await Bun.file(running.sessionPath).exists(),
      otherSessionIntact: await Bun.file(other.sessionPath).exists(),
      cacheUnchanged: Buffer.from(cacheBytesBefore).equals(
        Buffer.from(cacheBytesAfter),
      ),
      tombstoneUnchanged: tombstoneAfter === tombstoneBefore,
      leakedXdgPath:
        queuedRendered.includes(xdg) || runningRendered.includes(xdg),
    }).toEqual({
      queuedRefused: true,
      queuedConflict: true,
      runningRefused: true,
      runningConflict: true,
      queuedSessionIntact: true,
      runningSessionIntact: true,
      otherSessionIntact: true,
      cacheUnchanged: true,
      tombstoneUnchanged: true,
      leakedXdgPath: false,
    });
  });

  it("still deletes completed, failed, and cancelled children", async () => {
    const xdg = await tempXdg();
    const completed = await seedChild(xdg, "child-completed", "completed");
    const failed = await seedChild(xdg, "child-failed", "failed");
    const cancelled = await seedChild(xdg, "child-cancelled", "cancelled");

    const registry = (
      await resolveProductionAdapterCliRegistry({
        action: "children.delete",
        workspaceKey: WORKSPACE,
        env: { XDG_DATA_HOME: xdg, HOME: xdg },
        homeDir: xdg,
        SessionManager,
        readinessProbe: createReadyPiNativeSessionReadinessProbe(),
      })
    )._unsafeUnwrap();

    const results = await Promise.all(
      ["child-completed", "child-failed", "child-cancelled"].map((childId) =>
        dispatchAdapterCommand(registry, {
          adapter: PI_ADAPTER_NAME,
          command: PI_ADAPTER_COMMAND_NAMES.childrenDelete,
          payloadJson: JSON.stringify({
            workspaceKey: WORKSPACE,
            childId,
            parentSessionId: PARENT_SESSION,
            confirmed: true,
          }),
        }),
      ),
    );
    const bodies = results.map((result) =>
      result.isOk()
        ? (JSON.parse(result.value.resultJson) as {
            kind?: string;
            childId?: string;
            tombstoned?: boolean;
          })
        : undefined,
    );
    const rendered = results
      .map((result) => (result.isOk() ? result.value.resultJson : ""))
      .join("");

    expect({
      completed: {
        dispatched: results[0]?.isOk() === true,
        kind: bodies[0]?.kind,
        childId: bodies[0]?.childId,
        tombstoned: bodies[0]?.tombstoned,
        sessionRemoved: !(await Bun.file(completed.sessionPath).exists()),
      },
      failed: {
        dispatched: results[1]?.isOk() === true,
        kind: bodies[1]?.kind,
        childId: bodies[1]?.childId,
        tombstoned: bodies[1]?.tombstoned,
        sessionRemoved: !(await Bun.file(failed.sessionPath).exists()),
      },
      cancelled: {
        dispatched: results[2]?.isOk() === true,
        kind: bodies[2]?.kind,
        childId: bodies[2]?.childId,
        tombstoned: bodies[2]?.tombstoned,
        sessionRemoved: !(await Bun.file(cancelled.sessionPath).exists()),
      },
      leakedXdgPath: rendered.includes(xdg),
    }).toEqual({
      completed: {
        dispatched: true,
        kind: "children.delete",
        childId: "child-completed",
        tombstoned: true,
        sessionRemoved: true,
      },
      failed: {
        dispatched: true,
        kind: "children.delete",
        childId: "child-failed",
        tombstoned: true,
        sessionRemoved: true,
      },
      cancelled: {
        dispatched: true,
        kind: "children.delete",
        childId: "child-cancelled",
        tombstoned: true,
        sessionRemoved: true,
      },
      leakedXdgPath: false,
    });
  });

  it("refuses malformed and already-tombstoned children without mutating them", async () => {
    const xdg = await tempXdg();
    const tombstoned = await seedChild(xdg, "child-tombstoned", "tombstoned");
    const malformed = await seedChild(xdg, "child-malformed", "completed");
    const cacheRoot = (
      await resolvePiChildMetadataCacheRoot({
        env: { XDG_DATA_HOME: xdg, HOME: xdg },
        homeDir: xdg,
      })
    )._unsafeUnwrap();
    const database = new Database(
      join(cacheRoot, PI_CHILD_METADATA_CACHE_LAYOUT.databaseFile),
    );
    database
      .query(
        "UPDATE children SET status = ? WHERE workspace_key = ? AND child_id = ?",
      )
      .run("not-a-status", WORKSPACE, "child-malformed");
    database.close();
    const databasePath = join(
      cacheRoot,
      PI_CHILD_METADATA_CACHE_LAYOUT.databaseFile,
    );
    const cacheBytesBefore = await Bun.file(databasePath).arrayBuffer();
    const tombstoneFile = join(
      malformed.sessionPath.slice(
        0,
        malformed.sessionPath.lastIndexOf("/child"),
      ),
      "tombstones.jsonl",
    );
    const tombstoneBefore = (await Bun.file(tombstoneFile).exists())
      ? await Bun.file(tombstoneFile).text()
      : "";

    const registry = (
      await resolveProductionAdapterCliRegistry({
        action: "children.delete",
        workspaceKey: WORKSPACE,
        env: { XDG_DATA_HOME: xdg, HOME: xdg },
        homeDir: xdg,
        SessionManager,
        readinessProbe: createReadyPiNativeSessionReadinessProbe(),
      })
    )._unsafeUnwrap();

    const tombstonedAttempt = await dispatchAdapterCommand(registry, {
      adapter: PI_ADAPTER_NAME,
      command: PI_ADAPTER_COMMAND_NAMES.childrenDelete,
      payloadJson: JSON.stringify({
        workspaceKey: WORKSPACE,
        childId: "child-tombstoned",
        parentSessionId: PARENT_SESSION,
        confirmed: true,
      }),
    });
    const malformedAttempt = await dispatchAdapterCommand(registry, {
      adapter: PI_ADAPTER_NAME,
      command: PI_ADAPTER_COMMAND_NAMES.childrenDelete,
      payloadJson: JSON.stringify({
        workspaceKey: WORKSPACE,
        childId: "child-malformed",
        parentSessionId: PARENT_SESSION,
        confirmed: true,
      }),
    });
    const tombstonedRendered = tombstonedAttempt.isErr()
      ? JSON.stringify(tombstonedAttempt.error)
      : "unexpected-success";
    const malformedRendered = malformedAttempt.isErr()
      ? JSON.stringify(malformedAttempt.error)
      : "unexpected-success";
    const cacheBytesAfter = await Bun.file(databasePath).arrayBuffer();
    const tombstoneAfter = (await Bun.file(tombstoneFile).exists())
      ? await Bun.file(tombstoneFile).text()
      : "";

    expect({
      tombstonedRefused: tombstonedAttempt.isErr(),
      tombstonedConflict: tombstonedRendered.includes(
        "child-already-tombstoned",
      ),
      malformedRefused: malformedAttempt.isErr(),
      malformedConflict: malformedRendered.includes(
        "Unavailable: CacheRecordInvalid",
      ),
      tombstonedSessionIntact: await Bun.file(tombstoned.sessionPath).exists(),
      malformedSessionIntact: await Bun.file(malformed.sessionPath).exists(),
      cacheUnchanged: Buffer.from(cacheBytesBefore).equals(
        Buffer.from(cacheBytesAfter),
      ),
      tombstoneUnchanged: tombstoneAfter === tombstoneBefore,
      leakedXdgPath:
        tombstonedRendered.includes(xdg) || malformedRendered.includes(xdg),
    }).toEqual({
      tombstonedRefused: true,
      tombstonedConflict: true,
      malformedRefused: true,
      malformedConflict: true,
      tombstonedSessionIntact: true,
      malformedSessionIntact: true,
      cacheUnchanged: true,
      tombstoneUnchanged: true,
      leakedXdgPath: false,
    });
  });
});
