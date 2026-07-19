import { expect, test } from "bun:test";
import { join } from "node:path";

test("compiled control is self-contained and digest recorded", async () => {
  const root = join(import.meta.dir, "..", "..", "..");
  const build = Bun.spawn(["bun", "scripts/build-release-control.ts"], {
    cwd: root,
  });
  expect(await build.exited).toBe(0);
  const binary = join(root, "dist-release-control", "release-control");
  const expected = (
    await Bun.file(
      join(root, "dist-release-control", "release-control.sha256"),
    ).text()
  ).split("  ")[0];
  const actual = new Bun.CryptoHasher("sha256")
    .update(await Bun.file(binary).bytes())
    .digest("hex");
  expect(actual).toBe(expected);
  const temp = await mktemp();
  const run = Bun.spawn([binary, "--help"], {
    cwd: temp,
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(await run.exited).toBe(0);
});
async function mktemp(): Promise<string> {
  const path = `/tmp/weave-release-control-${crypto.randomUUID()}`;
  const process = Bun.spawn(["mkdir", "-p", path]);
  if ((await process.exited) !== 0) throw new Error("mkdir failed");
  return path;
}
