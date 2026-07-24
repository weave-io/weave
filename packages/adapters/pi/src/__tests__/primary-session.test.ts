import { describe, expect, it } from "bun:test";
import type {
  AgentDescriptor,
  EffectiveToolPolicy,
} from "@weaveio/weave-engine";
import { errAsync, okAsync } from "neverthrow";
import type { PiModelApplyPort } from "../model-resolution.js";
import {
  appendWeaveBlockOnce,
  PiPrimarySession,
  renderWeavePromptBlock,
} from "../primary-session.js";
import { PiSkillCatalog } from "../skill-catalog.js";
import type { PiModelInfo } from "../types.js";
import { RecordingLogger } from "./fakes/fake-pi-host.js";

const POLICY: EffectiveToolPolicy = {
  read: "allow",
  write: "allow",
  execute: "allow",
  delegate: "allow",
  network: "ask",
};

function descriptor(overrides: Partial<AgentDescriptor> = {}): AgentDescriptor {
  return {
    name: "loom",
    composedPrompt: "You are Loom, the orchestrator.",
    models: ["claude-sonnet-4-5"],
    mode: "primary",
    effectiveToolPolicy: POLICY,
    rawToolPolicy: undefined,
    delegationTargets: [],
    skills: [],
    ...overrides,
  };
}

