/**
 * CLI scenarios — `weave validate`.
 *
 * Bucket: CLI. The black box is the command line. Input is argv plus the files
 * on the user's disk; output is what they see on stdout/stderr and the exit
 * code their shell gets. The test enters through `run()` — the same function
 * `main.ts` calls — so command routing, flag parsing, config discovery and
 * output rendering are all exercised together.
 *
 * The filesystem is virtual, so these scenarios never read the developer's real
 * `$HOME` or working directory and produce the same result on every machine.
 */

import { describe, expect, it } from "bun:test";
import { run } from "../../packages/cli/src/cli.js";
import { MemoryFileSystem } from "../../packages/cli/src/fs/file-system.js";
import { BufferTerminal } from "../../packages/cli/src/io/terminal.js";
import { dedent } from "../support/scenario.js";

const PROJECT_DIR = "/project";
const HOME_DIR = "/home/user";

/** A config that a user would consider correct and complete. */
const workingConfig = dedent(`
  agent loom {
    description "Loom (Main Orchestrator)"
    prompt "You are Loom, the orchestrator."
    models ["anthropic/claude-sonnet-4-5"]
    mode primary
  }

  category frontend {
    description "Frontend UI and styling"
    models ["openai/gpt-5"]
  }
`);

/** Runs `weave <args>` against a virtual disk and captures everything the user sees. */
async function runWeave(args: string[], files: Record<string, string>) {
  const terminal = new BufferTerminal();
  const fs = new MemoryFileSystem(files, PROJECT_DIR, HOME_DIR);
  const result = await run({
    argv: ["bun", "weave", ...args],
    terminal,
    colorEnabled: false,
    fs,
  });

  return {
    exitCode: result._unsafeUnwrap(),
    stdout: terminal.out.join("\n"),
    stderr: terminal.err.join("\n"),
  };
}

describe("a user checks the config they just wrote", () => {
  it("exits 0 and confirms the config is valid", async () => {
    const { exitCode, stdout } = await runWeave(["validate", "--project"], {
      [`${PROJECT_DIR}/.weave/config.weave`]: workingConfig,
    });

    expect(exitCode).toBe(0);
    expect(stdout).toContain("Weave config is valid");
  });

  it("summarises what Weave found, so the user can confirm it read the right file", async () => {
    const { stdout } = await runWeave(["validate", "--project"], {
      [`${PROJECT_DIR}/.weave/config.weave`]: workingConfig,
    });

    expect(stdout).toContain("agents: 1");
    expect(stdout).toContain("categories: 1");
  });
});

describe("a user has a typo in their config", () => {
  it("exits non-zero and points at the line and column of the mistake", async () => {
    const brokenConfig = dedent(`
      agent loom {
        prompt "You are Loom."
        models ["anthropic/claude-sonnet-4-5"
      }
    `);

    const { exitCode, stdout, stderr } = await runWeave(
      ["validate", "--project"],
      { [`${PROJECT_DIR}/.weave/config.weave`]: brokenConfig },
    );
    const output = `${stdout}\n${stderr}`;

    expect(exitCode).not.toBe(0);
    expect(output).toContain("config.weave");
    expect(output).toMatch(/\d+:\d+/);
  });
});

describe("a user runs validate before they have a config", () => {
  it("exits non-zero and tells them the file is missing rather than crashing", async () => {
    const { exitCode, stdout, stderr } = await runWeave(
      ["validate", "--project"],
      {},
    );
    const output = `${stdout}\n${stderr}`;

    expect(exitCode).not.toBe(0);
    expect(output).toContain("File not found");
    expect(output).toContain(`${PROJECT_DIR}/.weave/config.weave`);
  });
});

describe("a user wires validate into a script", () => {
  it("emits machine-readable JSON under --json", async () => {
    const { exitCode, stdout } = await runWeave(
      ["validate", "--project", "--json"],
      { [`${PROJECT_DIR}/.weave/config.weave`]: workingConfig },
    );

    expect(exitCode).toBe(0);
    expect(() => JSON.parse(stdout) as unknown).not.toThrow();
  });
});

