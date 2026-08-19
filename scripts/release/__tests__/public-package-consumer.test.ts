import { describe, expect, it } from "bun:test";
import { join, resolve } from "node:path";
import { errAsync, okAsync, Result, ResultAsync } from "neverthrow";
import { PackagePolicyValidator } from "../package-policy.js";
import { BunPackageCommandRunner, PublicPackagePackager } from "../packager.js";
import { TarInspector } from "../tar-inspector.js";

type ConsumerTestError =
  | { type: "Command"; command: readonly string[]; cwd: string; output: string }
  | { type: "Filesystem"; path: string; operation: "read" | "write" }
  | { type: "TemporaryDirectory"; output: string };

interface CommandOutput {
  stdout: string;
  stderr: string;
}

class IsolatedConsumer {
  constructor(readonly directory: string) {}

  static create(): ResultAsync<IsolatedConsumer, ConsumerTestError> {
    const spawned = Result.fromThrowable(
      () =>
        Bun.spawn({ cmd: ["mktemp", "-d"], stdout: "pipe", stderr: "pipe" }),
      () => ({
        type: "TemporaryDirectory" as const,
        output: "Could not start mktemp",
      }),
    )();
    if (spawned.isErr()) return errAsync(spawned.error);
    return ResultAsync.fromPromise(
      Promise.all([
        spawned.value.exited,
        new Response(spawned.value.stdout).text(),
        new Response(spawned.value.stderr).text(),
      ]),
      () => ({
        type: "TemporaryDirectory" as const,
        output: "mktemp output unavailable",
      }),
    ).andThen(([code, stdout, stderr]) => {
      if (code !== 0 || stdout.trim().length === 0)
        return errAsync({
          type: "TemporaryDirectory" as const,
          output: stderr,
        });
      return okAsync(new IsolatedConsumer(stdout.trim()));
    });
  }

  copyFixture(file: string): ResultAsync<void, ConsumerTestError> {
    const source = join("scripts/release/__fixtures__/consumer", file);
    const destination = join(this.directory, file);
    return ResultAsync.fromPromise(Bun.file(source).arrayBuffer(), () => ({
      type: "Filesystem" as const,
      path: source,
      operation: "read" as const,
    })).andThen((contents) =>
      ResultAsync.fromPromise(Bun.write(destination, contents), () => ({
        type: "Filesystem" as const,
        path: destination,
        operation: "write" as const,
      })).andThen(() => okAsync()),
    );
  }

  run(
    command: readonly string[],
  ): ResultAsync<CommandOutput, ConsumerTestError> {
    const spawned = Result.fromThrowable(
      () =>
        Bun.spawn({
          cmd: [...command],
          cwd: this.directory,
          stdout: "pipe",
          stderr: "pipe",
        }),
      () => ({
        type: "Command" as const,
        command,
        cwd: this.directory,
        output: "Could not start command",
      }),
    )();
    if (spawned.isErr()) return errAsync(spawned.error);
    return ResultAsync.fromPromise(
      Promise.all([
        spawned.value.exited,
        new Response(spawned.value.stdout).text(),
        new Response(spawned.value.stderr).text(),
      ]),
      () => ({
        type: "Command" as const,
        command,
        cwd: this.directory,
        output: "Command output unavailable",
      }),
    ).andThen(([code, stdout, stderr]) => {
      if (code === 0) return okAsync({ stdout, stderr });
      return errAsync({
        type: "Command" as const,
        command,
        cwd: this.directory,
        output: `${stdout}\n${stderr}`,
      });
    });
  }

  cleanup(): ResultAsync<void, ConsumerTestError> {
    return this.run(["rm", "-rf", this.directory]).andThen(() => okAsync());
  }
}

function failure(error: ConsumerTestError): Error {
  return new Error(JSON.stringify(error));
}

describe("public consumer fixture", () => {
  it("installs, imports, typechecks, and executes packed public packages", async () => {
    const staging = await IsolatedConsumer.create();
    if (staging.isErr()) throw failure(staging.error);
    const root = resolve(staging.value.directory);
    const createdConsumer = await IsolatedConsumer.create();
    if (createdConsumer.isErr()) {
      await staging.value.cleanup();
      throw failure(createdConsumer.error);
    }
    const consumer = createdConsumer.value;
    try {
      const build = await new IsolatedConsumer(process.cwd()).run([
        "bun",
        "scripts/build-public-packages.ts",
      ]);
      if (build.isErr()) throw failure(build.error);

      const tarballs = await new PublicPackagePackager(
        new BunPackageCommandRunner(),
        new PackagePolicyValidator(),
      ).packAll(join(root, "staging"));
      if (tarballs.isErr()) throw new Error(JSON.stringify(tarballs.error));

      for (const tarball of tarballs.value) {
        const inspection = new TarInspector().inspect(
          await Bun.file(tarball).bytes(),
        );
        expect(inspection.isOk()).toBe(true);
      }

      for (const file of [
        "package.json",
        "tsconfig.json",
        "index.ts",
        "runtime.mjs",
      ]) {
        const copied = await consumer.copyFixture(file);
        if (copied.isErr()) throw failure(copied.error);
      }

      const install = await consumer.run([
        "npm",
        "install",
        "--ignore-scripts",
        ...tarballs.value.map((tarball) => resolve(tarball)),
      ]);
      if (install.isErr()) throw failure(install.error);

      const runtime = await consumer.run(["bun", "runtime.mjs"]);
      if (runtime.isErr()) throw failure(runtime.error);
      const typecheck = await consumer.run([
        "./node_modules/.bin/tsc",
        "-p",
        "tsconfig.json",
      ]);
      if (typecheck.isErr()) throw failure(typecheck.error);
      const help = await consumer.run(["./node_modules/.bin/weave", "--help"]);
      if (help.isOk()) expect(help.value.stdout).toContain("USAGE");
      else throw failure(help.error);

      for (const packageName of [
        "@weaveio/weave-adapter-claude-code",
        "@weaveio/weave-cli",
      ]) {
        for (const file of [
          ".claude-plugin/plugin.json",
          "hooks/hooks.json",
          "skills/compose/SKILL.md",
        ]) {
          const source = await Bun.file(
            join("packages/adapters/claude-code/src/bootstrap", file),
          ).bytes();
          const installed = await Bun.file(
            join(
              consumer.directory,
              "node_modules",
              packageName,
              "dist/bootstrap",
              file,
            ),
          ).bytes();
          expect(installed).toEqual(source);
        }
      }
    } finally {
      const cleanedConsumer = await consumer.cleanup();
      expect(cleanedConsumer.isOk()).toBe(true);
      const cleanedRoot = await new IsolatedConsumer(root).cleanup();
      expect(cleanedRoot.isOk()).toBe(true);
    }
  }, 120_000);
});
