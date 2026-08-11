/**
 * Activation readiness must be *proved*, never inferred.
 *
 * Task 11 review blocker A: the adapter previously reported `ready` from static
 * command/usage surfaces alone, and only discovered a real native-session
 * failure later (when thread sources opened), by which point the primary had
 * been committed and only delegation was disabled. These tests pin the
 * replacement contract:
 *
 * - each unavailable class maps to exactly one closed, path-free reason,
 * - a host whose static surfaces all look ready is still not ready when the
 *   native session/root/process surfaces are unproven (false-ready regression),
 * - an unproven generation performs zero downstream work: no config
 *   activation/materialization, no primary, no transport, no lease, no spawn,
 * - a proved host still reaches ready.
 */

import { describe, expect, it } from "bun:test";
import { ALL_CAPABILITY_IDS } from "@weaveio/weave-engine";
import { errAsync, okAsync } from "neverthrow";
import { DefaultPiCapabilityProber } from "../capability-prober.js";
import type { PiNativeSessionFsPort } from "../child-native-sessions.js";
import type { PiChildProcessPort } from "../child-process-port.js";
import { ADAPTER_PACKAGE_IDENTITY, WEAVE_COMMAND_NAMES } from "../commands.js";
import type { PiConfigActivator } from "../config-activator.js";
import { HOST_PACKAGE_NAME } from "../host-compatibility.js";
import { PI_HOST_SURFACE_IDS } from "../host-compatibility-matrix.js";
import { readHostSurfaceReport } from "../host-inventory.js";
import { MemoryPiNativeSessionFs } from "../native-session-fs.js";
import {
  createBlockedPiNativeSessionReadinessProbe,
  createPiNativeSessionReadinessProbe,
  createReadyPiNativeSessionReadinessProbe,
  isProcessLaunchSurfaceUsable,
  mapRootOpenFailureToReadinessReason,
  mapSessionRootErrorToReadinessReason,
  type PiExecutableResolverPort,
  type PiNativeSessionReadinessProbe,
} from "../native-session-readiness.js";
import { PiSafeInitializer } from "../safe-initializer.js";
import type { PiTrustedDataRootPort } from "../trusted-data-root.js";
import type { PiCommandInfo } from "../types.js";
import { FakeChildProcessPort } from "./fakes/fake-child-process-port.js";
import { FakeHostPackageReader } from "./fakes/fake-host-package-reader.js";

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

const PRIVATE_HOME = "/private/home/example";
const CHILD_EXECUTABLE = "/private/home/example/.pi/agent/bin/pi";

function readyHostSurfaceReport() {
  return readHostSurfaceReport(
    PI_HOST_SURFACE_IDS.map((surfaceId) => ({
      surfaceId,
      status: "native" as const,
      details: "fixture",
    })),
  );
}

/** A structurally complete Pi `SessionManager` static surface. */
function sessionManagerStatic(): unknown {
  return {
    create: () => ({}),
    open: () => ({}),
  };
}

function readinessProbeWith(overrides: {
  readonly SessionManager?: unknown;
  readonly fs?: PiNativeSessionFsPort;
  readonly processPort?: PiChildProcessPort;
  readonly childCommand?: readonly string[];
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly executableExists?: (path: string) => Promise<boolean>;
  readonly executableResolver?: PiExecutableResolverPort;
  readonly trustedRoot?: PiTrustedDataRootPort;
}): PiNativeSessionReadinessProbe {
  return createPiNativeSessionReadinessProbe({
    processPort: overrides.processPort ?? new FakeChildProcessPort(),
    childCommand: overrides.childCommand ?? [CHILD_EXECUTABLE, "--mode", "rpc"],
    SessionManager:
      overrides.SessionManager === undefined
        ? sessionManagerStatic()
        : overrides.SessionManager,
    fs: overrides.fs ?? new MemoryPiNativeSessionFs(),
    env: overrides.env ?? {
      XDG_DATA_HOME: `${PRIVATE_HOME}/.local/share`,
      HOME: PRIVATE_HOME,
    },
    homeDir: PRIVATE_HOME,
    // Canonicalization of the XDG base is proved by `trusted-data-root`'s own
    // suite; these tests isolate the readiness classes instead.
    trustedRoot: overrides.trustedRoot ?? {
      canonicalize: (base: string) => okAsync(base),
    },
    executableExists:
      overrides.executableExists ?? (() => Promise.resolve(true)),
    ...(overrides.executableResolver === undefined
      ? {}
      : { executableResolver: overrides.executableResolver }),
  });
}

