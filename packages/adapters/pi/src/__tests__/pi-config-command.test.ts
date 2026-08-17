/**
 * `/weave:pi-config` at the command boundary: registration, classification,
 * palette exposure, and every path that refuses to open the overlay.
 *
 * The overlay's own model, rendering, and payload rules are proven in
 * `pi-config-ui.test.ts`. This file only proves the wiring around it, against
 * the fake Pi host - no real harness, no real filesystem, no real store.
 */
import { describe, expect, it } from "bun:test";
import {
  type AgentDescriptor,
  ALL_CAPABILITY_IDS,
  createInMemoryRuntimeStore,
  type RuntimeStore,
} from "@weaveio/weave-engine";
import { errAsync, ok, okAsync } from "neverthrow";
import {
  CHILD_EXTENSION_SELECTION_KEY,
  PI_PREFERENCE_NAMESPACE,
} from "../child-extension-selection.js";
import {
  classifyWeaveCommand,
  WEAVE_COMMAND_NAMES,
  WEAVE_PI_CONFIG_COMMAND_NAME,
} from "../commands.js";
import { createPiExtension, type PiExtensionDeps } from "../extension-impl.js";
import { HOST_PACKAGE_NAME } from "../host-compatibility.js";
import {
  PI_HOST_SURFACE_IDS,
  type PiHostSurfaceReader,
} from "../host-inventory.js";
import { FakePathContainmentPort } from "../path-containment.js";
import type {
  PiExtensionInventory,
  PiExtensionInventoryEntry,
} from "../pi-extension-inventory.js";
import { buildPaletteActions } from "../workflow-commands.js";
import { FakeHostPackageReader } from "./fakes/fake-host-package-reader.js";
import {
  FakeClock,
  FakeIdGenerator,
  fakeConfigActivator,
  RecordingFakePiHost,
  RecordingLogger,
} from "./fakes/fake-pi-host.js";
import { TEST_ONLY_GRANTED_SESSION_STORAGE_AUTHORITY } from "./fakes/test-only-session-storage-authority.js";

function allNativeHostSurfaceReader(): PiHostSurfaceReader {
  return {
    read: () =>
      okAsync(
        PI_HOST_SURFACE_IDS.map((surfaceId) => ({
          surfaceId,
          status: "native" as const,
          details: `test-${surfaceId}`,
        })),
      ),
  };
}

/** The default primary this generation needs before any command is allowed. */
function loomDescriptor(): AgentDescriptor {
  return {
    name: "loom",
    composedPrompt: "You are Loom, the main orchestrator.",
    models: ["claude-sonnet-4-5"],
    mode: "primary",
    effectiveToolPolicy: {
      read: "allow",
      write: "allow",
      execute: "allow",
      delegate: "allow",
      network: "ask",
    },
    rawToolPolicy: undefined,
    delegationTargets: [],
    skills: [],
  };
}

const WEAVE_INVENTORY_ENTRY: PiExtensionInventoryEntry = {
  id: "npm:@weaveio/weave-adapter-pi",
  label: "weave-adapter-pi",
  source: "npm:@weaveio/weave-adapter-pi",
  path: "/host/weave/dist/extension.js",
  origin: "package",
  scope: "user",
  evidence: ["loaded"],
  mandatory: true,
  available: true,
};

const VIM_INVENTORY_ENTRY: PiExtensionInventoryEntry = {
  id: "npm:pi-vim",
  label: "pi-vim",
  source: "npm:pi-vim",
  path: "/host/pi-vim/dist/extension.js",
  origin: "package",
  scope: "user",
  evidence: ["configured-package"],
  mandatory: false,
  available: true,
};

/**
 * A complete, deterministic inventory. Production collection scans the real
 * agent directory, which adapter tests must never do.
 */
function fakeInventory(
  entries: readonly PiExtensionInventoryEntry[] = [
    WEAVE_INVENTORY_ENTRY,
    VIM_INVENTORY_ENTRY,
  ],
): PiExtensionInventory {
  return { entries, truncated: false, projectScanned: true };
}

