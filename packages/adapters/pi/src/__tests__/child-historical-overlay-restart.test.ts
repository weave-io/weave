import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  ALL_CAPABILITY_IDS,
  createInMemoryRuntimeStore,
} from "@weaveio/weave-engine";
import { $ } from "bun";
import { ok, okAsync } from "neverthrow";
import { PiNativeSessionStore } from "../child-native-sessions.js";
import { CHILD_OVERLAY_BOUNDS } from "../child-overlay-types.js";
import {
  createNativeChildRefSourceAuthority,
  PI_CHILD_REF_BOUNDS,
  PiChildSessionRefStore,
} from "../child-session-refs.js";
import { PiConfigActivator } from "../config-activator.js";
import { createPiExtension } from "../extension.js";
import { HOST_PACKAGE_NAME } from "../host-compatibility.js";
import { PI_HOST_SURFACE_IDS } from "../host-inventory.js";
import { createBunPiNativeSessionFs } from "../native-session-fs.js";
import { FakePathContainmentPort } from "../path-containment.js";
import {
  openPiThreadSources,
  type PiThreadSourceFactoryInput,
} from "../thread-sources.js";
import { FakeHostPackageReader } from "./fakes/fake-host-package-reader.js";
import {
  FakeClock,
  FakeIdGenerator,
  RecordingFakePiHost,
  RecordingLogger,
} from "./fakes/fake-pi-host.js";
import { createTestOnlyDescriptorSafeNativeSessionHost } from "./fakes/test-only-descriptor-safe-host.js";

const PARENT = "parent-session-hist-1";
const CHILD = "hist-child-1";

const EMPTY_CONFIG = {
  agents: {},
  disabled: { agents: [], skills: [] },
} as never;

function loomDescriptor() {
  return {
    name: "loom",
    composedPrompt: "You are Loom.",
    models: ["claude-sonnet-4-5"],
    mode: "primary" as const,
    effectiveToolPolicy: {
      read: "allow" as const,
      write: "allow" as const,
      execute: "allow" as const,
      delegate: "allow" as const,
      network: "ask" as const,
    },
    rawToolPolicy: undefined,
    delegationTargets: [],
    skills: [],
  };
}

