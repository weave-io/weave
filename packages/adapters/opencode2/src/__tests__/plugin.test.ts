import { describe, expect, it } from "bun:test";

import { setupWeavePlugin } from "../plugin.js";
import { MockPluginContext } from "./mock-plugin-context.js";

describe("setupWeavePlugin", () => {
  it("initializes the adapter (registers built-in commands) via facade.command.transform", async () => {
    const facade = new MockPluginContext();

    await setupWeavePlugin(facade);

    const commandTransformCalls = facade.calls.filter(
      (call) => call.method === "command.transform",
    );
    expect(commandTransformCalls.length).toBeGreaterThan(0);
  });

  it("subscribes to events with an AbortSignal", async () => {
    const facade = new MockPluginContext();

    await setupWeavePlugin(facade);

    const subscribeCalls = facade.calls.filter(
      (call) => call.method === "event.subscribe",
    );
    expect(subscribeCalls.length).toBe(1);
    const [options] = subscribeCalls[0]?.args ?? [];
    expect(
      (options as { signal?: AbortSignal } | undefined)?.signal,
    ).toBeInstanceOf(AbortSignal);
  });

  it("cleanup aborts the subscription controller and disposes every registration", async () => {
    const disposedCommandRegistrations: string[] = [];
    const facade = new MockPluginContext();
    const originalCommandTransform = facade.command.transform.bind(
      facade.command,
    );
    (facade as unknown as { command: typeof facade.command }).command = {
      transform: async (
        callback: Parameters<typeof originalCommandTransform>[0],
      ) => {
        const registration = await originalCommandTransform(callback);
        return {
          dispose: async () => {
            disposedCommandRegistrations.push("command");
            await registration.dispose();
          },
        };
      },
    };

    const cleanup = await setupWeavePlugin(facade);

    await cleanup();

    // The subscribe call's signal should now be aborted.
    const subscribeCalls = facade.calls.filter(
      (call) => call.method === "event.subscribe",
    );
    const [options] = subscribeCalls[0]?.args ?? [];
    const signal = (options as { signal?: AbortSignal } | undefined)?.signal;
    expect(signal?.aborted).toBe(true);

    // Every command registration accumulated during init() must have been
    // disposed during cleanup.
    expect(disposedCommandRegistrations.length).toBeGreaterThan(0);
  });
});
