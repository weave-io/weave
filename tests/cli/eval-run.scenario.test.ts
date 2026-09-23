/**
 * CLI scenarios — `weave eval run` argument handling.
 *
 * Bucket: CLI. Every scenario here is refused before a fixture is read or a
 * model is called, so it runs hermetically through `run()` with an empty
 * environment: no API key, no network, no disk beyond the injected one.
 */

import { describe, expect, it } from "bun:test";
import { run } from "../../packages/cli/src/cli.js";
import { MemoryFileSystem } from "../../packages/cli/src/fs/file-system.js";
import { BufferTerminal } from "../../packages/cli/src/io/terminal.js";

async function weaveEvalRun(args: string[]) {
  const terminal = new BufferTerminal();
  const result = await run({
    argv: ["bun", "weave", "eval", "run", ...args],
    terminal,
    colorEnabled: false,
    fs: new MemoryFileSystem({}, "/project", "/home/user"),
    env: {},
  });
  return {
    exitCode: result._unsafeUnwrap(),
    stdout: terminal.out.join("\n"),
    stderr: terminal.err.join("\n"),
  };
}

describe("a maintainer asks for the cheap development subset", () => {
  it("names the model sets it knows when given one it does not", async () => {
    const { exitCode, stderr } = await weaveEvalRun(["--models", "cheap"]);

    expect(exitCode).toBe(1);
    expect(stderr).toContain('--models "cheap"');
    expect(stderr).toContain("default, dev");
  });

  it("refuses --models dev with --model, rather than guessing which one was meant", async () => {
    const { exitCode, stderr } = await weaveEvalRun([
      "--models",
      "dev",
      "--model",
      "openai/gpt-5.5",
    ]);

    expect(exitCode).toBe(1);
    expect(stderr).toContain("cannot be combined");
    expect(stderr).toContain("openai/gpt-5.5");
  });

  it("asks for a set name when --models is given none", async () => {
    const { exitCode, stderr } = await weaveEvalRun(["--models"]);

    expect(exitCode).toBe(1);
    expect(stderr).toContain("--models requires a model set name");
  });

  it("lists --models dev in the usage text", async () => {
    const terminal = new BufferTerminal();
    await run({
      argv: ["bun", "weave", "eval"],
      terminal,
      colorEnabled: false,
      fs: new MemoryFileSystem({}, "/project", "/home/user"),
      env: {},
    });

    expect(terminal.err.join("\n")).toContain("--models dev");
  });
});
