import { createWeavePlugin } from "@weave/adapter-opencode";
import { okAsync, ResultAsync } from "neverthrow";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(tmpdir(), `weave-sdk-debug-${Date.now()}`);
await Bun.write(
  join(root, ".weave", "config.weave"),
  [
    `agent sdk-debug-agent {`,
    `  prompt "You are a test agent."`,
    `  models ["claude-sonnet-4-5"]`,
    `  mode subagent`,
    `  temperature 0.2`,
    `}`,
    "",
  ].join("\n"),
);

const createAgentCalls: string[] = [];
const mockClient = {
  listAgents: () => okAsync([]),
  createAgent: (name: string, config: unknown) => {
    createAgentCalls.push(name);
    console.log("createAgent called:", name, JSON.stringify(config, null, 2));
    return okAsync(undefined);
  },
  updateAgent: (name: string, config: unknown) => {
    console.log("updateAgent called:", name);
    return okAsync(undefined);
  },
};

function projectOnlyReader(r: string) {
  return {
    exists: async (path: string): Promise<boolean> => {
      if (!path.startsWith(r)) return false;
      return Bun.file(path).exists();
    },
    read: (path: string) => {
      return ResultAsync.fromPromise(
        Bun.file(path).text(),
        (cause: unknown) => ({ type: "FileReadError" as const, path, cause }),
      );
    },
  };
}

const plugin = createWeavePlugin({ fileReader: projectOnlyReader(root) });
const input = {
  client: mockClient as never,
  directory: root,
  project: {} as never,
  worktree: root,
  experimental_workspace: { register: () => {} },
  serverUrl: new URL("http://localhost:1234"),
  $: {} as never,
};

const hooks = await plugin(input);
console.log("hooks.config:", typeof hooks.config);
console.log("createAgentCalls:", createAgentCalls);
