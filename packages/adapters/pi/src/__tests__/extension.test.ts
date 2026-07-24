import { describe, expect, it } from "bun:test";
import type { WeaveConfig } from "@weaveio/weave-core";
import type {
  AgentDescriptor,
  MaterializationPlan,
} from "@weaveio/weave-engine";
import { okAsync } from "neverthrow";
import { DefaultPiCapabilityProber } from "../capability-prober.js";
import { WEAVE_COMMAND_NAMES } from "../commands.js";
import { PiConfigActivator } from "../config-activator.js";
import { createPiExtension, type PiExtensionDeps } from "../extension.js";
import { HOST_PACKAGE_NAME } from "../host-compatibility.js";
import { MODEL_REGISTRY_THREW_REASON } from "../port-safety.js";
import { FakeHostPackageReader } from "./fakes/fake-host-package-reader.js";
import {
  FakeClock,
  FakeIdGenerator,
  RecordingFakePiHost,
  RecordingLogger,
} from "./fakes/fake-pi-host.js";

const EMPTY_CONFIG = {
  agents: {},
  disabled: { agents: [], skills: [] },
} as unknown as WeaveConfig;

/**
 * A `PiConfigActivator` wired to fully in-memory fake ports so extension
 * tests never touch the real filesystem (no real `.weave/config.weave`,
 * global or project, is ever read). `plan` defaults to no descriptors at
 * all, matching the pre-task-7 test fixtures' expectations exactly.
 */
function fakeConfigActivator(
  plan: MaterializationPlan = { agents: [], errors: [] },
): PiConfigActivator {
  return new PiConfigActivator({
    configLoader: { load: () => okAsync(EMPTY_CONFIG) },
    materializer: { materialize: () => okAsync(plan) },
  });
}

function installExtension(
  host: RecordingFakePiHost,
  hostVersion = "0.81.1",
  overrides: Partial<PiExtensionDeps> = {},
) {
  const factory = createPiExtension({
    hostPackageReader: FakeHostPackageReader.ok({
      name: HOST_PACKAGE_NAME,
      version: hostVersion,
    }),
    capabilityProber: new DefaultPiCapabilityProber(),
    idGenerator: new FakeIdGenerator(),
    clock: new FakeClock(),
    logger: new RecordingLogger(),
    configActivator: fakeConfigActivator(),
    ...overrides,
  });
  factory(host.api);
  return factory;
}

