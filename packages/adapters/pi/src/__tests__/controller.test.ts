import { describe, expect, it } from "bun:test";
import type { CapabilityProbeResult } from "@weaveio/weave-engine";
import { ALL_CAPABILITY_IDS } from "@weaveio/weave-engine";
import { ok, okAsync, type Result, ResultAsync } from "neverthrow";
import type { PiCapabilityProbeSource } from "../capability-prober.js";
import { ADAPTER_PACKAGE_IDENTITY, WEAVE_COMMAND_NAMES } from "../commands.js";
import { PiExtensionController } from "../controller.js";
import {
  HOST_PACKAGE_NAME,
  type HostPackageInfo,
  type HostPackageReader,
} from "../host-compatibility.js";
import { PiSafeInitializer } from "../safe-initializer.js";
import type { PiCommandInfo } from "../types.js";
import { FakeHostPackageReader } from "./fakes/fake-host-package-reader.js";
import {
  FakeClock,
  FakeIdGenerator,
  fakeConfigActivator,
  RecordingLogger,
} from "./fakes/fake-pi-host.js";

const ALL_OWNED_COMMANDS: PiCommandInfo[] = WEAVE_COMMAND_NAMES.map((name) => ({
  name,
  source: "extension",
  sourceInfo: {
    path: `/node_modules/${ADAPTER_PACKAGE_IDENTITY}/dist/extension.js`,
    source: `npm:${ADAPTER_PACKAGE_IDENTITY}`,
    scope: "user",
    origin: "package",
  },
}));

class FixedProber implements PiCapabilityProbeSource {
  constructor(private readonly results: readonly CapabilityProbeResult[]) {}
  probe(): readonly CapabilityProbeResult[] {
    return this.results;
  }
}

function allOkProbes(): CapabilityProbeResult[] {
  return ALL_CAPABILITY_IDS.map((id) => ({
    capabilityId: id,
    probeStatus: "ok" as const,
  }));
}

function degradedProbes(): CapabilityProbeResult[] {
  return ALL_CAPABILITY_IDS.map((id) =>
    id === "workflow-persistence"
      ? { capabilityId: id, probeStatus: "unavailable" as const }
      : { capabilityId: id, probeStatus: "ok" as const },
  );
}

function makeController(probes: readonly CapabilityProbeResult[]) {
  const safeInitializer = new PiSafeInitializer({
    hostPackageReader: FakeHostPackageReader.ok({
      name: HOST_PACKAGE_NAME,
      version: "0.81.1",
    }),
    capabilityProber: new FixedProber(probes),
    configActivator: fakeConfigActivator(),
  });
  return new PiExtensionController({
    safeInitializer,
    idGenerator: new FakeIdGenerator(),
    clock: new FakeClock(),
    logger: new RecordingLogger(),
  });
}

function trustedTuiSession() {
  return {
    mode: "tui" as const,
    isProjectTrusted: () => true,
    cwd: "/fake/project",
    modelRegistry: { getAvailable: () => [] },
  };
}

function deferredResultAsync<T, E>(
  fallbackError: E,
): {
  readonly called: Promise<void>;
  readonly start: () => ResultAsync<T, E>;
  readonly settle: (result: Result<T, E>) => void;
} {
  let resolveCalled!: () => void;
  let resolveResult!: (result: Result<T, E>) => void;
  let result: ResultAsync<T, E> | undefined;
  const called = new Promise<void>((resolve) => {
    resolveCalled = resolve;
  });

  return {
    called,
    start: () => {
      if (result !== undefined) return result;
      result = ResultAsync.fromPromise(
        new Promise<Result<T, E>>((resolve) => {
          resolveResult = resolve;
        }),
        () => fallbackError,
      ).andThen((settled) => settled);
      resolveCalled();
      return result;
    },
    settle: (settled) => resolveResult(settled),
  };
}

describe("PiExtensionController.activate", () => {
  it("creates a fresh generation with a distinct ID on each activation", async () => {
    const controller = makeController(allOkProbes());
    const first = await controller.activate(
      trustedTuiSession(),
      ALL_OWNED_COMMANDS,
    );
    const second = await controller.activate(
      trustedTuiSession(),
      ALL_OWNED_COMMANDS,
    );
    expect(first.isOk()).toBe(true);
    expect(second.isOk()).toBe(true);
    expect(first._unsafeUnwrap().id).not.toBe(second._unsafeUnwrap().id);
    expect(controller.getCurrentGeneration()?.id).toBe(
      second._unsafeUnwrap().id,
    );
  });

  it("is not ready before the first activation", () => {
    const controller = makeController(allOkProbes());
    expect(controller.getCurrentGeneration()).toBeUndefined();
  });
});

