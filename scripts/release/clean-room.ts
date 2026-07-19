import { join } from "node:path";
import { logger } from "@weaveio/weave-engine";
import {
  createBindingRecord,
  verifyBindingRecord,
} from "./artifact-binding.js";
import { digest, FixtureGitHub, nightlyFixture } from "./release-fixtures.js";
import { runScenarios } from "./verification-harness.js";

const log = logger.child({ module: "release-control-clean-room" });
const root = join(import.meta.dir, "..", "..");
const output = join(root, "dist-release-control");
const binary = join(output, "release-control");
const sidecar = join(output, "release-control.sha256");
const build = Bun.spawn(["bun", "run", "release:control:build"], {
  cwd: root,
  stdout: "pipe",
  stderr: "pipe",
});
if ((await build.exited) !== 0) process.exit(1);
const bytes = new Uint8Array(await Bun.file(binary).bytes());
const recorded = (await Bun.file(sidecar).text()).split("  ")[0];
const directory = `/tmp/weave-release-control-${crypto.randomUUID()}`;
await Bun.write(join(directory, "release-control"), bytes);
const chmod = Bun.spawn(["chmod", "+x", join(directory, "release-control")]);
if ((await chmod.exited) !== 0) process.exit(1);
const help = Bun.spawn([join(directory, "release-control"), "--help"], {
  cwd: directory,
  stdout: "pipe",
  stderr: "pipe",
});
const fixture = nightlyFixture();
const binding = createBindingRecord({
  ...fixture,
  files: [
    {
      filename: fixture.filename,
      sha256: fixture.manifest.artifacts[0].sha256,
    },
    { filename: "release-control", sha256: digest(bytes) },
  ],
});
if (binding.isErr()) process.exit(2);
const context = { ...fixture.context, expectedFiles: binding.value.files };
log.info({ directory }, "created clean-room control fixture");
await runScenarios("release-control-clean-room", [
  {
    name: "happy-path",
    verify: async () => {
      const verified = await verifyBindingRecord(
        binding.value,
        context,
        new FixtureGitHub(fixture),
      );
      return (
        recorded === digest(bytes).replace("sha256:", "") &&
        (await help.exited) === 0 &&
        verified.isOk()
      );
    },
  },
  {
    name: "tampered-executable",
    verify: async () =>
      (
        await verifyBindingRecord(
          binding.value,
          context,
          new FixtureGitHub(fixture, {}, { 2: new Uint8Array([...bytes, 0]) }),
        )
      ).match(
        () => false,
        (error) =>
          error.type === "BindingMismatch" &&
          error.field === "downloadDigest" &&
          error.expected === fixture.artifacts[1]?.uploadDigest,
      ),
  },
  {
    name: "tampered-binding",
    verify: async () =>
      (
        await verifyBindingRecord(
          { ...binding.value, headSha: "c".repeat(40) },
          context,
          new FixtureGitHub(fixture),
        )
      ).match(
        () => false,
        (error) =>
          error.type === "BindingMismatch" && error.field === "recordDigest",
      ),
  },
  {
    name: "tampered-payload",
    verify: async () =>
      (
        await verifyBindingRecord(
          binding.value,
          context,
          new FixtureGitHub(fixture, {}, { 1: new Uint8Array([...bytes, 1]) }),
        )
      ).match(
        () => false,
        (error) =>
          error.type === "BindingMismatch" &&
          error.field === "downloadDigest" &&
          error.expected === fixture.artifacts[0]?.uploadDigest,
      ),
  },
]);