describe("a user's global config is broken but their project config is fine", () => {
  it("validates the scope they asked for and ignores the other one", async () => {
    const files = {
      [`${HOME_DIR}/.weave/config.weave`]: "agent broken { models [ }",
      [`${PROJECT_DIR}/.weave/config.weave`]: workingConfig,
    };

    const project = await runWeave(["validate", "--project"], files);
    const global = await runWeave(["validate", "--global"], files);

    expect(project.exitCode).toBe(0);
    expect(global.exitCode).not.toBe(0);
  });
});

describe("a user's config has an agent that harnesses would leave out", () => {
  // Harness adapters register every other agent and drop only one that cannot
  // be composed, so validate is where the user finds out before a session
  // quietly runs without it.
  it("names an agent whose prompt file is not there, and where it looked", async () => {
    const { exitCode, stderr } = await runWeave(["validate", "--project"], {
      [`${PROJECT_DIR}/.weave/config.weave`]: dedent(`
        agent helper {
          prompt_file "helper.md"
          mode subagent
        }
      `),
    });

    expect(exitCode).toBe(1);
    expect(stderr).toContain('agent "helper"');
    expect(stderr).toContain(`${PROJECT_DIR}/.weave/prompts/helper.md`);
  });

  it("names a custom agent that has no prompt", async () => {
    const { exitCode, stderr } = await runWeave(["validate", "--project"], {
      [`${PROJECT_DIR}/.weave/config.weave`]: dedent(`
        agent scribe {
          models ["anthropic/claude-haiku-4-5"]
          mode subagent
        }
      `),
    });

    expect(exitCode).toBe(1);
    expect(stderr).toContain('agent "scribe"');
    expect(stderr).toContain("must define either prompt or prompt_file");
  });

  it("checks a global config against the global prompts directory", async () => {
    const { exitCode, stderr } = await runWeave(["validate", "--global"], {
      [`${HOME_DIR}/.weave/config.weave`]: dedent(`
        agent helper {
          prompt_file "helper.md"
          mode subagent
        }
      `),
    });

    expect(exitCode).toBe(1);
    expect(stderr).toContain(`${HOME_DIR}/.weave/prompts/helper.md`);
  });
});

describe("a user's config only changes part of a builtin", () => {
  it("passes when a block sets only a model or permissions, because the builtin supplies the rest", async () => {
    const { exitCode } = await runWeave(["validate", "--project"], {
      [`${PROJECT_DIR}/.weave/config.weave`]: dedent(`
        agent shuttle {
          models ["github-copilot/gpt-6-sol"]
        }

        agent loom {
          tool_policy {
            network deny
          }
        }
      `),
    });

    expect(exitCode).toBe(0);
  });

  it("passes when the prompt file it names is there", async () => {
    const { exitCode } = await runWeave(["validate", "--project"], {
      [`${PROJECT_DIR}/.weave/config.weave`]: dedent(`
        agent helper {
          prompt_file "helper.md"
          mode subagent
        }
      `),
      [`${PROJECT_DIR}/.weave/prompts/helper.md`]: "You help.",
    });

    expect(exitCode).toBe(0);
  });
});

describe("a user's effective config points at a prompt file beside it", () => {
  it("reads the prompt file from the same disk as the config and accepts it", async () => {
    const { exitCode, stdout, stderr } = await runWeave(["validate"], {
      [`${PROJECT_DIR}/.weave/config.weave`]: dedent(`
        agent reviewer {
          description "Reviewer"
          prompt_file "reviewer.md"
          models ["anthropic/claude-sonnet-4-5"]
          mode subagent
        }
      `),
      [`${PROJECT_DIR}/.weave/prompts/reviewer.md`]: "You review code.",
    });

    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Weave config is valid");
  });
});
