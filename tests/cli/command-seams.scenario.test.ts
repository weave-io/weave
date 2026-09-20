/**
 * CLI scenarios — every command is drivable from outside.
 *
 * Bucket: CLI. These are the regression guard for the seam itself: each of
 * Weave's commands can be run through `run()` against a virtual filesystem,
 * without reading the developer's real disk, `$HOME` or environment.
 *
 * A command that loses that property fails here rather than silently going
 * back to reading whatever the developer happens to have on their machine.
 */

import { describe, expect, it } from "bun:test";
import { run } from "../../packages/cli/src/cli.js";
import { MemoryFileSystem } from "../../packages/cli/src/fs/file-system.js";
import { BufferTerminal } from "../../packages/cli/src/io/terminal.js";
import { dedent } from "../support/scenario.js";

const PROJECT_DIR = "/project";
const HOME_DIR = "/home/user";

const workingConfig = dedent(`
  agent loom {
    description "Loom (Main Orchestrator)"
    prompt "You are Loom, the orchestrator."
    models ["anthropic/claude-sonnet-4-5"]
    mode primary
  }

  agent shuttle {
    description "Shuttle (Domain Specialist)"
    prompt "You are Shuttle."
    models ["anthropic/claude-sonnet-4-5"]
    mode subagent
  }
`);

async function runWeave(
  args: string[],
  files: Record<string, string> = {},
  env: Record<string, string | undefined> = {},
) {
  const terminal = new BufferTerminal();
  const fs = new MemoryFileSystem(files, PROJECT_DIR, HOME_DIR);
  const result = await run({
    argv: ["bun", "weave", ...args],
    terminal,
    colorEnabled: false,
    fs,
    env,
  });

  return {
    exitCode: result._unsafeUnwrap(),
    output: `${terminal.out.join("\n")}\n${terminal.err.join("\n")}`,
    fs,
  };
}

const projectOnly = { [`${PROJECT_DIR}/.weave/config.weave`]: workingConfig };

describe("a user lists and inspects the agents their config declares", () => {
  it("lists the agents from the project config, not from the real disk", async () => {
    const { output } = await runWeave(["prompt", "list"], projectOnly);

    expect(output).toContain("shuttle");
  });

  it("renders the prompt the project config declares for an agent", async () => {
    const { output } = await runWeave(
      ["prompt", "inspect", "shuttle"],
      projectOnly,
    );

    expect(output).toContain("You are Shuttle.");
  });

  it("reports an agent the config does not declare", async () => {
    const { exitCode, output } = await runWeave(
      ["prompt", "inspect", "no-such-agent"],
      projectOnly,
    );

    expect(exitCode).toBe(1);
    expect(output).toContain("no-such-agent");
  });
});

describe("a user checks runtime status before anything has run", () => {
  it("looks for the runtime database under the injected root", async () => {
    const { exitCode, output } = await runWeave(
      ["runtime", "status"],
      projectOnly,
    );

    expect(exitCode).toBe(0);
    expect(output.toLowerCase()).toContain("runtime");
  });
});

describe("a user runs weave compose", () => {
  it("writes the plugin bundle into the injected filesystem, not onto disk", async () => {
    const { fs } = await runWeave(
      ["compose", "--adapter", "claude-code"],
      projectOnly,
    );

    const written = Object.keys(fs.snapshot());
    const agentFiles = written.filter((path) => path.includes("/agents/"));

    expect(agentFiles.length).toBeGreaterThan(0);
    for (const path of written) {
      expect(path.startsWith(PROJECT_DIR) || path.startsWith(HOME_DIR)).toBe(
        true,
      );
    }
  });

  it("reports the adapter it does not support instead of writing anything", async () => {
    const { exitCode, output, fs } = await runWeave(
      ["compose", "--adapter", "nonexistent-harness"],
      projectOnly,
    );

    expect(exitCode).toBe(1);
    expect(output).toContain("nonexistent-harness");
    expect(Object.keys(fs.snapshot())).toEqual([
      `${PROJECT_DIR}/.weave/config.weave`,
    ]);
  });
});

describe("a user runs weave eval with filters set in the environment", () => {
  it("reads the injected environment rather than the developer's", async () => {
    const withFilter = await runWeave(
      ["eval", "run", "--dry-run"],
      projectOnly,
      {
        WEAVE_EVAL_MODELS: "openai/gpt-4o-mini",
      },
    );
    const withoutFilter = await runWeave(
      ["eval", "run", "--dry-run"],
      projectOnly,
      {},
    );

    expect(typeof withFilter.exitCode).toBe("number");
    expect(typeof withoutFilter.exitCode).toBe("number");
    expect(withFilter.output).not.toEqual(withoutFilter.output);
  });
});
