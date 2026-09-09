import { describe, expect, it } from "bun:test";
import { Model, Provider } from "@opencode-ai/plugin";
import type { CommandDefinition } from "@opencode-ai/plugin/promise/command";
import type {
  PlanTaskSnapshot,
  PlanTaskSnapshotReader,
} from "@weaveio/weave-engine";
import { errAsync, okAsync } from "neverthrow";
import {
  type OpenCode2CommandDependencies,
  OpenCode2Commands,
} from "../v2/commands.js";
import type {
  CommandEditor,
  CommandInvocation,
  OpenCode2Context,
} from "../v2/host-types.js";
import { OpenCode2PlanSessionState } from "../v2/plan-session-state.js";
import { catalog, projection } from "./v2-fixtures.js";

const snapshot: PlanTaskSnapshot = {
  planName: "release",
  contentRevision: "a".repeat(64),
  format: "canonical",
  parents: [{ id: "1", title: "Build", state: "pending", children: [] }],
  totalParentCount: 1,
  totalTaskCount: 1,
  completedTaskCount: 0,
  complete: false,
};

class MemoryStorage {
  readonly values = new Map<
    string,
    Awaited<ReturnType<OpenCode2Context["storage"]["get"]>>
  >();
  async get(key: string) {
    return this.values.get(key);
  }
  async set(
    key: string,
    value: Parameters<OpenCode2Context["storage"]["set"]>[1],
  ) {
    this.values.set(key, value);
  }
  async remove(key: string) {
    this.values.delete(key);
  }
}

function commandHarness(
  options: {
    promptFails?: boolean;
    planMissing?: boolean;
    owned?: boolean;
    refreshedModelID?: string;
    refreshRemovesTapestry?: boolean;
  } = {},
) {
  const calls: Array<{ name: string; input?: unknown }> = [];
  const storage = new MemoryStorage();
  const plans = new OpenCode2PlanSessionState(storage);
  const refreshedModel = {
    providerID: Provider.ID.make("provider"),
    id: Model.ID.make(options.refreshedModelID ?? "model"),
  };
  const refreshedTapestry = {
    ...projection("tapestry"),
    model: refreshedModel,
  };
  const refreshed = options.refreshRemovesTapestry
    ? catalog()
    : catalog(new Map([["tapestry", refreshedTapestry]]));
  const reader: PlanTaskSnapshotReader = {
    readSnapshot: () =>
      options.planMissing
        ? errAsync({ type: "PlanMissing", planName: "release" })
        : okAsync(snapshot),
  };
  const dependencies = {
    location: "/project",
    workspaceID: "workspace",
    refresh: () => {
      calls.push({ name: "refresh" });
      return okAsync(refreshed);
    },
    ownsAgent: () => options.owned !== false,
    plans,
    reader,
    planChanged: async (sessionID: string) => {
      calls.push({ name: "event", input: sessionID });
    },
    context: {
      session: {
        get: async () => ({
          location: { directory: "/project", workspaceID: "workspace" },
          agent: "old-agent",
          model: {
            providerID: Provider.ID.make("old-provider"),
            id: Model.ID.make("old-model"),
          },
        }),
        switchAgent: async (input: unknown) => {
          calls.push({ name: "agent", input });
        },
        switchModel: async (input: unknown) => {
          calls.push({ name: "model", input });
        },
        prompt: async (input: unknown) => {
          calls.push({ name: "prompt", input });
          if (options.promptFails) throw new Error("rejected");
        },
        synthetic: async (input: unknown) => {
          calls.push({ name: "synthetic", input });
        },
      },
    },
  } as unknown as OpenCode2CommandDependencies;
  let definition: CommandDefinition | undefined;
  new OpenCode2Commands(dependencies).register({
    add: (value) => {
      definition = value;
    },
  } as CommandEditor);
  return { calls, plans, definition };
}

function invocation(text = "release"): CommandInvocation {
  return {
    sessionID: "session",
    prompt: {
      id: "command-prompt",
      text,
      files: [{ uri: "file:///project/input.txt" }],
    },
    delivery: "queue",
  } as unknown as CommandInvocation;
}

describe("OpenCode2Commands", () => {
  it("registers only the reserved command when Tapestry is owned", () => {
    expect(commandHarness().definition?.name).toBe("weave:start");
    expect(commandHarness({ owned: false }).definition).toBeUndefined();
  });

  it("starts one explicit plan, preserves files without reusing the command prompt ID, and stores display state", async () => {
    const harness = commandHarness();
    await harness.definition?.execute(invocation());
    expect(harness.calls.map((call) => call.name)).toEqual([
      "refresh",
      "event",
      "agent",
      "model",
      "prompt",
      "event",
    ]);
    const prompt = harness.calls.find((call) => call.name === "prompt")
      ?.input as { id?: string; files?: unknown[]; text: string };
    expect(prompt.files).toHaveLength(1);
    expect(prompt.id).toBeUndefined();
    expect(prompt.text).toContain(".weave/plans/release.md");
    expect((await harness.plans.get("session"))._unsafeUnwrap()?.planName).toBe(
      "release",
    );
  });

  it("clears old display state and does not switch agents for a missing plan", async () => {
    const harness = commandHarness({ planMissing: true });
    await harness.definition?.execute(invocation());
    expect(harness.calls.some((call) => call.name === "agent")).toBe(false);
    expect(harness.calls.map((call) => call.name)).toEqual([
      "refresh",
      "event",
      "synthetic",
    ]);
    expect(harness.calls[2]?.input).toMatchObject({ resume: false });
    expect(
      (await harness.plans.get("session"))._unsafeUnwrap(),
    ).toBeUndefined();
  });

  it("restores prior session intent and stores no selection when prompt admission fails", async () => {
    const harness = commandHarness({ promptFails: true });
    await harness.definition?.execute(invocation());
    expect(harness.calls.map((call) => call.name)).toEqual([
      "refresh",
      "event",
      "agent",
      "model",
      "prompt",
      "agent",
      "model",
      "synthetic",
    ]);
    expect(
      (await harness.plans.get("session"))._unsafeUnwrap(),
    ).toBeUndefined();
  });

  it("asks for one explicit plan without changing state", async () => {
    const harness = commandHarness();
    await harness.definition?.execute(invocation(""));
    expect(harness.calls.map((call) => call.name)).toEqual(["synthetic"]);
  });

  it("uses the refreshed Tapestry model for command admission", async () => {
    const harness = commandHarness({ refreshedModelID: "new-model" });
    await harness.definition?.execute(invocation());
    expect(harness.calls[0]?.name).toBe("refresh");
    expect(
      harness.calls.find((call) => call.name === "model")?.input,
    ).toMatchObject({
      model: { providerID: "provider", id: "new-model" },
    });
  });

  it("does not admit work when refresh removes Tapestry", async () => {
    const harness = commandHarness({ refreshRemovesTapestry: true });
    await harness.definition?.execute(invocation());
    expect(harness.calls.map((call) => call.name)).toEqual([
      "refresh",
      "event",
      "synthetic",
    ]);
    expect(harness.calls.some((call) => call.name === "prompt")).toBe(false);
  });
});