const CATALOG: PiModelInfo[] = [
  { provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
];

interface FakeApplier extends PiModelApplyPort {
  readonly calls: PiModelInfo[];
}

function fakeApplier(succeed = true): FakeApplier {
  const calls: PiModelInfo[] = [];
  return {
    calls,
    applyModel: (model) => {
      calls.push(model);
      return succeed
        ? okAsync(undefined)
        : errAsync(new Error("setModel rejected"));
    },
  };
}

function context(overrides: Record<string, unknown> = {}) {
  return {
    availableModels: CATALOG,
    currentModel: undefined,
    modelApplier: fakeApplier(),
    ...overrides,
  };
}

describe("renderWeavePromptBlock / appendWeaveBlockOnce", () => {
  it("renders one delimited block with the descriptor's stable identity and final composedPrompt", () => {
    const block = renderWeavePromptBlock(descriptor());
    expect(block).toContain('name="loom"');
    expect(block).toContain("You are Loom, the orchestrator.");
  });

  it("appends to a non-empty system prompt without dropping existing content", () => {
    const result = appendWeaveBlockOnce(
      "Pi's native system prompt.",
      descriptor(),
    );
    expect(result).toContain("Pi's native system prompt.");
    expect(result).toContain("You are Loom, the orchestrator.");
  });

  it("does not append twice for the same descriptor identity", () => {
    const once = appendWeaveBlockOnce("base", descriptor());
    const twice = appendWeaveBlockOnce(once, descriptor());
    expect(twice).toBe(once);
    expect(twice.split('weave:agent:start name="loom"').length - 1).toBe(1);
  });
});

describe("PiPrimarySession.activate", () => {
  it("atomically activates a primary-mode descriptor: identity, prompt, applied model, skills", async () => {
    const applier = fakeApplier();
    const session = new PiPrimarySession({
      skillCatalog: new PiSkillCatalog([{ name: "tdd" }]),
      logger: new RecordingLogger(),
    });

    const result = await session.activate(
      descriptor({ skills: ["tdd"] }),
      context({ modelApplier: applier }),
    );

    expect(result.isOk()).toBe(true);
    const active = result._unsafeUnwrap();
    expect(active.descriptor.name).toBe("loom");
    expect(active.promptBlock).toContain("You are Loom, the orchestrator.");
    expect(active.modelActivation).toEqual({
      status: "applied",
      model: CATALOG[0],
      intentEntry: "claude-sonnet-4-5",
      source: "bare-id",
    });
    expect(applier.calls).toEqual([CATALOG[0]]);
    expect(active.resolvedSkills.map((s) => s.name)).toEqual(["tdd"]);
    expect(session.getCurrent()).toEqual(active);
  });

  it("allows mode: all descriptors as primary", async () => {
    const session = new PiPrimarySession({
      skillCatalog: new PiSkillCatalog(),
      logger: new RecordingLogger(),
    });
    const result = await session.activate(
      descriptor({ mode: "all" }),
      context({ availableModels: [] }),
    );
    expect(result.isOk()).toBe(true);
  });

  it("rejects mode: subagent descriptors and leaves prior state untouched", async () => {
    const session = new PiPrimarySession({
      skillCatalog: new PiSkillCatalog(),
      logger: new RecordingLogger(),
    });
    const first = await session.activate(descriptor(), context());
    expect(first.isOk()).toBe(true);

    const rejected = await session.activate(
      descriptor({ name: "shuttle", mode: "subagent" }),
      context(),
    );
    expect(rejected.isErr()).toBe(true);
    expect(rejected._unsafeUnwrapErr()).toEqual({
      type: "NotEligiblePrimary",
      agentName: "shuttle",
      mode: "subagent",
    });
    // Atomicity: the rejected candidate never replaces the current primary.
    expect(session.getCurrent()?.descriptor.name).toBe("loom");
  });

  it("fails atomically when a requested skill is missing, without applying a model or mutating current state", async () => {
    const applier = fakeApplier();
    const session = new PiPrimarySession({
      skillCatalog: new PiSkillCatalog([]),
      logger: new RecordingLogger(),
    });
    const first = await session.activate(
      descriptor(),
      context({ modelApplier: applier }),
    );
    expect(first.isOk()).toBe(true);

    const failed = await session.activate(
      descriptor({ name: "loom-v2", skills: ["missing-skill"] }),
      context({ modelApplier: applier }),
    );
    expect(failed.isErr()).toBe(true);
    expect(failed._unsafeUnwrapErr()).toEqual({
      type: "SkillResolutionFailed",
      agentName: "loom-v2",
      errors: [
        {
          type: "MissingSkill",
          agentName: "loom-v2",
          skillName: "missing-skill",
        },
      ],
    });
    expect(session.getCurrent()?.descriptor.name).toBe("loom");
    // The failed candidate's model must never have been applied.
    expect(applier.calls).toEqual([CATALOG[0]]);
  });

  it("reports the model degraded (unresolved) when nothing in the intent matches, but still commits the descriptor", async () => {
    const applier = fakeApplier();
    const session = new PiPrimarySession({
      skillCatalog: new PiSkillCatalog(),
      logger: new RecordingLogger(),
    });
    const result = await session.activate(
      descriptor({ models: ["nonexistent"] }),
      context({ modelApplier: applier, currentModel: CATALOG[0] }),
    );
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().modelActivation).toEqual({
      status: "degraded",
      reason: "unresolved",
      currentModel: CATALOG[0],
    });
    expect(applier.calls).toEqual([]);
    expect(session.getCurrent()?.descriptor.name).toBe(descriptor().name);
  });

  it("reports the model degraded (apply-failed) when the host rejects setModel, but still commits the descriptor", async () => {
    const applier = fakeApplier(false);
    const session = new PiPrimarySession({
      skillCatalog: new PiSkillCatalog(),
      logger: new RecordingLogger(),
    });
    const result = await session.activate(
      descriptor(),
      context({ modelApplier: applier, currentModel: CATALOG[0] }),
    );
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().modelActivation).toEqual({
      status: "degraded",
      reason: "apply-failed",
      currentModel: CATALOG[0],
    });
  });

  it("exposes a visible, deduplicated model capability warning when the model is degraded", async () => {
    const session = new PiPrimarySession({
      skillCatalog: new PiSkillCatalog(),
      logger: new RecordingLogger(),
    });
    await session.activate(descriptor({ models: ["nonexistent"] }), context());
    await session.activate(
      descriptor({ name: "loom-v2", models: ["nonexistent"] }),
      context(),
    );

    const warnings = session
      .getCapabilityWarnings()
      .filter((w) => w.capability === "model");
    // Same agentName + detail combination is deduplicated; a different
    // agentName is a distinct, separately-surfaced warning.
    expect(warnings).toHaveLength(2);
    expect(warnings[0]?.agentName).toBe("loom");
    expect(warnings[1]?.agentName).toBe("loom-v2");
  });

  it("ignores a declared temperature, keeps the descriptor usable, and exposes exactly one deduplicated capability warning across the session", async () => {
    const logger = new RecordingLogger();
    const session = new PiPrimarySession({
      skillCatalog: new PiSkillCatalog(),
      logger,
    });

    const first = await session.activate(
      descriptor({ temperature: 0.7 }),
      context(),
    );
    expect(first.isOk()).toBe(true);
    expect(first._unsafeUnwrap().temperatureDegraded).toBe(true);

    const second = await session.activate(
      descriptor({ name: "loom-v2", temperature: 0.9 }),
      context(),
    );
    expect(second.isOk()).toBe(true);
    expect(second._unsafeUnwrap().temperatureDegraded).toBe(true);

    // Same agentName+detail is deduplicated; a *different* descriptor name
    // declaring temperature is still its own distinct, visible warning.
    const tempWarnings = session
      .getCapabilityWarnings()
      .filter((w) => w.capability === "temperature");
    expect(tempWarnings.map((w) => w.agentName)).toEqual(["loom", "loom-v2"]);

    const warnEntries = logger.entries.filter((e) => e.level === "warn");
    expect(warnEntries.length).toBeGreaterThan(0);
  });

  it("does not warn when temperature is undeclared", async () => {
    const logger = new RecordingLogger();
    const session = new PiPrimarySession({
      skillCatalog: new PiSkillCatalog(),
      logger,
    });
    await session.activate(descriptor(), context());
    expect(
      session
        .getCapabilityWarnings()
        .filter((w) => w.capability === "temperature"),
    ).toHaveLength(0);
  });

  it("does not re-warn for the same descriptor+detail combination on repeated activation", async () => {
    const session = new PiPrimarySession({
      skillCatalog: new PiSkillCatalog(),
      logger: new RecordingLogger(),
    });
    await session.activate(descriptor({ temperature: 0.7 }), context());
    await session.activate(descriptor({ temperature: 0.7 }), context());
    expect(
      session
        .getCapabilityWarnings()
        .filter((w) => w.capability === "temperature"),
    ).toHaveLength(1);
  });
});

