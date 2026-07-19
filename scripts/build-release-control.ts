import { join } from "node:path";

const output = join(import.meta.dir, "..", "dist-release-control");
const mkdir = Bun.spawn(["mkdir", "-p", output]);
if ((await mkdir.exited) !== 0) process.exit(1);
const binary = join(output, "release-control");
const build = Bun.spawn(
  [
    "bun",
    "build",
    "--compile",
    join(import.meta.dir, "release", "control-main.ts"),
    "--outfile",
    binary,
  ],
  { stdout: "inherit", stderr: "inherit" },
);
if ((await build.exited) !== 0) process.exit(1);
const digest = new Bun.CryptoHasher("sha256")
  .update(await Bun.file(binary).bytes())
  .digest("hex");
await Bun.write(
  join(output, "release-control.sha256"),
  `${digest}  release-control\n`,
);