function allOkCapabilityProber() {
  return {
    probe: () =>
      ALL_CAPABILITY_IDS.map((capabilityId) => ({
        capabilityId,
        probeStatus: "ok" as const,
      })),
  };
}

function installExtension(
  host: RecordingFakePiHost,
  overrides: Partial<PiExtensionDeps> = {},
) {
  const factory = createPiExtension({
    hostPackageReader: FakeHostPackageReader.ok({
      name: HOST_PACKAGE_NAME,
      version: "0.81.1",
    }),
    capabilityProber: allOkCapabilityProber(),
    idGenerator: new FakeIdGenerator(),
    clock: new FakeClock(),
    logger: new RecordingLogger(),
    configActivator: fakeConfigActivator({
      agents: [
        { agentName: "loom", source: "explicit", descriptor: loomDescriptor() },
      ],
      errors: [],
    }),
    // The real port spawns a subprocess, which adapter tests may never do.
    pathContainmentPort: new FakePathContainmentPort(
      new Map(),
      ok("/fake/project"),
    ),
    threadSourceFactory: undefined,
    hostKeybindings: () => host.hostKeybindingsForTest(),
    hostSurfaceReader: allNativeHostSurfaceReader(),
    sessionStorageAuthority: TEST_ONLY_GRANTED_SESSION_STORAGE_AUTHORITY,
    runtimeStoreFactory: { open: () => okAsync(createInMemoryRuntimeStore()) },
    piExtensionInventory: () => okAsync(fakeInventory()),
    ...overrides,
  });
  factory(host.api);
  return factory;
}

function lastNotice(host: RecordingFakePiHost): string {
  return host.notifyCalls[host.notifyCalls.length - 1]?.message ?? "";
}

/**
 * The command reads the store and collects the inventory before it opens the
 * overlay, so a single microtask flush is not enough to observe the mount.
 */
async function waitForCustomMount(host: RecordingFakePiHost): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (host.customComponents.length > 0) return;
    await Bun.sleep(0);
  }
}

/** The overlay settles before its write completes, so the write is polled. */
async function waitForStoredSelection(store: RuntimeStore): Promise<string> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const row = (
      await store.preferences.get(
        PI_PREFERENCE_NAMESPACE,
        CHILD_EXTENSION_SELECTION_KEY,
      )
    )._unsafeUnwrap();
    if (row !== null) return row.valueJson;
    await Bun.sleep(0);
  }
  return "";
}

describe("/weave:pi-config registration and classification", () => {
  it("is a first-class /weave:* command with a description", async () => {
    await Promise.resolve();
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    installExtension(host);
    const registration = host.registerCommandCalls.find(
      (call) => call.name === WEAVE_PI_CONFIG_COMMAND_NAME,
    );
    expect(registration).toBeDefined();
    expect(registration?.registration.description).toBe(
      "Choose which Pi extensions Weave children load",
    );
    expect(WEAVE_COMMAND_NAMES).toContain(WEAVE_PI_CONFIG_COMMAND_NAME);
    // Mutating: it writes a durable preference that changes future spawns.
    expect(classifyWeaveCommand(WEAVE_PI_CONFIG_COMMAND_NAME)).toBe("mutating");
  });

  it("appears in the /weave palette and maps back to the command name", async () => {
    await Promise.resolve();
    const action = buildPaletteActions({
      healthOnly: false,
      hasActiveInstance: false,
      hasPendingArtifact: false,
    }).find((candidate) => candidate.id === "weave.pi-config");
    expect(action).toEqual({
      id: "weave.pi-config",
      label: "Weave: Configure Child Extensions",
      visible: true,
      disabledReason: undefined,
    });
    expect(action?.id.replace("weave.", "weave:")).toBe(
      WEAVE_PI_CONFIG_COMMAND_NAME,
    );
    // Health-only mode disables it in the palette for the same reason the
    // command gate blocks it.
    expect(
      buildPaletteActions({
        healthOnly: true,
        hasActiveInstance: false,
        hasPendingArtifact: false,
      }).find((candidate) => candidate.id === "weave.pi-config")
        ?.disabledReason,
    ).toBe("Weave is in health-only mode; run /weave:health.");
  });
});