async function probeReadiness(probe: PiNativeSessionReadinessProbe) {
  return (await probe.probe())._unsafeUnwrap();
}

/**
 * Records every downstream effect a generation could produce. A generation that
 * cannot prove readiness must leave all of these untouched.
 */
function recordingInitializer(readiness: PiNativeSessionReadinessProbe): {
  readonly initializer: PiSafeInitializer;
  readonly effects: readonly string[];
} {
  const effects: string[] = [];
  const initializer = new PiSafeInitializer({
    hostPackageReader: FakeHostPackageReader.ok({
      name: HOST_PACKAGE_NAME,
      version: "0.83.0",
    }),
    // Every static probe claims support, so any residual readiness can only
    // come from the real native proof.
    capabilityProber: {
      probe: () =>
        ALL_CAPABILITY_IDS.map((capabilityId) => ({
          capabilityId,
          probeStatus: "ok" as const,
        })),
    },
    configActivator: {
      activate: () => {
        effects.push("config-activation");
        return okAsync({
          config: { agents: {}, categories: {}, workflows: {} },
          descriptors: { byName: new Map(), errors: [] },
          childInspectionSettings: { status: "valid", settings: {} },
        } as never);
      },
    } as unknown as PiConfigActivator,
    buildDelegationToolRegistrations: () => {
      effects.push("delegation-tool");
      return [];
    },
    nativeSessionReadiness: readiness,
  });
  return { initializer, effects };
}

function trustedTuiSession() {
  return {
    mode: "tui" as const,
    isProjectTrusted: () => true,
    cwd: "/repo",
    modelRegistry: { getAvailable: () => [] },
  };
}

