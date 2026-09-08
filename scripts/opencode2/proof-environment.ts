import { resolve } from "node:path";
import { err, ok, type Result, ResultAsync } from "neverthrow";

export const OPENCODE2_PROOF_HOST_VERSION = "0.0.0-beta-19086" as const;
export const OPENCODE2_PROOF_ROOT =
  "/private/var/folders/00/kg4g6rwj56df8m493xpgm7s00000gn/T/opencode";

export type ProofEnvironmentError = {
  readonly type: "CommandFailed" | "FileFailed" | "IdentityFailed";
  readonly step: string;
  readonly detail: string;
};

interface CommandOutput {
  readonly stdout: string;
  readonly stderr: string;
}

function cleanEnvironment(
  extra: Readonly<Record<string, string>> = {},
): Record<string, string> {
  const inherited = Object.fromEntries(
    Object.entries(Bun.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  return { ...inherited, ...extra };
}

function runCommand(
  command: readonly string[],
  cwd: string,
  env: Readonly<Record<string, string>> = {},
): ResultAsync<CommandOutput, ProofEnvironmentError> {
  return ResultAsync.fromThrowable(
    async () => {
      const child = Bun.spawn([...command], {
        cwd,
        env: cleanEnvironment(env),
        stdout: "pipe",
        stderr: "pipe",
      });
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      if (exitCode !== 0) throw new Error(stderr.slice(0, 800));
      return { stdout: stdout.trim(), stderr: stderr.trim() };
    },
    (cause): ProofEnvironmentError => ({
      type: "CommandFailed",
      step: command.join(" "),
      detail:
        cause instanceof Error ? cause.message.slice(0, 800) : "command failed",
    }),
  )();
}

function writeText(
  path: string,
  contents: string,
): ResultAsync<void, ProofEnvironmentError> {
  return ResultAsync.fromThrowable(
    async () => {
      await Bun.write(path, contents);
    },
    (): ProofEnvironmentError => ({
      type: "FileFailed",
      step: "write",
      detail: path,
    }),
  )();
}

function digest(path: string): ResultAsync<string, ProofEnvironmentError> {
  return ResultAsync.fromThrowable(
    async () => {
      const bytes = new Uint8Array(await Bun.file(path).arrayBuffer());
      return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
    },
    (): ProofEnvironmentError => ({
      type: "FileFailed",
      step: "digest",
      detail: path,
    }),
  )();
}

function weaveSource(revision: string): string {
  return `agent loom {
  models ["proof/proof-model#proof-variant"]
  temperature 0.42
  prompt_append "${revision}"
  skills ["proof-skill", "missing-skill"]
  tool_policy {
    read deny
    write deny
    execute deny
    delegate allow
    network deny
  }
}

agent tapestry {
  models ["proof/proof-model#proof-variant"]
  temperature 0.43
  prompt_append "${revision}"
}

agent shuttle {
  models ["proof/proof-model#proof-variant"]
  temperature 0.44
  prompt_append "${revision} CHILD_ROLE_SYSTEM"
}

agent proof-denied {
  description "Delegation denied proof"
  prompt "DENIED_ROLE_SYSTEM"
  models ["proof/proof-model#proof-variant"]
  mode primary
  tool_policy {
    read deny
    write deny
    execute deny
    delegate deny
    network deny
  }
}

agent collision {
  description "Weave collision candidate"
  prompt "WEAVE_COLLISION_SYSTEM"
  models ["proof/proof-model#proof-variant"]
  mode subagent
}

agent unavailable-model {
  description "Missing model proof"
  prompt "UNAVAILABLE_MODEL_SYSTEM"
  models ["missing/not-installed"]
  mode subagent
}
`;
}

export class OpenCode2ProofEnvironment {
  readonly runtime: string;
  readonly project: string;
  readonly home: string;
  readonly xdgConfig: string;
  readonly xdgData: string;
  readonly xdgCache: string;
  readonly xdgState: string;
  readonly registrationFile: string;
  readonly binary: string;
  readonly installedAdapter: string;

  private constructor(
    readonly root: string,
    readonly repository: string,
    readonly tarball: string,
    readonly adapterVersion: string,
    readonly tarballSha256: string,
    readonly pluginSha256: string,
  ) {
    this.runtime = resolve(root, "runtime");
    this.project = resolve(root, "project");
    this.home = resolve(root, "home");
    this.xdgConfig = resolve(root, "xdg/config");
    this.xdgData = resolve(root, "xdg/data");
    this.xdgCache = resolve(root, "xdg/cache");
    this.xdgState = resolve(root, "xdg/state");
    this.registrationFile = resolve(this.xdgState, "opencode/service.json");
    this.binary = resolve(this.runtime, "node_modules/.bin/opencode2");
    this.installedAdapter = resolve(
      this.runtime,
      "node_modules/@weaveio/weave-adapter-opencode",
    );
  }

  static prepare(): ResultAsync<
    OpenCode2ProofEnvironment,
    ProofEnvironmentError
  > {
    return ResultAsync.fromSafePromise(
      OpenCode2ProofEnvironment.prepareResult(),
    ).andThen((result) => result);
  }

  serviceEnvironment(): Record<string, string> {
    return {
      HOME: this.home,
      XDG_CONFIG_HOME: this.xdgConfig,
      XDG_DATA_HOME: this.xdgData,
      XDG_CACHE_HOME: this.xdgCache,
      XDG_STATE_HOME: this.xdgState,
      WEAVE_PROOF_API_KEY: "proof",
    };
  }

  writeValidWeaveConfig(
    revision: string,
  ): ResultAsync<void, ProofEnvironmentError> {
    return writeText(
      resolve(this.project, ".weave/config.weave"),
      weaveSource(revision),
    );
  }

  writeInvalidWeaveConfig(): ResultAsync<void, ProofEnvironmentError> {
    return writeText(
      resolve(this.project, ".weave/config.weave"),
      "agent broken {",
    );
  }

  writeMissingPromptWeaveConfig(): ResultAsync<void, ProofEnvironmentError> {
    return writeText(
      resolve(this.project, ".weave/config.weave"),
      `${weaveSource("WEAVE_REVISION_TWO")}\nagent missing-prompt {\n  prompt_file "missing.md"\n  mode subagent\n}\n`,
    );
  }

  configureProject(
    providerURL: string,
  ): ResultAsync<void, ProofEnvironmentError> {
    const config = {
      update: "disable",
      plugins: [
        {
          package: this.installedAdapter,
          options: {
            projectConfig: true,
            defaultAgent: "loom",
            refreshIntervalMs: 250,
          },
        },
      ],
      model: "proof/proof-model",
      agents: {
        collision: {
          system: "FOREIGN_COLLISION_SYSTEM",
          description: "Foreign collision",
          mode: "subagent",
        },
      },
      commands: {
        "weave:start": {
          template: "FOREIGN_COMMAND",
          description: "Foreign command",
        },
      },
      providers: {
        proof: {
          name: "Proof",
          env: ["WEAVE_PROOF_API_KEY"],
          package: "@opencode-ai/ai/providers/openai-compatible",
          settings: {
            baseURL: `${providerURL}/v1`,
            apiKey: "{env:WEAVE_PROOF_API_KEY}",
          },
          models: {
            "proof-model": {
              name: "Proof Model",
              capabilities: { tools: true, input: ["text"], output: ["text"] },
              limit: { context: 32768, output: 4096 },
              variants: [
                {
                  id: "proof-variant",
                  body: { weave_variant_probe: "proof-variant" },
                },
              ],
            },
          },
        },
      },
    };
    return writeText(
      resolve(this.project, "opencode.jsonc"),
      `${JSON.stringify(config, null, 2)}\n`,
    )
      .andThen(() => this.writeValidWeaveConfig("WEAVE_REVISION_ONE"))
      .andThen(() =>
        writeText(
          resolve(this.project, ".weave/plans/active.md"),
          "- [-] 1. Active task\n- [ ] 2. Next task\n",
        ),
      )
      .andThen(() =>
        writeText(
          resolve(this.project, ".opencode/skills/proof-skill/SKILL.md"),
          `---
name: proof-skill
description: Deterministic proof skill
---
PROOF_SKILL_CONTENT
`,
        ),
      );
  }

  cleanup(): ResultAsync<void, ProofEnvironmentError> {
    if (Bun.env.WEAVE_OPENCODE2_KEEP_PROOF === "1")
      return ResultAsync.fromSafePromise(Promise.resolve());
    return runCommand(["rm", "-rf", this.root], this.repository).map(
      () => undefined,
    );
  }

  private static async prepareResult(): Promise<
    Result<OpenCode2ProofEnvironment, ProofEnvironmentError>
  > {
    const repository = resolve(import.meta.dir, "../..");
    const created = await runCommand(
      ["mktemp", "-d", `${OPENCODE2_PROOF_ROOT}/weave-proof.XXXXXX`],
      repository,
    );
    if (created.isErr()) return err(created.error);
    const root = created.value.stdout;
    const abort = async (
      error: ProofEnvironmentError,
    ): Promise<Result<OpenCode2ProofEnvironment, ProofEnvironmentError>> => {
      await runCommand(["rm", "-rf", root], repository);
      return err(error);
    };
    const directories = [
      "artifacts",
      "runtime",
      "project/.weave/plans",
      "project/.opencode/skills/proof-skill",
      "home",
      "xdg/config",
      "xdg/data",
      "xdg/cache",
      "xdg/state/opencode",
    ].map((path) => resolve(root, path));
    const made = await runCommand(["mkdir", "-p", ...directories], repository);
    if (made.isErr()) return abort(made.error);

    const built = await runCommand(
      [Bun.which("bun") ?? "bun", "run", "build"],
      repository,
    );
    if (built.isErr()) return abort(built.error);
    const artifacts = resolve(root, "artifacts");
    const packed = await runCommand(
      [
        Bun.which("bun") ?? "bun",
        "pm",
        "pack",
        "--quiet",
        "--destination",
        artifacts,
      ],
      resolve(repository, "packages/adapters/opencode"),
    );
    if (packed.isErr()) return abort(packed.error);
    const found = await runCommand(
      ["find", artifacts, "-name", "*.tgz", "-type", "f", "-print"],
      repository,
    );
    if (found.isErr()) return abort(found.error);
    const tarball = found.value.stdout.split("\n").find(Boolean);
    if (tarball === undefined) {
      return abort({
        type: "IdentityFailed",
        step: "pack",
        detail: "adapter tarball was not created",
      });
    }

    const sourcePackage = await ResultAsync.fromThrowable(
      () =>
        Bun.file(
          resolve(repository, "packages/adapters/opencode/package.json"),
        ).json() as Promise<{ version?: string }>,
      (): ProofEnvironmentError => ({
        type: "FileFailed",
        step: "read",
        detail: "adapter package.json",
      }),
    )();
    if (sourcePackage.isErr()) return abort(sourcePackage.error);
    const adapterVersion = sourcePackage.value.version;
    if (adapterVersion === undefined) {
      return abort({
        type: "IdentityFailed",
        step: "package",
        detail: "adapter version is missing",
      });
    }
    const runtime = resolve(root, "runtime");
    const runtimePackage = {
      private: true,
      type: "module",
      trustedDependencies: ["@opencode-ai/cli"],
      dependencies: {
        "@opencode-ai/cli": OPENCODE2_PROOF_HOST_VERSION,
        "@opencode-ai/client": OPENCODE2_PROOF_HOST_VERSION,
        "@weaveio/weave-adapter-opencode": `file:${tarball}`,
      },
    };
    const wrote = await writeText(
      resolve(runtime, "package.json"),
      `${JSON.stringify(runtimePackage, null, 2)}\n`,
    );
    if (wrote.isErr()) return abort(wrote.error);
    const installed = await runCommand(
      [Bun.which("bun") ?? "bun", "install"],
      runtime,
    );
    if (installed.isErr()) return abort(installed.error);
    const version = await runCommand(
      [resolve(runtime, "node_modules/.bin/opencode2"), "--version"],
      runtime,
    );
    if (version.isErr()) return abort(version.error);
    if (version.value.stdout !== `opencode2 v${OPENCODE2_PROOF_HOST_VERSION}`) {
      return abort({
        type: "IdentityFailed",
        step: "host",
        detail: version.value.stdout,
      });
    }
    const tarballHash = await digest(tarball);
    if (tarballHash.isErr()) return abort(tarballHash.error);
    const pluginHash = await digest(
      resolve(
        runtime,
        "node_modules/@weaveio/weave-adapter-opencode/dist/plugin.js",
      ),
    );
    if (pluginHash.isErr()) return abort(pluginHash.error);
    return ok(
      new OpenCode2ProofEnvironment(
        root,
        repository,
        tarball,
        adapterVersion,
        tarballHash.value,
        pluginHash.value,
      ),
    );
  }
}