describe("/weave:pi-config gating", () => {
  it("is blocked in health-only mode without opening an overlay", async () => {
    await Promise.resolve();
    const host = new RecordingFakePiHost({ mode: "tui", trusted: false });
    installExtension(host);
    await host.triggerSessionStart();
    await host.invokeCommand(WEAVE_PI_CONFIG_COMMAND_NAME);
    expect(host.customCalls).toHaveLength(0);
    expect(lastNotice(host)).toContain("health-only mode");
  });

  it("never opens outside a TUI session", async () => {
    await Promise.resolve();
    // A non-TUI session is already health-only, so that gate answers first.
    const printHost = new RecordingFakePiHost({ mode: "print", trusted: true });
    installExtension(printHost);
    await printHost.triggerSessionStart();
    await printHost.invokeCommand(WEAVE_PI_CONFIG_COMMAND_NAME);
    expect(printHost.customCalls).toHaveLength(0);

    // A host that reports TUI mode but exposes no custom-UI surface is told
    // what it is missing rather than silently doing nothing.
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    installExtension(host);
    const ctx = await host.triggerSessionStart();
    const registration = host.registerCommandCalls.find(
      (call) => call.name === WEAVE_PI_CONFIG_COMMAND_NAME,
    );
    await registration?.registration.handler("", {
      ...ctx,
      ui: { ...ctx.ui, custom: undefined },
    } as never);
    expect(host.customCalls).toHaveLength(0);
    expect(lastNotice(host)).toContain("requires Pi TUI mode");
  });

  it("says so when the Runtime Store is unavailable", async () => {
    await Promise.resolve();
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    installExtension(host, {
      runtimeStoreFactory: { open: () => errAsync({ type: "OpenFailed" }) },
    } as unknown as Partial<PiExtensionDeps>);
    await host.triggerSessionStart();
    await host.invokeCommand(WEAVE_PI_CONFIG_COMMAND_NAME);
    expect(host.customCalls).toHaveLength(0);
    expect(lastNotice(host)).toContain("Runtime Store is unavailable");
  });

  it("reports a failed preference read instead of opening", async () => {
    await Promise.resolve();
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    const store = createInMemoryRuntimeStore();
    const failingStore = {
      ...store,
      preferences: {
        ...store.preferences,
        get: () => errAsync({ type: "QueryFailed" }),
      },
    } as unknown as RuntimeStore;
    installExtension(host, {
      runtimeStoreFactory: { open: () => okAsync(failingStore) },
    } as unknown as Partial<PiExtensionDeps>);
    await host.triggerSessionStart();
    await host.invokeCommand(WEAVE_PI_CONFIG_COMMAND_NAME);
    expect(host.customCalls).toHaveLength(0);
    expect(lastNotice(host)).toContain(
      "Could not read the stored Weave child-extension selection",
    );
  });
});

