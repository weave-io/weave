import { join } from "node:path";
import { logger } from "@weaveio/weave-engine";
import {
  createBindingRecord,
  verifyBindingRecord,
} from "./artifact-binding.js";
import type { ArtifactManifest } from "./model.js";
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
const digest = (value: Uint8Array | string) =>
  `sha256:${Bun.CryptoHasher.hash("sha256", value, "hex")}`;
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
const manifest: ArtifactManifest = {
  schemaVersion: 1,
  releaseSubjectSha: "a".repeat(40),
  channel: "nightly",
  packages: ["@weaveio/weave-cli"],
  versions: { "@weaveio/weave-cli": "1.0.0-nightly.20260101.aaaaaaaaaaaa" },
  artifacts: [
    {
      filename: "@weaveio-weave-cli-1.0.0-nightly.20260101.aaaaaaaaaaaa.tgz",
      checksumFilename: "x.sha256",
      sizeBytes: 1,
      sha256: digest("payload"),
    },
  ],
};
const binding = createBindingRecord({
  repositoryId: 1,
  workflowSha: "b".repeat(40),
  runId: 1,
  runAttempt: 1,
  event: "workflow_dispatch",
  operation: "nightly",
  headRef: "refs/heads/main",
  headSha: "a".repeat(40),
  originJobConclusion: "success",
  artifacts: [],
  manifest,
  manifestDigest: digest(JSON.stringify(manifest)),
  files: [
    {
      filename: manifest.artifacts[0].filename,
      sha256: manifest.artifacts[0].sha256,
    },
    { filename: "release-control", sha256: digest(bytes) },
  ],
});
const context = {
  expectedWorkflowSha: "b".repeat(40),
  expectedOperation: "nightly" as const,
  expectedHeadRef: "refs/heads/main" as const,
  expectedHeadSha: "a".repeat(40),
  expectedManifest: manifest,
  expectedManifestDigest: digest(JSON.stringify(manifest)),
  expectedFiles: binding.isOk() ? binding.value.files : [],
};
const github = {
  getWorkflowRun: () =>
    import("neverthrow").then(({ okAsync }) =>
      okAsync({
        repositoryId: 1,
        id: 1,
        runAttempt: 1,
        event: "workflow_dispatch" as const,
        workflowPath: ".github/workflows/publish.yml",
        workflowSha: "b".repeat(40),
        headRef: "refs/heads/main" as const,
        headSha: "a".repeat(40),
        conclusion: "success" as const,
      }),
    ),
  listRunArtifacts: () =>
    import("neverthrow").then(({ okAsync }) => okAsync([])),
  getArtifact: () => import("neverthrow").then(({ okAsync }) => okAsync({})),
  downloadArtifact: () =>
    import("neverthrow").then(({ okAsync }) => okAsync(new Uint8Array())),
};
log.info({ directory }, "created clean-room control fixture");
await runScenarios("release-control-clean-room", [
  {
    name: "happy-path",
    verify: async () =>
      recorded === digest(bytes).replace("sha256:", "") &&
      (await help.exited) === 0,
  },
  {
    name: "tampered-executable",
    verify: async () =>
      binding.isErr() ||
      (
        await verifyBindingRecord(
          {
            ...binding.value,
            files: [
              ...binding.value.files.slice(0, 1),
              {
                filename: "release-control",
                sha256: digest(new Uint8Array([...bytes.slice(0, 1), 0])),
              },
            ],
          },
          context,
          github as never,
        )
      ).isErr(),
  },
  {
    name: "tampered-binding",
    verify: async () =>
      binding.isErr() ||
      (
        await verifyBindingRecord(
          { ...binding.value, headSha: "c".repeat(40) },
          context,
          github as never,
        )
      ).isErr(),
  },
  {
    name: "tampered-payload",
    verify: async () =>
      binding.isErr() ||
      (
        await verifyBindingRecord(
          {
            ...binding.value,
            files: [
              {
                filename: manifest.artifacts[0].filename,
                sha256: digest("tampered"),
              },
              ...binding.value.files.slice(1),
            ],
          },
          context,
          github as never,
        )
      ).isErr(),
  },
]);
