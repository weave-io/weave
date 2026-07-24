import { describe, expect, it } from "bun:test";
import { ALL_CAPABILITY_IDS } from "@weaveio/weave-engine";
import {
  buildBlockedProbeSet,
  DefaultPiCapabilityProber,
  PROJECT_PATH_DEPENDENT_CAPABILITIES,
  sanitizeCapabilityProbeResults,
} from "../capability-prober.js";
import { ADAPTER_PACKAGE_IDENTITY, WEAVE_COMMAND_NAMES } from "../commands.js";
import type { PiCommandInfo } from "../types.js";

/**
 * A command whose `sourceInfo` proves canonical ownership (Spec 33 §7.1):
 * `origin: "package"` plus a `source` that resolves, via the same
 * `npm:<name>[@version]` convention Pi's own package manager uses, to this
 * package's exact npm name. Ownership MUST NOT be inferred from the command
 * name or from `path` substring matching.
 */
function ownedCommand(name: string): PiCommandInfo {
  return {
    name,
    source: "extension",
    sourceInfo: {
      path: `/node_modules/${ADAPTER_PACKAGE_IDENTITY}/dist/extension.js`,
      source: `npm:${ADAPTER_PACKAGE_IDENTITY}`,
      scope: "user",
      origin: "package",
    },
  };
}

/** A command registered by some other npm-installed extension. */
function foreignCommand(
  name: string,
  source = "npm:some-other-extension",
): PiCommandInfo {
  return {
    name,
    source: "extension",
    sourceInfo: {
      path: "/node_modules/some-other-extension/dist/index.js",
      source,
      scope: "user",
      origin: "package",
    },
  };
}

const ALL_OWNED_COMMANDS = WEAVE_COMMAND_NAMES.map(ownedCommand);

describe("buildBlockedProbeSet", () => {
  it("returns exactly one unavailable probe for all 19 capability IDs", () => {
    const probes = buildBlockedProbeSet("interactive-tui-required");
    expect(probes).toHaveLength(19);
    expect(probes).toHaveLength(ALL_CAPABILITY_IDS.length);
    for (const probe of probes) {
      expect(probe.probeStatus).toBe("unavailable");
      expect(probe.details).toBe("interactive-tui-required");
    }
    const ids = probes.map((probe) => probe.capabilityId).sort();
    expect(ids).toEqual([...ALL_CAPABILITY_IDS].sort());
  });
});