async function flushBackgroundWork(ticks = 40): Promise<void> {
  for (let index = 0; index < ticks; index += 1) {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/**
 * Extension-boundary coverage for Spec 33 Task 20 item (c): a settled child
 * whose native session and parent ref ledger are real files on disk opens in
 * the native overlay after the parent generation restarts, not in the
 * custom-editor fallback.
 *
 * This is **not** a regression test for the live blocker
 * `historical_selection_activated_custom_editor_fallback_instead_of_native_overlay`.
 * It passes on the pre-change baseline as well, so it does not reproduce that
 * failure and must not be cited as proof that the failure is fixed. It exists
 * to pin the boundary that is known to work offline: picker resolution, page
 * read, native mount, bounded newest page, and read-only rendering. The live
 * cause is instead instrumented through the bounded overlay fallback reason
 * codes reported to `/weave:health`.
 */
describe("createPiExtension: historical native overlay after a parent restart", () => {
  let root = "";
  beforeEach(async () => {
    root = (await $`mktemp -d /private/tmp/weave-hist-XXXXXX`.text()).trim();
  });
  afterEach(async () => {
    if (root.length > 0) await $`rm -rf ${root}`.quiet();
  });

  /**
   * Opens the picker for one persisted settled child after a parent restart
   * and selects it. The child's ref `title` is the only variable: it is the
   * exact field that decided native mount versus custom-editor fallback.
   */
  async function openHistoricalChildAfterRestart(title: string): Promise<{
    readonly host: RecordingFakePiHost;
    readonly customBefore: number;
    readonly editorCallsBefore: number;
    readonly editorOwnerBefore: unknown;
  }> {
    const fs = createBunPiNativeSessionFs();
    const nativeHost =
      createTestOnlyDescriptorSafeNativeSessionHost(SessionManager);
    const store = new PiNativeSessionStore({
      root: `${root}/sessions`,
      fs,
      host: nativeHost,
    });
    const created = (
      await store.createChildSession({
        childId: CHILD,
        parentSession: PARENT,
        cwd: root,
      })
    )._unsafeUnwrap();
    const directory = (
      await fs.openDirectory(`${root}/sessions/${CHILD}`, false)
    )._unsafeUnwrap();
    const fileName = created.ref.slice(created.ref.lastIndexOf("/") + 1);
    const lines: string[] = [];
    for (let index = 0; index < 69; index += 1) {
      lines.push(
        `${JSON.stringify({
          type: "message",
          id: `entry-${index}`,
          parentId: index === 0 ? null : `entry-${index - 1}`,
          timestamp: new Date(1_700_000_000_000 + index).toISOString(),
          message: {
            role: "assistant",
            content: [{ type: "text", text: `body-${index}` }],
          },
        })}\n`,
      );
    }
    (
      await directory.appendFile(
        fileName,
        new TextEncoder().encode(lines.join("")),
        0o600,
      )
    )._unsafeUnwrap();

    // Durable parent ref ledger, written before the "restart".
    const parentEntries: { type: string; data: unknown }[] = [];
    const seedRefs = new PiChildSessionRefStore({
      parentSessionId: PARENT,
      append: {
        appendEntry: (type, data) => {
          parentEntries.push({ type, data });
        },
      },
      read: { getEntries: () => parentEntries },
      authority: createNativeChildRefSourceAuthority(store),
    });
    const seeded = (
      await seedRefs.appendNewChild({
        childId: CHILD,
        nativeSessionId: created.sessionId,
        sessionRef: created.ref,
        title,
        status: "running",
      })
    )._unsafeUnwrap();
    (
      await seedRefs.appendLifecycle(seeded, { status: "completed" })
    )._unsafeUnwrap();

    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    host.setSessionManager({
      getSessionId: () => PARENT,
      getSessionFile: () => `${root}/parent.jsonl`,
      isPersisted: () => true,
      getEntries: () => parentEntries,
    } as never);
    host.effectiveKeybindingConfig = {};

    const factory = createPiExtension({
      hostPackageReader: FakeHostPackageReader.ok({
        name: HOST_PACKAGE_NAME,
        version: "0.83.0",
      }),
      capabilityProber: {
        probe: () =>
          ALL_CAPABILITY_IDS.map((capabilityId) => ({
            capabilityId,
            probeStatus: "ok" as const,
          })),
      },
      idGenerator: new FakeIdGenerator(),
      clock: new FakeClock(),
      logger: new RecordingLogger(),
      configActivator: new PiConfigActivator({
        configLoader: { load: () => okAsync(EMPTY_CONFIG) },
        materializer: {
          materialize: () =>
            okAsync({
              agents: [
                {
                  agentName: "loom",
                  source: "explicit" as const,
                  descriptor: loomDescriptor(),
                },
              ],
              errors: [],
            }),
        },
      } as never),
      pathContainmentPort: new FakePathContainmentPort(
        new Map(),
        ok("/fake/project"),
      ),
      hostSurfaceReader: {
        read: () =>
          okAsync(
            PI_HOST_SURFACE_IDS.map((surfaceId) => ({
              surfaceId,
              status: "native" as const,
              details: `test-${surfaceId}`,
            })),
          ),
      },
      runtimeStoreFactory: {
        open: () => okAsync(createInMemoryRuntimeStore()),
      },
      parentSessionId: () => PARENT,
      threadSourceFactory: (input: PiThreadSourceFactoryInput) =>
        openPiThreadSources({
          ...input,
          sessionRoot: `${root}/sessions`,
          fs,
          host: nativeHost,
          cacheRoot: `${root}/cache`,
        }),
      hostKeybindings: () => host.hostKeybindingsForTest(),
    } as never);
    factory(host.api);

    // Generation 1, then a restart: a second session start replaces it.
    await host.triggerSessionStart();
    await flushBackgroundWork();
    await host.triggerSessionStart();
    await flushBackgroundWork();

    const customBefore = host.customCalls.length;
    const editorCallsBefore = host.editorFactoryCalls.length;
    const editorOwnerBefore = host.getEditorComponentForTest();
    const deferred = host.deferNextSelect();
    void host.invokeCommand("weave:inspect");
    await flushBackgroundWork();

    const labels = host.selectCalls.at(-1)?.options ?? [];
    const label = labels.find((option) => option.startsWith("history: "));
    expect(label).toBeDefined();
    deferred.settle(label);
    await flushBackgroundWork();

    return { host, customBefore, editorCallsBefore, editorOwnerBefore };
  }

  it("mounts the native overlay for a persisted settled child selected after a restart", async () => {
    const { host, customBefore, editorCallsBefore, editorOwnerBefore } =
      await openHistoricalChildAfterRestart("loom");

    // The native overlay mounts through ui.custom and never borrows the
    // session editor; the custom-editor fallback always calls
    // setEditorComponent, so an unchanged editor owner proves the native path.
    expect(host.customCalls.length - customBefore).toBe(1);
    expect(host.editorFactoryCalls.length).toBe(editorCallsBefore);
    expect(host.getEditorComponentForTest()).toBe(editorOwnerBefore);

    const rendered = host.customRenderedLines.at(-1)?.join("\n") ?? "";
    expect(rendered).toContain("SETTLED");
    expect(rendered).toContain("Read-only");
    // Bounded newest page: the newest entries are present, the oldest are not.
    expect(rendered).toContain("body-68");
    expect(rendered).not.toContain("body-0 ");
    expect(rendered).not.toContain(root);
    expect(rendered).not.toContain("/Users/");

    // Escape leaves the overlay and never submits to the parent session.
    host.inputCustom("\u001b");
    host.finishCustom();
    await flushBackgroundWork();
    expect(host.getEditorComponentForTest()).toBe(editorOwnerBefore);
    expect(host.sentUserMessages).toEqual([]);
  });

  /**
   * Regression for the Task 20(c) live failure. A real ref title is derived
   * from the delegated task and is bounded by the ref store at
   * `PI_CHILD_REF_BOUNDS.maxTitleLength`; the durable proof fixture carried a
   * title of exactly that length. The overlay descriptor schema used to cap
   * `title` at the shorter run-divider label bound, so `open` rejected the
   * described child with `OverlayInvalidChild` and the selection landed in the
   * custom-editor fallback with the opaque `open-failed` code.
   */
  it("mounts the native overlay for a title at the persisted ref title bound", async () => {
    const title = "t".repeat(PI_CHILD_REF_BOUNDS.maxTitleLength);
    const { host, customBefore, editorCallsBefore, editorOwnerBefore } =
      await openHistoricalChildAfterRestart(title);

    // Native mount: ui.custom ran once and the primary editor never changed
    // owner, which the custom-editor fallback could not leave untouched.
    expect(host.customCalls.length - customBefore).toBe(1);
    expect(host.editorFactoryCalls.length).toBe(editorCallsBefore);
    expect(host.getEditorComponentForTest()).toBe(editorOwnerBefore);

    const rendered = host.customRenderedLines.at(-1)?.join("\n") ?? "";
    expect(rendered).toContain("SETTLED");
    expect(rendered).toContain("Read-only");
    expect(rendered).toContain("body-68");

    host.inputCustom("\u001b");
    host.finishCustom();
    await flushBackgroundWork();
    expect(host.getEditorComponentForTest()).toBe(editorOwnerBefore);
    expect(host.sentUserMessages).toEqual([]);
  });

  it("admits exactly the title length the ref store persists", () => {
    // The overlay descriptor validates an already-validated persisted title;
    // a narrower bound here can only reject real data.
    expect(CHILD_OVERLAY_BOUNDS.maxTitleLength).toBe(
      PI_CHILD_REF_BOUNDS.maxTitleLength,
    );
  });
});
