import { describe, expect, test } from "bun:test";
import { dirname, join, resolve } from "node:path";
import { errAsync, okAsync, type Result, type ResultAsync } from "neverthrow";
import { renderChangelog } from "../../changelog-format.js";
import {
  buildChangelogPrompt,
  CHANGELOG_AGENT_API_KEY_ENV,
  CHANGELOG_AGENT_DEFAULT_THINKING,
  CHANGELOG_AGENT_LIMITS,
  CHANGELOG_AGENT_MODEL,
  CHANGELOG_PROMPT_VERSION,
  type ChangelogAgentError,
  type ChangelogAgentResult,
  FORBIDDEN_HEADLESS_TOOLS,
  runChangelogAgent,
  SUBMIT_CHANGELOG_TOOL,
  toPiCreateAgentSessionOptions,
} from "../changelog-agent.js";
import {
  assembleEvidence,
  type BoundedEvidence,
  DEFAULT_EVIDENCE_BUDGETS,
  type EvidenceAssemblyInput,
  type EvidenceChangeset,
} from "../evidence.js";
import type {
  HeadlessSession,
  HeadlessSessionDriver,
  IsolatedHeadlessSessionConfig,
} from "../headless-session.js";
import {
  CHANGELOG_SUBMISSION_LIMITS,
  type ChangelogSubmission,
  type ChangelogSubmissionEntry,
} from "../submission-schema.js";

const CLI = "@weaveio/weave-cli" as const;
const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);
const SECRET = "sk-live-changelog-agent-test-key";
const PUBLISH_MAIN = resolve(import.meta.dir, "../../publish-main.ts");
const AGENT_MODULE = resolve(import.meta.dir, "../changelog-agent.ts");

function changeset(
  id: string,
  text: string,
  sourceDigest = DIGEST_A,
): EvidenceChangeset {
  return { identity: { id, sourceDigest }, text };
}

function evidenceInput(): EvidenceAssemblyInput {
  return {
    selectedPackages: [CLI],
    packages: [
      {
        packageName: CLI,
        changesets: [changeset("first", "Add the changelog agent.")],
        pullRequests: [{ number: 12, title: "Add changelog agent" }],
        commits: [{ subject: "add changelog agent" }],
        diffs: [
          {
            path: "packages/cli/src/index.ts",
            patch: "+export const changelog = true;",
          },
        ],
      },
    ],
    budgets: { ...DEFAULT_EVIDENCE_BUDGETS },
  };
}

function evidenceValue(
  result: ReturnType<typeof assembleEvidence>,
): BoundedEvidence {
  if (result.isErr()) throw new Error(`unexpected ${result.error.type}`);
  return result.value;
}

function validEntry(
  identity = changeset("first", "").identity,
  refs: NonNullable<ChangelogSubmissionEntry["refs"]> = [
    { kind: "pull-request", number: 12 },
  ],
): ChangelogSubmissionEntry {
  return {
    prose: "Changelog prose is submitted through one typed tool.",
    sourceChangesets: [identity],
    refs,
  };
}

function validSubmission(
  identity = changeset("first", "").identity,
): ChangelogSubmission {
  return {
    packages: [
      {
        packageName: CLI,
        sections: [{ name: "Added", entries: [validEntry(identity)] }],
      },
    ],
  };
}

class FakeDriver implements HeadlessSessionDriver {
  readonly configs: IsolatedHeadlessSessionConfig[] = [];
  readonly prompts: string[] = [];
  private readonly submissions: readonly unknown[];
  private readonly toolName: string;

  constructor(
    submissions: readonly unknown[],
    options: { toolName?: string } = {},
  ) {
    this.submissions = submissions;
    this.toolName = options.toolName ?? SUBMIT_CHANGELOG_TOOL;
  }

  open(config: IsolatedHeadlessSessionConfig) {
    this.configs.push(config);
    let index = 0;
    const prompts = this.prompts;
    const submissions = this.submissions;
    const toolName = this.toolName;
    const session: HeadlessSession = {
      config,
      prompt: (text: string) => {
        prompts.push(text);
        const last = submissions.length - 1;
        const input = submissions[Math.min(index, Math.max(last, 0))];
        index += 1;
        return okAsync({ toolName, input });
      },
      dispose: () => undefined,
    };
    return okAsync(session);
  }
}

