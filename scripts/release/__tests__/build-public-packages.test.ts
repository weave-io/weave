import { describe, expect, it } from "bun:test";
import { errAsync, okAsync } from "neverthrow";
import type { BoundedProcess } from "../../bounded-process/contract.js";
import { MAX_BOUNDED_PROCESS_LINE_BYTES } from "../../bounded-process/stream.js";
import {
  BUILD_GIT_PROCESS_LIMITS,
  hasPrivateDeclarationReference,
  hasPrivateDependencyReference,
  hasRuntimeRelativeImport,
  PI_EXTENSION_IDENTITY_MANIFEST,
  type PublicPackageBuildError,
  type PublicPackageFileSystem,
  parseGitBuildIdentity,
  piIdentityOutputFiles,
  piOutputName,
  readGitBuildIdentity,
  runGit,
  writePiExtensionBuildIdentityManifest,
} from "../../build-public-packages.js";
import {
  PUBLIC_PACKAGE_BUILDS,
  PUBLIC_RUNTIME_EXTERNALS,
} from "../constants.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function streamFromText(text: string): ReadableStream<Uint8Array<ArrayBuffer>> {
  return new ReadableStream<Uint8Array<ArrayBuffer>>({
    start(controller) {
      controller.enqueue(
        new TextEncoder().encode(text) as Uint8Array<ArrayBuffer>,
      );
      controller.close();
    },
  });
}

function trackedStream(
  onCancel: () => void,
): ReadableStream<Uint8Array<ArrayBuffer>> {
  return new ReadableStream<Uint8Array<ArrayBuffer>>({
    cancel() {
      onCancel();
    },
  });
}

function fakeProcess(input: {
  readonly stdout?: ReadableStream<Uint8Array<ArrayBuffer>>;
  readonly stderr?: ReadableStream<Uint8Array<ArrayBuffer>>;
  readonly exited?: PromiseLike<number>;
  readonly onKill?: (signal: "SIGTERM" | "SIGKILL") => unknown;
}): BoundedProcess {
  return {
    stdout: input.stdout ?? streamFromText(""),
    stderr: input.stderr ?? streamFromText(""),
    exited: input.exited ?? Promise.resolve(0),
    exitCode: null,
    signalCode: null,
    kill: (signal) => input.onKill?.(signal),
  };
}

const GIT_TEST_LIMITS = {
  ...BUILD_GIT_PROCESS_LIMITS,
  spawnMs: 10,
  firstOutputMs: 15,
  totalReadMs: 40,
  gracefulTermMs: 10,
  postKillMs: 10,
  cleanupMs: 40,
};

