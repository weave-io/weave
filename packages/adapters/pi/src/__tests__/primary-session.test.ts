import { describe, expect, it } from "bun:test";
import type {
  AgentDescriptor,
  EffectiveToolPolicy,
} from "@weaveio/weave-engine";
import { errAsync, okAsync } from "neverthrow";
import { fingerprintPiAssistantMessage } from "../model-failover-contract.js";
import { createPiModelFailoverCoordinator } from "../model-failover-coordinator.js";
import {
  type PiModelActivationOutcome,
  PiModelActivator,
  type PiModelApplyPort,
  resolvePiOrderedDistinctModels,
} from "../model-resolution.js";
import {
  appendWeaveBlockOnce,
  isReadOnlyChildAccessAllowed,
  PiPrimarySession,
  probeParentSession,
  renderWeavePromptBlock,
  requirePersistentParentSession,
  UNKNOWN_PARENT_SESSION,
} from "../primary-session.js";
import { PiSkillCatalog } from "../skill-catalog.js";
import {
  type PiModelInfo,
  type PiSourceInfo,
  projectPiProviderEvent,
} from "../types.js";
import {
  RecordingFakePiHost,
  RecordingFakeTimerPort,
  RecordingLogger,
} from "./fakes/fake-pi-host.js";

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

const SNAPSHOT_CATALOG: PiModelInfo[] = [
  {
    provider: "anthropic",
    id: "claude-sonnet-4-5",
    name: "Claude Sonnet 4.5",
  },
  { provider: "openai", id: "gpt-5.6", name: "GPT-5.6" },
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

describe("PiPrimarySession.prepareComposedPrompt", () => {
  it("loads available skills for a delegated agent and warns for missing ones", () => {
    const session = new PiPrimarySession({
      skillCatalog: new PiSkillCatalog([{ name: "tdd" }]),
      logger: new RecordingLogger(),
    });

    const prompt = session.prepareComposedPrompt(
      descriptor({
        name: "shuttle",
        mode: "subagent",
        skills: ["tdd", "missing-skill"],
      }),
    );

    expect(prompt).toContain(
      'Required skill names to load before work: ["tdd"]',
    );
    expect(prompt).not.toContain('["tdd","missing-skill"]');
    expect(prompt).toContain("You are Loom, the orchestrator.");
    expect(session.getCapabilityWarnings()).toEqual([
      {
        capability: "skill",
        agentName: "shuttle",
        detail:
          'required skill "missing-skill" is unavailable in Pi; continuing without it',
      },
    ]);
  });

  it("silently filters a disabled delegated skill", () => {
    const session = new PiPrimarySession({
      skillCatalog: new PiSkillCatalog(),
      logger: new RecordingLogger(),
    });

    expect(
      session.prepareComposedPrompt(
        descriptor({ name: "shuttle", skills: ["disabled-skill"] }),
        ["disabled-skill"],
      ),
    ).toBe("You are Loom, the orchestrator.");
    expect(session.getCapabilityWarnings()).toEqual([]);
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
    expect(active.promptBlock).toContain(
      'Required skill names to load before work: ["tdd"]',
    );
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

  it("preserves a native user-selected model without applying descriptor model intent", async () => {
    const userModel = { provider: "openai", id: "gpt-5" };
    const applier = fakeApplier();
    const session = new PiPrimarySession({
      skillCatalog: new PiSkillCatalog(),
      logger: new RecordingLogger(),
    });

    const result = await session.activate(
      descriptor(),
      context({
        currentModel: userModel,
        modelApplier: applier,
        preserveCurrentModel: true,
      }),
    );

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().modelActivation).toEqual({
      status: "preserved",
      currentModel: userModel,
      reason: "user-selected",
    });
    expect(applier.calls).toEqual([]);
    expect(session.getCapabilityWarnings()).toEqual([]);
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

  it("activates with available skills and emits one visible warning for each missing skill", async () => {
    const applier = fakeApplier();
    const session = new PiPrimarySession({
      skillCatalog: new PiSkillCatalog([{ name: "tdd" }]),
      logger: new RecordingLogger(),
    });
    const first = await session.activate(
      descriptor(),
      context({ modelApplier: applier }),
    );
    expect(first.isOk()).toBe(true);

    const activated = await session.activate(
      descriptor({
        name: "loom-v2",
        skills: ["tdd", "missing-skill", "missing-skill"],
      }),
      context({ modelApplier: applier }),
    );
    expect(activated.isOk()).toBe(true);
    expect(
      activated._unsafeUnwrap().resolvedSkills.map((skill) => skill.name),
    ).toEqual(["tdd"]);
    expect(session.getCurrent()?.descriptor.name).toBe("loom-v2");
    expect(applier.calls).toEqual([CATALOG[0], CATALOG[0]]);
    expect(session.getCapabilityWarnings()).toEqual([
      {
        capability: "skill",
        agentName: "loom-v2",
        detail:
          'required skill "missing-skill" is unavailable in Pi; continuing without it',
      },
    ]);
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

describe("PiPrimarySession committed-state isolation", () => {
  it("copies mutable activation inputs before committing them", async () => {
    const reviewModelIntent = "openai/review-model";
    const models = ["anthropic/claude-sonnet-4-5", reviewModelIntent];
    const skills = ["tdd"];
    const effectiveToolPolicy: EffectiveToolPolicy = { ...POLICY };
    const rawToolPolicy: AgentDescriptor["rawToolPolicy"] = {
      read: "allow",
      write: "ask",
    };
    const triggers = ["typescript", "review"];
    const target: AgentDescriptor["delegationTargets"][number] = {
      name: "shuttle",
      description: "Implementation worker",
      triggers,
      isCategory: false,
    };
    const category: NonNullable<AgentDescriptor["category"]> = {
      name: "tests",
      description: "Test work",
    };
    const model = {
      provider: "anthropic",
      id: "claude-sonnet-4-5",
      name: "Claude Sonnet 4.5",
      api: "anthropic-messages",
    };
    const sourceInfo = {
      path: "/skills/tdd/SKILL.md",
      source: "skill",
      scope: "project",
      origin: "top-level",
      baseDir: "/skills/tdd",
    } satisfies PiSourceInfo;
    const skillCatalog = new PiSkillCatalog([
      { name: "tdd", filePath: sourceInfo.path, sourceInfo },
    ]);
    const modelActivation: PiModelActivationOutcome = {
      status: "applied",
      model,
      intentEntry: models[0] ?? "",
      source: "canonical",
      thinkingLevel: "high",
      thinkingApplied: true,
    };
    const modelActivator = new PiModelActivator();
    modelActivator.activate = () => okAsync(modelActivation);
    const session = new PiPrimarySession({
      skillCatalog,
      modelActivator,
      logger: new RecordingLogger(),
    });

    const activated = await session.activate(
      descriptor({
        models,
        skills,
        effectiveToolPolicy,
        rawToolPolicy,
        delegationTargets: [target],
        category,
        fast: true,
      }),
      context(),
    );
    expect(activated.isOk()).toBe(true);
    const expected = structuredClone(session.getCurrent());
    expect(expected?.descriptor.models).toEqual([
      "anthropic/claude-sonnet-4-5",
      reviewModelIntent,
    ]);

    models.splice(0, models.length, "mutated-primary", "mutated-review");
    skills.splice(0, skills.length, "mutated-skill");
    Object.assign(effectiveToolPolicy, {
      read: "deny",
      write: "deny",
      execute: "deny",
      delegate: "deny",
      network: "deny",
    });
    Object.assign(rawToolPolicy, { read: "deny", write: "deny" });
    target.name = "mutated-target";
    target.description = "mutated description";
    triggers.splice(0, triggers.length, "mutated-trigger");
    category.name = "mutated-category";
    category.description = "mutated category description";
    Object.assign(model, {
      provider: "mutated-provider",
      id: "mutated-model",
      name: "Mutated Model",
      api: "mutated-api",
    });
    Object.assign(modelActivation, {
      intentEntry: "mutated-intent",
      source: "human-name",
      thinkingLevel: "low",
      thinkingApplied: false,
    });
    const catalogMetadata = skillCatalog.getAvailableSkills()[0]?.metadata as {
      filePath?: string;
      sourceInfo?: {
        path: string;
        source: string;
        scope: string;
        origin: string;
        baseDir?: string;
      };
    };
    catalogMetadata.filePath = "/mutated/SKILL.md";
    Object.assign(catalogMetadata.sourceInfo ?? {}, {
      path: "/mutated/source",
      source: "mutated-source",
      scope: "temporary",
      origin: "package",
      baseDir: "/mutated",
    });

    expect(session.getCurrent()).toEqual(expected);
  });

  it("isolates later reads and request behavior from getCurrent mutation", async () => {
    const session = new PiPrimarySession({
      skillCatalog: new PiSkillCatalog([
        {
          name: "tdd",
          filePath: "/skills/tdd/SKILL.md",
          sourceInfo: {
            path: "/skills/tdd/SKILL.md",
            source: "skill",
            scope: "project",
            origin: "top-level",
          },
        },
      ]),
      logger: new RecordingLogger(),
    });
    const modelIntent = "anthropic/claude-sonnet-4-5#high";
    const activated = await session.activate(
      descriptor({
        displayName: "Loom",
        description: "Primary orchestrator",
        models: [modelIntent, "openai/review-model"],
        skills: ["tdd"],
        rawToolPolicy: { read: "allow", write: "ask" },
        delegationTargets: [
          {
            name: "shuttle",
            description: "Implementation worker",
            triggers: ["typescript", "review"],
            isCategory: false,
          },
        ],
        category: { name: "tests", description: "Test work" },
        fast: true,
      }),
      context({
        availableModels: [
          {
            provider: "anthropic",
            id: "claude-sonnet-4-5",
            name: "Claude Sonnet 4.5",
          },
        ],
        thinkingApplier: { applyThinkingLevel: () => okAsync(undefined) },
      }),
    );
    expect(activated.isOk()).toBe(true);

    const exposed = session.getCurrent();
    expect(exposed).toBeDefined();
    if (exposed === undefined) return;
    const expectedCurrent = structuredClone(exposed);
    const expectedPrompt = session.appendToSystemPrompt("base");
    const expectedSnapshot = session.captureRequestSnapshot();

    Object.assign(exposed.descriptor, {
      name: "mutated-name",
      displayName: "Mutated Name",
      description: "mutated description",
      composedPrompt: "mutated prompt",
      temperature: 1,
    });
    exposed.descriptor.models.splice(
      0,
      exposed.descriptor.models.length,
      "mutated-model",
    );
    exposed.descriptor.skills.splice(
      0,
      exposed.descriptor.skills.length,
      "mutated-skill",
    );
    Object.assign(exposed.descriptor.effectiveToolPolicy, {
      read: "deny",
      write: "deny",
      execute: "deny",
      delegate: "deny",
      network: "deny",
    });
    Object.assign(exposed.descriptor.rawToolPolicy ?? {}, {
      read: "deny",
      write: "deny",
    });
    Object.assign(exposed.descriptor.category ?? {}, {
      name: "mutated-category",
      description: "mutated category description",
    });
    const exposedTarget = exposed.descriptor.delegationTargets[0];
    expect(exposedTarget).toBeDefined();
    if (exposedTarget === undefined) return;
    Object.assign(exposedTarget, {
      name: "mutated-target",
      description: "mutated target description",
      isCategory: true,
    });
    exposedTarget.triggers.splice(
      0,
      exposedTarget.triggers.length,
      "mutated-trigger",
    );

    expect(exposed.modelActivation.status).toBe("applied");
    if (exposed.modelActivation.status !== "applied") return;
    Object.assign(
      exposed.modelActivation.model as unknown as Record<string, unknown>,
      {
        provider: "mutated-provider",
        id: "mutated-model",
        name: "Mutated Model",
        api: "mutated-api",
      },
    );
    Object.assign(exposed.modelActivation, {
      intentEntry: "mutated-intent",
      source: "human-name",
      thinkingLevel: "low",
      thinkingApplied: false,
    });

    const exposedSkill = exposed.resolvedSkills[0] as
      | {
          name: string;
          skillInfo: {
            name: string;
            metadata?: {
              filePath?: string;
              sourceInfo?: { path: string; source: string };
            };
          };
        }
      | undefined;
    expect(exposedSkill).toBeDefined();
    if (exposedSkill === undefined) return;
    exposedSkill.name = "mutated-skill";
    exposedSkill.skillInfo.name = "mutated-skill-info";
    if (exposedSkill.skillInfo.metadata !== undefined) {
      exposedSkill.skillInfo.metadata.filePath = "/mutated/SKILL.md";
      Object.assign(exposedSkill.skillInfo.metadata.sourceInfo ?? {}, {
        path: "/mutated/source",
        source: "mutated-source",
      });
    }
    (exposed.resolvedSkills as unknown[]).push({
      name: "injected",
      skillInfo: { name: "injected" },
    });
    Object.assign(
      exposed as {
        promptBlock: string;
        temperatureDegraded: boolean;
        generation: number;
        fast?: true;
      },
      {
        promptBlock: "mutated prompt block",
        temperatureDegraded: true,
        generation: 999,
      },
    );
    delete (exposed as { fast?: true }).fast;

    expect(session.getCurrent()).toEqual(expectedCurrent);
    expect(session.appendToSystemPrompt("base")).toBe(expectedPrompt);
    expect(session.captureRequestSnapshot()).toEqual(expectedSnapshot);
  });

  it("copies repeated arrays and records independently for sibling fields", async () => {
    const repeatedRecord = { value: "record" };
    const repeatedArray = [{ value: "array" }];
    const sourceInfo = {
      path: "/skills/tdd/SKILL.md",
      source: "skill",
      scope: "project",
      origin: "top-level",
      firstRecord: repeatedRecord,
      secondRecord: repeatedRecord,
      firstArray: repeatedArray,
      secondArray: repeatedArray,
    } as unknown as PiSourceInfo;
    const repeatedTriggers = ["shared-trigger"];
    const repeatedTarget: AgentDescriptor["delegationTargets"][number] = {
      name: "shuttle",
      triggers: repeatedTriggers,
      isCategory: false,
    };
    const session = new PiPrimarySession({
      skillCatalog: new PiSkillCatalog([
        { name: "tdd", filePath: sourceInfo.path, sourceInfo },
      ]),
      logger: new RecordingLogger(),
    });

    const activated = await session.activate(
      descriptor({
        skills: ["tdd"],
        delegationTargets: [repeatedTarget, repeatedTarget],
      }),
      context(),
    );
    expect(activated.isOk()).toBe(true);
    const current = session.getCurrent();
    expect(current).toBeDefined();
    if (current === undefined) return;

    const firstTarget = current.descriptor.delegationTargets[0];
    const secondTarget = current.descriptor.delegationTargets[1];
    expect(firstTarget).not.toBe(secondTarget);
    expect(firstTarget?.triggers).not.toBe(secondTarget?.triggers);
    if (firstTarget === undefined || secondTarget === undefined) return;
    firstTarget.triggers[0] = "mutated-trigger";
    expect(secondTarget.triggers).toEqual(["shared-trigger"]);

    const metadata = current.resolvedSkills[0]?.skillInfo.metadata as {
      sourceInfo: {
        firstRecord: { value: string };
        secondRecord: { value: string };
        firstArray: Array<{ value: string }>;
        secondArray: Array<{ value: string }>;
      };
    };
    expect(metadata.sourceInfo.firstRecord).not.toBe(
      metadata.sourceInfo.secondRecord,
    );
    expect(metadata.sourceInfo.firstArray).not.toBe(
      metadata.sourceInfo.secondArray,
    );
    metadata.sourceInfo.firstRecord.value = "mutated-record";
    const firstArrayValue = metadata.sourceInfo.firstArray[0];
    expect(firstArrayValue).toBeDefined();
    if (firstArrayValue === undefined) return;
    firstArrayValue.value = "mutated-array";
    expect(metadata.sourceInfo.secondRecord.value).toBe("record");
    expect(metadata.sourceInfo.secondArray).toEqual([{ value: "array" }]);
  });

  it("omits hostile skill metadata accessors and cycles without reading them", async () => {
    let getterReads = 0;
    const sourceInfo: Record<string, unknown> = {
      source: "skill",
      scope: "project",
      origin: "top-level",
      safe: "kept",
    };
    Object.defineProperty(sourceInfo, "path", {
      enumerable: true,
      get: () => {
        getterReads += 1;
        return "/hostile/SKILL.md";
      },
    });
    sourceInfo.cycle = sourceInfo;
    const session = new PiPrimarySession({
      skillCatalog: new PiSkillCatalog([
        {
          name: "hostile",
          filePath: "/safe/SKILL.md",
          sourceInfo: sourceInfo as unknown as PiSourceInfo,
        },
      ]),
      logger: new RecordingLogger(),
    });

    const activated = await session.activate(
      descriptor({ skills: ["hostile"] }),
      context(),
    );
    expect(activated.isOk()).toBe(true);
    const metadata = session.getCurrent()?.resolvedSkills[0]?.skillInfo
      .metadata as {
      filePath: string;
      sourceInfo: Record<string, unknown>;
    };

    expect(getterReads).toBe(0);
    expect(metadata.filePath).toBe("/safe/SKILL.md");
    expect(metadata.sourceInfo.safe).toBe("kept");
    expect(Object.hasOwn(metadata.sourceInfo, "path")).toBe(false);
    expect(Object.hasOwn(metadata.sourceInfo, "cycle")).toBe(false);
    expect(() => JSON.stringify(metadata)).not.toThrow();
  });
});

describe("PiPrimarySession fast intent and request snapshots", () => {
  it("has no committed state or snapshot before activation", () => {
    const session = new PiPrimarySession({
      skillCatalog: new PiSkillCatalog(),
      logger: new RecordingLogger(),
    });
    expect(session.getCurrent()).toBeUndefined();
    expect(session.captureRequestSnapshot()).toBeUndefined();
    expect(
      session
        .resolveRequestSnapshot({
          generation: 1,
          primaryName: "loom",
          modelIntent: ["claude-sonnet-4-5"],
          selectedModel: CATALOG[0],
          fast: true,
        })
        .isErr(),
    ).toBe(true);
  });

  it("commits fast true atomically with identity, prompt, model, and skills", async () => {
    const session = new PiPrimarySession({
      skillCatalog: new PiSkillCatalog([{ name: "tdd" }]),
      logger: new RecordingLogger(),
    });
    const result = await session.activate(
      descriptor({ fast: true, skills: ["tdd"] }),
      context(),
    );
    expect(result.isOk()).toBe(true);
    const active = result._unsafeUnwrap();
    expect(active.fast).toBe(true);
    expect(active.descriptor.name).toBe("loom");
    expect(active.resolvedSkills.map((skill) => skill.name)).toEqual(["tdd"]);
    expect(active.modelActivation).toMatchObject({
      status: "applied",
      model: CATALOG[0],
    });
    expect(session.getCurrent()?.fast).toBe(true);
    expect(session.captureRequestSnapshot()).toMatchObject({
      generation: 1,
      primaryName: "loom",
      fast: true,
      selectedModel: CATALOG[0],
    });
    expect(active).not.toHaveProperty("fast", false);
  });

  it("omits fast on a non-fast primary and never infers it from model ids", async () => {
    const session = new PiPrimarySession({
      skillCatalog: new PiSkillCatalog(),
      logger: new RecordingLogger(),
    });
    const result = await session.activate(
      descriptor({
        models: ["openai/gpt-fast", "cursor/grok-4.5:fast#high"],
      }),
      context({
        availableModels: [
          { provider: "openai", id: "gpt-fast" },
          { provider: "cursor", id: "grok-4.5:fast" },
        ],
      }),
    );
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().fast).toBeUndefined();
    expect(session.getCurrent()).not.toHaveProperty("fast");
    expect(session.captureRequestSnapshot()).not.toHaveProperty("fast");
  });

  it("switches fast to absent and absent to fast without leftover intent", async () => {
    const session = new PiPrimarySession({
      skillCatalog: new PiSkillCatalog(),
      logger: new RecordingLogger(),
    });
    const fast = await session.activate(descriptor({ fast: true }), context());
    expect(fast._unsafeUnwrap().fast).toBe(true);
    const absent = await session.activate(
      descriptor({ name: "tapestry", mode: "all" }),
      context(),
    );
    expect(absent._unsafeUnwrap().fast).toBeUndefined();
    expect(session.getCurrent()?.fast).toBeUndefined();
    expect(session.captureRequestSnapshot()).toMatchObject({
      primaryName: "tapestry",
      generation: 2,
    });
    expect(session.captureRequestSnapshot()).not.toHaveProperty("fast");

    const restoredFast = await session.activate(
      descriptor({ name: "loom-fast", fast: true }),
      context(),
    );
    expect(restoredFast._unsafeUnwrap().fast).toBe(true);
    expect(session.captureRequestSnapshot()).toMatchObject({
      primaryName: "loom-fast",
      generation: 3,
      fast: true,
    });
  });

  it("rolls back a failed fast-to-absent switch and an absent-to-fast switch", async () => {
    const session = new PiPrimarySession({
      skillCatalog: new PiSkillCatalog(),
      logger: new RecordingLogger(),
    });
    await session.activate(descriptor({ fast: true }), context());
    const failedAbsent = await session.activate(
      descriptor({ name: "shuttle", mode: "subagent" }),
      context(),
    );
    expect(failedAbsent.isErr()).toBe(true);
    expect(session.getCurrent()?.fast).toBe(true);
    expect(session.getCurrent()?.descriptor.name).toBe("loom");
    expect(session.captureRequestSnapshot()?.fast).toBe(true);

    await session.activate(
      descriptor({ name: "tapestry", mode: "all" }),
      context(),
    );
    const failedFast = await session.activate(
      descriptor({ name: "shuttle-fast", mode: "subagent", fast: true }),
      context(),
    );
    expect(failedFast.isErr()).toBe(true);
    expect(session.getCurrent()?.fast).toBeUndefined();
    expect(session.getCurrent()?.descriptor.name).toBe("tapestry");
    expect(session.captureRequestSnapshot()).not.toHaveProperty("fast");
  });

  it("rejects a stale or mutated snapshot after a later activation", async () => {
    const session = new PiPrimarySession({
      skillCatalog: new PiSkillCatalog(),
      logger: new RecordingLogger(),
    });
    await session.activate(descriptor({ fast: true }), context());
    const stale = session.captureRequestSnapshot();
    expect(stale).toBeDefined();
    if (stale === undefined) return;

    await session.activate(
      descriptor({ name: "tapestry", mode: "all" }),
      context(),
    );
    expect(session.resolveRequestSnapshot(stale).isErr()).toBe(true);
    expect(session.captureRequestSnapshot()?.generation).toBe(2);

    const current = session.captureRequestSnapshot();
    expect(current).toBeDefined();
    if (current === undefined) return;
    const forged: typeof current = {
      ...current,
      fast: true,
    };
    expect(session.resolveRequestSnapshot(forged).isErr()).toBe(true);
  });

  it("keeps request snapshots isolated from later input and output mutation", async () => {
    const models = ["claude-sonnet-4-5"];
    const session = new PiPrimarySession({
      skillCatalog: new PiSkillCatalog(),
      logger: new RecordingLogger(),
    });
    const result = await session.activate(
      descriptor({ models, fast: true }),
      context(),
    );
    expect(result.isOk()).toBe(true);
    models.push("mutated-after-activate");
    const snapshot = session.captureRequestSnapshot();
    expect(snapshot?.modelIntent).toEqual(["claude-sonnet-4-5"]);
    if (snapshot === undefined) return;
    const mutableIntent = snapshot.modelIntent as string[];
    expect(() => {
      mutableIntent.push("mutated-snapshot");
    }).toThrow();
    if (snapshot.selectedModel !== undefined) {
      expect(() => {
        (snapshot.selectedModel as { id: string }).id = "mutated-model";
      }).toThrow();
    }
    expect(session.captureRequestSnapshot()?.modelIntent).toEqual([
      "claude-sonnet-4-5",
    ]);
    expect(session.captureRequestSnapshot()?.selectedModel).toEqual(CATALOG[0]);
  });

  it("commits the host-reported model api exactly and never infers it", async () => {
    const session = new PiPrimarySession({
      skillCatalog: new PiSkillCatalog(),
      logger: new RecordingLogger(),
    });
    const catalogModel: PiModelInfo = {
      provider: "anthropic",
      id: "claude-sonnet-4-5",
      name: "Claude Sonnet 4.5",
      api: "anthropic-messages",
    };
    const result = await session.activate(
      descriptor(),
      context({ availableModels: [catalogModel] }),
    );
    expect(result.isOk()).toBe(true);
    const active = result._unsafeUnwrap();
    expect(active.modelActivation).toMatchObject({
      status: "applied",
      model: {
        provider: "anthropic",
        id: "claude-sonnet-4-5",
        name: "Claude Sonnet 4.5",
        api: "anthropic-messages",
      },
    });
    expect(session.getCurrent()?.modelActivation).toMatchObject({
      status: "applied",
      model: { api: "anthropic-messages" },
    });
    expect(session.captureRequestSnapshot()?.selectedModel).toEqual({
      provider: "anthropic",
      id: "claude-sonnet-4-5",
      name: "Claude Sonnet 4.5",
      api: "anthropic-messages",
    });
  });

  it("omits api when the host catalog omits it and never infers it from ids", async () => {
    const session = new PiPrimarySession({
      skillCatalog: new PiSkillCatalog(),
      logger: new RecordingLogger(),
    });
    const result = await session.activate(
      descriptor({
        models: ["openai/gpt-5.6", "anthropic/claude-sonnet-4-5"],
      }),
      context({
        availableModels: [
          { provider: "openai", id: "gpt-5.6", name: "GPT-5.6" },
          {
            provider: "anthropic",
            id: "claude-sonnet-4-5",
            name: "Claude Sonnet 4.5",
          },
        ],
      }),
    );
    expect(result.isOk()).toBe(true);
    const selected = result._unsafeUnwrap().modelActivation;
    expect(selected).toMatchObject({
      status: "applied",
      model: { provider: "openai", id: "gpt-5.6", name: "GPT-5.6" },
    });
    if (selected.status !== "applied") return;
    expect(selected.model).not.toHaveProperty("api");
    const currentActivation = session.getCurrent()?.modelActivation;
    expect(currentActivation?.status).toBe("applied");
    if (currentActivation?.status !== "applied") return;
    expect(currentActivation.model).not.toHaveProperty("api");
    expect(session.captureRequestSnapshot()?.selectedModel).not.toHaveProperty(
      "api",
    );
  });

  it("omits blank, whitespace, non-string, and oversized host api without failing activation", async () => {
    const session = new PiPrimarySession({
      skillCatalog: new PiSkillCatalog(),
      logger: new RecordingLogger(),
    });
    for (const api of ["", "   ", "x".repeat(129), 42, { family: "openai" }]) {
      const result = await session.activate(
        descriptor(),
        context({
          availableModels: [
            {
              provider: "anthropic",
              id: "claude-sonnet-4-5",
              name: "Claude Sonnet 4.5",
              api,
            } as unknown as PiModelInfo,
          ],
        }),
      );
      expect(result.isOk()).toBe(true);
      const activation = result._unsafeUnwrap().modelActivation;
      expect(activation.status).toBe("applied");
      if (activation.status !== "applied") return;
      expect(activation.model).not.toHaveProperty("api");
      expect(
        session.captureRequestSnapshot()?.selectedModel,
      ).not.toHaveProperty("api");
    }
  });

  it("isolates committed api from later source and output mutation", async () => {
    const catalogModel: PiModelInfo = {
      provider: "anthropic",
      id: "claude-sonnet-4-5",
      name: "Claude Sonnet 4.5",
      api: "anthropic-messages",
    };
    const session = new PiPrimarySession({
      skillCatalog: new PiSkillCatalog(),
      logger: new RecordingLogger(),
    });
    const activated = await session.activate(
      descriptor(),
      context({ availableModels: [catalogModel] }),
    );
    expect(activated.isOk()).toBe(true);
    (catalogModel as { api?: string }).api = "mutated-source-api";

    const current = session.getCurrent();
    expect(current?.modelActivation).toMatchObject({
      status: "applied",
      model: { api: "anthropic-messages" },
    });
    if (current?.modelActivation.status !== "applied") return;
    (current.modelActivation.model as { api?: string }).api =
      "mutated-current-api";
    delete (current.modelActivation.model as { api?: string }).api;

    const snapshot = session.captureRequestSnapshot();
    expect(snapshot?.selectedModel).toEqual({
      provider: "anthropic",
      id: "claude-sonnet-4-5",
      name: "Claude Sonnet 4.5",
      api: "anthropic-messages",
    });
    if (snapshot?.selectedModel === undefined) return;
    expect(() => {
      (snapshot.selectedModel as { api?: string }).api = "mutated-snapshot-api";
    }).toThrow();
    expect(session.captureRequestSnapshot()?.selectedModel?.api).toBe(
      "anthropic-messages",
    );
    expect(session.getCurrent()?.modelActivation).toMatchObject({
      status: "applied",
      model: { api: "anthropic-messages" },
    });
  });

  it("rejects forged, removed, added, and oversized api on exact snapshots", async () => {
    const session = new PiPrimarySession({
      skillCatalog: new PiSkillCatalog(),
      logger: new RecordingLogger(),
    });
    const withApi = await session.activate(
      descriptor(),
      context({
        availableModels: [
          {
            provider: "anthropic",
            id: "claude-sonnet-4-5",
            name: "Claude Sonnet 4.5",
            api: "anthropic-messages",
          },
        ],
      }),
    );
    expect(withApi.isOk()).toBe(true);
    const snapshotWithApi = session.captureRequestSnapshot();
    expect(snapshotWithApi?.selectedModel?.api).toBe("anthropic-messages");
    if (
      snapshotWithApi === undefined ||
      snapshotWithApi.selectedModel === undefined
    ) {
      return;
    }
    const selectedWithApi = snapshotWithApi.selectedModel;
    const { api: _omittedApi, ...withoutApi } = selectedWithApi;
    for (const forgedSelectedModel of [
      { ...selectedWithApi, api: "openai-responses" },
      withoutApi,
      { ...selectedWithApi, api: "x".repeat(129) },
    ]) {
      expect(
        session
          .resolveRequestSnapshot({
            ...snapshotWithApi,
            selectedModel: forgedSelectedModel,
          })
          .isErr(),
      ).toBe(true);
    }

    const withoutHostApi = await session.activate(
      descriptor({ name: "tapestry", mode: "all" }),
      context({
        availableModels: [
          {
            provider: "anthropic",
            id: "claude-sonnet-4-5",
            name: "Claude Sonnet 4.5",
          },
        ],
      }),
    );
    expect(withoutHostApi.isOk()).toBe(true);
    const snapshotWithoutApi = session.captureRequestSnapshot();
    expect(snapshotWithoutApi?.selectedModel).not.toHaveProperty("api");
    expect(session.resolveRequestSnapshot(snapshotWithApi).isErr()).toBe(true);
    if (
      snapshotWithoutApi === undefined ||
      snapshotWithoutApi.selectedModel === undefined
    ) {
      return;
    }
    expect(
      session
        .resolveRequestSnapshot({
          ...snapshotWithoutApi,
          selectedModel: {
            ...snapshotWithoutApi.selectedModel,
            api: "anthropic-messages",
          },
        })
        .isErr(),
    ).toBe(true);
    expect(session.resolveRequestSnapshot(snapshotWithoutApi).isOk()).toBe(
      true,
    );
  });

  it("authenticates exact ordered model intent and selected model snapshots", async () => {
    const firstIntent = "anthropic/claude-sonnet-4-5#high";
    const secondIntent = "openai/gpt-5.6#medium";
    const session = new PiPrimarySession({
      skillCatalog: new PiSkillCatalog(),
      logger: new RecordingLogger(),
    });
    const activated = await session.activate(
      descriptor({ models: [firstIntent, secondIntent] }),
      context({ availableModels: SNAPSHOT_CATALOG }),
    );
    expect(activated.isOk()).toBe(true);

    const snapshot = session.captureRequestSnapshot();
    expect(snapshot).toBeDefined();
    if (snapshot === undefined || snapshot.selectedModel === undefined) return;

    const resolved = session.resolveRequestSnapshot(snapshot);
    expect(resolved.isOk()).toBe(true);
    if (resolved.isErr()) return;
    expect(resolved.value).toEqual(snapshot);
    expect(resolved.value).not.toBe(snapshot);
    expect(resolved.value.modelIntent).not.toBe(snapshot.modelIntent);
    expect(resolved.value.selectedModel).not.toBe(snapshot.selectedModel);
    expect(() => {
      (resolved.value.modelIntent as string[]).push("mutated-resolve-output");
    }).toThrow();
    expect(() => {
      (resolved.value.selectedModel as { id: string }).id =
        "mutated-resolve-output";
    }).toThrow();
    expect(session.captureRequestSnapshot()).toEqual(snapshot);

    const rejectedIntents = [
      ["openai/claude-sonnet-4-5#high", secondIntent],
      ["anthropic/forged-model#high", secondIntent],
      ["anthropic/claude-sonnet-4-5#low", secondIntent],
      [secondIntent, firstIntent],
      [firstIntent],
      [firstIntent, secondIntent, firstIntent],
    ];
    for (const modelIntent of rejectedIntents) {
      expect(
        session.resolveRequestSnapshot({ ...snapshot, modelIntent }).isErr(),
      ).toBe(true);
    }

    const { modelIntent: _omittedModelIntent, ...withoutModelIntent } =
      snapshot;
    expect(
      session
        .resolveRequestSnapshot(withoutModelIntent as typeof snapshot)
        .isErr(),
    ).toBe(true);

    const selectedModel = snapshot.selectedModel;
    for (const forgedSelectedModel of [
      { ...selectedModel, provider: "forged-provider" },
      { ...selectedModel, id: "forged-model" },
      { ...selectedModel, name: "Forged model" },
      { ...selectedModel, api: "openai-responses" },
      { ...selectedModel, forged: true },
    ]) {
      expect(
        session
          .resolveRequestSnapshot({
            ...snapshot,
            selectedModel: forgedSelectedModel,
          })
          .isErr(),
      ).toBe(true);
    }

    expect(
      session
        .resolveRequestSnapshot({ ...snapshot, selectedModel: undefined })
        .isErr(),
    ).toBe(true);
    const { selectedModel: _omittedSelectedModel, ...withoutSelectedModel } =
      snapshot;
    expect(
      session
        .resolveRequestSnapshot(withoutSelectedModel as typeof snapshot)
        .isErr(),
    ).toBe(true);
  });

  it("re-probes the parent session on restart without leaking the prior snapshot", async () => {
    const session = new PiPrimarySession({
      skillCatalog: new PiSkillCatalog(),
      logger: new RecordingLogger(),
      parentSessionProbe: {
        isPersisted: () => true,
        getSessionFile: () => "/sessions/a.jsonl",
        getSessionId: () => "runtime-1",
        getHeader: () => ({ type: "session", id: "session-a" }),
      },
    });
    await session.activate(descriptor({ fast: true }), context());
    const first = session.captureRequestSnapshot();
    expect(session.getParentSession()).toMatchObject({
      persistence: "persistent",
      sessionId: "session-a",
    });
    session.refreshParentSession({
      isPersisted: () => true,
      getSessionFile: () => "/sessions/a.jsonl",
      getSessionId: () => "runtime-2",
      getHeader: () => ({ type: "session", id: "session-a" }),
    });
    await session.activate(descriptor({ fast: true }), context());
    const second = session.captureRequestSnapshot();
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    if (first === undefined || second === undefined) return;
    expect(session.resolveRequestSnapshot(first).isErr()).toBe(true);
    expect(second.generation).toBe(2);
    expect(second.fast).toBe(true);
  });

  it("does not leak committed state or snapshots across session instances", async () => {
    const first = new PiPrimarySession({
      skillCatalog: new PiSkillCatalog(),
      logger: new RecordingLogger(),
    });
    const second = new PiPrimarySession({
      skillCatalog: new PiSkillCatalog(),
      logger: new RecordingLogger(),
    });
    await first.activate(descriptor({ fast: true }), context());
    expect(second.getCurrent()).toBeUndefined();
    expect(second.captureRequestSnapshot()).toBeUndefined();
    const firstSnapshot = first.captureRequestSnapshot();
    expect(firstSnapshot).toBeDefined();
    if (firstSnapshot === undefined) return;
    expect(second.resolveRequestSnapshot(firstSnapshot).isErr()).toBe(true);
    await second.activate(
      descriptor({ name: "tapestry", mode: "all" }),
      context(),
    );
    expect(second.captureRequestSnapshot()).not.toHaveProperty("fast");
    expect(first.captureRequestSnapshot()?.fast).toBe(true);
  });
});

describe("PiPrimarySession model failover seams", () => {
  // Manual-override latching and ordinary user-turn handling belong to the
  // coordinator integration. This primary-session unit has no ordinary-turn
  // transition, so it does not add a fake test for that behavior.
  it("supplies ordered distinct candidates and the applied origin after explicit activation", async () => {
    const origin: PiModelInfo = {
      provider: "anthropic",
      id: "claude-sonnet-4-5",
      name: "Claude Sonnet 4.5",
    };
    const fallback: PiModelInfo = {
      provider: "openai",
      id: "gpt-5.6",
      name: "GPT-5.6",
    };
    const availableModels = [origin, fallback];
    const modelIntent = [
      "anthropic/claude-sonnet-4-5#high",
      "gpt-5.6",
      "openai/gpt-5.6",
      "anthropic/claude-sonnet-4-5",
    ];
    const session = new PiPrimarySession({
      skillCatalog: new PiSkillCatalog(),
      logger: new RecordingLogger(),
    });

    const activated = await session.activate(
      descriptor({ models: modelIntent }),
      context({ availableModels }),
    );
    expect(activated.isOk()).toBe(true);
    const current = session.getCurrent();
    expect(current).toBeDefined();
    if (current === undefined) return;

    // This is the same immutable activation data that the lifecycle seam uses
    // to arm the coordinator: aliases resolve in intent order and duplicate
    // provider/id identities are removed, while the applied model is the
    // origin for the coordinator cursor.
    const candidates = resolvePiOrderedDistinctModels(
      current.descriptor.models,
      availableModels,
    );
    expect(candidates).toEqual([
      {
        resolved: true,
        model: origin,
        intentEntry: "anthropic/claude-sonnet-4-5#high",
        source: "canonical",
        thinkingLevel: "high",
      },
      {
        resolved: true,
        model: fallback,
        intentEntry: "gpt-5.6",
        source: "bare-id",
      },
    ]);
    expect(session.getActivationId()).toBe("activation-1");
    expect(session.getAppliedModel()).toEqual(origin);
    expect(session.captureRequestSnapshot()).toMatchObject({
      generation: 1,
      primaryName: "loom",
      modelIntent,
      selectedModel: origin,
    });
  });

  it("updates the applied provider and model together for a proven fallback", async () => {
    const origin: PiModelInfo = {
      provider: "anthropic",
      id: "claude-sonnet-4-5",
      name: "Claude Sonnet 4.5",
    };
    const fallback: PiModelInfo = {
      provider: "openai",
      id: "gpt-5.6",
      name: "GPT-5.6",
      api: "openai-responses",
    };
    const session = new PiPrimarySession({
      skillCatalog: new PiSkillCatalog(),
      logger: new RecordingLogger(),
    });
    await session.activate(
      descriptor({ models: ["anthropic/claude-sonnet-4-5", "openai/gpt-5.6"] }),
      context({ availableModels: [origin, fallback] }),
    );

    expect(session.noteAppliedModel(fallback).isOk()).toBe(true);
    expect(session.getActivationId()).toBe("activation-1");
    expect(session.getAppliedModel()).toEqual(fallback);
    expect(session.captureRequestSnapshot()).toMatchObject({
      modelIntent: ["anthropic/claude-sonnet-4-5", "openai/gpt-5.6"],
      selectedModel: fallback,
    });
    // The activation record keeps configured intent separate from host truth;
    // both provider and model in the request-facing applied identity change as
    // one value.
    expect(session.getCurrent()?.modelActivation).toEqual({
      status: "applied",
      model: origin,
      intentEntry: "anthropic/claude-sonnet-4-5",
      source: "canonical",
    });
  });

  it("keeps applied fallback truth when context recovery fails later", async () => {
    const origin: PiModelInfo = {
      provider: "anthropic",
      id: "claude-sonnet-4-5",
      name: "Claude Sonnet 4.5",
    };
    const fallback: PiModelInfo = {
      provider: "openai",
      id: "gpt-5.6",
      name: "GPT-5.6",
    };
    const availableModels = [origin, fallback];
    const modelIntent = ["anthropic/claude-sonnet-4-5", "openai/gpt-5.6"];
    const session = new PiPrimarySession({
      skillCatalog: new PiSkillCatalog(),
      logger: new RecordingLogger(),
    });
    await session.activate(
      descriptor({ models: modelIntent }),
      context({ availableModels }),
    );
    const current = session.getCurrent();
    expect(current).toBeDefined();
    if (current === undefined) return;

    const host = new RecordingFakePiHost({
      currentModel: origin,
      availableModels,
    });
    const timer = new RecordingFakeTimerPort();
    const candidates = resolvePiOrderedDistinctModels(
      current.descriptor.models,
      availableModels,
    );
    const fingerprint = fingerprintPiAssistantMessage({
      role: "assistant",
      id: "failed-assistant",
      stopReason: "error",
      content: [{ type: "text", text: "bounded partial output" }],
    });
    expect(fingerprint.isOk()).toBe(true);
    if (fingerprint.isErr()) return;

    const coordinator = createPiModelFailoverCoordinator({
      host: host.api,
      context: host.createSessionContext(),
      scope: {
        generationId: "generation-1",
        nativeSessionId: "session-1",
        activationId: session.getActivationId() ?? "activation-missing",
        candidates,
        currentModel: session.getAppliedModel(),
      },
      timer,
      switchTimeoutMs: 100,
      markerTimeoutMs: 100,
      contextTimeoutMs: 100,
      getGenerationId: () => "generation-1",
      getNativeSessionId: () => "session-1",
      onAppliedModel: (event) => {
        const applied = availableModels.find(
          (model) =>
            model.provider === event.model.provider &&
            model.id === event.model.id,
        );
        if (applied !== undefined) session.noteAppliedModel(applied);
      },
    });

    const started = await coordinator.handleFailure({
      failureClass: "provider_unavailable",
      failedModel: origin,
      fingerprint: fingerprint.value,
    });
    expect(started.isOk()).toBe(true);
    expect(coordinator.onModelSelect({ model: fallback }).isOk()).toBe(true);
    expect(session.getAppliedModel()).toEqual(fallback);

    const marker = host.sendMessageCalls.at(-1)?.message;
    expect(marker).toBeDefined();
    if (marker === undefined) return;
    expect(
      coordinator
        .onMessageStart({ type: "message_start", message: marker })
        .isOk(),
    ).toBe(true);
    // No context repair arrives. The coordinator fails closed, but primary
    // session truth stays on the model that was actually applied.
    timer.fireNext();
    expect(coordinator.terminalDecision).toMatchObject({
      kind: "failed",
      reason: "context-timeout",
    });
    expect(session.getAppliedModel()).toEqual(fallback);
    expect(session.captureRequestSnapshot()).toMatchObject({
      modelIntent,
      selectedModel: fallback,
    });
    expect(session.getCurrent()?.modelActivation).toMatchObject({
      status: "applied",
      model: origin,
    });
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

describe("parent session persistence", () => {
  function probe(overrides: {
    persisted?: boolean;
    file?: string | undefined;
    id?: string;
    throws?: boolean;
    header?: unknown;
    headerThrows?: boolean;
  }) {
    const base = {
      isPersisted: () => {
        if (overrides.throws === true) throw new Error("host exploded");
        return overrides.persisted ?? true;
      },
      getSessionFile: () => overrides.file,
      getSessionId: () => overrides.id ?? "session-1",
    };
    if (overrides.header === undefined && overrides.headerThrows !== true) {
      return base;
    }
    return {
      ...base,
      getHeader: () => {
        if (overrides.headerThrows === true) throw new Error("header exploded");
        return overrides.header as { id?: unknown } | null;
      },
    };
  }

  it("records the host-probed identity of a persisted parent", () => {
    const state = probeParentSession(
      probe({ persisted: true, file: "/sessions/a.jsonl", id: "session-a" }),
    );
    expect(state).toEqual({
      persistence: "persistent",
      sessionId: "session-a",
      runtimeSessionId: "session-a",
      identitySource: "runtime",
      sessionFile: "/sessions/a.jsonl",
    });
  });

  it("prefers the persisted header id over an ephemeral runtime id", () => {
    // A restart that reopens the same parent session can probe while the
    // host still reports a freshly minted runtime id. The persisted header
    // is the stable identity historical refs were written against.
    const state = probeParentSession(
      probe({
        persisted: true,
        file: "/sessions/a.jsonl",
        id: "runtime-9",
        header: { type: "session", id: "session-a", cwd: "/w" },
      }),
    );
    expect(state).toEqual({
      persistence: "persistent",
      sessionId: "session-a",
      runtimeSessionId: "runtime-9",
      identitySource: "session-header",
      sessionFile: "/sessions/a.jsonl",
    });
  });

  it("uses the fork's own header id, never the source session id", () => {
    // Forking writes a new header id and records the source in
    // `parentSession`. Origin authority follows the new id, so refs copied
    // from the source session stay excluded.
    const state = probeParentSession(
      probe({
        persisted: true,
        file: "/sessions/fork.jsonl",
        id: "session-fork",
        header: {
          type: "session",
          id: "session-fork",
          parentSession: "/sessions/a.jsonl",
        },
      }),
    );
    expect(state.persistence === "persistent" && state.sessionId).toBe(
      "session-fork",
    );
  });

  it.each([
    ["absent header", null],
    ["non-object header", "session-a"],
    ["empty header id", { type: "session", id: "" }],
    ["non-string header id", { type: "session", id: 42 }],
    ["oversized header id", { type: "session", id: "x".repeat(257) }],
  ])("falls back to the runtime id for %s", (_name, header) => {
    const state = probeParentSession(
      probe({
        persisted: true,
        file: "/sessions/a.jsonl",
        id: "runtime-9",
        header,
      }),
    );
    expect(state).toEqual({
      persistence: "persistent",
      sessionId: "runtime-9",
      runtimeSessionId: "runtime-9",
      identitySource: "runtime",
      sessionFile: "/sessions/a.jsonl",
    });
  });

  it("treats a throwing header probe as unknown, never fabricating an id", () => {
    const state = probeParentSession(
      probe({
        persisted: true,
        file: "/sessions/a.jsonl",
        id: "runtime-9",
        headerThrows: true,
      }),
    );
    expect(state).toEqual({ persistence: "unknown", reason: "probe-failed" });
  });

  it("reports a --no-session parent as ephemeral from the host answer alone", () => {
    expect(
      probeParentSession(probe({ persisted: false, file: undefined })),
    ).toEqual({
      persistence: "ephemeral",
      reason: "host-reports-not-persisted",
    });
  });

  it("treats a persisted parent without a session file as ephemeral", () => {
    expect(probeParentSession(probe({ persisted: true, file: "" }))).toEqual({
      persistence: "ephemeral",
      reason: "no-session-file",
    });
  });

  it("never infers persistence when no probe or a throwing probe is available", () => {
    expect(probeParentSession(undefined)).toEqual(UNKNOWN_PARENT_SESSION);
    expect(probeParentSession(probe({ throws: true }))).toEqual({
      persistence: "unknown",
      reason: "probe-failed",
    });
  });

  it("rejects every mutation boundary on a non-persistent parent with one stable failure", () => {
    const state = probeParentSession(probe({ persisted: false }));
    for (const operation of [
      "delegate",
      "steer",
      "follow-up",
      "retry",
      "continue",
      "delete",
    ] as const) {
      const result = requirePersistentParentSession(state, operation);
      expect(result.isErr()).toBe(true);
      const failure = result._unsafeUnwrapErr();
      expect(failure.code).toBe("PersistentParentSessionRequired");
      expect(failure.retryable).toBe(false);
      expect(failure.correlation).toEqual({
        operation,
        reason: "host-reports-not-persisted",
        remediation:
          "Start or reopen Pi with a persistent session (do not use --no-session).",
      });
      expect(failure.safeMessage).toContain("persistent Pi session");
      expect(JSON.stringify(failure)).not.toContain("session-1");
    }
  });

  it("allows mutations only on a host-proven persistent parent", () => {
    expect(
      requirePersistentParentSession(
        probeParentSession(probe({ file: "/sessions/a.jsonl" })),
        "delegate",
      ).isOk(),
    ).toBe(true);
  });

  it("fails closed for unknown parents (no-probe and probe-failed)", () => {
    for (const reason of ["no-probe", "probe-failed"] as const) {
      const result = requirePersistentParentSession(
        { persistence: "unknown", reason },
        "delegate",
      );
      expect(result.isErr()).toBe(true);
      const failure = result._unsafeUnwrapErr();
      expect(failure.code).toBe("PersistentParentSessionRequired");
      expect(failure.correlation).toMatchObject({
        operation: "delegate",
        reason,
      });
    }
  });

  it("keeps read-only child access allowed for every parent state", () => {
    expect(
      isReadOnlyChildAccessAllowed(
        probeParentSession(probe({ persisted: false })),
      ),
    ).toBe(true);
    expect(isReadOnlyChildAccessAllowed(UNKNOWN_PARENT_SESSION)).toBe(true);
    expect(
      isReadOnlyChildAccessAllowed(
        probeParentSession(probe({ file: "/sessions/a.jsonl" })),
      ),
    ).toBe(true);
  });

  it("records the parent session on the primary session and re-probes on transition", () => {
    const session = new PiPrimarySession({
      skillCatalog: new PiSkillCatalog(),
      logger: new RecordingLogger(),
      parentSessionProbe: probe({ persisted: false }),
    });
    expect(session.getParentSession().persistence).toBe("ephemeral");
    expect(session.requirePersistentParent("delegate").isErr()).toBe(true);

    session.refreshParentSession(
      probe({ persisted: true, file: "/sessions/b.jsonl", id: "session-b" }),
    );
    expect(session.getParentSession()).toEqual({
      persistence: "persistent",
      sessionId: "session-b",
      runtimeSessionId: "session-b",
      identitySource: "runtime",
      sessionFile: "/sessions/b.jsonl",
    });
    expect(session.requirePersistentParent("delegate").isOk()).toBe(true);
  });

  it("defaults to unknown and fails closed when no probe is wired", () => {
    const session = new PiPrimarySession({
      skillCatalog: new PiSkillCatalog(),
      logger: new RecordingLogger(),
    });
    expect(session.getParentSession()).toEqual(UNKNOWN_PARENT_SESSION);
    expect(session.requirePersistentParent("retry").isErr()).toBe(true);
    expect(
      session.requirePersistentParent("retry")._unsafeUnwrapErr().correlation,
    ).toMatchObject({ reason: "no-probe" });
  });
});

describe("projectPiProviderEvent", () => {
  it("projects only the hook name and integer status, never payload or headers", () => {
    const payload = { secret: "do-not-copy" };
    const headers = { authorization: "secret-token" };
    const request = projectPiProviderEvent({
      type: "before_provider_request",
      payload,
    });
    const headerEvent = projectPiProviderEvent({
      type: "before_provider_headers",
      headers,
    });
    const response = projectPiProviderEvent({
      type: "after_provider_response",
      status: 200,
      headers,
      body: "do-not-copy",
    });
    expect(request._unsafeUnwrap()).toEqual({
      type: "before_provider_request",
    });
    expect(headerEvent._unsafeUnwrap()).toEqual({
      type: "before_provider_headers",
    });
    expect(response._unsafeUnwrap()).toEqual({
      type: "after_provider_response",
      status: 200,
    });
    expect(JSON.stringify(request._unsafeUnwrap())).not.toContain("secret");
    expect(JSON.stringify(headerEvent._unsafeUnwrap())).not.toContain(
      "authorization",
    );
    expect(JSON.stringify(response._unsafeUnwrap())).not.toContain(
      "do-not-copy",
    );
    payload.secret = "mutated";
    headers.authorization = "mutated";
    expect(request._unsafeUnwrap()).toEqual({
      type: "before_provider_request",
    });
  });

  it("accepts safe plain and null-prototype events", () => {
    const nullPrototypeRequest = Object.create(null) as Record<string, unknown>;
    nullPrototypeRequest.type = "before_provider_request";
    const nullPrototypeHeaders = Object.create(null) as Record<string, unknown>;
    nullPrototypeHeaders.type = "before_provider_headers";
    const nullPrototypeResponse = Object.create(null) as Record<
      string,
      unknown
    >;
    nullPrototypeResponse.type = "after_provider_response";
    nullPrototypeResponse.status = 204;

    expect(
      projectPiProviderEvent({ type: "before_provider_request" }).isOk(),
    ).toBe(true);
    expect(projectPiProviderEvent(nullPrototypeRequest).isOk()).toBe(true);
    expect(projectPiProviderEvent(nullPrototypeHeaders).isOk()).toBe(true);
    expect(
      projectPiProviderEvent(nullPrototypeResponse)._unsafeUnwrap(),
    ).toEqual({ type: "after_provider_response", status: 204 });
  });

  it("rejects inherited, symbol, callable, and unexpected-prototype inputs", () => {
    const inheritedType = Object.create({ type: "before_provider_request" });
    const inheritedStatus = Object.create({ status: 200 });
    Object.defineProperty(inheritedStatus, "type", {
      value: "after_provider_response",
      enumerable: true,
      writable: true,
      configurable: true,
    });
    const symbolKey = Symbol("provider-secret");
    const withSymbol = { type: "before_provider_request" } as Record<
      string | symbol,
      unknown
    >;
    Object.defineProperty(withSymbol, symbolKey, {
      value: "secret",
      enumerable: true,
      writable: true,
      configurable: true,
    });
    const unexpectedPrototype = Object.create(Date.prototype) as {
      type: string;
    };
    Object.defineProperty(unexpectedPrototype, "type", {
      value: "before_provider_request",
      enumerable: true,
      writable: true,
      configurable: true,
    });

    expect(projectPiProviderEvent(inheritedType).isErr()).toBe(true);
    expect(projectPiProviderEvent(inheritedStatus).isErr()).toBe(true);
    expect(projectPiProviderEvent(withSymbol).isErr()).toBe(true);
    expect(projectPiProviderEvent(() => undefined).isErr()).toBe(true);
    expect(projectPiProviderEvent(unexpectedPrototype).isErr()).toBe(true);
  });

  it("rejects accessors without invoking throwing or mutating getters", () => {
    let throwingGetterReads = 0;
    const throwingGetter = {};
    Object.defineProperty(throwingGetter, "type", {
      enumerable: true,
      configurable: true,
      get: () => {
        throwingGetterReads += 1;
        throw new Error("getter must not run");
      },
    });

    let mutatingGetterReads = 0;
    const mutatingGetter = { type: "after_provider_response" };
    Object.defineProperty(mutatingGetter, "status", {
      enumerable: true,
      configurable: true,
      get: () => {
        mutatingGetterReads += 1;
        mutatingGetter.type = "before_provider_request";
        return 200;
      },
    });

    let setterCalls = 0;
    const setterOnly = {};
    Object.defineProperty(setterOnly, "type", {
      enumerable: true,
      configurable: true,
      set: () => {
        setterCalls += 1;
      },
    });

    expect(projectPiProviderEvent(throwingGetter).isErr()).toBe(true);
    expect(projectPiProviderEvent(mutatingGetter).isErr()).toBe(true);
    expect(projectPiProviderEvent(setterOnly).isErr()).toBe(true);
    expect(throwingGetterReads).toBe(0);
    expect(mutatingGetterReads).toBe(0);
    expect(setterCalls).toBe(0);
    expect(mutatingGetter.type).toBe("after_provider_response");
  });

  it("rejects unsafe descriptors before reading their values", () => {
    for (const unsafeDescriptor of [
      { enumerable: false },
      { writable: false },
      { configurable: false },
    ]) {
      const event = {};
      Object.defineProperty(event, "type", {
        value: "before_provider_request",
        enumerable: true,
        writable: true,
        configurable: true,
        ...unsafeDescriptor,
      });
      expect(projectPiProviderEvent(event).isErr()).toBe(true);
    }
  });

  it("rejects unknown or malformed provider events without throwing", () => {
    expect(projectPiProviderEvent(null).isErr()).toBe(true);
    expect(projectPiProviderEvent({ type: "session_start" }).isErr()).toBe(
      true,
    );
    expect(projectPiProviderEvent({ type: 42 }).isErr()).toBe(true);
    expect(
      projectPiProviderEvent({
        type: "after_provider_response",
        status: "200",
      }).isErr(),
    ).toBe(true);
    expect(
      projectPiProviderEvent({
        type: "after_provider_response",
        status: 200.5,
      }).isErr(),
    ).toBe(true);
  });
});
