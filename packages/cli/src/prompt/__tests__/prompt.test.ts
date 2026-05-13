import { describe, expect, it } from "bun:test";
import { StaticPromptAdapter } from "../index.js";

describe("prompt adapter", () => {
  it("returns selected scope answers", async () => {
    const prompt = new StaticPromptAdapter({ select: ["global"] });
    const result = await prompt.select({
      message:
        "Choose scope: global installs shared config, local installs project config",
      options: [
        { value: "global", label: "Global", hint: "shared across projects" },
        { value: "local", label: "Local", hint: "this project only" },
      ],
      initialValue: "local",
    });
    expect(result._unsafeUnwrap()).toBe("global");
  });

  it("returns install-directory defaults and overrides", async () => {
    const prompt = new StaticPromptAdapter({ text: ["/custom/.weave"] });
    const result = await prompt.text({
      message: "Install directory",
      defaultValue: "/project/.weave",
    });
    expect(result._unsafeUnwrap()).toBe("/custom/.weave");
  });

  it("returns multi-select harness answers", async () => {
    const prompt = new StaticPromptAdapter({
      multiselect: [["opencode", "pi"]],
    });
    const result = await prompt.multiselect({
      message: "Select harnesses",
      options: [
        { value: "opencode", label: "OpenCode" },
        { value: "pi", label: "Pi" },
      ],
      required: false,
    });
    expect(result._unsafeUnwrap()).toEqual(["opencode", "pi"]);
  });

  it("returns adapter module prompts", async () => {
    const prompt = new StaticPromptAdapter({ multiselect: [["agents"]] });
    const result = await prompt.multiselect({
      message: "Select adapter modules",
      options: [{ value: "agents", label: "Weave agent descriptors" }],
      initialValues: ["agents"],
    });
    expect(result._unsafeUnwrap()).toEqual(["agents"]);
  });

  it("reports non-TTY prompt unavailability", async () => {
    const prompt = new StaticPromptAdapter({ interactive: false });
    const result = await prompt.confirm({
      message: "Continue?",
      initialValue: true,
    });
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().type).toBe("PromptUnavailable");
  });

  it("supports --yes style bypass by not prompting", () => {
    const prompt = new StaticPromptAdapter({ interactive: false });
    expect(prompt.isInteractive()).toBe(false);
  });

  it("returns cancellation as an explicit result", async () => {
    const prompt = new StaticPromptAdapter({ cancelNext: true });
    const result = await prompt.text({
      message: "Install directory",
      defaultValue: "/project/.weave",
    });
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().type).toBe("PromptCancelled");
  });
});