describe("bounded Git build probes", () => {
  it("parses a normal subject and dirty status only after both probes succeed", async () => {
    const subject = "a".repeat(40);
    const result = await readGitBuildIdentity((command) =>
      command[0] === "rev-parse"
        ? okAsync(`${subject}\n`)
        : okAsync(" M scripts/build-public-packages.ts\n"),
    );

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual({ subject, dirty: true });
    const parsed = parseGitBuildIdentity(`${subject}\n`, "");
    expect(parsed.isOk()).toBe(true);
    expect(parsed._unsafeUnwrap()).toEqual({ subject, dirty: false });
  });

  it("drains stderr-only floods and returns a closed build error", async () => {
    const result = await runGit(
      ["rev-parse", "HEAD"],
      "git-subject-unavailable",
      {
        limits: GIT_TEST_LIMITS,
        spawn: () =>
          fakeProcess({
            stdout: streamFromText(""),
            stderr: streamFromText("stderr-flood".repeat(100_000)),
          }),
      },
    );

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toEqual({
      type: "BuildIdentity",
      reason: "git-subject-unavailable",
    });
  });

  it("rejects newline-free and multiline stdout overflow", async () => {
    const newlineFree = await runGit(
      ["rev-parse", "HEAD"],
      "git-subject-unavailable",
      {
        limits: GIT_TEST_LIMITS,
        spawn: () =>
          fakeProcess({
            stdout: streamFromText(
              "x".repeat(MAX_BOUNDED_PROCESS_LINE_BYTES + 1),
            ),
          }),
      },
    );
    const multiline = await runGit(["status"], "git-state-unavailable", {
      limits: { ...GIT_TEST_LIMITS, maxCaptureBytes: 8 },
      spawn: () => fakeProcess({ stdout: streamFromText("1234\n5678\n") }),
    });

    expect(newlineFree.isErr()).toBe(true);
    expect(multiline.isErr()).toBe(true);
    expect(JSON.stringify(newlineFree)).not.toContain("x");
  });

  it("accepts stdout at the exact capture bound", async () => {
    const result = await runGit(
      ["rev-parse", "HEAD"],
      "git-subject-unavailable",
      {
        limits: { ...GIT_TEST_LIMITS, maxCaptureBytes: 32 },
        spawn: () =>
          fakeProcess({ stdout: streamFromText(`${"x".repeat(31)}\n`) }),
      },
    );

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toBe(`${"x".repeat(31)}\n`);
  });

  it("bounds a hanging Git process through TERM and KILL", async () => {
    const signals: string[] = [];
    const result = await runGit(["status"], "git-state-unavailable", {
      limits: GIT_TEST_LIMITS,
      spawn: () =>
        fakeProcess({
          exited: new Promise<number>(() => undefined),
          onKill: (signal) => signals.push(signal),
        }),
    });

    expect(result.isErr()).toBe(true);
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("cleans up a process that arrives after the spawn deadline", async () => {
    const signals: string[] = [];
    let stdoutCancellations = 0;
    let stderrCancellations = 0;
    const late = fakeProcess({
      stdout: trackedStream(() => {
        stdoutCancellations += 1;
      }),
      stderr: trackedStream(() => {
        stderrCancellations += 1;
      }),
      exited: new Promise<number>(() => undefined),
      onKill: (signal) => signals.push(signal),
    });
    const result = await runGit(["status"], "git-state-unavailable", {
      limits: GIT_TEST_LIMITS,
      spawn: () =>
        new Promise<BoundedProcess>((resolve) =>
          setTimeout(() => resolve(late), GIT_TEST_LIMITS.spawnMs * 3),
        ),
    });

    expect(result.isErr()).toBe(true);
    await sleep(100);
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(stdoutCancellations).toBe(1);
    expect(stderrCancellations).toBe(1);
  });

  it("does not expose stderr from a nonzero Git exit", async () => {
    const sentinel = "git-secret-sentinel";
    const result = await runGit(["status"], "git-state-unavailable", {
      limits: GIT_TEST_LIMITS,
      spawn: () =>
        fakeProcess({
          stdout: streamFromText("ignored\n"),
          stderr: streamFromText(sentinel),
          exited: Promise.resolve(17),
        }),
    });

    expect(result.isErr()).toBe(true);
    expect(JSON.stringify(result)).not.toContain(sentinel);
  });
});

describe("public package build guard", () => {
  it("rejects bundled private workspace dependency maps", () => {
    expect(
      hasPrivateDependencyReference(
        '{ "@weaveio/weave-core": "workspace:*" }',
        "@weaveio/weave-core",
      ),
    ).toBe(true);
  });

  it("rejects bundled private module specifiers", () => {
    expect(
      hasPrivateDependencyReference(
        'import { parseConfig } from "@weaveio/weave-config";',
        "@weaveio/weave-config",
      ),
    ).toBe(true);
  });

  it("allows prose that merely names a private package", () => {
    expect(
      hasPrivateDependencyReference(
        "Install @weaveio/weave-engine before continuing.",
        "@weaveio/weave-engine",
      ),
    ).toBe(false);
  });

  it("rejects private workspace references in declaration rollups", () => {
    expect(
      hasPrivateDeclarationReference(
        'import type { WeaveConfig } from "@weaveio/weave-core";',
        "@weaveio/weave-core",
      ),
    ).toBe(true);
  });

  it("rejects private package names in declaration prose", () => {
    expect(
      hasPrivateDeclarationReference(
        "/** Use @weaveio/weave-core to define this config. */",
        "@weaveio/weave-core",
      ),
    ).toBe(true);
  });

  it("keeps Pi's CommonJS-heavy externals scoped to the Pi build", () => {
    expect(PUBLIC_RUNTIME_EXTERNALS).not.toContain("pino");
    expect(PUBLIC_RUNTIME_EXTERNALS).not.toContain("kysely");
    expect(
      PUBLIC_PACKAGE_BUILDS["@weaveio/weave-adapter-pi"].runtimeExternals,
    ).toEqual(["kysely", "pino"]);
  });

  it("declares both Pi extension loader and implementation entries", () => {
    const piBuild = PUBLIC_PACKAGE_BUILDS["@weaveio/weave-adapter-pi"];
    const outputs = piBuild.entries.map((entry) => entry.output);
    expect(outputs).toContain("packages/adapters/pi/dist/extension.js");
    expect(outputs).toContain(
      "packages/adapters/pi/dist/extension-build-identity.js",
    );
    expect(outputs).toContain("packages/adapters/pi/dist/extension-impl.js");
    expect(piBuild.extraFiles).toEqual(["dist/extension-build-identity.json"]);
    const extensionEntry = piBuild.entries.find(
      (entry) => entry.output === "packages/adapters/pi/dist/extension.js",
    );
    expect(extensionEntry).toBeDefined();
    expect("transpileOnly" in (extensionEntry ?? {})).toBe(false);
    const identityEntry = piBuild.entries.find(
      (entry) =>
        entry.output ===
        "packages/adapters/pi/dist/extension-build-identity.js",
    );
    expect(identityEntry).toBeDefined();
    expect("transpileOnly" in (identityEntry ?? {})).toBe(false);
  });

  it("bundles the preloader into one self-contained output", async () => {
    expect(
      hasRuntimeRelativeImport('import "./extension-preloader-factory.js";'),
    ).toBe(true);
    const outdir = `/tmp/weave-pi-preloader-build-${crypto.randomUUID()}`;
    const result = await Bun.build({
      entrypoints: ["packages/adapters/pi/src/extension.ts"],
      outdir,
      target: "bun",
      format: "esm",
    });
    expect(result.success).toBe(true);
    expect(result.outputs).toHaveLength(1);
    const output = result.outputs[0];
    if (output === undefined) throw new Error("preloader output missing");
    const contents = await new Response(output).text();
    expect(hasRuntimeRelativeImport(contents)).toBe(false);
    expect(contents).not.toMatch(
      /(?:from|import)\s*["']\.\/extension-preloader-/u,
    );
    await Bun.file(output.path).delete();
  });

  it("keeps the three Pi host packages as public runtime externals", () => {
    expect(PUBLIC_RUNTIME_EXTERNALS).toContain(
      "@earendil-works/pi-coding-agent",
    );
    expect(PUBLIC_RUNTIME_EXTERNALS).toContain("@earendil-works/pi-ai");
    expect(PUBLIC_RUNTIME_EXTERNALS).toContain("@earendil-works/pi-tui");
  });
});

class MemoryPublicPackageFileSystem implements PublicPackageFileSystem {
  readonly files = new Map<string, string>();
  readonly writes: string[] = [];

  copyFile(): ReturnType<PublicPackageFileSystem["copyFile"]> {
    return okAsync(undefined);
  }
  ensureDirectory(): ReturnType<PublicPackageFileSystem["ensureDirectory"]> {
    return okAsync(undefined);
  }
  makeExecutable(): ReturnType<PublicPackageFileSystem["makeExecutable"]> {
    return okAsync(undefined);
  }
  listDeclarationFiles(): ReturnType<
    PublicPackageFileSystem["listDeclarationFiles"]
  > {
    return okAsync([]);
  }
  readText(path: string): ReturnType<PublicPackageFileSystem["readText"]> {
    const contents = this.files.get(path);
    return contents === undefined
      ? errAsync({
          type: "Filesystem",
          path,
          operation: "copy",
        } satisfies PublicPackageBuildError)
      : okAsync(contents);
  }
  removeFile(): ReturnType<PublicPackageFileSystem["removeFile"]> {
    return okAsync(undefined);
  }
  writeText(
    path: string,
    contents: string,
  ): ReturnType<PublicPackageFileSystem["writeText"]> {
    this.writes.push(path);
    this.files.set(path, contents);
    return okAsync(undefined);
  }
}

describe("Pi extension build identity sidecar", () => {
  const digestA = "a".repeat(64);
  const digestB = "b".repeat(64);
  const subject = "c".repeat(40);

  it("names outputs logically and writes the sidecar after those outputs exist", async () => {
    expect(piOutputName("packages/adapters/pi/dist/extension.js")).toBe(
      "extension",
    );
    expect(piOutputName("packages/adapters/pi/dist/index.d.ts")).toBe(
      "index-declarations",
    );
    expect(piIdentityOutputFiles().map((output) => output.name)).toContain(
      "extension",
    );
    expect(
      piIdentityOutputFiles().some((output) => output.name.includes("/")),
    ).toBe(false);

    const fileSystem = new MemoryPublicPackageFileSystem();
    const result = await writePiExtensionBuildIdentityManifest({
      fileSystem,
      subject,
      dirty: true,
      buildBinding: digestA,
      inputDigests: [digestB, digestA],
      outputs: [
        { name: "index", sha256: digestB },
        { name: "extension", sha256: digestA },
      ],
      buildCompletedAt: "1970-01-01T00:00:00.100Z",
    });
    expect(result.isOk()).toBe(true);
    expect(fileSystem.writes).toEqual([PI_EXTENSION_IDENTITY_MANIFEST]);
    const sidecar = fileSystem.files.get(PI_EXTENSION_IDENTITY_MANIFEST);
    expect(sidecar).toBeDefined();
    expect(sidecar).not.toContain("packages/");
    expect(sidecar).not.toContain("/Users/");
    expect(sidecar).not.toContain("PATH");
    const parsed = JSON.parse(sidecar ?? "") as {
      schemaVersion: number;
      git: { subject: string; dirty: boolean };
      buildInputs: string[];
      outputs: { name: string; sha256: string }[];
      buildCompletedAt: string;
    };
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.git).toEqual({ subject, dirty: true });
    expect(parsed.buildInputs).toEqual([digestA, digestB]);
    expect(parsed.outputs.map((output) => output.name)).toEqual([
      "extension",
      "index",
    ]);
    expect(parsed.buildCompletedAt).toBe("1970-01-01T00:00:00.100Z");
  });

  it("refuses a sidecar when hashed outputs are missing or unsorted names collide", async () => {
    const fileSystem = new MemoryPublicPackageFileSystem();
    const result = await writePiExtensionBuildIdentityManifest({
      fileSystem,
      subject,
      dirty: false,
      buildBinding: digestA,
      inputDigests: [],
      outputs: [],
    });
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toEqual({
      type: "BuildIdentity",
      reason: "manifest-invalid",
    });
    expect(fileSystem.writes).toEqual([]);
  });
});