describe("createPiExtension factory (layer C: compiled extension against a fake host)", () => {
  it("registers exactly the nine /weave:* command shells and four lifecycle delegates, nothing else", () => {
    const host = new RecordingFakePiHost();
    installExtension(host);
    expect(host.registerCommandCalls.map((call) => call.name).sort()).toEqual(
      [...WEAVE_COMMAND_NAMES].sort(),
    );
    expect(host.onCalls.map((call) => call.event).sort()).toEqual([
      "before_agent_start",
      "session_shutdown",
      "session_start",
      "tool_call",
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
      // A real project always materializes at least one agent; an empty
      // agent set has no policy to bind and the engine's permission
      // activation itself rejects an empty policy map, so this fixture
      // must include one to reach a genuinely healthy "ready" outcome.
      configActivator: fakeConfigActivator({
        agents: [
          {
            agentName: "loom",
            source: "explicit",
            descriptor: loomDescriptor(),
          },
        ],
        errors: [],
      }),
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

function loomDescriptor(
  overrides: Partial<AgentDescriptor> = {},
): AgentDescriptor {
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
    ...overrides,
  };
}

describe("createPiExtension: config activation, materialization consumption, primary activation, prompt append (Spec 33 \u00a77.2, \u00a78, \u00a79)", () => {
  it("materializes config, activates the default primary (loom), and never touches a real developer config file", async () => {
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    installExtension(host, "0.81.1", {
      configActivator: fakeConfigActivator({
        agents: [
          {
            agentName: "loom",
            source: "explicit",
            descriptor: loomDescriptor(),
          },
        ],
        errors: [],
      }),
    });
    await host.triggerSessionStart();

    const { systemPrompt } = await host.triggerBeforeAgentStart({
      systemPrompt: "Pi's native system prompt.",
    });

    expect(systemPrompt).toContain("Pi's native system prompt.");
    expect(systemPrompt).toContain("You are Loom, the main orchestrator.");
    expect(systemPrompt).toContain('name="loom"');
  });

  it("appends nothing extra when the same descriptor's before_agent_start fires twice", async () => {
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    installExtension(host, "0.81.1", {
      configActivator: fakeConfigActivator({
        agents: [
          {
            agentName: "loom",
            source: "explicit",
            descriptor: loomDescriptor(),
          },
        ],
        errors: [],
      }),
    });
    await host.triggerSessionStart();

    const first = await host.triggerBeforeAgentStart({
      systemPrompt: "native",
    });
    const rerun = await host.triggerBeforeAgentStart({
      systemPrompt: first.systemPrompt,
    });

    expect(rerun.systemPrompt).toBe(first.systemPrompt);
  });

  it("does not append anything when the default primary (loom) is missing from the materialization plan", async () => {
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    installExtension(host, "0.81.1", {
      configActivator: fakeConfigActivator({ agents: [], errors: [] }),
    });
    await host.triggerSessionStart();

    const { systemPrompt } = await host.triggerBeforeAgentStart({
      systemPrompt: "Pi's native system prompt.",
    });

    expect(systemPrompt).toBe("Pi's native system prompt.");
  });

  it("consumes ctx.modelRegistry.getAvailable()/ctx.model as the real Pi model discovery context and applies the resolved model via pi.setModel", async () => {
    const catalogModel = {
      provider: "anthropic",
      id: "claude-sonnet-4-5",
      name: "Claude Sonnet 4.5",
    };
    const host = new RecordingFakePiHost({
      mode: "tui",
      trusted: true,
      availableModels: [catalogModel],
    });
    installExtension(host, "0.81.1", {
      configActivator: fakeConfigActivator({
        agents: [
          {
            agentName: "loom",
            source: "explicit",
            descriptor: loomDescriptor(),
          },
        ],
        errors: [],
      }),
    });
    await host.triggerSessionStart();

    const { systemPrompt } = await host.triggerBeforeAgentStart({
      systemPrompt: "native",
    });

    expect(host.setModelCalls).toEqual([catalogModel]);
    expect(systemPrompt).toContain("You are Loom, the main orchestrator.");
  });

  it("keeps the current authenticated model and surfaces a visible, deduplicated degraded-model warning when pi.setModel rejects", async () => {
    const host = new RecordingFakePiHost({
      mode: "tui",
      trusted: true,
      availableModels: [{ provider: "anthropic", id: "claude-sonnet-4-5" }],
    });
    host.poisonSetModel();
    installExtension(host, "0.81.1", {
      configActivator: fakeConfigActivator({
        agents: [
          {
            agentName: "loom",
            source: "explicit",
            descriptor: loomDescriptor(),
          },
        ],
        errors: [],
      }),
    });
    await host.triggerSessionStart();

    const { systemPrompt } = await host.triggerBeforeAgentStart({
      systemPrompt: "native",
    });

    // A degraded model is an accepted terminal state (Spec 33 §9.2, §28) --
    // the descriptor still activates and its prompt still gets appended.
    // The call was attempted (recorded) even though it threw and never took
    // effect (currentModel stays whatever it was before).
    expect(systemPrompt).toContain("You are Loom, the main orchestrator.");
    expect(host.setModelCalls).toHaveLength(1);

    const health = await host.invokeCommand("weave:health");
    expect(host.notifyCalls.at(-1)?.message).toContain("warning [model] loom");
    expect(health).toBeDefined();
  });

  it("treats a resolved false from pi.setModel as a failed application, not success (distinct from a thrown/rejected setModel)", async () => {
    const host = new RecordingFakePiHost({
      mode: "tui",
      trusted: true,
      availableModels: [{ provider: "anthropic", id: "claude-sonnet-4-5" }],
    });
    host.declineNextSetModel();
    installExtension(host, "0.81.1", {
      configActivator: fakeConfigActivator({
        agents: [
          {
            agentName: "loom",
            source: "explicit",
            descriptor: loomDescriptor(),
          },
        ],
        errors: [],
      }),
    });
    await host.triggerSessionStart();

    const { systemPrompt } = await host.triggerBeforeAgentStart({
      systemPrompt: "native",
    });

    // Non-throwing `false` must be treated exactly like a thrown/rejected
    // setModel: the descriptor still commits (degraded model health), and
    // the host's currentModel is never overwritten as if it had succeeded.
    expect(systemPrompt).toContain("You are Loom, the main orchestrator.");
    expect(host.getCurrentModel()).toBeUndefined();

    await host.invokeCommand("weave:health");
    expect(host.notifyCalls.at(-1)?.message).toContain("warning [model] loom");
  });

  it("fails closed instead of crashing the turn when ctx.modelRegistry.getAvailable() throws", async () => {
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    host.poisonGetAvailableModels();
    const logger = new RecordingLogger();
    installExtension(host, "0.81.1", {
      logger,
      configActivator: fakeConfigActivator({
        agents: [
          {
            agentName: "loom",
            source: "explicit",
            descriptor: loomDescriptor(),
          },
        ],
        errors: [],
      }),
    });
    await host.triggerSessionStart();

    const { systemPrompt } = await host.triggerBeforeAgentStart({
      systemPrompt: "native",
    });

    // The descriptor still activates (model resolution degrades to an
    // empty catalog rather than crashing the turn), and the throw is
    // logged, not swallowed silently.
    expect(systemPrompt).toContain("You are Loom, the main orchestrator.");
    const warnEntry = logger.entries.find(
      (entry) =>
        entry.level === "warn" &&
        typeof entry.msg === "string" &&
        entry.msg.includes("ctx.modelRegistry.getAvailable() threw"),
    );
    expect(warnEntry).toBeDefined();
    // The logged reason is a fixed, closed-set literal - never the raw
    // thrown message, which cannot be trusted not to contain private
    // paths, environment values, or secrets.
    expect(warnEntry?.obj.reason).toBe(MODEL_REGISTRY_THREW_REASON);
    expect(JSON.stringify(logger.entries)).not.toContain("id_rsa");
    expect(JSON.stringify(logger.entries)).not.toContain("sk-super-secret-123");
  });

  it("never commits or appends a stale descriptor prompt if the controller's generation changed while primary activation was still in flight", async () => {
    const host = new RecordingFakePiHost({
      mode: "tui",
      trusted: true,
      availableModels: [{ provider: "anthropic", id: "claude-sonnet-4-5" }],
    });
    const deferred = host.deferNextSetModel();
    const logger = new RecordingLogger();
    installExtension(host, "0.81.1", {
      logger,
      configActivator: fakeConfigActivator({
        agents: [
          {
            agentName: "loom",
            source: "explicit",
            descriptor: loomDescriptor(),
          },
        ],
        errors: [],
      }),
    });
    await host.triggerSessionStart();

    // Start a before_agent_start turn; its setModel call will hang until we
    // settle it below, simulating an in-flight primary activation.
    const stalePromise = host.triggerBeforeAgentStart({
      systemPrompt: "native",
    });

    // A session replacement happens while the above is still pending (e.g. a
    // reload/fork/switch/new session_start installs a fresh generation).
    await host.triggerSessionStart();

    // Now let the stale call's setModel settle successfully.
    deferred.settle(true);
    const stale = await stalePromise;

    // The stale call must never return an authoritative, committed prompt
    // for a generation that is no longer current.
    expect(stale.systemPrompt).toBe("native");
    expect(
      logger.entries.some(
        (entry) =>
          entry.level === "warn" &&
          typeof entry.msg === "string" &&
          entry.msg.includes("discarding stale authority"),
      ),
    ).toBe(true);

    // The fresh generation's own before_agent_start still works normally.
    const fresh = await host.triggerBeforeAgentStart({
      systemPrompt: "native",
    });
    expect(fresh.systemPrompt).toContain(
      "You are Loom, the main orchestrator.",
    );
  });

  it("preserves a native user model change: does not re-apply pi.setModel on a later turn once a primary is already active", async () => {
    const host = new RecordingFakePiHost({
      mode: "tui",
      trusted: true,
      availableModels: [{ provider: "anthropic", id: "claude-sonnet-4-5" }],
    });
    installExtension(host, "0.81.1", {
      configActivator: fakeConfigActivator({
        agents: [
          {
            agentName: "loom",
            source: "explicit",
            descriptor: loomDescriptor(),
          },
        ],
        errors: [],
      }),
    });
    await host.triggerSessionStart();

    const first = await host.triggerBeforeAgentStart({
      systemPrompt: "native",
    });
    expect(host.setModelCalls).toHaveLength(1);

    await host.triggerBeforeAgentStart({ systemPrompt: first.systemPrompt });
    expect(host.setModelCalls).toHaveLength(1);
  });

  it("resolves requested skills from Pi's real before_agent_start skill catalog, exactly", async () => {
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    installExtension(host, "0.81.1", {
      configActivator: fakeConfigActivator({
        agents: [
          {
            agentName: "loom",
            source: "explicit",
            descriptor: loomDescriptor({ skills: ["tdd"] }),
          },
        ],
        errors: [],
      }),
    });
    await host.triggerSessionStart();

    const { systemPrompt } = await host.triggerBeforeAgentStart(
      { systemPrompt: "native" },
      [{ name: "tdd", filePath: "/fake/skills/tdd/SKILL.md" }],
    );

    expect(systemPrompt).toContain("You are Loom, the main orchestrator.");
    // Only the skill's name is ever consumed for matching -- never its body.
    expect(systemPrompt).not.toContain("SKILL.md");
  });

  it("disables only the affected descriptor when a requested skill is missing from Pi's catalog, without crashing and without applying a model", async () => {
    const host = new RecordingFakePiHost({
      mode: "tui",
      trusted: true,
      availableModels: [{ provider: "anthropic", id: "claude-sonnet-4-5" }],
    });
    installExtension(host, "0.81.1", {
      configActivator: fakeConfigActivator({
        agents: [
          {
            agentName: "loom",
            source: "explicit",
            descriptor: loomDescriptor({ skills: ["nonexistent-skill"] }),
          },
        ],
        errors: [],
      }),
    });
    await host.triggerSessionStart();

    const { systemPrompt } = await host.triggerBeforeAgentStart({
      systemPrompt: "native",
    });

    expect(systemPrompt).toBe("native");
    expect(host.setModelCalls).toHaveLength(0);

    // The failed attempt is not retried on a later turn (no spam), and stays
    // visible via /weave:health rather than only in logs.
    await host.triggerBeforeAgentStart({ systemPrompt: "native" });
    expect(host.setModelCalls).toHaveLength(0);
    await host.invokeCommand("weave:health");
    expect(host.notifyCalls.at(-1)?.message).toContain(
      "primary activation failed: SkillResolutionFailed",
    );
  });

  it("exposes a declared-temperature capability warning through /weave:health, not just a log line", async () => {
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    installExtension(host, "0.81.1", {
      configActivator: fakeConfigActivator({
        agents: [
          {
            agentName: "loom",
            source: "explicit",
            descriptor: loomDescriptor({ temperature: 0.7 }),
          },
        ],
        errors: [],
      }),
    });
    await host.triggerSessionStart();
    await host.triggerBeforeAgentStart({ systemPrompt: "native" });

    await host.invokeCommand("weave:health");
    expect(host.notifyCalls.at(-1)?.message).toContain(
      "warning [temperature] loom",
    );
  });

  it("never loads or materializes config when the mode is unsupported (Spec 33 §28 wrong-mode -> health-only)", async () => {
    let activateCalls = 0;
    const host = new RecordingFakePiHost({ mode: "print", trusted: true });
    installExtension(host, "0.81.1", {
      configActivator: new PiConfigActivator({
        configLoader: {
          load: () => {
            activateCalls += 1;
            return okAsync(EMPTY_CONFIG);
          },
        },
      }),
    });
    await host.triggerSessionStart();
    expect(activateCalls).toBe(0);
    const { systemPrompt } = await host.triggerBeforeAgentStart({
      systemPrompt: "native",
    });
    expect(systemPrompt).toBe("native");
  });

  it("never loads or materializes config on an unsupported host version (Spec 33 §28 wrong-host -> health-only)", async () => {
    let activateCalls = 0;
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    installExtension(host, "0.80.0", {
      configActivator: new PiConfigActivator({
        configLoader: {
          load: () => {
            activateCalls += 1;
            return okAsync(EMPTY_CONFIG);
          },
        },
      }),
    });
    await host.triggerSessionStart();
    expect(activateCalls).toBe(0);
  });

  it("logs every MaterializationPlan error without crashing session_start", async () => {
    const logger = new RecordingLogger();
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    installExtension(host, "0.81.1", {
      logger,
      configActivator: fakeConfigActivator({
        agents: [],
        errors: [
          {
            type: "DescriptorCompositionFailure",
            agentName: "broken",
            cause: {
              type: "PromptSourceMissingError",
              agentName: "broken",
              message: "missing prompt",
            },
          },
        ],
      }),
    });

    await host.triggerSessionStart();

    expect(
      logger.entries.some(
        (entry) => entry.level === "warn" && entry.obj.agentName === "broken",
      ),
    ).toBe(true);
  });
});
