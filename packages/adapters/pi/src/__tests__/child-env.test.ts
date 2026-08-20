import { describe, expect, it } from "bun:test";
import {
  buildDefaultPiChildCommand,
  DEFAULT_PI_CHILD_EXECUTABLE,
  resolveCurrentPiExecutablePath,
  sanitizedBaseEnv,
  WEAVE_CHILD_AGENT_NAME_ENV,
  WEAVE_CHILD_DEPTH_ENV,
  WEAVE_CHILD_ID_ENV,
  WEAVE_CHILD_PARENT_ID_ENV,
  WEAVE_CHILD_SECRET_ENV,
  WEAVE_CONTROLLER_GENERATION_ENV,
} from "../child-env.js";
import type { PiEnvPort } from "../types.js";

/** In-memory `PiEnvPort` fixture - never touches real `Bun.env`. */
class FakeEnvPort implements PiEnvPort {
  constructor(private readonly values: Record<string, string | undefined>) {}
  read(name: string): string | undefined {
    return this.values[name];
  }
  deleteValue(name: string): void {
    delete this.values[name];
  }
}

describe("sanitizedBaseEnv", () => {
  it("preserves ordinary runtime environment values (e.g. PATH-shaped keys)", () => {
    const original = Bun.env.PATH;
    if (original === undefined) return; // Nothing to assert in an environment without PATH.
    const result = sanitizedBaseEnv(() => false);
    expect(result.PATH).toBe(original);
  });

  it("never forwards a key the caller's isDeniedKey policy flags, regardless of value", () => {
    const denied = new Set(["SOME_SECRET_TOKEN"]);
    const result = sanitizedBaseEnv((key) => denied.has(key));
    expect(Object.keys(result)).not.toContain("SOME_SECRET_TOKEN");
  });

  it("never forwards this adapter's own reserved WEAVE_CHILD_* bootstrap variables, even if somehow present in Bun.env", () => {
    const result = sanitizedBaseEnv(() => false);
    for (const reserved of [
      WEAVE_CHILD_SECRET_ENV,
      WEAVE_CHILD_ID_ENV,
      WEAVE_CONTROLLER_GENERATION_ENV,
      WEAVE_CHILD_AGENT_NAME_ENV,
      WEAVE_CHILD_DEPTH_ENV,
      WEAVE_CHILD_PARENT_ID_ENV,
    ]) {
      expect(Object.keys(result)).not.toContain(reserved);
    }
  });

  it("produces only string values (never undefined entries)", () => {
    const result = sanitizedBaseEnv(() => false);
    for (const value of Object.values(result)) {
      expect(typeof value).toBe("string");
    }
  });
});

// Pi adapter contract: a bare `"pi"` spawn command lets `Bun.spawn`'s
// own `PATH` resolution silently select an unrelated `pi` install (e.g. a
// different toolchain's shim) shadowing the real host - whose runtime then
// fails packed-extension import with `Cannot find module 'bun:ffi'`. `_` is
// exact host identity and must be read, never re-derived from `PATH`.
describe("resolveCurrentPiExecutablePath", () => {
  it("resolves the exact launching executable from `_`, regardless of what PATH would otherwise resolve", () => {
    const envPort = new FakeEnvPort({
      _: "/opt/official/pi/pi",
      PATH: "/some/other/shadowing/toolchain/bin:/usr/bin",
    });
    expect(resolveCurrentPiExecutablePath(envPort)).toBe("/opt/official/pi/pi");
  });

  it("changing PATH alone (never `_`) never changes the resolved executable", () => {
    const base = { _: "/opt/official/pi/pi" };
    const withoutShadow = new FakeEnvPort({
      ...base,
      PATH: "/usr/bin:/bin",
    });
    const withShadow = new FakeEnvPort({
      ...base,
      PATH: "/some/other/shadowing/toolchain/bin:/usr/bin:/bin",
    });
    expect(resolveCurrentPiExecutablePath(withShadow)).toBe(
      resolveCurrentPiExecutablePath(withoutShadow),
    );
  });

  it("returns undefined when `_` is absent", () => {
    const envPort = new FakeEnvPort({ PATH: "/usr/bin" });
    expect(resolveCurrentPiExecutablePath(envPort)).toBeUndefined();
  });

  it("returns undefined when `_` is empty", () => {
    const envPort = new FakeEnvPort({ _: "" });
    expect(resolveCurrentPiExecutablePath(envPort)).toBeUndefined();
  });

  it("returns undefined when `_` is not an absolute path (never trusts a relative/malformed value)", () => {
    const envPort = new FakeEnvPort({ _: "pi" });
    expect(resolveCurrentPiExecutablePath(envPort)).toBeUndefined();
  });

  it("returns undefined when `_` points at an absolute non-Pi wrapper or runtime", () => {
    expect(
      resolveCurrentPiExecutablePath(new FakeEnvPort({ _: "/usr/bin/bun" })),
    ).toBeUndefined();
    expect(
      resolveCurrentPiExecutablePath(
        new FakeEnvPort({ _: "/opt/homebrew/bin/timeout" }),
      ),
    ).toBeUndefined();
  });
});

describe("buildDefaultPiChildCommand", () => {
  it("builds the RPC child command from the exact launching executable", () => {
    const envPort = new FakeEnvPort({ _: "/opt/official/pi/pi" });
    expect(buildDefaultPiChildCommand(envPort)).toEqual([
      "/opt/official/pi/pi",
      "--mode",
      "rpc",
    ]);
  });

  it("falls back to the bare default executable name only when `_` cannot be resolved", () => {
    const envPort = new FakeEnvPort({});
    expect(buildDefaultPiChildCommand(envPort)).toEqual([
      DEFAULT_PI_CHILD_EXECUTABLE,
      "--mode",
      "rpc",
    ]);
  });

  it("never carries a session flag, which PiRpcChild would reject as ChildSpawnFailed", () => {
    const envPort = new FakeEnvPort({ _: "/opt/official/pi/pi" });
    const command = buildDefaultPiChildCommand(envPort);
    for (const flag of [
      "--no-session",
      "--session-dir",
      "--session",
      "--continue",
      "--resume",
      "--fork",
    ]) {
      expect(
        command.some(
          (argument) => argument === flag || argument.startsWith(`${flag}=`),
        ),
      ).toBe(false);
    }
  });

  it("never carries an extension flag, which PiRpcChild alone appends and validates", () => {
    const envPort = new FakeEnvPort({ _: "/opt/official/pi/pi" });
    const command = buildDefaultPiChildCommand(envPort);
    for (const flag of ["--no-extensions", "-e", "--extension"]) {
      expect(
        command.some(
          (argument) => argument === flag || argument.startsWith(`${flag}=`),
        ),
      ).toBe(false);
    }
  });

  it("a PATH entry that would shadow the real pi install never changes the built command", () => {
    const shadowed = new FakeEnvPort({
      _: "/opt/official/pi/pi",
      PATH: "/some/other/shadowing/toolchain/bin:/usr/bin",
    });
    const unshadowed = new FakeEnvPort({
      _: "/opt/official/pi/pi",
      PATH: "/usr/bin",
    });
    expect(buildDefaultPiChildCommand(shadowed)).toEqual(
      buildDefaultPiChildCommand(unshadowed),
    );
  });
});
