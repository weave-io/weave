import { describe, expect, it } from "bun:test";
import {
  readValidatedCommands,
  readValidatedTools,
} from "../host-inventory.js";

describe("readValidatedCommands", () => {
  it("passes through a well-formed inventory", () => {
    const api = {
      getCommands: () => [
        {
          name: "weave:health",
          source: "extension" as const,
          sourceInfo: {
            path: "/node_modules/@weaveio/weave-adapter-pi/dist/extension.js",
            source: "npm:@weaveio/weave-adapter-pi",
            scope: "user" as const,
            origin: "package" as const,
          },
        },
      ],
    };
    const result = readValidatedCommands(api);
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toHaveLength(1);
  });

  it("converts a throwing host call into InvariantViolation", () => {
    const api = {
      getCommands: () => {
        throw new Error("host exploded");
      },
    };
    const result = readValidatedCommands(api);
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().code).toBe("InvariantViolation");
  });

  it("converts a malformed payload into InvariantViolation instead of trusting the shape", () => {
    const api = { getCommands: () => [{ name: 42 }] as unknown as [] };
    const result = readValidatedCommands(api);
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().code).toBe("InvariantViolation");
  });
});

describe("readValidatedTools", () => {
  it("passes through a well-formed inventory", () => {
    const api = {
      getAllTools: () => [
        {
          name: "read",
          sourceInfo: {
            path: "builtin",
            source: "builtin",
            scope: "user" as const,
            origin: "top-level" as const,
          },
        },
      ],
    };
    const result = readValidatedTools(api);
    expect(result.isOk()).toBe(true);
  });

  it("converts a throwing host call into InvariantViolation", () => {
    const api = {
      getAllTools: () => {
        throw new Error("host exploded");
      },
    };
    const result = readValidatedTools(api);
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().code).toBe("InvariantViolation");
  });
});