async function withApiKey(
  run: () => ResultAsync<ChangelogAgentResult, ChangelogAgentError>,
): Promise<Result<ChangelogAgentResult, ChangelogAgentError>> {
  const previous = process.env[CHANGELOG_AGENT_API_KEY_ENV];
  process.env[CHANGELOG_AGENT_API_KEY_ENV] = SECRET;
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env[CHANGELOG_AGENT_API_KEY_ENV];
    else process.env[CHANGELOG_AGENT_API_KEY_ENV] = previous;
  }
}

function expectOk(
  result: Result<ChangelogAgentResult, ChangelogAgentError>,
): ChangelogAgentResult {
  if (result.isErr())
    throw new Error(`unexpected ${JSON.stringify(result.error)}`);
  return result.value;
}

function expectErr(
  result: Result<ChangelogAgentResult, ChangelogAgentError>,
): ChangelogAgentError {
  if (result.isOk())
    throw new Error(`unexpected success ${JSON.stringify(result.value)}`);
  return result.error;
}

function requiredIdentity(evidence: BoundedEvidence) {
  const identity = evidence.packages[0]?.changesets[0]?.identity;
  if (identity === undefined) throw new Error("missing identity");
  return identity;
}

describe("headless changelog agent", () => {
  test("uses the exact isolated session config", async () => {
    const evidence = evidenceValue(assembleEvidence(evidenceInput()));
    const identity = requiredIdentity(evidence);
    const driver = new FakeDriver([validSubmission(identity)]);
    const result = expectOk(
      await withApiKey(() =>
        runChangelogAgent({
          evidence,
          versions: [{ packageName: CLI, version: "0.1.0" }],
          driver,
        }),
      ),
    );
    expect(driver.configs).toHaveLength(1);
    const config = driver.configs[0];
    if (config === undefined) throw new Error("missing config");
    expect(config).toEqual(result.session);
    expect(config.model).toBe(CHANGELOG_AGENT_MODEL);
    expect(config.thinking).toBe(CHANGELOG_AGENT_DEFAULT_THINKING);
    expect(config.sessionManager).toBe("in-memory");
    expect(config.persistSession).toBe(false);
    expect(config.settingsManager).toBe("in-memory");
    expect(config.discovery).toEqual({
      skills: false,
      extensions: false,
      templates: false,
      themes: false,
      globalSettings: false,
    });
    expect(config.tools.allowlist).toEqual([SUBMIT_CHANGELOG_TOOL]);
    expect(config.tools.noTools).toBe("all");
    expect(config.tools.forbidden).toEqual(FORBIDDEN_HEADLESS_TOOLS);
    expect(config.apiKeyEnv).toBe(CHANGELOG_AGENT_API_KEY_ENV);
    expect(config.apiKeyPresent).toBe(true);
    const pi = toPiCreateAgentSessionOptions(config);
    expect(pi.model).toBe(CHANGELOG_AGENT_MODEL);
    expect(pi.thinkingLevel).toBe("medium");
    expect(pi.noTools).toBe("all");
    expect(pi.tools).toEqual([SUBMIT_CHANGELOG_TOOL]);
    expect(pi.customTools).toEqual([SUBMIT_CHANGELOG_TOOL]);
    expect(pi.sessionManager).toBe("in-memory");
    expect(pi.settingsManager).toBe("in-memory");
    expect(pi.persistSession).toBe(false);
    expect(pi.loadGlobalSettings).toBe(false);
    expect(pi.resourceLoader).toEqual({
      extensions: [],
      skills: [],
      prompts: [],
      themes: [],
      agentsFiles: [],
    });
  });

  test("isolates the session to the one typed submission tool", async () => {
    const evidence = evidenceValue(assembleEvidence(evidenceInput()));
    const driver = new FakeDriver([
      validSubmission(requiredIdentity(evidence)),
    ]);
    expectOk(
      await withApiKey(() =>
        runChangelogAgent({
          evidence,
          versions: [{ packageName: CLI, version: "0.1.0" }],
          driver,
        }),
      ),
    );
    const tools = driver.configs[0]?.tools;
    if (tools === undefined) throw new Error("missing tools");
    expect(tools.allowlist).toEqual([SUBMIT_CHANGELOG_TOOL]);
    for (const tool of FORBIDDEN_HEADLESS_TOOLS)
      expect(tools.allowlist).not.toContain(tool);
    expect(tools.forbidden).toEqual(FORBIDDEN_HEADLESS_TOOLS);
    expect(tools.noTools).toBe("all");
    const allowlistSerialized = JSON.stringify(tools.allowlist);
    expect(allowlistSerialized).not.toContain("bash");
    expect(allowlistSerialized).not.toContain("read");
    expect(allowlistSerialized).not.toContain("write");
    expect(allowlistSerialized).not.toContain("edit");
  });

  test("renders a valid submission through Task 7 on the first attempt", async () => {
    const evidence = evidenceValue(assembleEvidence(evidenceInput()));
    const identity = requiredIdentity(evidence);
    const submission = validSubmission(identity);
    const driver = new FakeDriver([submission]);
    const result = expectOk(
      await withApiKey(() =>
        runChangelogAgent({
          evidence,
          versions: [{ packageName: CLI, version: "0.1.0" }],
          driver,
        }),
      ),
    );
    expect(result.attempts).toBe(1);
    expect(result.promptVersion).toBe(CHANGELOG_PROMPT_VERSION);
    expect(result.model).toBe(CHANGELOG_AGENT_MODEL);
    expect(result.evidenceDigest).toBe(evidence.digest);
    expect(result.submission).toEqual(submission);
    expect(driver.prompts).toHaveLength(1);
    expect(driver.prompts[0]).toContain(
      `CHANGELOG_PROMPT_VERSION ${CHANGELOG_PROMPT_VERSION}`,
    );
    expect(driver.prompts[0]).toContain("Breaking Changes");
    expect(driver.prompts[0]).toContain("first");
    const expected = renderChangelog(
      {
        packageName: CLI,
        versions: [
          {
            version: "0.1.0",
            sections: [
              {
                name: "Added",
                entries: [
                  {
                    prose:
                      submission.packages[0]?.sections[0]?.entries[0]?.prose ??
                      "",
                    sourceChangesets: [identity],
                    refs: [{ kind: "pull-request", number: 12 }],
                  },
                ],
              },
            ],
          },
        ],
      },
      { pullRequests: [12] },
    );
    if (expected.isErr()) throw new Error(expected.error.type);
    expect(result.changelogs).toEqual([
      { packageName: CLI, markdown: expected.value },
    ]);
  });

  test("retries once after an invalid first submission", async () => {
    const evidence = evidenceValue(assembleEvidence(evidenceInput()));
    const identity = requiredIdentity(evidence);
    const driver = new FakeDriver([
      { packages: [] },
      validSubmission(identity),
    ]);
    const result = expectOk(
      await withApiKey(() =>
        runChangelogAgent({
          evidence,
          versions: [{ packageName: CLI, version: "0.1.0" }],
          driver,
        }),
      ),
    );
    expect(result.attempts).toBe(2);
    expect(driver.prompts).toHaveLength(2);
    expect(driver.prompts[1]).toContain("Previous submission was rejected");
    expect(driver.prompts[1]).toContain("too_small");
    expect(result.submission).toEqual(validSubmission(identity));
  });

  test("blocks after two invalid attempts with no fallback", async () => {
    const evidence = evidenceValue(assembleEvidence(evidenceInput()));
    const driver = new FakeDriver([{ packages: [] }, { packages: [] }]);
    const error = expectErr(
      await withApiKey(() =>
        runChangelogAgent({
          evidence,
          versions: [{ packageName: CLI, version: "0.1.0" }],
          driver,
        }),
      ),
    );
    expect(error.type).toBe("ChangelogAgentBlocked");
    if (error.type !== "ChangelogAgentBlocked") return;
    expect(error.attempts).toBe(2);
    expect(error.issues.some((issue) => issue.code === "too_small")).toBe(true);
    expect(driver.prompts).toHaveLength(2);
    expect(JSON.stringify(error)).not.toContain("fallback");
  });

  test("rejects missing consumed identities", async () => {
    const input = evidenceInput();
    const firstPackage = input.packages[0];
    if (firstPackage === undefined) throw new Error("missing package");
    const evidence = evidenceValue(
      assembleEvidence({
        ...input,
        packages: [
          {
            ...firstPackage,
            changesets: [
              changeset("first", "first body"),
              changeset("second", "second body", DIGEST_B),
            ],
          },
        ],
      }),
    );
    const first = evidence.packages[0]?.changesets.find(
      (item) => item.identity.id === "first",
    )?.identity;
    if (first === undefined) throw new Error("missing first");
    const driver = new FakeDriver([
      validSubmission(first),
      validSubmission(first),
    ]);
    const error = expectErr(
      await withApiKey(() =>
        runChangelogAgent({
          evidence,
          versions: [{ packageName: CLI, version: "0.1.0" }],
          driver,
        }),
      ),
    );
    expect(error.type).toBe("ChangelogAgentBlocked");
    if (error.type !== "ChangelogAgentBlocked") return;
    expect(
      error.issues.some((issue) => issue.code === "missing_identity"),
    ).toBe(true);
  });

  test("rejects duplicate consumed identities", async () => {
    const evidence = evidenceValue(assembleEvidence(evidenceInput()));
    const identity = requiredIdentity(evidence);
    const duplicate: ChangelogSubmission = {
      packages: [
        {
          packageName: CLI,
          sections: [
            {
              name: "Added",
              entries: [validEntry(identity), validEntry(identity)],
            },
          ],
        },
      ],
    };
    const driver = new FakeDriver([duplicate, duplicate]);
    const error = expectErr(
      await withApiKey(() =>
        runChangelogAgent({
          evidence,
          versions: [{ packageName: CLI, version: "0.1.0" }],
          driver,
        }),
      ),
    );
    expect(error.type).toBe("ChangelogAgentBlocked");
    if (error.type !== "ChangelogAgentBlocked") return;
    expect(
      error.issues.some((issue) => issue.code === "duplicate_identity"),
    ).toBe(true);
  });

  test("rejects foreign identities and digest mismatches", async () => {
    const evidence = evidenceValue(assembleEvidence(evidenceInput()));
    const foreign: ChangelogSubmission = {
      packages: [
        {
          packageName: CLI,
          sections: [
            {
              name: "Added",
              entries: [validEntry({ id: "other", sourceDigest: DIGEST_B })],
            },
          ],
        },
      ],
    };
    const mismatch: ChangelogSubmission = {
      packages: [
        {
          packageName: CLI,
          sections: [
            {
              name: "Added",
              entries: [validEntry({ id: "first", sourceDigest: DIGEST_B })],
            },
          ],
        },
      ],
    };
    const driver = new FakeDriver([foreign, mismatch]);
    const error = expectErr(
      await withApiKey(() =>
        runChangelogAgent({
          evidence,
          versions: [{ packageName: CLI, version: "0.1.0" }],
          driver,
        }),
      ),
    );
    expect(error.type).toBe("ChangelogAgentBlocked");
    if (error.type !== "ChangelogAgentBlocked") return;
    expect(
      error.issues.some((issue) => issue.code === "foreign_identity"),
    ).toBe(true);
  });

  test("rejects refs the controller did not supply", async () => {
    const evidence = evidenceValue(assembleEvidence(evidenceInput()));
    const identity = requiredIdentity(evidence);
    const unsupplied: ChangelogSubmission = {
      packages: [
        {
          packageName: CLI,
          sections: [
            {
              name: "Added",
              entries: [
                validEntry(identity, [{ kind: "pull-request", number: 99 }]),
              ],
            },
          ],
        },
      ],
    };
    const driver = new FakeDriver([unsupplied, unsupplied]);
    const error = expectErr(
      await withApiKey(() =>
        runChangelogAgent({
          evidence,
          versions: [{ packageName: CLI, version: "0.1.0" }],
          driver,
        }),
      ),
    );
    expect(error.type).toBe("ChangelogAgentBlocked");
    if (error.type !== "ChangelogAgentBlocked") return;
    expect(error.issues.some((issue) => issue.code === "unsupplied_ref")).toBe(
      true,
    );
  });

  test("bounds prompts and retry errors", async () => {
    const huge = "x".repeat(80 * 1024);
    const input = evidenceInput();
    const firstPackage = input.packages[0];
    if (firstPackage === undefined) throw new Error("missing package");
    const evidence = evidenceValue(
      assembleEvidence({
        ...input,
        packages: [
          {
            ...firstPackage,
            changesets: [changeset("first", huge)],
          },
        ],
      }),
    );
    const identity = requiredIdentity(evidence);
    const overflow = buildChangelogPrompt({
      evidence,
      versions: new Map([[CLI, "0.1.0"]]),
      refs: { pullRequests: [12] },
      required: [{ packageName: CLI, identity }],
    });
    expect(overflow.isErr()).toBe(true);
    if (overflow.isOk()) return;
    expect(overflow.error.type).toBe("ChangelogPromptOverflow");

    const small = evidenceValue(assembleEvidence(evidenceInput()));
    const driver = new FakeDriver([{ packages: [] }, { packages: [] }]);
    const error = expectErr(
      await withApiKey(() =>
        runChangelogAgent({
          evidence: small,
          versions: [{ packageName: CLI, version: "0.1.0" }],
          driver,
        }),
      ),
    );
    expect(error.type).toBe("ChangelogAgentBlocked");
    if (error.type !== "ChangelogAgentBlocked") return;
    expect(error.issues.length).toBeLessThanOrEqual(
      CHANGELOG_SUBMISSION_LIMITS.issues,
    );
    const retry = driver.prompts[1] ?? "";
    expect(new TextEncoder().encode(retry).byteLength).toBeLessThanOrEqual(
      CHANGELOG_AGENT_LIMITS.promptBytes +
        CHANGELOG_AGENT_LIMITS.retryErrorBytes,
    );
    expect(JSON.stringify(error).length).toBeLessThan(4 * 1024);
  });

  test("never returns or logs the provider API key", async () => {
    const evidence = evidenceValue(assembleEvidence(evidenceInput()));
    const identity = requiredIdentity(evidence);
    const leaked: ChangelogSubmission = {
      packages: [
        {
          packageName: CLI,
          sections: [
            {
              name: "Added",
              entries: [
                {
                  prose: `uses ${SECRET} in prose`,
                  sourceChangesets: [identity],
                },
              ],
            },
          ],
        },
      ],
    };
    const driver = new FakeDriver([leaked, validSubmission(identity)]);
    const result = expectOk(
      await withApiKey(() =>
        runChangelogAgent({
          evidence,
          versions: [{ packageName: CLI, version: "0.1.0" }],
          driver,
        }),
      ),
    );
    const visible = `${JSON.stringify(result)}\n${JSON.stringify(driver.configs)}\n${driver.prompts.join("\n")}`;
    expect(visible).not.toContain(SECRET);
    expect(visible).toContain(CHANGELOG_AGENT_API_KEY_ENV);
    const blockedDriver = new FakeDriver([leaked, leaked]);
    const error = expectErr(
      await withApiKey(() =>
        runChangelogAgent({
          evidence,
          versions: [{ packageName: CLI, version: "0.1.0" }],
          driver: blockedDriver,
        }),
      ),
    );
    expect(JSON.stringify(error)).not.toContain(SECRET);
    expect(blockedDriver.prompts.join("\n")).not.toContain(SECRET);
  });

  test("honors a configured thinking level", async () => {
    const evidence = evidenceValue(assembleEvidence(evidenceInput()));
    const driver = new FakeDriver([
      validSubmission(requiredIdentity(evidence)),
    ]);
    const result = expectOk(
      await withApiKey(() =>
        runChangelogAgent({
          evidence,
          versions: [{ packageName: CLI, version: "0.1.0" }],
          driver,
          thinking: "high",
        }),
      ),
    );
    expect(result.thinking).toBe("high");
    expect(driver.configs[0]?.thinking).toBe("high");
  });

  test("rejects an unknown thinking level", async () => {
    const evidence = evidenceValue(assembleEvidence(evidenceInput()));
    const error = expectErr(
      await withApiKey(() =>
        runChangelogAgent({
          evidence,
          versions: [{ packageName: CLI, version: "0.1.0" }],
          driver: new FakeDriver([validSubmission()]),
          thinking: "ludicrous",
        }),
      ),
    );
    expect(error).toEqual({
      type: "InvalidChangelogThinking",
      thinking: "ludicrous",
    });
  });

  test("maps a driver failure without falling back", async () => {
    const evidence = evidenceValue(assembleEvidence(evidenceInput()));
    const driver: HeadlessSessionDriver = {
      open: () =>
        errAsync({ type: "HeadlessSessionFailed", reason: "unavailable" }),
    };
    const error = expectErr(
      await withApiKey(() =>
        runChangelogAgent({
          evidence,
          versions: [{ packageName: CLI, version: "0.1.0" }],
          driver,
        }),
      ),
    );
    expect(error).toEqual({
      type: "HeadlessSessionFailed",
      reason: "unavailable",
    });
  });

  test("keeps the publication module graph isolated from ai/", async () => {
    expect(await moduleGraphReaches(AGENT_MODULE, PUBLISH_MAIN)).toBe(false);
    if (await Bun.file(PUBLISH_MAIN).exists()) {
      const aiDir = resolve(import.meta.dir, "..");
      expect(await moduleGraphReaches(PUBLISH_MAIN, aiDir)).toBe(false);
    }
    const fixture = join("/tmp", `publish-main-leak-${Bun.randomUUIDv7()}.ts`);
    await Bun.write(
      fixture,
      'import { runChangelogAgent } from "../changelog-agent.ts";\n',
    );
    try {
      expect(await moduleGraphReaches(fixture, AGENT_MODULE)).toBe(false);
      const fixtureText = await Bun.file(fixture).text();
      expect(fixtureText.includes("changelog-agent")).toBe(true);
      expect(
        importSpecs(await Bun.file(AGENT_MODULE).text()).some((spec) =>
          spec.includes("publish-main"),
        ),
      ).toBe(false);
    } finally {
      Bun.spawnSync(["rm", "-f", fixture]);
    }
  });
});

