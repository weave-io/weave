import { beforeEach, describe, expect, it } from "bun:test";
import type { AgentDescriptor } from "@weave/engine";
import { access } from "node:fs/promises";
import { dirname } from "node:path";
import { PiAdapter, type PiExtensionAPI } from "../index.js";

type MockPiToolDefinition = {
  name: string;
  label: string;
  description: string;
  parameters: {
    type?: string;
    properties?: Record<string, unknown>;
  };
  execute(
    toolCallId: string,
    params: { agent: string; task: string },
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: unknown,
  ): Promise<unknown>;
};

class MockPiExtensionAPI implements PiExtensionAPI {
  public readonly registeredTools: MockPiToolDefinition[] = [];
  public activeTools: string[] = [];
  public readonly handlers = new Map<string, Function>();
  public execResult: unknown = "mock exec result";
  public lastExecArgs: string[] = [];

  public on(event: string, handler: Function): void {
    this.handlers.set(event, handler);
  }

  public registerTool(tool: MockPiToolDefinition): void {
    this.registeredTools.push(tool);
  }

  public setActiveTools(names: string[]): void {
    this.activeTools = names;
  }

  public async exec(
    _command: string,
    args: string[],
    _options?: Record<string, unknown>,
  ): Promise<unknown> {
    this.lastExecArgs = [...args];
    return this.execResult;
  }
}

function makeDescriptor(overrides: Partial<AgentDescriptor> = {}): AgentDescriptor {
  return {
    name: "loom",
    description: "Test agent",
    composedPrompt: "You are a test agent.",
    models: ["github-copilot/gpt-5.4"],
    mode: "primary",
    temperature: 0.1,
    toolPolicy: {
      read: "allow",
      write: "deny",
      execute: "deny",
      network: "deny",
      delegate: "deny",
    },
    delegationTargets: [],
    ...overrides,
  };
}

