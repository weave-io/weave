import { describe, expect, it } from "bun:test";
import type {
  AgentDescriptor,
  EffectiveToolPolicy,
  MaterializationPlan,
} from "@weaveio/weave-engine";
import { ALL_CAPABILITY_IDS } from "@weaveio/weave-engine";
import { errAsync, okAsync } from "neverthrow";
import {
  DefaultPiCapabilityProber,
  type PiCapabilityProbeSource,
  type PiPreflightContext,
} from "../capability-prober.js";
import { PiConfigActivator } from "../config-activator.js";
import { makeRequiredCapabilityUnavailableFailure } from "../errors.js";
import { createPiExtension, type PiExtensionDeps } from "../extension.js";
import { HOST_PACKAGE_NAME } from "../host-compatibility.js";
import { PiPermissionBridge } from "../permission-bridge.js";
import type { PiToolCallEvent } from "../types.js";

/**
 * Reports every required capability as `ok`, regardless of context - proves
 * that a post-preflight permission activation/registration failure enters
 * health-only even when the injected prober is maximally optimistic
 * (Spec 33 §21).
 */
class AllOkCapabilityProber implements PiCapabilityProbeSource {
  probe(_context: PiPreflightContext) {
    return ALL_CAPABILITY_IDS.map((capabilityId) => ({
      capabilityId,
      probeStatus: "ok" as const,
    }));
  }
}

import { FakeHostPackageReader } from "./fakes/fake-host-package-reader.js";
import {
  FakeClock,
  FakeIdGenerator,
  foreignToolSourceInfo,
  piBuiltinSourceInfo,
  RecordingFakePiHost,
  RecordingLogger,
} from "./fakes/fake-pi-host.js";

const EMPTY_CONFIG = {
  agents: {},
  disabled: { agents: [], skills: [] },
} as unknown as import("@weaveio/weave-core").WeaveConfig;

function loomDescriptor(
  effectiveToolPolicy: EffectiveToolPolicy,
): AgentDescriptor {
  return {
    name: "loom",
    composedPrompt: "You are Loom.",
    models: ["claude-sonnet-4-5"],
    mode: "primary",
    effectiveToolPolicy,
    rawToolPolicy: undefined,
    delegationTargets: [],
    skills: [],
  };
}

function fakeConfigActivator(plan: MaterializationPlan): PiConfigActivator {
  return new PiConfigActivator({
    configLoader: { load: () => okAsync(EMPTY_CONFIG) },
    materializer: { materialize: () => okAsync(plan) },
  });
}

/** Installs the compiled extension against a fake host with a 'loom' primary agent under the given policy. */
function install(
  host: RecordingFakePiHost,
  effectiveToolPolicy: EffectiveToolPolicy,
  overrides: Partial<PiExtensionDeps> = {},
) {
  const plan: MaterializationPlan = {
    agents: [
      {
        agentName: "loom",
        descriptor: loomDescriptor(effectiveToolPolicy),
        source: "explicit",
      },
    ],
    errors: [],
  };
  const factory = createPiExtension({
    hostPackageReader: FakeHostPackageReader.ok({
      name: HOST_PACKAGE_NAME,
      version: "0.81.1",
    }),
    capabilityProber: new DefaultPiCapabilityProber(),
    idGenerator: new FakeIdGenerator(),
    clock: new FakeClock(),
    logger: new RecordingLogger(),
    configActivator: fakeConfigActivator(plan),
    permissionBridge: new PiPermissionBridge({ logger: new RecordingLogger() }),
    ...overrides,
  });
  factory(host.api);
  return factory;
}

function bashCall(command: string): PiToolCallEvent {
  return {
    type: "tool_call",
    toolCallId: "1",
    toolName: "bash",
    input: { command },
  };
}

const allowPolicy: EffectiveToolPolicy = {
  read: "allow",
  write: "allow",
  execute: "allow",
  delegate: "allow",
  network: "allow",
};
const askPolicy: EffectiveToolPolicy = {
  read: "ask",
  write: "ask",
  execute: "ask",
  delegate: "ask",
  network: "ask",
};
const denyPolicy: EffectiveToolPolicy = {
  read: "deny",
  write: "deny",
  execute: "deny",
  delegate: "deny",
  network: "deny",
};

