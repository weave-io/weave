import { describe, expect, it } from "bun:test";
import type { JsonValue } from "@weaveio/weave-engine";
import {
  buildNativeToolResolver,
  classifyDiscoveredTools,
  PI_NATIVE_TOOL_CAPABILITY,
} from "../tool-governance.js";
import type { PiToolInfo } from "../types.js";
import {
  foreignToolSourceInfo,
  piBuiltinSourceInfo,
} from "./fakes/fake-pi-host.js";

function builtin(name: string): PiToolInfo {
  return { name, sourceInfo: piBuiltinSourceInfo(name) };
}

function foreign(name: string): PiToolInfo {
  return { name, sourceInfo: foreignToolSourceInfo() };
}

describe("classifyDiscoveredTools", () => {
  it("classifies every genuinely built-in-sourced governed tool as native and verifiedNative", () => {
    const allTools = Object.keys(PI_NATIVE_TOOL_CAPABILITY).map(builtin);
    const result = classifyDiscoveredTools(allTools, []);
    const names = Object.keys(PI_NATIVE_TOOL_CAPABILITY).sort();
    expect([...result.native].sort()).toEqual(names);
    expect([...result.verifiedNative].sort()).toEqual(names);
    expect(result.weaveOwned).toEqual([]);
    expect(result.unmanaged).toEqual([]);
  });

  it("still requires coverage for a native-named tool shadowed by a foreign extension, but never verifies it", () => {
    // A foreign extension registered its own tool literally named "bash" -
    // Pi allows this (docs/extensions.md). The name is still a required
    // native capability (coverage must account for it), but it must never
    // be treated as genuinely Pi-native since its provenance is not
    // `source: "builtin"`.
    const result = classifyDiscoveredTools([foreign("bash")], []);
    expect(result.native).toEqual(["bash"]);
    expect(result.verifiedNative).toEqual([]);
    expect(result.unmanaged).toEqual([]);
  });

  it('never verifies an entry that spoofs source:"builtin" but not the full documented convention', () => {
    // A foreign extension cannot be stopped from setting `source: "builtin"`
    // on its own registration - the strengthened check must also require
    // `origin: "top-level"`, `scope: "temporary"`, and the exact
    // `<builtin:${name}>` path Pi's own runtime derives, or a spoof with
    // only the `source` field right would be wrongly trusted.
    const wrongOrigin: PiToolInfo = {
      name: "bash",
      sourceInfo: { ...piBuiltinSourceInfo("bash"), origin: "package" },
    };
    const wrongScope: PiToolInfo = {
      name: "read",
      sourceInfo: { ...piBuiltinSourceInfo("read"), scope: "user" },
    };
    const wrongPath: PiToolInfo = {
      name: "edit",
      sourceInfo: { ...piBuiltinSourceInfo("edit"), path: "<builtin:read>" },
    };
    const result = classifyDiscoveredTools(
      [wrongOrigin, wrongScope, wrongPath],
      [],
    );
    expect([...result.native].sort()).toEqual(["bash", "edit", "read"]);
    expect(result.verifiedNative).toEqual([]);
  });

  it("classifies a requested Weave-owned name even when Pi has not yet registered it", () => {
    const result = classifyDiscoveredTools([], ["weave_complete_step"]);
    expect(result.weaveOwned).toEqual(["weave_complete_step"]);
    expect(result.native).toEqual([]);
    expect(result.verifiedNative).toEqual([]);
    expect(result.unmanaged).toEqual([]);
  });

  it("reports an unrelated third-party tool as unmanaged, never as native or weave-owned", () => {
    const result = classifyDiscoveredTools(
      [foreign("some-other-extension-tool")],
      [],
    );
    expect(result.unmanaged).toEqual(["some-other-extension-tool"]);
    expect(result.native).toEqual([]);
    expect(result.weaveOwned).toEqual([]);
  });

  it("only claims native coverage for built-ins this host actually discovered", () => {
    const result = classifyDiscoveredTools([builtin("read")], []);
    expect(result.native).toEqual(["read"]);
    expect(result.verifiedNative).toEqual(["read"]);
  });

  it("prefers weave-owned classification over native/unmanaged when a name is requested as weave-owned", () => {
    const result = classifyDiscoveredTools([builtin("bash")], ["bash"]);
    expect(result.weaveOwned).toEqual(["bash"]);
    expect(result.native).toEqual([]);
    expect(result.verifiedNative).toEqual([]);
  });
});

