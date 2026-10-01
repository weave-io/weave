/**
 * CLI scenarios — `weave models status | update | apply | pin` and the model
 * recommendations lines of `weave validate` (Spec 39 item 5, "Visibility").
 *
 * Bucket: CLI. A user who opted in to model recommendations wants to see where
 * each agent's models come from, fetch and apply a new list, and freeze it.
 * Input is argv, the config files on a virtual disk, and the list tryweave.io
 * serves; output is what the user sees, the exit code, and the files left
 * behind. The network, the clock and the recommendations cache are fakes, and
 * lists are signed with a throwaway key made for this run.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import { globalConfigDir } from "@weaveio/weave-config";
import { errAsync } from "neverthrow";
import { run } from "../../packages/cli/src/cli.js";
import { MemoryFileSystem } from "../../packages/cli/src/fs/file-system.js";
import { BufferTerminal } from "../../packages/cli/src/io/terminal.js";
import { StaticPromptAdapter } from "../../packages/cli/src/prompt/index.js";
import {
  generateSigningKeys,
  MemoryRecommendationsCache,
  ScriptedFetch,
  type SigningKeys,
  signedEnvelope,
} from "../support/model-recommendations.js";
import { dedent } from "../support/scenario.js";

const PROJECT_DIR = "/project";
const HOME_DIR = "/home/user";
const NOW = new Date("2026-10-02T12:00:00Z");
const GLOBAL_CONFIG = `${globalConfigDir()}/config.weave`;
const PROJECT_CONFIG = `${PROJECT_DIR}/.weave/config.weave`;

const NOTIFY = dedent(`
  # My global config
  settings {
    model_updates {
      mode notify
    }
  }
`);

const AUTO = dedent(`
  settings {
    model_updates {
      mode auto
    }
  }
`);

/** A published list issued on `day` October 2026 at 09:00 UTC. */
function list(
  day: number,
  loom: string[],
  extra: Record<string, unknown> = {},
) {
  return {
    schema: 1,
    channel: "stable",
    issued: `2026-10-0${day}T09:00:00Z`,
    expires: "2026-12-20T09:00:00Z",
    evidence: `https://tryweave.io/evals/runs/run-${day}`,
    default: {
      agents: { loom: { models: loom }, "future-agent": { models: ["x"] } },
    },
    harnesses: {
      "claude-code": { agents: { loom: { models: ["opus"] } } },
    },
    ...extra,
  };
}

let keys: SigningKeys;

beforeAll(async () => {
  keys = await generateSigningKeys();
});

/** One user's machine: their files, the recommendations cache and the site. */
class Machine {
  readonly fs: MemoryFileSystem;
  readonly cache = new MemoryRecommendationsCache(() => NOW);
  readonly site = new ScriptedFetch();

  constructor(files: Record<string, string>) {
    this.fs = new MemoryFileSystem(files, PROJECT_DIR, HOME_DIR);
  }

  async publish(published: unknown): Promise<void> {
    this.site.serve(await signedEnvelope(published, keys));
  }

  async weave(args: string[], prompt?: StaticPromptAdapter) {
    const terminal = new BufferTerminal();
    const result = await run({
      argv: ["bun", "weave", ...args],
      terminal,
      colorEnabled: false,
      fs: this.fs,
      now: () => NOW,
      prompt: prompt ?? new StaticPromptAdapter({ interactive: false }),
      modelRecommendations: {
        fetch: this.site.fetch,
        files: this.cache,
        shell: this.cache,
        publicKeys: [keys.publicKey],
        baseUrl: "https://models.test/models",
      },
    });
    return {
      exitCode: result._unsafeUnwrap(),
      stdout: terminal.out.join("\n"),
      stderr: terminal.err.join("\n"),
    };
  }

  file(path: string): string | undefined {
    return this.fs.snapshot()[path];
  }
}