describe("tool_call governance (layer C: compiled extension against a fake host)", () => {
  it("allows a governed native call under an allow policy and writes back only the consumed snapshot", async () => {
    const host = new RecordingFakePiHost();
    host.injectTool({ name: "bash", sourceInfo: piBuiltinSourceInfo("bash") });
    install(host, allowPolicy);
    await host.triggerSessionStart();

    const event = bashCall("ls -la");
    const result = await host.triggerToolCall(event);
    expect(result).toBeUndefined();
    expect(event.input.command).toBe("ls -la");
  });

  it("blocks a governed native call under a deny policy", async () => {
    const host = new RecordingFakePiHost();
    host.injectTool({ name: "bash", sourceInfo: piBuiltinSourceInfo("bash") });
    install(host, denyPolicy);
    await host.triggerSessionStart();

    const result = await host.triggerToolCall(bashCall("ls -la"));
    expect(result).toEqual({ block: true, reason: "policy-denied" });
  });

  it("prompts for approval under an ask policy and allows once approved", async () => {
    // Overall health-only mode disables approval (Spec 33 §21) regardless
    // of tool-policy's own coverage - an all-required-probes-ok fixture is
    // required here so the approval UI is genuinely permitted to open.
    const host = new RecordingFakePiHost();
    host.injectTool({ name: "bash", sourceInfo: piBuiltinSourceInfo("bash") });
    install(host, askPolicy, { capabilityProber: new AllOkCapabilityProber() });
    await host.triggerSessionStart();

    host.scriptSelect("Allow once");
    const result = await host.triggerToolCall(bashCall("ls -la"));
    expect(result).toBeUndefined();
    expect(host.selectCalls).toHaveLength(1);
    expect(host.selectCalls[0].opts?.timeout).toBeGreaterThan(0);
  });

  it("blocks an ask-policy call when the user cancels the approval prompt", async () => {
    const host = new RecordingFakePiHost();
    host.injectTool({ name: "bash", sourceInfo: piBuiltinSourceInfo("bash") });
    install(host, askPolicy, { capabilityProber: new AllOkCapabilityProber() });
    await host.triggerSessionStart();

    host.scriptSelect(undefined);
    const result = await host.triggerToolCall(bashCall("ls -la"));
    expect(result).toEqual({
      block: true,
      reason: "approval-cancelled-or-rejected",
    });
  });

  it("never opens the approval UI for an ask-policy call while the adapter is overall health-only, even for an unrelated degraded capability", async () => {
    // Spec 33 §21: overall health-only mode disables approval, regardless
    // of *why* the adapter is health-only. Here tool-policy's own coverage
    // is fine (bash is a genuine builtin), but the default prober reports
    // other required capabilities as not-yet-implemented, so the whole
    // adapter is health-only - the ask-policy call must block via the
    // existing no-UI-available path rather than opening a dialog.
    const host = new RecordingFakePiHost();
    host.injectTool({ name: "bash", sourceInfo: piBuiltinSourceInfo("bash") });
    install(host, askPolicy);
    await host.triggerSessionStart();
    expect(host.statusCalls.at(-1)?.value).toContain("health-only");

    const result = await host.triggerToolCall(bashCall("ls -la"));
    expect(result).toEqual({
      block: true,
      reason: "approval-ui-unavailable",
    });
    expect(host.selectCalls).toHaveLength(0);
  });

  it("still allows a policy-allow native call while the adapter is overall health-only for an unrelated capability", async () => {
    // The explicit rule is "no approval in health-only", not "no governed
    // calls at all" - an allow-policy call needs no UI and must still
    // succeed even when an unrelated required capability is degraded.
    const host = new RecordingFakePiHost();
    host.injectTool({ name: "bash", sourceInfo: piBuiltinSourceInfo("bash") });
    install(host, allowPolicy);
    await host.triggerSessionStart();
    expect(host.statusCalls.at(-1)?.value).toContain("health-only");

    const result = await host.triggerToolCall(bashCall("ls -la"));
    expect(result).toBeUndefined();
    expect(host.selectCalls).toHaveLength(0);
  });

  it("preserves owner behavior for an unrelated third-party tool, never prompting or calling the engine", async () => {
    const host = new RecordingFakePiHost();
    host.injectTool({ name: "bash", sourceInfo: piBuiltinSourceInfo("bash") });
    host.injectTool({
      name: "third-party-tool",
      sourceInfo: foreignToolSourceInfo(),
    });
    install(host, denyPolicy);
    await host.triggerSessionStart();

    const event: PiToolCallEvent = {
      type: "tool_call",
      toolCallId: "2",
      toolName: "third-party-tool",
      input: { anything: true },
    };
    const result = await host.triggerToolCall(event);
    expect(result).toBeUndefined();
    expect(host.selectCalls).toHaveLength(0);
  });

  it("blocks a governed native tool when coverage failed to activate this generation (health-only), while an unrelated tool still passes through", async () => {
    const host = new RecordingFakePiHost();
    // "bash" is shadowed by a foreign extension at session_start time -
    // coverage fails, so no PermissionSession activates this generation.
    host.injectTool({ name: "bash", sourceInfo: foreignToolSourceInfo() });
    host.injectTool({
      name: "third-party-tool",
      sourceInfo: foreignToolSourceInfo(),
    });
    install(host, allowPolicy);
    await host.triggerSessionStart();

    const blocked = await host.triggerToolCall(bashCall("ls -la"));
    expect(blocked).toEqual({ block: true, reason: "tool-policy-unavailable" });

    const passthrough = await host.triggerToolCall({
      type: "tool_call",
      toolCallId: "3",
      toolName: "third-party-tool",
      input: {},
    });
    expect(passthrough).toBeUndefined();
  });

  it("blocks every governed native tool when no session was ever activated (session_start never ran)", async () => {
    const host = new RecordingFakePiHost();
    install(host, allowPolicy);
    // No triggerSessionStart() at all - activeSession stays undefined.
    const result = await host.triggerToolCall(bashCall("ls -la"));
    expect(result).toEqual({ block: true, reason: "tool-policy-unavailable" });
  });

  it("blocks on a stale controller generation discovered after an in-flight approval prompt", async () => {
    const host = new RecordingFakePiHost();
    host.injectTool({ name: "bash", sourceInfo: piBuiltinSourceInfo("bash") });
    install(host, askPolicy);
    await host.triggerSessionStart();

    const deferred = host.deferNextSelect();
    const pending = host.triggerToolCall(bashCall("ls -la"));

    // A fresh session_start produces a new controller generation while the
    // approval prompt above is still awaiting a response.
    await host.triggerSessionStart();
    deferred.settle("Allow once");

    const result = await pending;
    expect(result).toEqual({
      block: true,
      reason: "tool-policy-generation-stale",
    });
  });

  it("blocks a governed native tool when the injected permission bridge fails to activate a session despite proven coverage", async () => {
    const host = new RecordingFakePiHost();
    host.injectTool({ name: "bash", sourceInfo: piBuiltinSourceInfo("bash") });
    const failingBridge = new PiPermissionBridge({
      logger: new RecordingLogger(),
    });
    failingBridge.activate = () =>
      errAsync(
        makeRequiredCapabilityUnavailableFailure(
          "tool-policy-mapping",
          "simulated-bridge-activate-failure",
        ),
      );
    install(host, allowPolicy, { permissionBridge: failingBridge });
    await host.triggerSessionStart();

    const result = await host.triggerToolCall(bashCall("ls -la"));
    expect(result).toEqual({ block: true, reason: "tool-policy-unavailable" });
  });

  it("blocks rather than rejects when the injected permission bridge's intercept() itself rejects", async () => {
    const host = new RecordingFakePiHost();
    host.injectTool({ name: "bash", sourceInfo: piBuiltinSourceInfo("bash") });
    const hostileBridge = new PiPermissionBridge({
      logger: new RecordingLogger(),
    });
    hostileBridge.intercept = (() =>
      Promise.reject(
        new Error("hostile bridge rejection: token=sk-super-secret-123"),
      )) as unknown as typeof hostileBridge.intercept;
    install(host, allowPolicy, { permissionBridge: hostileBridge });
    await host.triggerSessionStart();

    const result = await host.triggerToolCall(bashCall("ls -la"));
    expect(result).toEqual({
      block: true,
      reason: "tool-policy-intercept-failed",
    });
  });

  it("blocks a governed call when the controller has already advanced past the active session's generation, with no approval in flight", async () => {
    const host = new RecordingFakePiHost();
    host.injectTool({ name: "bash", sourceInfo: piBuiltinSourceInfo("bash") });

    // `controller.activate()` mints a fresh generation unconditionally, even
    // when the rest of `session_start` returns early afterward (Spec 33
    // §7.2/§28: a blocked/failed config activation still advances the
    // generation). Making the SECOND config load fail deterministically
    // advances the controller's generation while leaving `activeSession`
    // pointed at generation 1 - no timing race required.
    let configLoadCount = 0;
    const plan: MaterializationPlan = {
      agents: [
        {
          agentName: "loom",
          descriptor: loomDescriptor(allowPolicy),
          source: "explicit",
        },
      ],
      errors: [],
    };
    const flakyConfigActivator = new PiConfigActivator({
      configLoader: {
        load: () => {
          configLoadCount += 1;
          if (configLoadCount === 1) return okAsync(EMPTY_CONFIG);
          return errAsync([
            {
              type: "FileReadError" as const,
              path: "config.weave",
              cause: new Error("simulated-second-config-load-failure"),
            },
          ]);
        },
      },
      materializer: { materialize: () => okAsync(plan) },
    });
    const factory = createPiExtension({
      hostPackageReader: FakeHostPackageReader.ok({
        name: HOST_PACKAGE_NAME,
        version: "0.81.1",
      }),
      capabilityProber: new DefaultPiCapabilityProber(),
      idGenerator: new FakeIdGenerator(),
      clock: new FakeClock(),
      logger: new RecordingLogger(),
      configActivator: flakyConfigActivator,
      permissionBridge: new PiPermissionBridge({
        logger: new RecordingLogger(),
      }),
    });
    factory(host.api);

    await host.triggerSessionStart();
    await host.triggerSessionStart(); // generation 2: config load fails, activeSession never reassigned

    const blocked = await host.triggerToolCall(bashCall("ls -la"));
    expect(blocked).toEqual({
      block: true,
      reason: "tool-policy-generation-stale",
    });
  });

  it("enters health-only for status/health output and blocks a mutating command when permission activation fails, even with an all-ok prober", async () => {
    const host = new RecordingFakePiHost();
    host.injectTool({ name: "bash", sourceInfo: piBuiltinSourceInfo("bash") });
    const failingBridge = new PiPermissionBridge({
      logger: new RecordingLogger(),
    });
    failingBridge.activate = () =>
      errAsync(
        makeRequiredCapabilityUnavailableFailure(
          "tool-policy-mapping",
          "simulated-bridge-activate-failure",
        ),
      );
    install(host, allowPolicy, {
      permissionBridge: failingBridge,
      capabilityProber: new AllOkCapabilityProber(),
    });
    await host.triggerSessionStart();

    await host.invokeCommand("weave:status");
    const statusMessage =
      host.notifyCalls[host.notifyCalls.length - 1]?.message ?? "";
    expect(statusMessage).toContain("health-only: true");

    await host.invokeCommand("weave:health");
    const healthMessage =
      host.notifyCalls[host.notifyCalls.length - 1]?.message ?? "";
    expect(healthMessage).toContain("Weave adapter mode: health-only");

    host.notifyCalls.length = 0;
    await host.invokeCommand("weave:start");
    expect(host.notifyCalls).toHaveLength(1);
    expect(host.notifyCalls[0]?.level).toBe("warning");
  });

  it("enters health-only for status/health output and blocks a mutating command when a shadowed native tool leaves coverage incomplete, even with an all-ok prober", async () => {
    // A misbehaving/optimistic injected prober reporting every probe ok
    // must never override the real coverage outcome: absent/failed
    // coverage is itself a runtime permission-activation failure.
    const host = new RecordingFakePiHost();
    host.injectTool({ name: "bash", sourceInfo: foreignToolSourceInfo() });
    install(host, allowPolicy, {
      capabilityProber: new AllOkCapabilityProber(),
    });
    await host.triggerSessionStart();

    const statusMessage = host.statusCalls.at(-1)?.value ?? "";
    expect(statusMessage).toContain("health-only");

    await host.invokeCommand("weave:status");
    expect(host.notifyCalls.at(-1)?.message).toContain("health-only: true");

    host.notifyCalls.length = 0;
    await host.invokeCommand("weave:start");
    expect(host.notifyCalls).toHaveLength(1);
    expect(host.notifyCalls[0]?.level).toBe("warning");
  });

  it("blocks bash after a genuine builtin is displaced by a foreign extension mid-generation (extension-layer displacement)", async () => {
    const host = new RecordingFakePiHost();
    host.injectTool({ name: "bash", sourceInfo: piBuiltinSourceInfo("bash") });
    install(host, allowPolicy);
    await host.triggerSessionStart();

    const allowed = await host.triggerToolCall(bashCall("ls -la"));
    expect(allowed).toBeUndefined();

    // A foreign extension registers over "bash" after activation - Pi allows
    // this (docs/extensions.md); the fake's `displaceTool` mirrors Pi's
    // real replace-on-registerTool behavior.
    host.displaceTool("bash", foreignToolSourceInfo());

    const blocked = await host.triggerToolCall(bashCall("ls -la"));
    expect(blocked).toEqual({
      block: true,
      reason: "tool-provenance-changed",
    });
  });
});