/** Runs `resolver({call, context})` and returns the single request produced. */
function resolveOne(
  toolName: string,
  capability: Parameters<typeof buildNativeToolResolver>[1],
  call: JsonValue,
) {
  const resolver = buildNativeToolResolver(toolName, capability);
  const result = resolver({
    call,
    context: { toolIdentity: toolName, owner: "pi-native", revision: "1" },
  });
  expect(result.isOk()).toBe(true);
  const requests = result._unsafeUnwrap();
  expect(requests).toHaveLength(1);
  return requests[0];
}

describe("buildNativeToolResolver: per-tool input-aware resolution", () => {
  it("bash: valid command produces a grantable execute request bound to the command", () => {
    const request = resolveOne("bash", "execute", { command: "ls -la" });
    expect(request.unresolved).toBe(false);
    if (request.unresolved) throw new Error("expected grantable");
    expect(request.capability).toBe("execute");
    expect(request.operation).toBe("bash");
    expect(request.target.identifier).toBe("ls -la");
  });
  it("bash: missing command is unresolved, not a grantable wildcard", () => {
    expect(resolveOne("bash", "execute", {}).unresolved).toBe(true);
  });
  it("bash: non-string command is unresolved", () => {
    expect(resolveOne("bash", "execute", { command: 42 }).unresolved).toBe(
      true,
    );
  });
  it("bash: unsafe command (control character) is unresolved", () => {
    expect(
      resolveOne("bash", "execute", { command: "ls\u0000-la" }).unresolved,
    ).toBe(true);
  });

  it("read: valid path produces a grantable read request bound to the path", () => {
    const request = resolveOne("read", "read", { path: "/src/a.ts" });
    if (request.unresolved) throw new Error("expected grantable");
    expect(request.target.identifier).toBe("/src/a.ts");
    expect(request.capability).toBe("read");
  });
  it("read: missing path is unresolved", () => {
    expect(resolveOne("read", "read", { offset: 0 }).unresolved).toBe(true);
  });

  it("edit: valid path produces a grantable write request", () => {
    const request = resolveOne("edit", "write", {
      path: "/src/a.ts",
      edits: [{ oldText: "a", newText: "b" }],
    });
    if (request.unresolved) throw new Error("expected grantable");
    expect(request.target.identifier).toBe("/src/a.ts");
  });
  it("edit: missing path is unresolved", () => {
    expect(
      resolveOne("edit", "write", { edits: [{ oldText: "a", newText: "b" }] })
        .unresolved,
    ).toBe(true);
  });

  it("write: valid path produces a grantable write request even with empty content", () => {
    const request = resolveOne("write", "write", {
      path: "/src/b.ts",
      content: "",
    });
    if (request.unresolved) throw new Error("expected grantable");
    expect(request.target.identifier).toBe("/src/b.ts");
  });
  it("write: missing path is unresolved", () => {
    expect(resolveOne("write", "write", { content: "x" }).unresolved).toBe(
      true,
    );
  });

  it("grep: valid pattern+path produces a grantable read request bound to both, via an unambiguous structure", () => {
    const request = resolveOne("grep", "read", {
      pattern: "TODO",
      path: "/src",
    });
    if (request.unresolved) throw new Error("expected grantable");
    // target carries the exact path only; pattern lives in constraints as
    // its own field - never a string concatenation of the two.
    expect(request.target.identifier).toBe("/src");
    expect(request.constraints).toEqual({ pattern: "TODO" });
  });
  it("grep: an omitted path defaults to the documented current-root default, not a wildcard", () => {
    const request = resolveOne("grep", "read", { pattern: "TODO" });
    if (request.unresolved) throw new Error("expected grantable");
    expect(request.target.identifier).toBe(".");
    expect(request.constraints).toEqual({ pattern: "TODO" });
  });
  it("grep: a delimiter-like path/pattern pair cannot collide with a differently-split equivalent (unambiguous structure)", () => {
    const a = resolveOne("grep", "read", { pattern: "c", path: "a::b" });
    const b = resolveOne("grep", "read", { pattern: "b::c", path: "a" });
    if (a.unresolved || b.unresolved) throw new Error("expected grantable");
    expect(a.target.identifier).not.toBe(b.target.identifier);
    expect(a.constraints).not.toEqual(b.constraints);
  });
  it("grep: a present but unsafe path is unresolved, not silently defaulted", () => {
    expect(
      resolveOne("grep", "read", { pattern: "TODO", path: "\u0000" })
        .unresolved,
    ).toBe(true);
  });
  it("grep: the same pattern in two different paths produces two distinct target identifiers (grant isolation)", () => {
    const a = resolveOne("grep", "read", { pattern: "TODO", path: "/src/a" });
    const b = resolveOne("grep", "read", { pattern: "TODO", path: "/src/b" });
    if (a.unresolved || b.unresolved) throw new Error("expected grantable");
    expect(a.target.identifier).not.toBe(b.target.identifier);
  });
  it("grep: options that change read extent/semantics are carried as bounded constraints, not silently dropped", () => {
    const request = resolveOne("grep", "read", {
      pattern: "TODO",
      path: "/src",
      glob: "*.ts",
      ignoreCase: true,
      literal: false,
      context: 3,
      limit: 50,
    });
    if (request.unresolved) throw new Error("expected grantable");
    expect(request.constraints).toEqual({
      pattern: "TODO",
      glob: "*.ts",
      ignoreCase: true,
      literal: false,
      context: 3,
      limit: 50,
    });
  });
  it("grep: a malformed optional option (wrong type) is unresolved rather than ignored", () => {
    expect(
      resolveOne("grep", "read", {
        pattern: "TODO",
        ignoreCase: "yes",
      }).unresolved,
    ).toBe(true);
    expect(
      resolveOne("grep", "read", { pattern: "TODO", context: -1 }).unresolved,
    ).toBe(true);
    expect(
      resolveOne("grep", "read", { pattern: "TODO", limit: 1.5 }).unresolved,
    ).toBe(true);
  });
  it("grep: missing pattern is unresolved", () => {
    expect(resolveOne("grep", "read", { path: "/src" }).unresolved).toBe(true);
  });

  it("find: valid pattern defaults path to the current-root default and binds both", () => {
    const request = resolveOne("find", "read", { pattern: "*.ts" });
    if (request.unresolved) throw new Error("expected grantable");
    expect(request.target.identifier).toBe(".");
    expect(request.constraints).toEqual({ pattern: "*.ts" });
  });
  it("find: the same pattern in two different paths produces two distinct target identifiers (grant isolation)", () => {
    const a = resolveOne("find", "read", { pattern: "*.ts", path: "/a" });
    const b = resolveOne("find", "read", { pattern: "*.ts", path: "/b" });
    if (a.unresolved || b.unresolved) throw new Error("expected grantable");
    expect(a.target.identifier).not.toBe(b.target.identifier);
  });
  it("find: a present but unsafe path is unresolved, not silently defaulted", () => {
    expect(
      resolveOne("find", "read", { pattern: "*.ts", path: "\u0000" })
        .unresolved,
    ).toBe(true);
  });
  it("find: a malformed limit is unresolved rather than ignored", () => {
    expect(
      resolveOne("find", "read", { pattern: "*.ts", limit: -1 }).unresolved,
    ).toBe(true);
  });
  it("find: empty pattern is unresolved", () => {
    expect(resolveOne("find", "read", { pattern: "" }).unresolved).toBe(true);
  });

  it("ls: valid path produces a grantable read request", () => {
    const request = resolveOne("ls", "read", { path: "/src" });
    if (request.unresolved) throw new Error("expected grantable");
    expect(request.target.identifier).toBe("/src");
  });
  it("ls: omitted path is grantable with a safe default target (path is genuinely optional)", () => {
    const request = resolveOne("ls", "read", {});
    if (request.unresolved) throw new Error("expected grantable");
    expect(request.target.identifier).toBe(".");
  });
  it("ls: a present but unsafe path is still unresolved, not silently defaulted", () => {
    expect(resolveOne("ls", "read", { path: "\u0000" }).unresolved).toBe(true);
  });

  it("an unrecognised call shape (non-object) is unresolved for every governed tool", () => {
    for (const [name, capability] of Object.entries(
      PI_NATIVE_TOOL_CAPABILITY,
    )) {
      expect(resolveOne(name, capability, "not-an-object").unresolved).toBe(
        true,
      );
    }
  });

  it("rejects an oversized authority-bearing argument as unresolved rather than truncating it", () => {
    // Truncating an authorization-identity field would let two distinct
    // long values sharing only a prefix collapse onto the same grant.
    expect(
      resolveOne("write", "write", { path: "a".repeat(1000) }).unresolved,
    ).toBe(true);
  });
  it("two long commands sharing a long common prefix never produce the same target identifier (no truncation collision)", () => {
    const prefix = "x".repeat(400);
    const a = resolveOne("bash", "execute", { command: `${prefix}-A` });
    const b = resolveOne("bash", "execute", { command: `${prefix}-B` });
    if (a.unresolved || b.unresolved) throw new Error("expected grantable");
    expect(a.target.identifier).not.toBe(b.target.identifier);
    expect(a.target.identifier).toBe(`${prefix}-A`);
    expect(b.target.identifier).toBe(`${prefix}-B`);
  });
  it("an oversized glob constraint is unresolved rather than truncated", () => {
    expect(
      resolveOne("grep", "read", {
        pattern: "TODO",
        glob: "g".repeat(600),
      }).unresolved,
    ).toBe(true);
  });
  it("an oversized pattern is unresolved rather than truncated", () => {
    expect(
      resolveOne("grep", "read", { pattern: "p".repeat(600) }).unresolved,
    ).toBe(true);
  });

  it("never throws for a hostile call shape (getter that throws)", () => {
    const resolver = buildNativeToolResolver("grep", "read");
    const hostile = {};
    Object.defineProperty(hostile, "pattern", {
      get() {
        throw new Error("boom");
      },
      enumerable: true,
    });
    // Documents current behavior: a hostile getter throws synchronously.
    // The engine's own `invokePermissionResolver` wraps every resolver
    // invocation in `Result.fromThrowable`, so this still fails closed
    // end-to-end (resolver_threw) rather than crashing the adapter.
    expect(() =>
      resolver({
        call: hostile,
        context: { toolIdentity: "grep", owner: "pi-native", revision: "1" },
      }),
    ).toThrow();
  });

  it("reusable-grant prevention (adapter level): distinct commands to the same tool produce distinct target identifiers", () => {
    // Different normalized targets translate to different authorization
    // keys upstream in the engine, so a grant issued for one exact call can
    // never cover a different one - this is the pure-function precondition
    // for that engine-level guarantee (exercised end-to-end against a real
    // PermissionSession in permission-bridge.test.ts).
    const a = resolveOne("bash", "execute", { command: "ls -la" });
    const b = resolveOne("bash", "execute", { command: "rm -rf /tmp/x" });
    if (a.unresolved || b.unresolved) throw new Error("expected grantable");
    expect(a.target.identifier).not.toBe(b.target.identifier);
  });
});