describe("Pi-native activation readiness: unavailable classes", () => {
  it("reports pi-session-api-unavailable when Pi exposes no session constructors", async () => {
    const readiness = await probeReadiness(
      readinessProbeWith({ SessionManager: { create: () => ({}) } }),
    );

    expect(readiness).toEqual({
      ready: false,
      reason: "pi-session-api-unavailable",
    });
  });

  it("reports pi-session-root-unavailable when the canonical root cannot be located", async () => {
    const readiness = await probeReadiness(
      readinessProbeWith({
        env: { XDG_DATA_HOME: "relative/data/home", HOME: PRIVATE_HOME },
      }),
    );

    expect(readiness).toEqual({
      ready: false,
      reason: "pi-session-root-unavailable",
    });
  });

  it("reports pi-session-root-unsafe when the root cannot hold private permissions", async () => {
    const permissiveFs: PiNativeSessionFsPort = {
      openDirectory: () =>
        errAsync({ type: "permissive-mode", kind: "directory" }),
    };

    const readiness = await probeReadiness(
      readinessProbeWith({ fs: permissiveFs }),
    );

    expect(readiness).toEqual({
      ready: false,
      reason: "pi-session-root-unsafe",
    });
  });

  it("reports pi-session-root-unavailable when the root cannot be initialized", async () => {
    const unreachableFs: PiNativeSessionFsPort = {
      openDirectory: () => errAsync({ type: "unavailable", operation: "open" }),
    };

    const readiness = await probeReadiness(
      readinessProbeWith({ fs: unreachableFs }),
    );

    expect(readiness).toEqual({
      ready: false,
      reason: "pi-session-root-unavailable",
    });
  });

  it("reports pi-process-unavailable when no launch surface exists", async () => {
    const readiness = await probeReadiness(
      readinessProbeWith({ processPort: {} as unknown as PiChildProcessPort }),
    );

    expect(readiness).toEqual({
      ready: false,
      reason: "pi-process-unavailable",
    });
  });

  it("reports pi-process-unavailable when the exact executable does not exist", async () => {
    const readiness = await probeReadiness(
      readinessProbeWith({ executableExists: () => Promise.resolve(false) }),
    );

    expect(readiness).toEqual({
      ready: false,
      reason: "pi-process-unavailable",
    });
  });

  it("reports pi-process-unavailable when a bare executable resolves to nothing", async () => {
    const requested: string[] = [];
    const readiness = await probeReadiness(
      readinessProbeWith({
        childCommand: ["pi", "--mode", "rpc"],
        executableResolver: {
          resolve: (command) => {
            requested.push(command);
            return undefined;
          },
        },
      }),
    );

    expect(requested).toEqual(["pi"]);
    expect(readiness).toEqual({
      ready: false,
      reason: "pi-process-unavailable",
    });
  });

  it("proves readiness when a bare executable resolves through PATH", async () => {
    const requested: string[] = [];
    const probed: string[] = [];
    const readiness = await probeReadiness(
      readinessProbeWith({
        childCommand: ["pi", "--mode", "rpc"],
        executableResolver: {
          resolve: (command) => {
            requested.push(command);
            return "/private/opt/bin/pi";
          },
        },
        executableExists: (path) => {
          probed.push(path);
          return Promise.resolve(true);
        },
      }),
    );

    // The resolved absolute executable, not the bare name, is what must exist.
    expect(requested).toEqual(["pi"]);
    expect(probed).toEqual(["/private/opt/bin/pi"]);
    expect(readiness).toEqual({ ready: true });
  });

  it("reports pi-process-unavailable when a resolved bare executable is absent", async () => {
    const readiness = await probeReadiness(
      readinessProbeWith({
        childCommand: ["pi", "--mode", "rpc"],
        executableResolver: { resolve: () => "/private/opt/bin/pi" },
        executableExists: () => Promise.resolve(false),
      }),
    );

    expect(readiness).toEqual({
      ready: false,
      reason: "pi-process-unavailable",
    });
  });

  it.each([
    ["an empty PATH result", ""],
    ["a relative PATH entry", "bin/pi"],
    ["a cwd-relative PATH entry", "./pi"],
  ])("reports pi-process-unavailable for %s", async (_label, resolved: string) => {
    const readiness = await probeReadiness(
      readinessProbeWith({
        childCommand: ["pi", "--mode", "rpc"],
        executableResolver: { resolve: () => resolved },
        executableExists: () => Promise.resolve(true),
      }),
    );

    expect(readiness).toEqual({
      ready: false,
      reason: "pi-process-unavailable",
    });
  });

  it("reports pi-process-unavailable when the executable resolver throws", async () => {
    const readiness = await probeReadiness(
      readinessProbeWith({
        childCommand: ["pi", "--mode", "rpc"],
        executableResolver: {
          resolve: () => {
            throw new Error("/private/home/example/.local/bin denied");
          },
        },
      }),
    );

    // The thrown value carries a host path; only the closed reason survives.
    expect(readiness).toEqual({
      ready: false,
      reason: "pi-process-unavailable",
    });
    expect(JSON.stringify(readiness)).not.toContain("/private");
  });

  it("proves readiness against a real root, session API, and launch surface", async () => {
    const fs = new MemoryPiNativeSessionFs();
    const readiness = await probeReadiness(readinessProbeWith({ fs }));

    expect(readiness).toEqual({ ready: true });
  });

  it("keeps every readiness reason closed and path-free", () => {
    expect({
      unsafeRoot: mapSessionRootErrorToReadinessReason({
        type: "SessionRootViolation",
        reason: "writable-data-root",
      }),
      symlinkedRoot: mapSessionRootErrorToReadinessReason({
        type: "SessionRootViolation",
        reason: "symlink-rejected",
      }),
      missingRoot: mapSessionRootErrorToReadinessReason({
        type: "SessionRootViolation",
        reason: "empty-home",
      }),
      storageDown: mapSessionRootErrorToReadinessReason({
        type: "SessionStorageUnavailable",
        reason: "filesystem-unavailable",
      }),
      permissiveOpen: mapRootOpenFailureToReadinessReason("permissive-mode"),
      absentOpen: mapRootOpenFailureToReadinessReason("missing"),
      sessionFlagCommand: isProcessLaunchSurfaceUsable(
        new FakeChildProcessPort(),
        [CHILD_EXECUTABLE, "--mode", "rpc", "--no-session"],
      ),
      emptyCommand: isProcessLaunchSurfaceUsable(
        new FakeChildProcessPort(),
        [],
      ),
      realCommand: isProcessLaunchSurfaceUsable(new FakeChildProcessPort(), [
        CHILD_EXECUTABLE,
        "--mode",
        "rpc",
      ]),
    }).toEqual({
      unsafeRoot: "pi-session-root-unsafe",
      symlinkedRoot: "pi-session-root-unsafe",
      missingRoot: "pi-session-root-unavailable",
      storageDown: "pi-session-root-unavailable",
      permissiveOpen: "pi-session-root-unsafe",
      absentOpen: "pi-session-root-unavailable",
      sessionFlagCommand: false,
      emptyCommand: false,
      realCommand: true,
    });
  });
});

