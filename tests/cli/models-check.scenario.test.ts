/**
 * CLI scenarios — `weave models check`.
 *
 * Bucket: CLI. A maintainer checks a model recommendations list before it is
 * signed and published (Spec 39, publication bar step 6). Input is argv plus
 * the list, envelope and expectations files on a virtual disk; output is what
 * they see and the exit code the website's deploy workflow gets.
 *
 * Envelopes are signed with a throwaway key pair made for this run and passed
 * with `--key`; the clock is injected so `issued` and `expires` stay fixed.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import { run } from "../../packages/cli/src/cli.js";
import { MemoryFileSystem } from "../../packages/cli/src/fs/file-system.js";
import { BufferTerminal } from "../../packages/cli/src/io/terminal.js";
import { signModelRecommendations } from "../../packages/config/src/index.js";

const PROJECT_DIR = "/site";
const NOW = new Date("2026-10-02T12:00:00Z");

const list = {
  schema: 1,
  channel: "stable",
  issued: "2026-10-01T09:00:00Z",
  expires: "2026-12-30T09:00:00Z",
  evidence: "https://tryweave.io/evals/runs/run-1",
  default: {
    agents: {
      shuttle: {
        models: ["claude-sonnet-5.5", "claude-sonnet-5-5", "gpt-6-sol"],
      },
    },
  },
  harnesses: {
    opencode2: {
      agents: {
        shuttle: {
          models: [
            "claude-sonnet-5.5",
            "claude-sonnet-5-5",
            "openrouter/anthropic/claude-sonnet-5.5",
            "gpt-6-sol",
          ],
        },
      },
    },
    "claude-code": { agents: { shuttle: { models: ["sonnet"] } } },
  },
};

const expectations = {
  schema: 1,
  harnesses: {
    opencode2: {
      "github-copilot": { shuttle: "github-copilot/claude-sonnet-5.5" },
      anthropic: { shuttle: "anthropic/claude-sonnet-5-5" },
      openai: { shuttle: "openai/gpt-6-sol" },
      openrouter: { shuttle: "openrouter/anthropic/claude-sonnet-5.5" },
      "github-copilot+openai": { shuttle: "github-copilot/claude-sonnet-5.5" },
    },
    "claude-code": { anthropic: { shuttle: "sonnet" } },
    pi: {
      "github-copilot": { shuttle: "github-copilot/claude-sonnet-5.5" },
      anthropic: { shuttle: "anthropic/claude-sonnet-5-5" },
      openai: { shuttle: "openai/gpt-6-sol" },
      openrouter: { shuttle: "none" },
      "github-copilot+openai": { shuttle: "github-copilot/claude-sonnet-5.5" },
    },
  },
};

let publicKey = "";
let privateKey = "";

beforeAll(async () => {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const b64 = (buffer: ArrayBuffer) =>
    btoa(String.fromCharCode(...new Uint8Array(buffer)));
  publicKey = b64(await crypto.subtle.exportKey("raw", pair.publicKey));
  privateKey = b64(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
});

async function envelope(payload: string): Promise<string> {
  return (await signModelRecommendations(payload, privateKey))._unsafeUnwrap();
}

async function runWeave(args: string[], files: Record<string, string>) {
  const terminal = new BufferTerminal();
  const fs = new MemoryFileSystem(files, PROJECT_DIR, "/home/user");
  const result = await run({
    argv: ["bun", "weave", ...args],
    terminal,
    colorEnabled: false,
    fs,
    now: () => NOW,
  });
  return {
    exitCode: result._unsafeUnwrap(),
    stdout: terminal.out.join("\n"),
    stderr: terminal.err.join("\n"),
  };
}

const json = (value: unknown) => JSON.stringify(value, null, 2);

describe("a maintainer checks a list before publishing it", () => {
  it("exits 0 and prints the model each agent gets per harness and provider", async () => {
    const { exitCode, stdout } = await runWeave(
      ["models", "check", "models/stable.json"],
      { "/site/models/stable.json": json(list) },
    );

    expect(exitCode).toBe(0);
    expect(stdout).toContain("channel    stable");
    expect(stdout).toContain("evidence   https://tryweave.io/evals/runs/run-1");
    expect(stdout).toContain("opencode2 (section: opencode2)");
    expect(stdout).toContain("pi (section: default)");
    expect(stdout).toContain("shuttle  openrouter/anthropic/claude-sonnet-5.5");
    expect(stdout).toContain("shuttle  sonnet");
    expect(stdout).toContain("signature  not checked");
  });

  it("passes when every resolution matches the expectations file", async () => {
    const { exitCode, stdout } = await runWeave(
      [
        "models",
        "check",
        "models/stable.json",
        "--expect",
        "models/stable.expect.json",
      ],
      {
        "/site/models/stable.json": json(list),
        "/site/models/stable.expect.json": json(expectations),
      },
    );

    expect(exitCode).toBe(0);
    expect(stdout).toContain("All 11 expectations match.");
  });

  it("fails and names every harness, provider and agent that resolves differently", async () => {
    const wrong = structuredClone(expectations);
    wrong.harnesses.pi.openrouter.shuttle =
      "openrouter/anthropic/claude-sonnet-5.5";
    const { exitCode, stderr } = await runWeave(
      [
        "models",
        "check",
        "models/stable.json",
        "--expect",
        "models/stable.expect.json",
      ],
      {
        "/site/models/stable.json": json(list),
        "/site/models/stable.expect.json": json(wrong),
      },
    );

    expect(exitCode).toBe(1);
    expect(stderr).toContain(
      "pi / openrouter / shuttle: expected openrouter/anthropic/claude-sonnet-5.5, resolved none",
    );
  });

  it("fails when the list names an agent the expectations file does not cover", async () => {
    const withLoom = structuredClone(list);
    (withLoom.harnesses["claude-code"].agents as Record<string, unknown>).loom =
      {
        models: ["opus"],
      };
    const { exitCode, stderr } = await runWeave(
      [
        "models",
        "check",
        "models/stable.json",
        "--expect",
        "models/stable.expect.json",
      ],
      {
        "/site/models/stable.json": json(withLoom),
        "/site/models/stable.expect.json": json(expectations),
      },
    );

    expect(exitCode).toBe(1);
    expect(stderr).toContain("claude-code / anthropic / loom: resolved opus");
  });

  it("rejects an expectations file that is not in the expected shape", async () => {
    const { exitCode, stderr } = await runWeave(
      [
        "models",
        "check",
        "models/stable.json",
        "--expect",
        "models/stable.expect.json",
      ],
      {
        "/site/models/stable.json": json(list),
        "/site/models/stable.expect.json": json({
          schema: 1,
          harnesses: { codex: {} },
        }),
      },
    );

    expect(exitCode).toBe(1);
    expect(stderr).toContain("stable.expect.json is not valid");
  });

  it("lists agents this version does not define, which clients skip", async () => {
    const withUnknown = structuredClone(list);
    (withUnknown.default.agents as Record<string, unknown>).loom2 = {
      models: ["gpt-6-sol"],
    };
    const { exitCode, stdout } = await runWeave(
      ["models", "check", "models/stable.json"],
      { "/site/models/stable.json": json(withUnknown) },
    );

    expect(exitCode).toBe(0);
    expect(stdout).toContain("Not builtin agents in this version");
    expect(stdout).toContain("loom2");
  });

  it("prints a machine-readable report with --json", async () => {
    const { exitCode, stdout } = await runWeave(
      ["models", "check", "models/stable.json", "--json"],
      { "/site/models/stable.json": json(list) },
    );

    expect(exitCode).toBe(0);
    const report = JSON.parse(stdout);
    expect(report.signature).toBe("not-checked");
    expect(report.resolutions).toHaveLength(11);
  });
});

describe("a maintainer checks a list that must not be published", () => {
  it.each([
    [
      "a claude-code entry that is not a tier",
      {
        harnesses: {
          "claude-code": {
            agents: { shuttle: { models: ["claude-sonnet-5-5"] } },
          },
        },
      },
      "claude-code entries must be opus, sonnet or haiku",
    ],
    ["no evidence link", { evidence: undefined }, "evidence"],
    [
      "an expiry more than 90 days out",
      { expires: "2027-01-01T09:00:00Z" },
      "at most 90 days",
    ],
    ["an unknown field", { prompts: {} }, "is not valid"],
  ])("exits 1 for %s and says why", async (_name, override, reason) => {
    const { exitCode, stderr } = await runWeave(
      ["models", "check", "models/stable.json"],
      { "/site/models/stable.json": json({ ...list, ...override }) },
    );

    expect(exitCode).toBe(1);
    expect(stderr).toContain(reason);
  });

  it("exits 1 for an expired list", async () => {
    const { exitCode, stderr } = await runWeave(
      ["models", "check", "models/stable.json"],
      {
        "/site/models/stable.json": json({
          ...list,
          issued: "2026-09-30T00:00:00Z",
          expires: "2026-10-01T00:00:00Z",
        }),
      },
    );

    expect(exitCode).toBe(1);
    expect(stderr).toContain("the list expired at 2026-10-01T00:00:00Z");
  });

  it("exits 1 for a list issued before this release's builtin models", async () => {
    const { exitCode, stderr } = await runWeave(
      ["models", "check", "models/stable.json"],
      {
        "/site/models/stable.json": json({
          ...list,
          issued: "2026-09-01T00:00:00Z",
          expires: "2026-11-01T00:00:00Z",
        }),
      },
    );

    expect(exitCode).toBe(1);
    expect(stderr).toContain("before this release's builtin models");
  });

  it("exits 1 when the file does not exist", async () => {
    const { exitCode, stderr } = await runWeave(
      ["models", "check", "models/missing.json"],
      {},
    );

    expect(exitCode).toBe(1);
    expect(stderr).toContain("File not found: /site/models/missing.json");
  });
});

describe("a maintainer verifies a signed envelope", () => {
  it("exits 0 and says the signature verified", async () => {
    const { exitCode, stdout } = await runWeave(
      ["models", "check", "stable.v1.json", "--envelope", "--key", publicKey],
      { "/site/stable.v1.json": await envelope(json(list)) },
    );

    expect(exitCode).toBe(0);
    expect(stdout).toContain("signature  verified");
  });

  it("exits 1 when the payload was changed after signing", async () => {
    const signed = JSON.parse(await envelope(json(list)));
    signed.payload = signed.payload.replace('sonnet"', 'opus"');
    const { exitCode, stderr } = await runWeave(
      ["models", "check", "stable.v1.json", "--envelope", "--key", publicKey],
      { "/site/stable.v1.json": JSON.stringify(signed) },
    );

    expect(exitCode).toBe(1);
    expect(stderr).toContain("the signature does not verify");
  });

  it("exits 1 against the built-in keys, which did not sign this test's envelope", async () => {
    const { exitCode, stderr } = await runWeave(
      ["models", "check", "stable.v1.json", "--envelope"],
      { "/site/stable.v1.json": await envelope(json(list)) },
    );

    expect(exitCode).toBe(1);
    expect(stderr).toContain("the signature does not verify");
  });

  it("exits 1 when --key is given for a plain list", async () => {
    const { exitCode, stderr } = await runWeave(
      ["models", "check", "models/stable.json", "--key", publicKey],
      { "/site/models/stable.json": json(list) },
    );

    expect(exitCode).toBe(1);
    expect(stderr).toContain(
      "--key verifies a signature, so it needs --envelope",
    );
  });
});

describe("a user runs weave models without a subcommand", () => {
  it("exits 1 and shows how to use it", async () => {
    const { exitCode, stderr } = await runWeave(["models"], {});

    expect(exitCode).toBe(1);
    expect(stderr).toContain("weave models check <file>");
  });
});