describe("a user who has not opted in to model recommendations", () => {
  const workingConfig = dedent(`
    agent loom {
      description "Loom (Main Orchestrator)"
      prompt "You are Loom, the orchestrator."
      models ["anthropic/claude-sonnet-4-5"]
      mode primary
    }
  `);

  it("sees exactly the validate output they saw before the feature existed", async () => {
    const machine = new Machine({ [PROJECT_CONFIG]: workingConfig });
    const project = await machine.weave(["validate", "--project"]);
    const effective = await machine.weave(["validate"]);

    expect(project.exitCode).toBe(0);
    expect(project.stdout).toBe(
      [
        "Weave config is valid.",
        "agents: 1",
        "categories: 0",
        "workflows: 0",
        "disabled: 0",
        "log_level: INFO",
      ].join("\n"),
    );
    expect(effective.stdout).not.toContain("model_");
    expect(effective.stderr).toBe("");
  });

  it("sees the mode is off and every agent's models with their source, and nothing is fetched", async () => {
    const machine = new Machine({ [PROJECT_CONFIG]: workingConfig });
    const { exitCode, stdout } = await machine.weave(["models", "status"]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain("mode        off");
    expect(stdout).toContain("Turn them on with settings { model_updates");
    expect(stdout).toMatch(
      /loom\n\s+anthropic\/claude-sonnet-4-5\s+project\n\s+claude-opus-5\.5\s+builtin/,
    );
    expect(machine.site.urls).toEqual([]);
  });

  it("is told update does nothing while model updates are off", async () => {
    const machine = new Machine({});
    const { exitCode, stderr } = await machine.weave(["models", "update"]);

    expect(exitCode).toBe(1);
    expect(stderr).toContain("Model updates are off, so nothing was fetched.");
    expect(machine.site.urls).toEqual([]);
  });
});

describe("a notify user fetches a new list and applies it", () => {
  it("shows the list waiting, then applied, with each entry's source", async () => {
    const machine = new Machine({ [GLOBAL_CONFIG]: NOTIFY });
    await machine.publish(list(1, ["claude-opus-5.6", "claude-opus-5.5"]));

    const pending = await machine.weave(["validate"]);
    expect(pending.stdout).toContain("model_updates: notify (channel stable)");
    expect(pending.stdout).toContain(
      "model_recommendations: pending, nothing applied yet (run weave models update, then weave models apply)",
    );

    const update = await machine.weave(["models", "update"]);
    expect(update.exitCode).toBe(0);
    expect(update.stdout).toContain(
      "A newer stable list, issued 2026-10-01T09:00:00Z, is waiting. Run weave models apply to use it.",
    );
    expect(update.stdout).toContain(
      [
        "  loom",
        "    was  claude-opus-5.5, claude-opus-5-5, gpt-6-sol",
        "    now  claude-opus-5.6, claude-opus-5.5, claude-opus-5-5, gpt-6-sol",
      ].join("\n"),
    );
    expect(machine.site.urls).toEqual([
      "https://models.test/models/stable.v1.json",
    ]);

    const waiting = await machine.weave(["models", "status"]);
    expect(waiting.stdout).toContain("applied     nothing yet");
    expect(waiting.stdout).toContain(
      "waiting     issued 2026-10-01T09:00:00Z (run weave models apply to use it)",
    );
    expect(waiting.stdout).toContain("last check  2026-10-02T12:00:00.000Z");

    const apply = await machine.weave(["models", "apply"]);
    expect(apply.exitCode).toBe(0);
    expect(apply.stdout).toContain(
      "Applied the stable list issued 2026-10-01T09:00:00Z.",
    );

    const status = await machine.weave(["models", "status"]);
    expect(status.stdout).toContain("harness     opencode2 (section: default)");
    expect(status.stdout).toContain(
      "applied     issued 2026-10-01T09:00:00Z, expires 2026-12-20T09:00:00Z",
    );
    expect(status.stdout).toContain(
      "evidence    https://tryweave.io/evals/runs/run-1",
    );
    expect(status.stdout).toContain("skipped     future-agent");
    expect(status.stdout).toMatch(
      /loom\n\s+claude-opus-5\.6\s+recommended\n\s+claude-opus-5\.5\s+recommended\n\s+claude-opus-5-5\s+builtin/,
    );

    const validate = await machine.weave(["validate"]);
    expect(validate.stdout).toContain(
      "model_recommendations: applied, issued 2026-10-01T09:00:00Z, expires 2026-12-20T09:00:00Z (opencode2, section default)",
    );

    const again = await machine.weave(["models", "apply"]);
    expect(again.stdout).toContain("Nothing to apply");
  });

  it("reports the status as JSON for scripts", async () => {
    const machine = new Machine({ [GLOBAL_CONFIG]: NOTIFY });
    await machine.publish(list(1, ["claude-opus-5.6"]));
    await machine.weave(["models", "update"]);
    await machine.weave(["models", "apply"]);

    const { exitCode, stdout } = await machine.weave([
      "models",
      "status",
      "--json",
    ]);
    const report = JSON.parse(stdout);
    expect(exitCode).toBe(0);
    expect(report).toMatchObject({
      mode: "notify",
      channel: "stable",
      harness: "opencode2",
      supported: true,
      applied: {
        state: "usable",
        issued: "2026-10-01T09:00:00Z",
        evidence: "https://tryweave.io/evals/runs/run-1",
        section: "default",
      },
      waiting: null,
      lastError: null,
      skippedAgents: ["future-agent"],
    });
    expect(report.agents.loom[0]).toEqual({
      model: "claude-opus-5.6",
      source: "recommended",
    });
  });

  it("uses the harness's own section when one is chosen", async () => {
    const machine = new Machine({ [GLOBAL_CONFIG]: NOTIFY });
    await machine.publish(list(1, ["claude-opus-5.6"]));
    await machine.weave(["models", "update"]);
    await machine.weave(["models", "apply"]);

    const { stdout } = await machine.weave([
      "models",
      "status",
      "--harness",
      "claude-code",
    ]);
    expect(stdout).toContain("harness     claude-code (section: claude-code)");
    expect(stdout).toMatch(/loom\n\s+opus\s+recommended/);
  });
});

describe("an auto user updates", () => {
  it("applies a newer list at once and prints old against new", async () => {
    const machine = new Machine({ [GLOBAL_CONFIG]: AUTO });
    await machine.publish(list(1, ["claude-opus-5.6"]));
    await machine.weave(["models", "update"]);
    await machine.publish(list(2, ["claude-opus-6"]));

    const { exitCode, stdout } = await machine.weave(["models", "update"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain(
      "Applied the stable list issued 2026-10-02T09:00:00Z (was 2026-10-01T09:00:00Z).",
    );
    expect(stdout).toContain(
      [
        "  loom",
        "    was  claude-opus-5.6, claude-opus-5.5, claude-opus-5-5, gpt-6-sol",
        "    now  claude-opus-6, claude-opus-5.5, claude-opus-5-5, gpt-6-sol",
      ].join("\n"),
    );

    const same = await machine.weave(["models", "update"]);
    expect(same.stdout).toContain(
      "Model recommendations are up to date (stable list issued 2026-10-02T09:00:00Z).",
    );
  });
});

describe("a list that repeats the models agents already run", () => {
  // The first stable list repeats the builtin lists. Applying it is real (the
  // list is now the applied one), but no agent's merged list changes.
  const BUILTIN_LOOM = ["claude-opus-5.5", "claude-opus-5-5", "gpt-6-sol"];

  it("says which list an auto update applied and that no agent's models changed", async () => {
    const machine = new Machine({ [GLOBAL_CONFIG]: AUTO });
    await machine.publish(list(1, BUILTIN_LOOM));

    const { exitCode, stdout, stderr } = await machine.weave([
      "models",
      "update",
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toBe(
      [
        "Applied the stable list issued 2026-10-01T09:00:00Z.",
        "  No agent's models changed.",
      ].join("\n"),
    );
    expect(stderr).toBe("");
  });

  it("tells a notify user the waiting list would change nothing, and apply says the same", async () => {
    const machine = new Machine({ [GLOBAL_CONFIG]: NOTIFY });
    await machine.publish(list(1, BUILTIN_LOOM));

    const update = await machine.weave(["models", "update"]);
    expect(update.stdout).toBe(
      [
        "A newer stable list, issued 2026-10-01T09:00:00Z, is waiting. Run weave models apply to use it.",
        "  No agent's models would change.",
      ].join("\n"),
    );

    const apply = await machine.weave(["models", "apply"]);
    expect(apply.stdout).toBe(
      [
        "Applied the stable list issued 2026-10-01T09:00:00Z.",
        "  No agent's models changed.",
      ].join("\n"),
    );
  });

  it("counts the user's own models: a list that only repeats them changes nothing", async () => {
    const machine = new Machine({
      [GLOBAL_CONFIG]: `${AUTO}\nagent loom {\n  models ["claude-opus-6"]\n}\n`,
    });
    await machine.publish(list(1, ["claude-opus-6", "claude-opus-5.5"]));

    const { stdout } = await machine.weave(["models", "update"]);
    expect(stdout).toBe(
      [
        "Applied the stable list issued 2026-10-01T09:00:00Z.",
        "  No agent's models changed.",
      ].join("\n"),
    );
  });
});

describe("the site cannot be reached", () => {
  it("fails the update with a readable reason and shows it in status", async () => {
    const machine = new Machine({ [GLOBAL_CONFIG]: NOTIFY });
    machine.site.fail(503);

    const update = await machine.weave(["models", "update"]);
    expect(update.exitCode).toBe(1);
    expect(update.stderr).toContain(
      "the stable list could not be checked: the server answered HTTP 503",
    );

    const status = await machine.weave(["models", "status"]);
    expect(status.stdout).toContain("last error  the server answered HTTP 503");
  });
});

describe("the applied list is damaged", () => {
  it("is reported as skipped by validate and status, and agents keep their builtin models", async () => {
    const machine = new Machine({ [GLOBAL_CONFIG]: AUTO });
    await machine.publish(list(1, ["claude-opus-5.6"]));
    await machine.weave(["models", "update"]);
    const applied = [...machine.cache.files.keys()].find((path) =>
      path.endsWith("/applied.json"),
    );
    if (applied === undefined) throw new Error("nothing was applied");
    machine.cache.files.set(applied, "{ not json");

    const validate = await machine.weave(["validate"]);
    expect(validate.exitCode).toBe(0);
    expect(validate.stdout).toMatch(
      /model_recommendations: skipped, the envelope is not \{ "payload", "sig" \}.*; agents use their builtin models/,
    );

    const json = await machine.weave(["validate", "--json"]);
    expect(() => JSON.parse(json.stdout) as unknown).not.toThrow();
    expect(json.stderr).toContain("model_recommendations: skipped");

    const forms = await machine.weave(["validate", "--path", GLOBAL_CONFIG]);
    expect(forms.stdout).toContain("model_recommendations: skipped");

    const status = await machine.weave(["models", "status"]);
    expect(status.stdout).toContain("applied     not used:");
    expect(status.stdout).toMatch(/loom\n\s+claude-opus-5\.5\s+builtin/);
  });
});

describe("the recommendations cache cannot be read", () => {
  it("is reported as skipped, not as nothing applied yet", async () => {
    const machine = new Machine({ [GLOBAL_CONFIG]: NOTIFY });
    machine.cache.exists = (path) =>
      errAsync({
        type: "CacheIoError",
        operation: "exists",
        path,
        message: "permission denied",
      });

    const { exitCode, stdout } = await machine.weave(["validate"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain(
      "model_recommendations: skipped, the applied recommendations file could not be read",
    );
  });
});

describe("a user pins the applied recommendations", () => {
  const ownConfig = dedent(`
    # My global config — keep this comment
    settings {
      model_updates {
        mode notify
      }
    }

    agent loom {
      temperature 0.1   # tuned by hand
      models ["my-model"]
    }

    agent shuttle {
      temperature 0.2
    }
  `);

  async function applied(machine: Machine): Promise<void> {
    await machine.publish({
      ...list(1, ["claude-opus-5.6"]),
      default: {
        agents: {
          loom: { models: ["claude-opus-5.6"] },
          shuttle: { models: ["claude-sonnet-5.6"] },
          thread: { models: ["claude-haiku-5"] },
        },
      },
    });
    await machine.weave(["models", "update"]);
    await machine.weave(["models", "apply"]);
  }

  it("prints the diff, writes only models lines with --yes, and suggests turning updates off", async () => {
    const machine = new Machine({ [GLOBAL_CONFIG]: ownConfig });
    await applied(machine);

    const { exitCode, stdout } = await machine.weave([
      "models",
      "pin",
      "--yes",
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain(`into ${GLOBAL_CONFIG}:`);
    expect(stdout).toContain('-  models ["my-model"]');
    expect(stdout).toContain('+  models ["my-model", "claude-opus-5.6"]');
    expect(stdout).toContain('+  models ["claude-sonnet-5.6"]');
    expect(stdout).toContain("Pinned the models of 3 agents");
    expect(stdout).toContain("settings { model_updates { mode off } }");

    expect(machine.file(GLOBAL_CONFIG)).toBe(
      `${dedent(`
        # My global config — keep this comment
        settings {
          model_updates {
            mode notify
          }
        }

        agent loom {
          temperature 0.1   # tuned by hand
          models ["my-model", "claude-opus-5.6"]
        }

        agent shuttle {
          temperature 0.2
          models ["claude-sonnet-5.6"]
        }
      `)}\n\n# Pinned by weave models pin: the stable list issued 2026-10-01T09:00:00Z, opencode2 (section default).\nagent thread {\n  models ["claude-haiku-5"]\n}\n`,
    );

    const status = await machine.weave(["models", "status"]);
    expect(status.stdout).toMatch(
      /loom\n\s+my-model\s+global\n\s+claude-opus-5\.6\s+global/,
    );

    const twice = await machine.weave(["models", "pin", "--yes"]);
    expect(twice.stdout).toContain("nothing to pin");
  });

  it("writes nothing without --yes when there is no terminal to ask", async () => {
    const machine = new Machine({ [GLOBAL_CONFIG]: ownConfig });
    await applied(machine);

    const { exitCode, stderr } = await machine.weave(["models", "pin"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Re-run with --yes");
    expect(machine.file(GLOBAL_CONFIG)).toBe(ownConfig);
  });

  it("writes nothing when the user declines", async () => {
    const machine = new Machine({ [GLOBAL_CONFIG]: ownConfig });
    await applied(machine);

    const { exitCode, stdout } = await machine.weave(
      ["models", "pin"],
      new StaticPromptAdapter({ confirm: [false] }),
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Nothing was written.");
    expect(machine.file(GLOBAL_CONFIG)).toBe(ownConfig);
  });

  it("writes nothing when the config changes while the question is open", async () => {
    const machine = new Machine({ [GLOBAL_CONFIG]: ownConfig });
    await applied(machine);
    const edited = `${ownConfig}\n# edited meanwhile\n`;
    const prompt = new StaticPromptAdapter({ confirm: [true] });
    const answer = prompt.confirm.bind(prompt);
    prompt.confirm = async (input) => {
      await machine.fs.writeText(GLOBAL_CONFIG, edited);
      return answer(input);
    };

    const { exitCode, stderr } = await machine.weave(["models", "pin"], prompt);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("changed while the diff was shown");
    expect(machine.file(GLOBAL_CONFIG)).toBe(edited);
  });

  describe("when the list has provider-qualified entries", () => {
    async function appliedQualified(machine: Machine): Promise<void> {
      // Only the opencode2 section may name a provider.
      await machine.publish({
        ...list(1, ["claude-opus-5.6"]),
        harnesses: {
          opencode2: {
            agents: {
              loom: {
                models: [
                  "openrouter/anthropic/claude-opus-5.5",
                  "claude-opus-5.6",
                ],
              },
              shuttle: { models: ["claude-sonnet-5.6"] },
              thread: { models: ["github-copilot/claude-haiku-5"] },
            },
          },
        },
      });
      await machine.weave(["models", "update"]);
      await machine.weave(["models", "apply"]);
    }

    it("leaves them out, says why, and keeps an agent with nothing else as it was", async () => {
      const machine = new Machine({ [GLOBAL_CONFIG]: ownConfig });
      await appliedQualified(machine);

      const { exitCode, stdout } = await machine.weave([
        "models",
        "pin",
        "--yes",
      ]);
      expect(exitCode).toBe(0);
      expect(stdout).toContain(
        "Left out provider-qualified models: loom (openrouter/anthropic/claude-opus-5.5), thread (github-copilot/claude-haiku-5).",
      );
      expect(stdout).toContain("OpenCode V1");
      expect(stdout).toContain("--include-qualified");
      expect(stdout).toContain(
        "thread keeps its existing models: all of its recommended entries are provider-qualified.",
      );
      expect(stdout).toContain('+  models ["my-model", "claude-opus-5.6"]');
      expect(stdout).not.toContain('+  models ["my-model", "openrouter');
      expect(stdout).not.toContain("@@ new blocks: thread @@");
      expect(stdout).toContain("Pinned the models of 2 agents");

      const written = machine.file(GLOBAL_CONFIG) ?? "";
      expect(written).toContain('models ["my-model", "claude-opus-5.6"]');
      expect(written).toContain('models ["claude-sonnet-5.6"]');
      expect(written).not.toContain("openrouter/");
      expect(written).not.toContain("agent thread");
    });

    it("changes nothing, and says so, when every recommended entry is provider-qualified", async () => {
      const machine = new Machine({ [GLOBAL_CONFIG]: ownConfig });
      await machine.publish({
        ...list(1, ["claude-opus-5.6"]),
        harnesses: {
          opencode2: {
            agents: {
              loom: { models: ["openrouter/anthropic/claude-opus-5.5"] },
            },
          },
        },
      });
      await machine.weave(["models", "update"]);
      await machine.weave(["models", "apply"]);

      const { exitCode, stdout } = await machine.weave([
        "models",
        "pin",
        "--yes",
      ]);
      expect(exitCode).toBe(0);
      expect(stdout).toContain(
        "loom keeps its existing models: all of its recommended entries are provider-qualified.",
      );
      expect(stdout).toContain(
        `Nothing else to pin; the global config was not changed (${GLOBAL_CONFIG}).`,
      );
      expect(stdout).not.toContain("already lists these models");
      expect(machine.file(GLOBAL_CONFIG)).toBe(ownConfig);
    });

    it("keeps them with --include-qualified and warns", async () => {
      const machine = new Machine({ [GLOBAL_CONFIG]: ownConfig });
      await appliedQualified(machine);

      const { exitCode, stdout } = await machine.weave([
        "models",
        "pin",
        "--include-qualified",
        "--yes",
      ]);
      expect(exitCode).toBe(0);
      expect(stdout).toContain(
        "Warning: pinning provider-qualified models: loom (openrouter/anthropic/claude-opus-5.5), thread (github-copilot/claude-haiku-5).",
      );
      expect(stdout).toContain("OpenCode V1");
      expect(stdout).toContain(
        '+  models ["my-model", "openrouter/anthropic/claude-opus-5.5", "claude-opus-5.6"]',
      );
      expect(stdout).toContain("Pinned the models of 3 agents");

      const written = machine.file(GLOBAL_CONFIG) ?? "";
      expect(written).toContain(
        'models ["my-model", "openrouter/anthropic/claude-opus-5.5", "claude-opus-5.6"]',
      );
      expect(written).toContain(
        'agent thread {\n  models ["github-copilot/claude-haiku-5"]\n}',
      );
    });
  });

  it("has nothing to pin before a list is applied", async () => {
    const machine = new Machine({ [GLOBAL_CONFIG]: NOTIFY });
    const { exitCode, stderr } = await machine.weave([
      "models",
      "pin",
      "--yes",
    ]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain(
      "Nothing to pin: no recommendations are applied yet",
    );
  });
});

describe("a user on a harness without recommendations", () => {
  it("is told OpenCode V1 is not supported by status, and update refuses", async () => {
    const machine = new Machine({ [GLOBAL_CONFIG]: NOTIFY });
    const status = await machine.weave([
      "models",
      "status",
      "--harness",
      "opencode",
    ]);
    expect(status.exitCode).toBe(0);
    expect(status.stdout).toContain(
      "Model recommendations are not supported on OpenCode V1",
    );

    const update = await machine.weave([
      "models",
      "update",
      "--harness",
      "copilot",
    ]);
    expect(update.exitCode).toBe(1);
    expect(update.stderr).toContain(
      "Model recommendations are not supported on Copilot CLI",
    );
    expect(machine.site.urls).toEqual([]);
  });

  it("rejects a harness name Weave does not know", async () => {
    const machine = new Machine({});
    const { exitCode, stderr } = await machine.weave([
      "models",
      "status",
      "--harness",
      "vim",
    ]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("--harness must be one of");
  });
});