describe("Pi-native activation readiness: preflight integration", () => {
  it("does not report ready from static surfaces alone when native readiness is unproven", async () => {
    const { initializer, effects } = recordingInitializer(
      createBlockedPiNativeSessionReadinessProbe("pi-session-root-unsafe"),
    );

    const preflight = (
      await initializer.preflight(
        trustedTuiSession(),
        ALL_OWNED_COMMANDS,
        readyHostSurfaceReport(),
      )
    )._unsafeUnwrap();
    const delegation = preflight.healthReport.probeResults.find(
      (probe) => probe.capabilityId === "delegated-specialist-execution",
    );
    const publicOutput = JSON.stringify({
      readiness: preflight.nativeSessionReadiness,
      probes: preflight.healthReport.probeResults,
      gaps: preflight.requiredCapabilityGaps,
    });

    expect({
      healthOnlyMode: preflight.healthOnlyMode,
      readiness: preflight.nativeSessionReadiness,
      delegationProbe: delegation,
      everyProbeUnavailable: preflight.healthReport.probeResults.every(
        (probe) => probe.probeStatus === "unavailable",
      ),
      // Zero downstream effects: config never loaded, nothing materialized,
      // no delegation tool prepared, no primary committed.
      effects,
      configActivation: preflight.configActivation,
      toolRegistrations: preflight.toolRegistrations,
      leakedPath: publicOutput.includes("/"),
    }).toEqual({
      healthOnlyMode: true,
      readiness: { ready: false, reason: "pi-session-root-unsafe" },
      delegationProbe: {
        capabilityId: "delegated-specialist-execution",
        probeStatus: "unavailable",
        details: "pi-session-root-unsafe",
      },
      everyProbeUnavailable: true,
      effects: [],
      configActivation: undefined,
      toolRegistrations: [],
      leakedPath: false,
    });
  });

  it("fails closed to health-only when no readiness probe is wired at all", async () => {
    const initializer = new PiSafeInitializer({
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
      configActivator: {
        activate: () => okAsync({} as never),
      } as unknown as PiConfigActivator,
    });

    const preflight = (
      await initializer.preflight(
        trustedTuiSession(),
        ALL_OWNED_COMMANDS,
        readyHostSurfaceReport(),
      )
    )._unsafeUnwrap();

    expect({
      healthOnlyMode: preflight.healthOnlyMode,
      readiness: preflight.nativeSessionReadiness,
      configActivation: preflight.configActivation,
    }).toEqual({
      healthOnlyMode: true,
      readiness: { ready: false, reason: "pi-session-api-unavailable" },
      configActivation: undefined,
    });
  });

  it("fails closed when the injected readiness probe misbehaves and throws", async () => {
    const { initializer, effects } = recordingInitializer({
      probe: () => {
        throw new Error(`native probe exploded reading ${CHILD_EXECUTABLE}`);
      },
    });

    const preflight = (
      await initializer.preflight(
        trustedTuiSession(),
        ALL_OWNED_COMMANDS,
        readyHostSurfaceReport(),
      )
    )._unsafeUnwrap();

    expect({
      healthOnlyMode: preflight.healthOnlyMode,
      readiness: preflight.nativeSessionReadiness,
      effects,
      leakedExecutable: JSON.stringify(preflight.healthReport).includes(
        CHILD_EXECUTABLE,
      ),
    }).toEqual({
      healthOnlyMode: true,
      readiness: { ready: false, reason: "pi-session-api-unavailable" },
      effects: [],
      leakedExecutable: false,
    });
  });

  it("does not probe readiness (and never initializes a root) for an already health-only generation", async () => {
    let probeCalls = 0;
    const { initializer } = recordingInitializer({
      probe: () => {
        probeCalls += 1;
        return okAsync({ ready: true as const });
      },
    });

    const preflight = (
      await initializer.preflight(
        {
          mode: "tui" as const,
          // Withheld project trust: already health-only before readiness.
          isProjectTrusted: () => false,
          cwd: "/repo",
          modelRegistry: { getAvailable: () => [] },
        },
        ALL_OWNED_COMMANDS,
        readyHostSurfaceReport(),
      )
    )._unsafeUnwrap();

    expect({
      probeCalls,
      healthOnlyMode: preflight.healthOnlyMode,
      readiness: preflight.nativeSessionReadiness,
    }).toEqual({
      probeCalls: 0,
      healthOnlyMode: true,
      readiness: undefined,
    });
  });

  it("reaches ready and activates config only once native readiness is proved", async () => {
    const { initializer, effects } = recordingInitializer(
      createReadyPiNativeSessionReadinessProbe(),
    );

    const preflight = (
      await initializer.preflight(
        trustedTuiSession(),
        ALL_OWNED_COMMANDS,
        readyHostSurfaceReport(),
      )
    )._unsafeUnwrap();

    expect({
      healthOnlyMode: preflight.healthOnlyMode,
      readiness: preflight.nativeSessionReadiness,
      activated: effects.includes("config-activation"),
    }).toEqual({
      healthOnlyMode: false,
      readiness: { ready: true },
      activated: true,
    });
  });

  it("keeps the host-surface gap reason closed when both surfaces and readiness fail", async () => {
    const probes = new DefaultPiCapabilityProber().probe({
      mode: "tui",
      trust: "trusted",
      commands: ALL_OWNED_COMMANDS,
      hostSurface: {
        probes: [
          {
            surfaceId: "custom-session-directory",
            status: "unavailable",
            details: `open failed for ${PRIVATE_HOME}/.local/share`,
          },
        ],
        requiredGaps: ["custom-session-directory"],
        overlayFallbackGaps: [],
      },
    });
    const delegation = probes.find(
      (probe) => probe.capabilityId === "delegated-specialist-execution",
    );

    expect({
      delegation,
      leakedPath: JSON.stringify(delegation).includes(PRIVATE_HOME),
    }).toEqual({
      delegation: {
        capabilityId: "delegated-specialist-execution",
        probeStatus: "unavailable",
        details: "pi-session-api-unavailable",
      },
      leakedPath: false,
    });
  });
});