describe("/weave:pi-config overlay", () => {
  it("opens read-only against a degraded inventory and never writes", async () => {
    await Promise.resolve();
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    const store = createInMemoryRuntimeStore();
    installExtension(host, {
      runtimeStoreFactory: { open: () => okAsync(store) },
      // An incomplete inventory saved as a selection would read as "the user
      // deselected everything missing", which is exactly the payload that
      // strips a child of its model provider.
      piExtensionInventory: () =>
        errAsync({
          inventory: fakeInventory([WEAVE_INVENTORY_ENTRY]),
          reasons: ["tools-unavailable"],
        }),
    } as unknown as Partial<PiExtensionDeps>);
    await host.triggerSessionStart();

    const invoked = host.invokeCommand(WEAVE_PI_CONFIG_COMMAND_NAME);
    await waitForCustomMount(host);
    const rendered = (host.customRenderedLines[0] ?? []).join("\n");
    expect(rendered).toContain("Read-only");
    expect(rendered).toContain("Weave adapter — always enabled");

    // Enter cannot save here; it only closes.
    host.inputCustom("\r");
    await invoked;
    expect(host.customDoneCalls).toBe(1);
    expect(
      (
        await store.preferences.get(
          PI_PREFERENCE_NAMESPACE,
          CHILD_EXTENSION_SELECTION_KEY,
        )
      )._unsafeUnwrap(),
    ).toBeNull();
  });

  it("saves an explicit selection that never names the Weave adapter", async () => {
    await Promise.resolve();
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    const store = createInMemoryRuntimeStore();
    installExtension(host, {
      runtimeStoreFactory: { open: () => okAsync(store) },
    } as unknown as Partial<PiExtensionDeps>);
    await host.triggerSessionStart();

    const invoked = host.invokeCommand(WEAVE_PI_CONFIG_COMMAND_NAME);
    await waitForCustomMount(host);
    host.inputCustom("a"); // select every available optional extension
    host.inputCustom("\r"); // save
    await invoked;
    expect(host.customDoneCalls).toBe(1);

    const stored = await waitForStoredSelection(store);
    expect(JSON.parse(stored)).toEqual({
      schemaVersion: 1,
      mode: "explicit",
      entries: [
        {
          id: "npm:pi-vim",
          source: "npm:pi-vim",
          path: "/host/pi-vim/dist/extension.js",
          label: "pi-vim",
        },
      ],
    });
    // The notice has to say the change does not touch running children.
    expect(lastNotice(host)).toContain(
      "after this session's next start, never to running children",
    );
  });

  it("clears the stored selection back to inherit-all", async () => {
    await Promise.resolve();
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    const store = createInMemoryRuntimeStore();
    (
      await store.preferences.set(
        PI_PREFERENCE_NAMESPACE,
        CHILD_EXTENSION_SELECTION_KEY,
        JSON.stringify({
          schemaVersion: 1,
          mode: "explicit",
          entries: [
            {
              id: "npm:pi-vim",
              source: "npm:pi-vim",
              path: "/host/pi-vim/dist/extension.js",
              label: "pi-vim",
            },
          ],
        }),
      )
    )._unsafeUnwrap();
    installExtension(host, {
      runtimeStoreFactory: { open: () => okAsync(store) },
    } as unknown as Partial<PiExtensionDeps>);
    await host.triggerSessionStart();

    const invoked = host.invokeCommand(WEAVE_PI_CONFIG_COMMAND_NAME);
    await waitForCustomMount(host);
    host.inputCustom(" "); // the inherit-all row is where the cursor opens
    host.inputCustom("\r");
    await invoked;

    for (let attempt = 0; attempt < 50; attempt += 1) {
      const row = (
        await store.preferences.get(
          PI_PREFERENCE_NAMESPACE,
          CHILD_EXTENSION_SELECTION_KEY,
        )
      )._unsafeUnwrap();
      if (row === null) break;
      await Bun.sleep(0);
    }
    expect(
      (
        await store.preferences.get(
          PI_PREFERENCE_NAMESPACE,
          CHILD_EXTENSION_SELECTION_KEY,
        )
      )._unsafeUnwrap(),
    ).toBeNull();
    expect(lastNotice(host)).toContain("inherit every Pi extension again");
  });

  it("settles exactly once on cancel and writes nothing", async () => {
    await Promise.resolve();
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    const store = createInMemoryRuntimeStore();
    installExtension(host, {
      runtimeStoreFactory: { open: () => okAsync(store) },
    } as unknown as Partial<PiExtensionDeps>);
    await host.triggerSessionStart();
    const invoked = host.invokeCommand(WEAVE_PI_CONFIG_COMMAND_NAME);
    await waitForCustomMount(host);
    host.inputCustom("a");
    host.inputCustom("\u001b");
    host.inputCustom("\u001b");
    host.inputCustom("\r");
    await invoked;
    expect(host.customDoneCalls).toBe(1);
    expect(
      (
        await store.preferences.get(
          PI_PREFERENCE_NAMESPACE,
          CHILD_EXTENSION_SELECTION_KEY,
        )
      )._unsafeUnwrap(),
    ).toBeNull();
  });
});
