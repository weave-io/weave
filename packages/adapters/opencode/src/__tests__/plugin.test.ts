import { describe, expect, it } from "bun:test";
import { okAsync } from "neverthrow";
import adapter, { WeavePlugin, WeavePluginServer } from "../index.js";
import type { OpenCode2Context } from "../v2/host-types.js";
import { setupOpenCode2 } from "../v2/plugin.js";
import { catalog, projection } from "./v2-fixtures.js";

describe("OpenCode adapter entrypoint", () => {
  it("publishes the V2 server plugin and keeps the library barrel loadable", () => {
    expect(adapter).toBe(WeavePlugin);
    expect(WeavePluginServer).toBe(WeavePlugin);
    expect(WeavePlugin.id).toBe("weave");
  });

  it("registers each owned boundary once and disposes every registration", async () => {
    const disposed: string[] = [];
    const hooks: string[] = [];
    const commands: string[] = [];
    const agents = new Map<string, Record<string, unknown>>();
    const registration = (name: string) => ({
      dispose: async () => {
        disposed.push(name);
      },
    });
    const context = {
      options: {},
      location: { directory: "/project", workspaceID: "workspace" },
      catalog: { model: { list: async () => ({ data: [] }) } },
      skill: { list: async () => ({ data: [] }) },
      event: {
        subscribe: async function* () {
          yield* [];
        },
      },
      agent: {
        transform: async (transform: (editor: unknown) => void) => {
          transform({
            get: (id: string) => agents.get(id),
            list: () => [...agents.values()],
            default: () => undefined,
            remove: () => undefined,
            update: (
              id: string,
              update: (agent: Record<string, unknown>) => void,
            ) => {
              const agent = { id, name: id, mode: "primary", permissions: [] };
              update(agent);
              agents.set(id, agent);
            },
          });
          return registration("agent");
        },
        reload: async () => undefined,
      },
      command: {
        transform: async (transform: (editor: unknown) => void) => {
          transform({
            add: (command: { name: string }) => commands.push(command.name),
          });
          return registration("command");
        },
        reload: async () => undefined,
      },
      session: {
        hook: async (name: string) => {
          hooks.push(name);
          return registration(name);
        },
      },
      rpc: {
        register: async () => ({
          ...registration("rpc"),
          events: { emit: async () => undefined },
        }),
      },
      storage: {
        get: async () => undefined,
        set: async () => undefined,
        remove: async () => undefined,
      },
    } as unknown as OpenCode2Context;
    const tapestry = projection("tapestry");
    const cleanup = await setupOpenCode2(context, {
      buildCatalog: () => okAsync(catalog(new Map([["tapestry", tapestry]]))),
    });
    expect([...agents.keys()]).toEqual(["tapestry"]);
    expect(commands).toEqual(["weave:start"]);
    expect(hooks).toEqual(["prompt", "context"]);
    await cleanup();
    expect(disposed.sort()).toEqual([
      "agent",
      "command",
      "context",
      "prompt",
      "rpc",
    ]);
  });
});
