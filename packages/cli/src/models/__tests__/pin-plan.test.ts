import { describe, expect, it } from "bun:test";
import { isQualifiedModel, planPins } from "../pin-plan.js";

const none = {};

describe("isQualifiedModel", () => {
  it("treats any entry with a slash as provider-qualified", () => {
    expect(isQualifiedModel("openrouter/anthropic/claude-opus-5.5")).toBe(true);
    expect(isQualifiedModel("github-copilot/gpt-6-sol")).toBe(true);
    expect(isQualifiedModel("claude-opus-5.6")).toBe(false);
    expect(isQualifiedModel("opus")).toBe(false);
  });
});

describe("planPins", () => {
  it("appends the recommended entries after the agent's own and counts the agents that change", () => {
    const plan = planPins(
      { loom: ["claude-opus-5.6"], shuttle: ["mine"] },
      { loom: ["my-model"], shuttle: ["mine"] },
      false,
    );
    expect(plan.lists).toEqual({
      loom: ["my-model", "claude-opus-5.6"],
      shuttle: ["mine"],
    });
    expect(plan.changed).toBe(1);
    expect(plan.qualified).toEqual([]);
    expect(plan.unchanged).toEqual([]);
  });

  it("leaves provider-qualified entries out by default and reports them", () => {
    const plan = planPins(
      {
        loom: ["openrouter/anthropic/claude-opus-5.5", "claude-opus-5.5"],
        weft: ["gpt-6-sol"],
      },
      none,
      false,
    );
    expect(plan.lists).toEqual({
      loom: ["claude-opus-5.5"],
      weft: ["gpt-6-sol"],
    });
    expect(plan.qualified).toEqual([
      { agent: "loom", models: ["openrouter/anthropic/claude-opus-5.5"] },
    ]);
    expect(plan.unchanged).toEqual([]);
    expect(plan.changed).toBe(2);
  });

  it("keeps provider-qualified entries when asked, and still reports them", () => {
    const plan = planPins(
      { loom: ["openrouter/anthropic/claude-opus-5.5", "claude-opus-5.5"] },
      none,
      true,
    );
    expect(plan.lists).toEqual({
      loom: ["openrouter/anthropic/claude-opus-5.5", "claude-opus-5.5"],
    });
    expect(plan.qualified).toEqual([
      { agent: "loom", models: ["openrouter/anthropic/claude-opus-5.5"] },
    ]);
  });

  it("leaves an agent alone when every recommended entry is provider-qualified", () => {
    const plan = planPins(
      {
        loom: ["claude-opus-5.6"],
        thread: ["github-copilot/claude-haiku-5"],
      },
      { thread: ["my-haiku"] },
      false,
    );
    expect(plan.lists).toEqual({ loom: ["claude-opus-5.6"] });
    expect(plan.unchanged).toEqual(["thread"]);
    expect(plan.qualified).toEqual([
      { agent: "thread", models: ["github-copilot/claude-haiku-5"] },
    ]);
    expect(plan.changed).toBe(1);
  });

  it("does not report a qualified entry the user already lists themselves", () => {
    const plan = planPins(
      { loom: ["openrouter/x", "claude-opus-5.6"] },
      { loom: ["openrouter/x"] },
      false,
    );
    expect(plan.lists).toEqual({ loom: ["openrouter/x", "claude-opus-5.6"] });
    expect(plan.qualified).toEqual([]);
  });

  it("counts an agent whose own list had duplicates as changed", () => {
    const plan = planPins({ loom: ["b"] }, { loom: ["a", "a"] }, false);
    expect(plan.lists).toEqual({ loom: ["a", "b"] });
    expect(plan.changed).toBe(1);
  });

  it("does not count an agent that already lists every recommended entry", () => {
    const plan = planPins({ loom: ["b", "a"] }, { loom: ["a", "b"] }, false);
    expect(plan.lists).toEqual({ loom: ["a", "b"] });
    expect(plan.changed).toBe(0);
  });
});
