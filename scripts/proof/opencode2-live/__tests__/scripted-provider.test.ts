import { describe, expect, it } from "bun:test";
import { ScriptedProvider } from "../scripted-provider.js";

function body(
  tools: readonly string[],
  roles: readonly string[] = ["system", "user"],
): object {
  return {
    messages: roles.map((role) => ({ role, content: "x" })),
    tools: tools.map((name) => ({ type: "function", function: { name } })),
  };
}

function toolCalls(
  text: string,
): Array<{ function: { name: string; arguments: string } }> {
  return text
    .split("\n")
    .filter((line) => line.startsWith("data: {"))
    .flatMap(
      (line) => JSON.parse(line.slice(6)).choices[0].delta.tool_calls ?? [],
    );
}

describe("the first request that offers the delegation tool", () => {
  it("is answered with one delegation to the configured subagent", async () => {
    const provider = new ScriptedProvider({
      delegationTool: "subagent",
      delegates: ["shuttle"],
    });
    const calls = toolCalls(
      await provider.reply(body(["read", "subagent"])).text(),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.function.name).toBe("subagent");
    expect(JSON.parse(calls[0]?.function.arguments ?? "{}").agent).toBe(
      "shuttle",
    );
  });
});

describe("requests after the delegation", () => {
  it("are answered with text, so a subagent wrongly offered the tool cannot loop", async () => {
    const provider = new ScriptedProvider({
      delegationTool: "subagent",
      delegates: ["shuttle"],
    });
    await provider.reply(body(["subagent"]));
    const again = await provider.reply(body(["subagent"])).text();
    expect(toolCalls(again)).toHaveLength(0);
    expect(again).toContain('"content":"OK"');
  });
});

describe("several configured subagents", () => {
  const RESULT = ["system", "user", "assistant", "tool"];

  it("are called one per turn, in order, each after the previous result came back", async () => {
    const provider = new ScriptedProvider({
      delegationTool: "subagent",
      delegates: ["explore", "shuttle"],
    });
    const agentOf = async (reply: Response) =>
      toolCalls(await reply.text()).map(
        (call) => JSON.parse(call.function.arguments).agent,
      );

    expect(await agentOf(provider.reply(body(["subagent"])))).toEqual([
      "explore",
    ]);
    // A turn that has not seen the first result yet (a subagent wrongly
    // offered the tool) gets text, not the next call.
    expect(await agentOf(provider.reply(body(["subagent"])))).toEqual([]);
    expect(await agentOf(provider.reply(body(["subagent"], RESULT)))).toEqual([
      "shuttle",
    ]);
    expect(
      await agentOf(provider.reply(body(["subagent"], [...RESULT, ...RESULT]))),
    ).toEqual([]);
  });
});

describe("a request that carries a tool result before any call was made", () => {
  it("is answered with text", async () => {
    const provider = new ScriptedProvider({
      delegationTool: "subagent",
      delegates: ["shuttle"],
    });
    const reply = await provider
      .reply(body(["subagent"], ["system", "user", "assistant", "tool"]))
      .text();
    expect(toolCalls(reply)).toHaveLength(0);
  });
});

describe("every request", () => {
  it("is recorded in arrival order", () => {
    const provider = new ScriptedProvider({
      delegationTool: "subagent",
      delegates: ["shuttle"],
    });
    const first = body([]);
    const second = body(["subagent"]);
    provider.reply(first);
    provider.reply(second);
    expect(provider.captured().map((entry) => entry.body)).toEqual([
      first,
      second,
    ]);
  });
});