describe("DefaultPiCapabilityProber", () => {
  const prober = new DefaultPiCapabilityProber();

  it("returns exactly one probe per capability ID, in the trusted case", () => {
    const probes = prober.probe({
      mode: "tui",
      trust: "trusted",
      commands: ALL_OWNED_COMMANDS,
    });
    expect(probes).toHaveLength(19);
    const ids = probes.map((probe) => probe.capabilityId);
    expect(new Set(ids).size).toBe(19);
    expect([...ids].sort()).toEqual([...ALL_CAPABILITY_IDS].sort());
  });

  it("reports command-entrypoints ok when all nine commands are exclusively owned", () => {
    const probes = prober.probe({
      mode: "tui",
      trust: "trusted",
      commands: ALL_OWNED_COMMANDS,
    });
    const entry = probes.find(
      (probe) => probe.capabilityId === "command-entrypoints",
    );
    expect(entry?.probeStatus).toBe("ok");
  });

  it("reports command-entrypoints unavailable when a command is missing", () => {
    const missingOne = ALL_OWNED_COMMANDS.filter(
      (command) => command.name !== "weave:start",
    );
    const probes = prober.probe({
      mode: "tui",
      trust: "trusted",
      commands: missingOne,
    });
    const entry = probes.find(
      (probe) => probe.capabilityId === "command-entrypoints",
    );
    expect(entry?.probeStatus).toBe("unavailable");
    expect(entry?.details).toContain("weave:start");
  });

  it("reports command-entrypoints unavailable when our registration was suffixed by a collision", () => {
    const suffixed = ALL_OWNED_COMMANDS.map((command) =>
      command.name === "weave:health"
        ? { ...command, name: "weave:health:2" }
        : command,
    );
    const probes = prober.probe({
      mode: "tui",
      trust: "trusted",
      commands: suffixed,
    });
    const entry = probes.find(
      (probe) => probe.capabilityId === "command-entrypoints",
    );
    expect(entry?.probeStatus).toBe("unavailable");
  });

  it("reports command-entrypoints unavailable when a rival suffix exists even though we still hold the bare name", () => {
    const rivalSuffixed = foreignCommand("weave:health:1");
    const probes = prober.probe({
      mode: "tui",
      trust: "trusted",
      commands: [...ALL_OWNED_COMMANDS, rivalSuffixed],
    });
    const entry = probes.find(
      (probe) => probe.capabilityId === "command-entrypoints",
    );
    expect(entry?.probeStatus).toBe("unavailable");
    expect(entry?.details).toContain("weave:health");
  });

  it("does not treat a foreign command as owned merely because its path string contains our package name", () => {
    const spoofed = ALL_OWNED_COMMANDS.map((command) =>
      command.name === "weave:start"
        ? {
            ...command,
            sourceInfo: {
              ...command.sourceInfo,
              path: `/node_modules/rogue-extension/vendored/${ADAPTER_PACKAGE_IDENTITY}/dist/index.js`,
              source: "npm:rogue-extension",
            },
          }
        : command,
    );
    const probes = prober.probe({
      mode: "tui",
      trust: "trusted",
      commands: spoofed,
    });
    const entry = probes.find(
      (probe) => probe.capabilityId === "command-entrypoints",
    );
    expect(entry?.probeStatus).toBe("unavailable");
    expect(entry?.details).toContain("weave:start");
  });

  it("does not treat a same-name package-origin command as owned when the npm source name differs", () => {
    const rivalSameName = ALL_OWNED_COMMANDS.map((command) =>
      command.name === "weave:plan"
        ? foreignCommand("weave:plan", "npm:@weaveio/weave-adapter-pi-fake")
        : command,
    );
    const probes = prober.probe({
      mode: "tui",
      trust: "trusted",
      commands: rivalSameName,
    });
    const entry = probes.find(
      (probe) => probe.capabilityId === "command-entrypoints",
    );
    expect(entry?.probeStatus).toBe("unavailable");
  });

  it("reports token-usage-reporting ok regardless of trust", () => {
    const probes = prober.probe({
      mode: "tui",
      trust: "withheld",
      commands: ALL_OWNED_COMMANDS,
    });
    const entry = probes.find(
      (probe) => probe.capabilityId === "token-usage-reporting",
    );
    expect(entry?.probeStatus).toBe("ok");
  });

  it("reports every not-yet-implemented capability as unavailable when trusted", () => {
    const probes = prober.probe({
      mode: "tui",
      trust: "trusted",
      commands: ALL_OWNED_COMMANDS,
    });
    for (const id of PROJECT_PATH_DEPENDENT_CAPABILITIES) {
      const entry = probes.find((probe) => probe.capabilityId === id);
      expect(entry?.probeStatus).toBe("unavailable");
      expect(entry?.details).toBe("not-yet-implemented");
    }
  });

  it("reports project-path-dependent capabilities as ok-with-note when trust is withheld", () => {
    const probes = prober.probe({
      mode: "tui",
      trust: "withheld",
      commands: ALL_OWNED_COMMANDS,
    });
    for (const id of PROJECT_PATH_DEPENDENT_CAPABILITIES) {
      const entry = probes.find((probe) => probe.capabilityId === id);
      expect(entry?.probeStatus).toBe("ok");
      expect(entry?.details).toBe("project-trust-withheld");
    }
  });

  it("does not let trust-withheld ok-with-note apply to non-project-path capabilities", () => {
    const probes = prober.probe({
      mode: "tui",
      trust: "withheld",
      commands: ALL_OWNED_COMMANDS,
    });
    const promptComposition = probes.find(
      (probe) => probe.capabilityId === "prompt-composition",
    );
    expect(promptComposition?.probeStatus).toBe("unavailable");
    expect(promptComposition?.details).toBe("not-yet-implemented");
  });
});

