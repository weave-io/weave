import { describe, expect, it } from "bun:test";
import { DefaultPiCapabilityProber } from "../capability-prober.js";
import { WEAVE_COMMAND_NAMES } from "../commands.js";
import { createPiExtension } from "../extension.js";
import { HOST_PACKAGE_NAME } from "../host-compatibility.js";
import { FakeHostPackageReader } from "./fakes/fake-host-package-reader.js";
import {
  FakeClock,
  FakeIdGenerator,
  RecordingFakePiHost,
  RecordingLogger,
} from "./fakes/fake-pi-host.js";

function installExtension(host: RecordingFakePiHost, hostVersion = "0.81.1") {
  const factory = createPiExtension({
    hostPackageReader: FakeHostPackageReader.ok({
      name: HOST_PACKAGE_NAME,
      version: hostVersion,
    }),
    capabilityProber: new DefaultPiCapabilityProber(),
    idGenerator: new FakeIdGenerator(),
    clock: new FakeClock(),
    logger: new RecordingLogger(),
  });
  factory(host.api);
  return factory;
}

describe("createPiExtension factory (layer C: compiled extension against a fake host)", () => {
  it("registers exactly the nine /weave:* command shells and two lifecycle delegates, nothing else", () => {
    const host = new RecordingFakePiHost();
    installExtension(host);
    expect(host.registerCommandCalls.map((call) => call.name).sort()).toEqual(
      [...WEAVE_COMMAND_NAMES].sort(),
    );
    expect(host.onCalls.map((call) => call.event).sort()).toEqual([
      "session_shutdown",
      "session_start",
    ]);
  });

  it("performs no work before session_start: no notify/status/widget calls happen at factory time", () => {
    const host = new RecordingFakePiHost();
    installExtension(host);
    expect(host.notifyCalls).toHaveLength(0);
    expect(host.statusCalls).toHaveLength(0);
    expect(host.widgetCalls).toHaveLength(0);
  });

  it("does not touch timers or spawn processes at factory time", () => {
    const originalSetTimeout = globalThis.setTimeout;
    const originalSpawn = Bun.spawn;
    let timerCalls = 0;
    let spawnCalls = 0;
    const spySetTimeout = ((
      ...args: Parameters<typeof setTimeout>
    ): ReturnType<typeof setTimeout> => {
      timerCalls += 1;
      return originalSetTimeout(...args);
    }) as typeof setTimeout;
    const spySpawn = ((
      ...args: Parameters<typeof Bun.spawn>
    ): ReturnType<typeof Bun.spawn> => {
      spawnCalls += 1;
      return originalSpawn(...(args as Parameters<typeof originalSpawn>));
    }) as typeof Bun.spawn;
    globalThis.setTimeout = spySetTimeout;
    Bun.spawn = spySpawn;
    try {
      const host = new RecordingFakePiHost();
      installExtension(host);
    } finally {
      globalThis.setTimeout = originalSetTimeout;
      Bun.spawn = originalSpawn;
    }
    expect(timerCalls).toBe(0);
    expect(spawnCalls).toBe(0);
  });

  it("becomes ready (health-only false is possible) when every probe is fully controlled to ok via the injected prober", async () => {
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    class AllOkProber {
      probe() {
        return [
          "command-entrypoints",
          "token-usage-reporting",
          "config-materialization",
          "agent-materialization",
          "primary-agent-selection",
          "delegated-specialist-execution",
          "prompt-composition",
          "tool-policy-mapping",
          "workflow-persistence",
          "workflow-step-dispatch",
          "plan-file-compatibility",
          "event-logging",
          "context-window-monitor",
          "idle-continuation",
          "compaction-recovery",
          "analytics-dashboard",
          "static-artifact-generation",
          "eval-integration",
          "multiple-active-workflows",
        ].map((capabilityId) => ({ capabilityId, probeStatus: "ok" as const }));
      }
    }
    const factory = createPiExtension({
      hostPackageReader: FakeHostPackageReader.ok({
        name: HOST_PACKAGE_NAME,
        version: "0.81.1",
      }),
      // biome-ignore lint/suspicious/noExplicitAny: structural fake, exact capability ID union is exercised via the real ALL_CAPABILITY_IDS list above
      capabilityProber: new AllOkProber() as any,
      idGenerator: new FakeIdGenerator(),
      clock: new FakeClock(),
      logger: new RecordingLogger(),
    });
    factory(host.api);
    await host.triggerSessionStart();
    expect(host.statusCalls.at(-1)?.value).toBe("ready");
  });

  it("enters health-only mode (real prober) on a fresh trusted TUI session, since later subsystems are not implemented yet, and blocks mutating commands", async () => {
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    installExtension(host);
    await host.triggerSessionStart();
    expect(host.statusCalls.at(-1)?.value).toContain("health-only");
    const ctx = await host.invokeCommand("weave:start");
    expect(host.notifyCalls.at(-1)?.message).toContain("health-only mode");
    expect(ctx.mode).toBe("tui");
  });

  it("still allows weave:health and weave:status and weave:abort while in health-only mode", async () => {
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    installExtension(host);
    await host.triggerSessionStart();
    await host.invokeCommand("weave:health");
    expect(host.notifyCalls.at(-1)?.message).toContain(
      "Weave adapter mode: health-only",
    );
    await host.invokeCommand("weave:status");
    expect(host.notifyCalls.at(-1)?.message).toContain("health-only: true");
    await host.invokeCommand("weave:abort");
    expect(host.notifyCalls.at(-1)?.message).toContain(
      "No active Weave execution",
    );
  });

  it("blocks activation into a wrong mode as health-only", async () => {
    const host = new RecordingFakePiHost({ mode: "print", trusted: true });
    installExtension(host);
    await host.triggerSessionStart();
    expect(host.statusCalls.at(-1)?.value).toContain("health-only");
  });

  it("blocks activation on an unsupported host version", async () => {
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    installExtension(host, "0.80.0");
    await host.triggerSessionStart();
    expect(host.statusCalls.at(-1)?.value).toContain("health-only");
  });

  it("detects a command collision from a rival extension and reports command-entrypoints as unavailable via /weave:health", async () => {
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    installExtension(host);
    host.renameOwnCommand("weave:health", "weave:health:2");
    await host.triggerSessionStart();
    expect(host.statusCalls.at(-1)?.value).toContain("health-only");
    // The rename simulates what Pi's inventory (`getCommands()`) reports after a
    // collision; our own registered handler is still invoked under its original
    // name -- `/weave:health` remains read-only and available in health-only mode.
    await host.invokeCommand("weave:health");
    const message = host.notifyCalls.at(-1)?.message;
    expect(message).toContain("Weave adapter mode: health-only");
    expect(message).toContain(
      "command-entrypoints: unsupported (declared native)",
    );
    const status = await host.invokeCommand("weave:status");
    expect(status).toBeDefined();
  });

  it("detects a command collision even when a rival extension's suffixed entry collides on our base name while we keep it", async () => {
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    installExtension(host);
    host.injectForeignCommand("weave:health:1");
    await host.triggerSessionStart();
    expect(host.statusCalls.at(-1)?.value).toContain("health-only");
    await host.invokeCommand("weave:health");
    const message = host.notifyCalls.at(-1)?.message;
    expect(message).toContain(
      "command-entrypoints: unsupported (declared native)",
    );
  });

  it("surfaces a poisoned getCommands() host failure as a notification rather than throwing", async () => {
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    installExtension(host);
    host.poisonGetCommands();
    await host.triggerSessionStart();
    expect(host.notifyCalls.some((call) => call.level === "error")).toBe(true);
  });

  it("surfaces a malformed getCommands() payload as a notification rather than throwing", async () => {
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    installExtension(host);
    host.returnMalformedCommands();
    await host.triggerSessionStart();
    expect(host.notifyCalls.some((call) => call.level === "error")).toBe(true);
  });

  it("shuts down idempotently on repeated session_shutdown events", async () => {
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    installExtension(host);
    await host.triggerSessionStart();
    await host.triggerSessionShutdown();
    await host.triggerSessionShutdown();
    // No throw means the idempotent cleanup path held.
    expect(
      host.onCalls.filter((call) => call.event === "session_shutdown"),
    ).toHaveLength(1);
  });

  it("gives each generation a fresh session context object, never a shared reference", async () => {
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    installExtension(host);
    const ctxA = await host.triggerSessionStart();
    const ctxB = await host.triggerSessionStart();
    expect(ctxA).not.toBe(ctxB);
  });
});