const IMPORT_SPEC =
  /(?:import|export)\s+(?:type\s+)?(?:[^'"\n]+from\s+)?["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)|require\(\s*["']([^"']+)["']\s*\)/g;

async function moduleGraphReaches(
  entry: string,
  target: string,
): Promise<boolean> {
  const pending = [resolve(entry)];
  const seen = new Set<string>();
  const wanted = resolve(target);
  while (pending.length > 0 && seen.size < 256) {
    const current = pending.pop();
    if (current === undefined || seen.has(current)) continue;
    seen.add(current);
    if (current === wanted || current.startsWith(`${wanted}/`)) return true;
    if (!(await Bun.file(current).exists())) continue;
    const fileText = await Bun.file(current).text();
    for (const spec of importSpecs(fileText)) {
      const resolved = await resolveImport(current, spec);
      if (resolved !== undefined) pending.push(resolved);
    }
  }
  return [...seen].some(
    (path) => path === wanted || path.startsWith(`${wanted}/`),
  );
}

function importSpecs(source: string): readonly string[] {
  const specs: string[] = [];
  for (const match of source.matchAll(IMPORT_SPEC)) {
    const spec = match[1] ?? match[2] ?? match[3];
    if (spec !== undefined) specs.push(spec);
  }
  return specs;
}

async function resolveImport(
  from: string,
  spec: string,
): Promise<string | undefined> {
  if (
    spec.startsWith("bun:") ||
    spec.startsWith("node:") ||
    spec.startsWith("http:") ||
    spec.startsWith("https:") ||
    !spec.startsWith(".")
  )
    return undefined;
  const base = resolve(dirname(from), spec);
  const candidates = [
    base,
    base.replace(/\.js$/, ".ts"),
    `${base}.ts`,
    `${base}.js`,
    join(base, "index.ts"),
  ];
  for (const candidate of candidates)
    if (await Bun.file(candidate).exists()) return candidate;
  return undefined;
}