describe("PiExtensionController command gating", () => {
  it("allows every classification when the generation is ready", async () => {
    const controller = makeController(allOkProbes());
    await controller.activate(trustedTuiSession(), ALL_OWNED_COMMANDS);
    for (const name of WEAVE_COMMAND_NAMES) {
      const decision = controller.evaluateCommandGate(name)._unsafeUnwrap();
      expect(decision.allowed).toBe(true);
    }
  });

  it("blocks mutating commands but allows read-only and idempotent-cleanup commands in health-only mode", async () => {
    const controller = makeController(degradedProbes());
    await controller.activate(trustedTuiSession(), ALL_OWNED_COMMANDS);
    const mutating = [
      "weave:start",
      "weave:run",
      "weave:advance",
      "weave:resume",
      "weave:artifact",
    ] as const;
    const readOnly = [
      "weave:status",
      "weave:health",
      "weave:plan",
      "weave:history",
      "weave:doctor",
    ] as const;
    for (const name of mutating) {
      const decision = controller.evaluateCommandGate(name)._unsafeUnwrap();
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toBe("health-only-mode");
    }
    for (const name of readOnly) {
      expect(controller.evaluateCommandGate(name)._unsafeUnwrap().allowed).toBe(
        true,
      );
    }
    expect(
      controller.evaluateCommandGate("weave:abort")._unsafeUnwrap().allowed,
    ).toBe(true);
  });

  it("fails with ActivationFailed when no generation has activated yet", () => {
    const controller = makeController(allOkProbes());
    const result = controller.evaluateCommandGate("weave:status");
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().code).toBe("ActivationFailed");
  });
});

describe("PiExtensionController generation replacement and staleness", () => {
  it("returns ControllerGenerationStale when the first activation settles after the second", async () => {
    const hostInfo: HostPackageInfo = {
      name: HOST_PACKAGE_NAME,
      version: "0.81.1",
    };
    const firstRead = deferredResultAsync<typeof hostInfo, never>(
      undefined as never,
    );
    let readCount = 0;
    const hostPackageReader: HostPackageReader = {
      read: () => {
        readCount += 1;
        return readCount === 1 ? firstRead.start() : okAsync(hostInfo);
      },
    };
    const controller = new PiExtensionController({
      safeInitializer: new PiSafeInitializer({
        hostPackageReader,
        capabilityProber: new FixedProber(allOkProbes()),
        configActivator: fakeConfigActivator(),
      }),
      idGenerator: new FakeIdGenerator(),
      clock: new FakeClock(),
      logger: new RecordingLogger(),
    });

    const firstActivation = controller.activate(
      trustedTuiSession(),
      ALL_OWNED_COMMANDS,
    );
    await firstRead.called;

    const secondActivation = await controller.activate(
      trustedTuiSession(),
      ALL_OWNED_COMMANDS,
    );
    expect(secondActivation.isOk()).toBe(true);

    firstRead.settle(ok(hostInfo));
    const firstResult = await firstActivation;
    expect(firstResult.isErr()).toBe(true);
    expect(firstResult._unsafeUnwrapErr().code).toBe(
      "ControllerGenerationStale",
    );
    expect(controller.getCurrentGeneration()?.id).toBe(
      secondActivation._unsafeUnwrap().id,
    );
  });

  it("rejects an operation handle captured before a replacement as ControllerGenerationStale", async () => {
    const controller = makeController(allOkProbes());
    await controller.activate(trustedTuiSession(), ALL_OWNED_COMMANDS);
    const handle = controller.beginOperation()._unsafeUnwrap();
    expect(handle.assertStillCurrent().isOk()).toBe(true);

    await controller.activate(trustedTuiSession(), ALL_OWNED_COMMANDS);

    const staleCheck = handle.assertStillCurrent();
    expect(staleCheck.isErr()).toBe(true);
    expect(staleCheck._unsafeUnwrapErr().code).toBe(
      "ControllerGenerationStale",
    );
  });

  it("a fresh operation handle taken after replacement remains current", async () => {
    const controller = makeController(allOkProbes());
    await controller.activate(trustedTuiSession(), ALL_OWNED_COMMANDS);
    await controller.activate(trustedTuiSession(), ALL_OWNED_COMMANDS);
    const handle = controller.beginOperation()._unsafeUnwrap();
    expect(handle.assertStillCurrent().isOk()).toBe(true);
  });

  it("beginOperation fails before any activation", () => {
    const controller = makeController(allOkProbes());
    expect(controller.beginOperation().isErr()).toBe(true);
  });
});

describe("PiExtensionController.shutdown", () => {
  it("clears the active generation and command gating then fails closed", async () => {
    const controller = makeController(allOkProbes());
    await controller.activate(trustedTuiSession(), ALL_OWNED_COMMANDS);
    expect(controller.shutdown().isOk()).toBe(true);
    expect(controller.getCurrentGeneration()).toBeUndefined();
    expect(controller.evaluateCommandGate("weave:status").isErr()).toBe(true);
  });

  it("is idempotent: calling shutdown twice does not throw or error", async () => {
    const controller = makeController(allOkProbes());
    await controller.activate(trustedTuiSession(), ALL_OWNED_COMMANDS);
    expect(controller.shutdown().isOk()).toBe(true);
    expect(controller.shutdown().isOk()).toBe(true);
  });

  it("an operation handle from before shutdown is stale afterward", async () => {
    const controller = makeController(allOkProbes());
    await controller.activate(trustedTuiSession(), ALL_OWNED_COMMANDS);
    const handle = controller.beginOperation()._unsafeUnwrap();
    controller.shutdown();
    expect(handle.assertStillCurrent().isErr()).toBe(true);
  });
});
