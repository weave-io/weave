/**
 * Real-filesystem proof for trusted XDG data-base canonicalization
 * (Task 20 real-harness remediation).
 *
 * The rule under test: symlinks are allowed *only* at or above the configured
 * base (`$XDG_DATA_HOME`, else `$HOME/.local/share`); everything from the
 * adapter-owned `weave/adapters/pi/sessions` boundary downwards stays strict
 * no-follow. These tests use a real temporary tree because the whole point is
 * libc `realpath(3)` behaviour, which a fake cannot prove.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { $ } from "bun";
import { resolvePiNativeSessionRoot } from "../child-native-sessions.js";
import { createBunPiNativeSessionFs } from "../native-session-fs.js";
import {
  BunPiTrustedDataRootPort,
  IdentityPiTrustedDataRootPort,
} from "../trusted-data-root.js";

const port = new BunPiTrustedDataRootPort();

describe("BunPiTrustedDataRootPort — real filesystem", () => {
  let root: string;

  beforeEach(async () => {
    // `/private/tmp` is already canonical on Darwin, so the fixture controls
    // exactly which components are symlinks.
    root = (await $`mktemp -d /private/tmp/weave-tdr-XXXXXX`.quiet())
      .text()
      .trim();
    await $`chmod 700 ${root}`.quiet();
  });

  afterEach(async () => {
    await $`rm -rf ${root}`.quiet();
  });

  test("accepts a user-owned symlinked base and returns its canonical target", async () => {
    const real = join(root, "dotfiles/.local/share");
    await $`mkdir -p ${real}`.quiet();
    await $`chmod 700 ${real}`.quiet();
    await $`mkdir -p ${join(root, "home")}`.quiet();
    await $`ln -s ${join(root, "dotfiles/.local")} ${join(root, "home/.local")}`.quiet();

    const resolved = await port.canonicalize(join(root, "home/.local/share"));

    expect(resolved._unsafeUnwrap()).toBe(real);
  });

  test("keeps not-yet-created components below the canonical target", async () => {
    const real = join(root, "dotfiles/.local");
    await $`mkdir -p ${real}`.quiet();
    await $`chmod 700 ${real}`.quiet();
    await $`mkdir -p ${join(root, "home")}`.quiet();
    await $`ln -s ${real} ${join(root, "home/.local")}`.quiet();

    const resolved = await port.canonicalize(join(root, "home/.local/share"));

    expect(resolved._unsafeUnwrap()).toBe(join(real, "share"));
  });

  test("a session root under a symlinked base stores under the canonical target", async () => {
    const real = join(root, "dotfiles/.local/share");
    await $`mkdir -p ${real}`.quiet();
    await $`chmod 700 ${real}`.quiet();
    await $`mkdir -p ${join(root, "home")}`.quiet();
    await $`ln -s ${join(root, "dotfiles/.local")} ${join(root, "home/.local")}`.quiet();

    const sessionRoot = await resolvePiNativeSessionRoot({
      env: {},
      homeDir: join(root, "home"),
      trustedRoot: port,
    });

    const expected = join(real, "weave/adapters/pi/sessions");
    expect(sessionRoot._unsafeUnwrap()).toBe(expected);

    // The adapter's own no-follow chain must then be able to create it.
    const fs = createBunPiNativeSessionFs();
    const directory = (
      await fs.openDirectory(sessionRoot._unsafeUnwrap(), true)
    )._unsafeUnwrap();
    expect(directory.path).toBe(expected);
    directory.close();
  });

  test("rejects a relative base", async () => {
    expect((await port.canonicalize("relative/data"))._unsafeUnwrapErr()).toBe(
      "relative-data-root",
    );
    expect((await port.canonicalize(""))._unsafeUnwrapErr()).toBe(
      "relative-data-root",
    );
  });

  test("rejects a symlink loop", async () => {
    await $`ln -s ${join(root, "loop-b")} ${join(root, "loop-a")}`.quiet();
    await $`ln -s ${join(root, "loop-a")} ${join(root, "loop-b")}`.quiet();

    expect(
      (await port.canonicalize(join(root, "loop-a")))._unsafeUnwrapErr(),
    ).toBe("unresolvable-data-root");
  });

  test("rejects a dangling symlinked base", async () => {
    await $`ln -s ${join(root, "missing-target")} ${join(root, "dangling")}`.quiet();

    expect(
      (await port.canonicalize(join(root, "dangling")))._unsafeUnwrapErr(),
    ).toBe("unresolvable-data-root");
    expect(
      (
        await port.canonicalize(join(root, "dangling/share"))
      )._unsafeUnwrapErr(),
    ).toBe("unresolvable-data-root");
  });

  test("rejects a base that is not a directory", async () => {
    await Bun.write(join(root, "file"), "x");

    expect(
      (await port.canonicalize(join(root, "file")))._unsafeUnwrapErr(),
    ).toBe("non-directory-data-root");
  });

  test("rejects a group- or world-writable base", async () => {
    const shared = join(root, "shared");
    await $`mkdir -p ${shared}`.quiet();
    await $`chmod 777 ${shared}`.quiet();

    expect((await port.canonicalize(shared))._unsafeUnwrapErr()).toBe(
      "writable-data-root",
    );

    await $`chmod 770 ${shared}`.quiet();
    expect((await port.canonicalize(shared))._unsafeUnwrapErr()).toBe(
      "writable-data-root",
    );

    await $`chmod 755 ${shared}`.quiet();
    expect((await port.canonicalize(shared))._unsafeUnwrap()).toBe(shared);
  });

  test("rejects a base owned by another user", async () => {
    // `/private/var/root` (Darwin) and `/root` (Linux) are root-owned; `/` is
    // root-owned everywhere and always exists.
    expect((await port.canonicalize("/"))._unsafeUnwrapErr()).toBe(
      "foreign-data-root",
    );
  });

  test("still refuses a symlinked component inside the adapter root", async () => {
    const base = join(root, "share");
    await $`mkdir -p ${join(base, "weave/adapters/pi")}`.quiet();
    await $`chmod -R 700 ${base}`.quiet();
    await $`mkdir -p ${join(root, "elsewhere")}`.quiet();
    await $`chmod 700 ${join(root, "elsewhere")}`.quiet();
    await $`ln -s ${join(root, "elsewhere")} ${join(base, "weave/adapters/pi/sessions")}`.quiet();

    const canonical = (await port.canonicalize(base))._unsafeUnwrap();
    expect(canonical).toBe(base);

    const fs = createBunPiNativeSessionFs();
    expect(
      (
        await fs.openDirectory(
          join(canonical, "weave/adapters/pi/sessions"),
          true,
        )
      )._unsafeUnwrapErr(),
    ).toEqual({ type: "symlink-rejected" });
  });

  test("still refuses a symlinked child directory below the adapter root", async () => {
    const sessions = join(root, "share/weave/adapters/pi/sessions");
    await $`mkdir -p ${sessions}`.quiet();
    await $`chmod -R 700 ${join(root, "share")}`.quiet();
    await $`mkdir -p ${join(root, "elsewhere")}`.quiet();
    await $`chmod 700 ${join(root, "elsewhere")}`.quiet();
    await $`ln -s ${join(root, "elsewhere")} ${join(sessions, "child-1")}`.quiet();

    const fs = createBunPiNativeSessionFs();
    expect(
      (
        await fs.openDirectory(join(sessions, "child-1"), true)
      )._unsafeUnwrapErr(),
    ).toEqual({ type: "symlink-rejected" });
  });
});

describe("IdentityPiTrustedDataRootPort", () => {
  test("passes absolute paths through and refuses relative ones", async () => {
    const identity = new IdentityPiTrustedDataRootPort();
    expect((await identity.canonicalize("/xdg"))._unsafeUnwrap()).toBe("/xdg");
    expect((await identity.canonicalize("xdg"))._unsafeUnwrapErr()).toBe(
      "relative-data-root",
    );
  });
});
