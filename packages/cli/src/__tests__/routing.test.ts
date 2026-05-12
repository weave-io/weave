import { describe, expect, it } from "bun:test";
import { run } from "../cli.js";
import { BufferTerminal } from "../io/terminal.js";

function cli(args: string[]) {
  const terminal = new BufferTerminal();
  const argv = ["bun", "weave", ...args];
  return { terminal, result: run({ argv, terminal, colorEnabled: false }) };
}

describe("CLI routing", () => {
  it("--help exits 0 and lists init and validate", async () => {
    const { terminal, result } = cli(["--help"]);
    const r = await result;
    expect(r.isOk()).toBe(true);
    expect(r._unsafeUnwrap()).toBe(0);
    const out = terminal.out.join("\n");
    expect(out).toContain("init");
    expect(out).toContain("validate");
  });

  it("-h is an alias for --help", async () => {
    const { terminal, result } = cli(["-h"]);
    const r = await result;
    expect(r.isOk()).toBe(true);
    expect(r._unsafeUnwrap()).toBe(0);
    const out = terminal.out.join("\n");
    expect(out).toContain("COMMANDS");
  });

  it("no arguments shows help", async () => {
    const { terminal, result } = cli([]);
    const r = await result;
    expect(r.isOk()).toBe(true);
    expect(r._unsafeUnwrap()).toBe(0);
    const out = terminal.out.join("\n");
    expect(out).toContain("USAGE");
  });

  it("--version exits 0 and prints version string", async () => {
    const { terminal, result } = cli(["--version"]);
    const r = await result;
    expect(r.isOk()).toBe(true);
    expect(r._unsafeUnwrap()).toBe(0);
    const out = terminal.out.join("\n");
    expect(out).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("-V is an alias for --version", async () => {
    const { terminal, result } = cli(["-V"]);
    const r = await result;
    expect(r.isOk()).toBe(true);
    expect(r._unsafeUnwrap()).toBe(0);
    const out = terminal.out.join("\n");
    expect(out).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("unknown command exits 1 with error message", async () => {
    const { terminal, result } = cli(["frobnicate"]);
    const r = await result;
    expect(r.isOk()).toBe(true);
    expect(r._unsafeUnwrap()).toBe(1);
    const errOut = terminal.err.join("\n");
    expect(errOut).toContain("frobnicate");
    expect(errOut).toContain("Unknown command");
  });

  it("run command exits 1 with product-vision message", async () => {
    const { terminal, result } = cli(["run"]);
    const r = await result;
    expect(r.isOk()).toBe(true);
    expect(r._unsafeUnwrap()).toBe(1);
    const errOut = terminal.err.join("\n");
    expect(errOut).toContain("does not run harness runtimes");
    expect(errOut).toContain("weave init");
  });

  it("--help overrides a command", async () => {
    const { terminal, result } = cli(["validate", "--help"]);
    const r = await result;
    expect(r.isOk()).toBe(true);
    expect(r._unsafeUnwrap()).toBe(0);
    const out = terminal.out.join("\n");
    expect(out).toContain("COMMANDS");
  });

  it("help output includes EXAMPLES section", async () => {
    const { terminal, result } = cli(["--help"]);
    await result;
    const out = terminal.out.join("\n");
    expect(out).toContain("EXAMPLES");
    expect(out).toContain("weave init");
    expect(out).toContain("weave validate");
  });
});
