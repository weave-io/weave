import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { $ } from "bun";
import { err, ok } from "neverthrow";
import {
  BunPathContainmentPort,
  FakePathContainmentPort,
  isDirectoryContainmentSafeWith,
  isLexicallyContained,
  NullPathContainmentPort,
} from "../path-containment.js";

describe("isLexicallyContained", () => {
  test("rejects empty, absolute, and traversal-bearing paths", () => {
    expect(isLexicallyContained("")).toBe(false);
    expect(isLexicallyContained("/etc/passwd")).toBe(false);
    expect(isLexicallyContained("../outside")).toBe(false);
    expect(isLexicallyContained("a/../b")).toBe(false);
  });

  test("accepts a plain relative path", () => {
    expect(isLexicallyContained("plans/foo.md")).toBe(true);
  });
});

describe("BunPathContainmentPort (production port)", () => {
  let root: string;

  beforeEach(async () => {
    const result = await $`mktemp -d`.quiet();
    root = result.text().trim();
  });

  afterEach(async () => {
    await $`rm -rf ${root}`.quiet();
  });

  test("proves containment through ordinary directories", async () => {
    await $`mkdir -p ${join(root, ".weave", "runtime")}`.quiet();
    const port = new BunPathContainmentPort();
    const result = await port.verifyContainment(root, ".weave/runtime");
    expect(result).toEqual(ok(join(root, ".weave", "runtime")));
  });

  test("rejects a symlinked directory component", async () => {
    const outsideResult = await $`mktemp -d`.quiet();
    const outside = outsideResult.text().trim();
    await $`ln -s ${outside} ${join(root, "linked")}`.quiet();
    const port = new BunPathContainmentPort();
    const result = await port.verifyContainment(root, "linked");
    expect(result).toEqual(err("symlink-component-rejected"));
    await $`rm -rf ${outside}`.quiet();
  });
});

describe("NullPathContainmentPort", () => {
  test("always fails closed", async () => {
    const port = new NullPathContainmentPort();
    const result = await port.verifyContainment("/tmp/project", "plan.md");
    expect(result.isErr()).toBe(true);
  });
});

describe("FakePathContainmentPort", () => {
  test("returns the scripted result for an exact root/relative-path pair", async () => {
    const port = new FakePathContainmentPort(
      new Map([["/tmp/project\u0000plan.md", ok("/tmp/project/plan.md")]]),
    );
    const result = await port.verifyContainment("/tmp/project", "plan.md");
    expect(result).toEqual(ok("/tmp/project/plan.md"));
  });

  test("falls back to the default result for an unscripted pair", async () => {
    const port = new FakePathContainmentPort(
      new Map(),
      err("symlink-component-rejected"),
    );
    const result = await port.verifyContainment("/tmp/project", "other.md");
    expect(result).toEqual(err("symlink-component-rejected"));
  });
});

describe("isDirectoryContainmentSafeWith", () => {
  test("rejects a lexically unsafe relative directory before consulting the port", async () => {
    const port = new FakePathContainmentPort(new Map(), ok("/tmp/project/x"));
    const safe = (
      await isDirectoryContainmentSafeWith(port, "/tmp/project", "../escape")
    ).unwrapOr(true);
    expect(safe).toBe(false);
  });

  test("reports true when the port proves containment", async () => {
    const port = new FakePathContainmentPort(
      new Map([
        ["/tmp/project\u0000.weave/runtime", ok("/tmp/project/.weave/runtime")],
      ]),
    );
    const safe = (
      await isDirectoryContainmentSafeWith(
        port,
        "/tmp/project",
        ".weave/runtime",
      )
    ).unwrapOr(false);
    expect(safe).toBe(true);
  });

  test("reports true when the directory does not exist yet (safe to create later)", async () => {
    const port = new FakePathContainmentPort(
      new Map([
        ["/tmp/project\u0000.weave/runtime", err("path-component-missing")],
      ]),
    );
    const safe = (
      await isDirectoryContainmentSafeWith(
        port,
        "/tmp/project",
        ".weave/runtime",
      )
    ).unwrapOr(false);
    expect(safe).toBe(true);
  });

  test("reports false for every other containment failure (symlink, escape, identity change)", async () => {
    const cases = [
      "symlink-component-rejected",
      "resolved-target-outside-root",
      "target-identity-changed",
      "target-unresolvable",
      "project-root-unresolvable",
    ] as const;
    for (const reason of cases) {
      const port = new FakePathContainmentPort(
        new Map([["/tmp/project\u0000.weave/runtime", err(reason)]]),
      );
      const safe = (
        await isDirectoryContainmentSafeWith(
          port,
          "/tmp/project",
          ".weave/runtime",
        )
      ).unwrapOr(true);
      expect(safe).toBe(false);
    }
  });

  test("with the real BunPathContainmentPort, a missing project root fails closed", async () => {
    const port = new BunPathContainmentPort();
    const safe = (
      await isDirectoryContainmentSafeWith(
        port,
        "/tmp/weave-project-that-does-not-exist",
        ".weave/runtime",
      )
    ).unwrapOr(true);
    expect(safe).toBe(false);
  });
});