describe("PiAdapter", () => {
  let adapter: PiAdapter;
  let pi: MockPiExtensionAPI;

  beforeEach(() => {
    adapter = new PiAdapter();
    pi = new MockPiExtensionAPI();
  });

  it("Should_collect_agent_descriptor_on_spawnSubagent", async () => {
    const descriptor = makeDescriptor();

    await adapter.spawnSubagent("loom", descriptor);

    const extension = adapter.toExtension();

    await expect(extension(pi)).resolves.toBeUndefined();
    expect(pi.handlers.has("before_agent_start")).toBe(true);
    expect(pi.registeredTools.map((tool) => tool.name)).toContain("delegate");
  });

  it("Should_return_system_prompt_when_before_agent_start_handler_runs", async () => {
    const descriptor = makeDescriptor({
      composedPrompt: "Composed primary system prompt.",
    });

    await adapter.spawnSubagent("loom", descriptor);
    await adapter.toExtension()(pi);

    const handler = pi.handlers.get("before_agent_start");

    expect(handler).toBeDefined();

    const result = await handler?.(
      {
        type: "before_agent_start",
        prompt: "User prompt",
        systemPrompt: "Original system prompt",
        systemPromptOptions: {},
      },
      {},
    );

    expect(result).toEqual({ systemPrompt: descriptor.composedPrompt });
  });

  it("Should_set_active_tools_when_before_agent_start_handler_runs", async () => {
    const descriptor = makeDescriptor({
      toolPolicy: {
        read: "allow",
        write: "allow",
        execute: "deny",
        network: "deny",
        delegate: "allow",
      },
    });

    await adapter.spawnSubagent("loom", descriptor);
    await adapter.toExtension()(pi);

    const handler = pi.handlers.get("before_agent_start");

    await handler?.(
      {
        type: "before_agent_start",
        prompt: "User prompt",
        systemPrompt: "Original system prompt",
        systemPromptOptions: {},
      },
      {},
    );

    expect(pi.activeTools).toEqual([
      "read",
      "grep",
      "find",
      "ls",
      "write",
      "edit",
      "delegate",
    ]);
  });

  it("Should_register_delegate_tool_with_typebox_parameters_schema", async () => {
    await adapter.spawnSubagent("loom", makeDescriptor());

    await adapter.toExtension()(pi);

    const delegateTool = pi.registeredTools.find((tool) => tool.name === "delegate");

    expect(delegateTool).toBeDefined();
    expect(delegateTool?.parameters.type).toBe("object");
    expect(delegateTool?.parameters.properties).toHaveProperty("agent");
    expect(delegateTool?.parameters.properties).toHaveProperty("task");
  });

  it("Should_return_agent_tool_result_shape_when_delegate_tool_executes", async () => {
    const primaryDescriptor = makeDescriptor({
      toolPolicy: {
        read: "allow",
        write: "allow",
        execute: "deny",
        network: "deny",
        delegate: "allow",
      },
    });
    const threadDescriptor = makeDescriptor({
      name: "thread",
      mode: "subagent",
      composedPrompt: "You are thread.",
    });

    await adapter.spawnSubagent("loom", primaryDescriptor);
    await adapter.spawnSubagent("thread", threadDescriptor);
    await adapter.toExtension()(pi);

    const delegateTool = pi.registeredTools.find((tool) => tool.name === "delegate");

    expect(delegateTool).toBeDefined();

    const result = await delegateTool?.execute(
      "tool-call-1",
      { agent: "thread", task: "explore the codebase" },
      undefined,
      undefined,
      {},
    );

    expect(result).toEqual({
      content: [
        {
          type: "text",
          text: JSON.stringify(pi.execResult),
        },
      ],
      details: {},
    });

    const taskIndex = pi.lastExecArgs.lastIndexOf("explore the codebase");

    expect(taskIndex).toBeGreaterThan(0);
    // Task is the last positional arg — no -- terminator (Pi CLI doesn't support it)
    expect(pi.lastExecArgs[taskIndex]).toBe("explore the codebase");
  });

  it("Should_strip_leading_dashes_from_task_to_prevent_arg_injection", async () => {
    const primaryDescriptor = makeDescriptor({
      toolPolicy: {
        read: "allow",
        write: "allow",
        execute: "deny",
        network: "deny",
        delegate: "allow",
      },
    });
    const threadDescriptor = makeDescriptor({
      name: "thread",
      mode: "subagent",
      composedPrompt: "You are thread.",
    });

    await adapter.spawnSubagent("loom", primaryDescriptor);
    await adapter.spawnSubagent("thread", threadDescriptor);
    await adapter.toExtension()(pi);

    const delegateTool = pi.registeredTools.find((tool) => tool.name === "delegate");

    await delegateTool?.execute(
      "tool-call-inject",
      { agent: "thread", task: "--malicious-flag value" },
      undefined,
      undefined,
      {},
    );

    const lastArg = pi.lastExecArgs[pi.lastExecArgs.length - 1];
    expect(lastArg).toBe("malicious-flag value");
  });

  it("Should_cleanup_temp_prompt_file_after_delegate_tool_executes", async () => {
    const primaryDescriptor = makeDescriptor({
      toolPolicy: {
        read: "allow",
        write: "allow",
        execute: "deny",
        network: "deny",
        delegate: "allow",
      },
    });
    const threadDescriptor = makeDescriptor({
      name: "thread",
      mode: "subagent",
      composedPrompt: "You are thread.",
    });

    await adapter.spawnSubagent("loom", primaryDescriptor);
    await adapter.spawnSubagent("thread", threadDescriptor);

    let tempPromptFileDuringExec = "";
    pi.exec = async (_command: string, args: string[]): Promise<unknown> => {
      pi.lastExecArgs = [...args];
      const promptFileIndex = args.indexOf("--append-system-prompt");
      tempPromptFileDuringExec = args[promptFileIndex + 1] ?? "";
      await access(tempPromptFileDuringExec);
      return pi.execResult;
    };

    await adapter.toExtension()(pi);

    const delegateTool = pi.registeredTools.find((tool) => tool.name === "delegate");

    await delegateTool?.execute(
      "tool-call-2",
      { agent: "thread", task: "inspect temp lifecycle" },
      undefined,
      undefined,
      {},
    );

    expect(tempPromptFileDuringExec).not.toBe("");
    await expect(access(dirname(tempPromptFileDuringExec))).rejects.toBeDefined();
  });
});
