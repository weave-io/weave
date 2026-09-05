import { describe, expect, it } from "bun:test";

import {
  BUILTIN_COMMANDS,
  WEAVE_START_TEMPLATE,
} from "../command-templates.js";
import {
  buildExecuteCallback,
  registerCommands,
} from "../runtime-command-projection.js";
import { MockPluginContext } from "./mock-plugin-context.js";

describe("registerCommands", () => {
  it("registers every template via its own command.transform call", async () => {
    const facade = new MockPluginContext();

    const result = await registerCommands(facade, BUILTIN_COMMANDS);

    expect(result.isOk()).toBe(true);
    const registrations = result._unsafeUnwrap();
    expect(registrations).toHaveLength(BUILTIN_COMMANDS.length);

    const transformCalls = facade.calls.filter(
      (c) => c.method === "command.transform",
    );
    expect(transformCalls).toHaveLength(BUILTIN_COMMANDS.length);
  });

  it("captures every returned V2Registration for disposal", async () => {
    const facade = new MockPluginContext();

    const result = await registerCommands(facade, BUILTIN_COMMANDS);
    const registrations = result._unsafeUnwrap();

    // Every registration must be disposable without throwing.
    for (const registration of registrations) {
      await expect(registration.dispose()).resolves.toBeUndefined();
    }
  });

  it("maps a command.transform rejection to a CommandRegistrationError", async () => {
    const facade = new MockPluginContext();
    (facade as { command: { transform: unknown } }).command.transform =
      async () => {
        throw new Error("boom");
      };

    const result = await registerCommands(facade, [WEAVE_START_TEMPLATE]);

    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.type).toBe("CommandRegistrationError");
    if (error.type === "CommandRegistrationError") {
      expect(error.commandName).toBe("weave:start");
    }
  });
});

describe("buildExecuteCallback", () => {
  it("calls facade.session.prompt with the templated text and delivery mode", async () => {
    const facade = new MockPluginContext();
    const execute = buildExecuteCallback(facade, WEAVE_START_TEMPLATE, "queue");

    await execute({
      sessionID: "session-1" as never,
      prompt: { text: "my-plan" } as never,
      delivery: "queue",
    });

    const promptCalls = facade.calls.filter(
      (c) => c.method === "session.prompt",
    );
    expect(promptCalls).toHaveLength(1);
    const [input] = promptCalls[0]?.args ?? [];
    const promptInput = input as {
      sessionID: string;
      text: string;
      delivery: string;
    };
    expect(promptInput.sessionID).toBe("session-1");
    expect(promptInput.delivery).toBe("queue");
    expect(promptInput.text).toContain("my-plan");
    expect(promptInput.text).toContain(
      "<command-name>weave:start</command-name>",
    );
  });

  it("defaults to the 'queue' delivery mode when unspecified", async () => {
    const facade = new MockPluginContext();
    const execute = buildExecuteCallback(facade, WEAVE_START_TEMPLATE);

    await execute({
      sessionID: "session-2" as never,
      prompt: { text: "" } as never,
      delivery: "queue",
    });

    const [input] =
      facade.calls.find((c) => c.method === "session.prompt")?.args ?? [];
    expect((input as { delivery: string }).delivery).toBe("queue");
  });
});