describe("PiPrimarySession.restorePrevious", () => {
  it("re-activates the descriptor active before the current one", async () => {
    const session = new PiPrimarySession({
      skillCatalog: new PiSkillCatalog(),
      logger: new RecordingLogger(),
    });
    const loom = descriptor();
    const tapestry = descriptor({ name: "tapestry", mode: "all" });
    const byName = new Map([
      ["loom", loom],
      ["tapestry", tapestry],
    ]);

    await session.activate(loom, context());
    await session.activate(tapestry, context());
    expect(session.getCurrent()?.descriptor.name).toBe("tapestry");

    const restored = await session.restorePrevious(byName, context());
    expect(restored.isOk()).toBe(true);
    expect(restored._unsafeUnwrap().descriptor.name).toBe("loom");
    expect(session.getCurrent()?.descriptor.name).toBe("loom");
  });

  it("errs with NoPriorPrimary when nothing was ever activated before", async () => {
    const session = new PiPrimarySession({
      skillCatalog: new PiSkillCatalog(),
      logger: new RecordingLogger(),
    });
    const restored = await session.restorePrevious(new Map(), context());
    expect(restored.isErr()).toBe(true);
    expect(restored._unsafeUnwrapErr()).toEqual({ type: "NoPriorPrimary" });
  });

  it("errs with DescriptorNotFound when the prior descriptor no longer exists in the catalog", async () => {
    const session = new PiPrimarySession({
      skillCatalog: new PiSkillCatalog(),
      logger: new RecordingLogger(),
    });
    await session.activate(descriptor(), context());
    await session.activate(
      descriptor({ name: "tapestry", mode: "all" }),
      context(),
    );

    const restored = await session.restorePrevious(new Map(), context());
    expect(restored.isErr()).toBe(true);
    expect(restored._unsafeUnwrapErr()).toEqual({
      type: "DescriptorNotFound",
      agentName: "loom",
    });
  });
});

describe("PiPrimarySession.appendToSystemPrompt", () => {
  it("returns the prompt unchanged when there is no active primary", () => {
    const session = new PiPrimarySession({
      skillCatalog: new PiSkillCatalog(),
      logger: new RecordingLogger(),
    });
    expect(session.appendToSystemPrompt("native prompt")).toBe("native prompt");
  });

  it("appends the current primary's block", async () => {
    const session = new PiPrimarySession({
      skillCatalog: new PiSkillCatalog(),
      logger: new RecordingLogger(),
    });
    await session.activate(descriptor(), context());
    const result = session.appendToSystemPrompt("native prompt");
    expect(result).toContain("native prompt");
    expect(result).toContain("You are Loom, the orchestrator.");
  });
});