describe("sanitizeCapabilityProbeResults", () => {
  function okProbe(id: string, details?: string) {
    return details === undefined
      ? { capabilityId: id, probeStatus: "ok" }
      : { capabilityId: id, probeStatus: "ok", details };
  }

  function fullValidSet(): Record<string, unknown>[] {
    return ALL_CAPABILITY_IDS.map((id) => okProbe(id));
  }

  it("passes a fully well-formed probe set through unchanged, one row per ID", () => {
    const sanitized = sanitizeCapabilityProbeResults(fullValidSet());
    expect(sanitized).toHaveLength(19);
    expect([...sanitized.map((probe) => probe.capabilityId)].sort()).toEqual(
      [...ALL_CAPABILITY_IDS].sort(),
    );
    for (const probe of sanitized) {
      expect(probe.probeStatus).toBe("ok");
    }
  });

  it("normalizes a missing capability ID to a single unavailable row", () => {
    const raw = fullValidSet().filter(
      (probe) => probe.capabilityId !== "workflow-persistence",
    );
    const sanitized = sanitizeCapabilityProbeResults(raw);
    expect(sanitized).toHaveLength(19);
    const entry = sanitized.find(
      (probe) => probe.capabilityId === "workflow-persistence",
    );
    expect(entry?.probeStatus).toBe("unavailable");
  });

  it("normalizes a duplicated capability ID (same status) to a single unavailable row", () => {
    const raw = [...fullValidSet(), okProbe("workflow-persistence")];
    const sanitized = sanitizeCapabilityProbeResults(raw);
    expect(sanitized).toHaveLength(19);
    const entries = sanitized.filter(
      (probe) => probe.capabilityId === "workflow-persistence",
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]?.probeStatus).toBe("unavailable");
  });

  it("normalizes a contradictory capability ID (disagreeing statuses) to a single unavailable row", () => {
    const raw = fullValidSet().map((probe) =>
      probe.capabilityId === "tool-policy-mapping"
        ? { ...probe, probeStatus: "unavailable" }
        : probe,
    );
    raw.push(okProbe("tool-policy-mapping"));
    const sanitized = sanitizeCapabilityProbeResults(raw);
    expect(sanitized).toHaveLength(19);
    const entries = sanitized.filter(
      (probe) => probe.capabilityId === "tool-policy-mapping",
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]?.probeStatus).toBe("unavailable");
  });

  it("normalizes a malformed probeStatus value to a single unavailable row", () => {
    const raw = fullValidSet().map((probe) =>
      probe.capabilityId === "event-logging"
        ? { ...probe, probeStatus: "super-ok" }
        : probe,
    );
    const sanitized = sanitizeCapabilityProbeResults(raw);
    expect(sanitized).toHaveLength(19);
    const entry = sanitized.find(
      (probe) => probe.capabilityId === "event-logging",
    );
    expect(entry?.probeStatus).toBe("unavailable");
  });

  it("drops an entry for an unrecognized capability ID without adding an extra row", () => {
    const raw = [
      ...fullValidSet(),
      { capabilityId: "not-a-real-capability", probeStatus: "ok" },
    ];
    const sanitized = sanitizeCapabilityProbeResults(raw);
    expect(sanitized).toHaveLength(19);
    expect(
      sanitized.some(
        (probe) => (probe.capabilityId as string) === "not-a-real-capability",
      ),
    ).toBe(false);
  });

  it("normalizes unsafe (oversized) detail data to a single unavailable row", () => {
    const raw = fullValidSet().map((probe) =>
      probe.capabilityId === "agent-materialization"
        ? { ...probe, details: "x".repeat(10_000) }
        : probe,
    );
    const sanitized = sanitizeCapabilityProbeResults(raw);
    expect(sanitized).toHaveLength(19);
    const entry = sanitized.find(
      (probe) => probe.capabilityId === "agent-materialization",
    );
    expect(entry?.probeStatus).toBe("unavailable");
  });

  it("normalizes unsafe (non-printable / control-character) detail data to a single unavailable row", () => {
    const raw = fullValidSet().map((probe) =>
      probe.capabilityId === "primary-agent-selection"
        ? { ...probe, details: "leaked-secret\u0000\nsomething" }
        : probe,
    );
    const sanitized = sanitizeCapabilityProbeResults(raw);
    expect(sanitized).toHaveLength(19);
    const entry = sanitized.find(
      (probe) => probe.capabilityId === "primary-agent-selection",
    );
    expect(entry?.probeStatus).toBe("unavailable");
  });

  it("handles every anomaly kind at once and still returns exactly 19 fail-closed rows", () => {
    const raw: Record<string, unknown>[] = [
      // missing: config-materialization omitted entirely
      okProbe("agent-materialization"),
      okProbe("primary-agent-selection"),
      okProbe("delegated-specialist-execution"),
      okProbe("prompt-composition"),
      okProbe("tool-policy-mapping"),
      // duplicate
      okProbe("workflow-persistence"),
      okProbe("workflow-persistence"),
      // contradictory
      okProbe("workflow-step-dispatch"),
      { capabilityId: "workflow-step-dispatch", probeStatus: "unavailable" },
      okProbe("plan-file-compatibility"),
      okProbe("command-entrypoints"),
      okProbe("event-logging"),
      // malformed status
      { capabilityId: "token-usage-reporting", probeStatus: "weird-status" },
      okProbe("context-window-monitor"),
      okProbe("idle-continuation"),
      okProbe("compaction-recovery"),
      okProbe("analytics-dashboard"),
      okProbe("static-artifact-generation"),
      okProbe("eval-integration"),
      okProbe("multiple-active-workflows"),
      // unknown ID, must be dropped without adding a row
      { capabilityId: "not-a-real-capability", probeStatus: "ok" },
      // unsafe detail on an otherwise well-formed, unique, valid-status probe
      {
        ...okProbe("multiple-active-workflows"),
        details: "\u0007bell-and-\u0000null",
      },
    ];
    const sanitized = sanitizeCapabilityProbeResults(raw);
    expect(sanitized).toHaveLength(19);
    expect([...sanitized.map((probe) => probe.capabilityId)].sort()).toEqual(
      [...ALL_CAPABILITY_IDS].sort(),
    );
    const byId = new Map(sanitized.map((probe) => [probe.capabilityId, probe]));
    expect(byId.get("config-materialization")?.probeStatus).toBe("unavailable");
    expect(byId.get("workflow-persistence")?.probeStatus).toBe("unavailable");
    expect(byId.get("workflow-step-dispatch")?.probeStatus).toBe("unavailable");
    expect(byId.get("token-usage-reporting")?.probeStatus).toBe("unavailable");
    // multiple-active-workflows now has 2 raw entries (its own + the unsafe-detail one) -> duplicate -> unavailable
    expect(byId.get("multiple-active-workflows")?.probeStatus).toBe(
      "unavailable",
    );
    expect(byId.get("agent-materialization")?.probeStatus).toBe("ok");
  });
});
