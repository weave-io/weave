import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { errAsync, okAsync, type Result, type ResultAsync } from "neverthrow";
import type {
  HeadlessSession,
  HeadlessSessionDriver,
  IsolatedHeadlessSessionConfig,
} from "../../ai/headless-session.js";
import {
  CHANGELOG_AGENT_API_KEY_ENV,
  CHANGELOG_AGENT_DEFAULT_THINKING,
  CHANGELOG_AGENT_MODEL,
  DOCS_AUDIT_FORBIDDEN_TOOLS,
  DOCS_AUDIT_LIMITS,
  DOCS_AUDIT_PROMPT_VERSION,
  DOCS_AUDIT_READONLY_TOOLS,
  type DocsAuditAgentError,
  type DocsAuditAgentResult,
  type DocsAuditSubmission,
  DocsAuditWorkspace,
  runDocsAuditAgent,
  SUBMIT_DOCS_AUDIT_TOOL,
  toPiCreateAgentSessionOptions,
} from "../agent.js";
import { docsAuditBytesDigest } from "../deterministic.js";
import { DOCS_AUDIT_POLICY_VERSION } from "../policy.js";

const SHA = "a".repeat(40);
const SECRET = "sk-live-docs-audit-agent-test-key";
const EXCERPT = "Public packages and adapters.";
const README = `# Weave\n\n${EXCERPT}\n`;
const PUBLISH_MAIN = resolve(import.meta.dir, "../../publish-main.ts");
const AGENT_MODULE = resolve(import.meta.dir, "../agent.ts");

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
    this.toolName = options.toolName ?? SUBMIT_DOCS_AUDIT_TOOL;
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
  run: () => ResultAsync<DocsAuditAgentResult, DocsAuditAgentError>,
): Promise<Result<DocsAuditAgentResult, DocsAuditAgentError>> {
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
  result: Result<DocsAuditAgentResult, DocsAuditAgentError>,
): DocsAuditAgentResult {
  if (result.isErr())
    throw new Error(`unexpected ${JSON.stringify(result.error)}`);
  return result.value;
}

function expectErr(
  result: Result<DocsAuditAgentResult, DocsAuditAgentError>,
): DocsAuditAgentError {
  if (result.isOk())
    throw new Error(`unexpected success ${JSON.stringify(result.value)}`);
  return result.error;
}

function blockingFinding(
  overrides: Partial<DocsAuditSubmission["findings"][number]> = {},
): DocsAuditSubmission["findings"][number] {
  return {
    severity: "block",
    kind: "factual-contradiction",
    evidence: {
      path: "README.md",
      excerpt: EXCERPT,
      excerptDigest: docsAuditBytesDigest(EXCERPT),
    },
    claim: "README contradicts shipped adapter availability.",
    ...overrides,
  };
}

function validSubmission(
  findings: DocsAuditSubmission["findings"] = [blockingFinding()],
  patches?: DocsAuditSubmission["patches"],
): DocsAuditSubmission {
  return patches === undefined ? { findings } : { findings, patches };
}

async function withRoot<T>(
  run: (root: string) => Promise<T>,
  extra: Record<string, string> = {},
): Promise<T> {
  const root = join(tmpdir(), `docs-audit-agent-${Bun.randomUUIDv7()}`);
  await Bun.write(join(root, "README.md"), README);
  await Bun.write(join(root, "docs/guide.md"), "# Guide\n");
  for (const [path, text] of Object.entries(extra))
    await Bun.write(join(root, path), text);
  try {
    return await run(root);
  } finally {
    Bun.spawnSync(["rm", "-rf", root]);
  }
}

describe("docs-audit agent", () => {
  test("uses the isolated exact-model medium session", async () => {
    await withRoot(async (root) => {
      const driver = new FakeDriver([validSubmission()]);
      const result = expectOk(
        await withApiKey(() =>
          runDocsAuditAgent({
            contentRoot: root,
            auditedSha: SHA,
            driver,
          }),
        ),
      );
      expect(driver.configs).toHaveLength(1);
      const config = driver.configs[0];
      if (config === undefined) throw new Error("missing config");
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
      expect(config.tools.allowlist).toEqual([
        ...DOCS_AUDIT_READONLY_TOOLS,
        SUBMIT_DOCS_AUDIT_TOOL,
      ]);
      expect(config.tools.noTools).toBe("all");
      expect(config.tools.forbidden).toEqual([...DOCS_AUDIT_FORBIDDEN_TOOLS]);
      expect(config.contentRoot).toBeDefined();
      expect(result.session.contentRoot).toBe(config.contentRoot);
      const serialized = JSON.stringify(config.tools.allowlist);
      expect(serialized).not.toContain("bash");
      expect(serialized).not.toContain("edit");
      expect(serialized).not.toContain("write");
      const pi = toPiCreateAgentSessionOptions(config);
      expect(pi.noTools).toBe("all");
      expect(pi.persistSession).toBe(false);
      expect(pi.loadGlobalSettings).toBe(false);
      expect(pi.resourceLoader).toEqual({
        extensions: [],
        skills: [],
        prompts: [],
        themes: [],
        agentsFiles: [],
      });
      expect(result.promptVersion).toBe(DOCS_AUDIT_PROMPT_VERSION);
      expect(result.policyVersion).toBe(DOCS_AUDIT_POLICY_VERSION);
      expect(driver.prompts[0]).toContain("submit_docs_audit");
    });
  });

  test("blocks factual contradiction and warns on style", async () => {
    await withRoot(async (root) => {
      const style = blockingFinding({
        severity: "warn",
        kind: "style",
        claim: "Tighten the heading.",
      });
      const driver = new FakeDriver([
        validSubmission([blockingFinding(), style]),
      ]);
      const result = expectOk(
        await withApiKey(() =>
          runDocsAuditAgent({
            contentRoot: root,
            auditedSha: SHA,
            driver,
          }),
        ),
      );
      expect(result.findings).toHaveLength(2);
      expect(result.findings[0]?.severity).toBe("block");
      expect(result.findings[1]?.severity).toBe("warn");
    });
  });

  test("rejects style submitted as block", async () => {
    await withRoot(async (root) => {
      const driver = new FakeDriver([
        validSubmission([
          blockingFinding({ severity: "block", kind: "style" }),
        ]),
        validSubmission([
          blockingFinding({ severity: "block", kind: "style" }),
        ]),
      ]);
      const error = expectErr(
        await withApiKey(() =>
          runDocsAuditAgent({
            contentRoot: root,
            auditedSha: SHA,
            driver,
          }),
        ),
      );
      expect(error.type).toBe("DocsAuditAgentBlocked");
      if (error.type !== "DocsAuditAgentBlocked") return;
      expect(
        error.issues.some((issue) => issue.code === "style_must_not_block"),
      ).toBe(true);
    });
  });

  test("downgrades unresolved evidence to an error, not a pass", async () => {
    await withRoot(async (root) => {
      const driver = new FakeDriver([
        validSubmission([
          blockingFinding({
            evidence: {
              path: "README.md",
              excerpt: EXCERPT,
              excerptDigest: docsAuditBytesDigest("wrong"),
            },
          }),
        ]),
        validSubmission([
          blockingFinding({
            evidence: {
              path: "missing.md",
              excerpt: EXCERPT,
              excerptDigest: docsAuditBytesDigest(EXCERPT),
            },
          }),
        ]),
      ]);
      const error = expectErr(
        await withApiKey(() =>
          runDocsAuditAgent({
            contentRoot: root,
            auditedSha: SHA,
            driver,
          }),
        ),
      );
      expect(error.type).toBe("DocsAuditAgentBlocked");
      if (error.type !== "DocsAuditAgentBlocked") return;
      expect(
        error.issues.some((issue) =>
          issue.code.startsWith("unresolved_evidence"),
        ),
      ).toBe(true);
    });
  });

  test("rejects a workflow patch proposal", async () => {
    await withRoot(async (root) => {
      const driver = new FakeDriver([
        validSubmission(
          [blockingFinding()],
          [
            {
              path: ".github/workflows/ci.yml",
              unifiedDiff:
                "--- a/.github/workflows/ci.yml\n+++ b/.github/workflows/ci.yml\n@@ -1 +1 @@\n-name: ci\n+name: pwn\n",
            },
          ],
        ),
        validSubmission(
          [blockingFinding()],
          [
            {
              path: ".github/workflows/ci.yml",
              unifiedDiff:
                "--- a/.github/workflows/ci.yml\n+++ b/.github/workflows/ci.yml\n@@ -1 +1 @@\n-name: ci\n+name: pwn\n",
            },
          ],
        ),
      ]);
      const error = expectErr(
        await withApiKey(() =>
          runDocsAuditAgent({
            contentRoot: root,
            auditedSha: SHA,
            driver,
          }),
        ),
      );
      expect(error.type).toBe("DocsAuditAgentBlocked");
      if (error.type !== "DocsAuditAgentBlocked") return;
      expect(
        error.issues.some((issue) => issue.code === "patch_path_rejected"),
      ).toBe(true);
    });
  });

  test("never returns the provider API key", async () => {
    await withRoot(async (root) => {
      const leaked = validSubmission([
        blockingFinding({ claim: `uses ${SECRET} in the claim` }),
      ]);
      const driver = new FakeDriver([leaked, validSubmission()]);
      const result = expectOk(
        await withApiKey(() =>
          runDocsAuditAgent({
            contentRoot: root,
            auditedSha: SHA,
            driver,
          }),
        ),
      );
      const visible = `${JSON.stringify(result)}\n${JSON.stringify(driver.configs)}\n${driver.prompts.join("\n")}`;
      expect(visible).not.toContain(SECRET);
      expect(visible).toContain(CHANGELOG_AGENT_API_KEY_ENV);
    });
  });

  test("bounds invalid issue lists", async () => {
    await withRoot(async (root) => {
      const oversized = {
        findings: Array.from({ length: DOCS_AUDIT_LIMITS.findings + 8 }, () =>
          blockingFinding({ kind: "style", severity: "block" }),
        ),
      };
      const driver = new FakeDriver([oversized, oversized]);
      const error = expectErr(
        await withApiKey(() =>
          runDocsAuditAgent({
            contentRoot: root,
            auditedSha: SHA,
            driver,
          }),
        ),
      );
      expect(error.type).toBe("DocsAuditAgentBlocked");
      if (error.type !== "DocsAuditAgentBlocked") return;
      expect(error.issues.length).toBeLessThanOrEqual(DOCS_AUDIT_LIMITS.issues);
    });
  });

  test("scrubs the provider key from driver failures", async () => {
    await withRoot(async (root) => {
      const driver: HeadlessSessionDriver = {
        open: () =>
          errAsync({
            type: "HeadlessSessionFailed",
            reason: `unavailable ${SECRET}`,
          }),
      };
      const error = expectErr(
        await withApiKey(() =>
          runDocsAuditAgent({
            contentRoot: root,
            auditedSha: SHA,
            driver,
          }),
        ),
      );
      expect(error).toEqual({
        type: "HeadlessSessionFailed",
        reason: "unavailable [redacted]",
      });
    });
  });

  test("keeps publication isolated from docs-audit", async () => {
    expect(await moduleGraphReaches(AGENT_MODULE, PUBLISH_MAIN)).toBe(false);
    if (await Bun.file(PUBLISH_MAIN).exists()) {
      const docsDir = resolve(import.meta.dir, "..");
      expect(await moduleGraphReaches(PUBLISH_MAIN, docsDir)).toBe(false);
    }
  });
});

describe("docs-audit content-root confinement", () => {
  test("rejects traversal", async () => {
    await withRoot(async (root) => {
      const workspace = await openWorkspace(root);
      const escaped = await workspace.read("../secret.md");
      expect(escaped.isErr()).toBe(true);
      if (escaped.isOk()) return;
      expect(escaped.error.type).toBe("DocsAuditPathUnsafe");
    });
  });

  test("rejects a symlink that leaves the content root", async () => {
    await withRoot(async (root) => {
      const outside = join(tmpdir(), `docs-audit-secret-${Bun.randomUUIDv7()}`);
      await Bun.write(outside, "leaked-secret\n");
      try {
        Bun.spawnSync(["ln", "-s", outside, join(root, "linked.md")]);
        const workspace = await openWorkspace(root);
        const result = await workspace.read("linked.md");
        expect(result.isErr()).toBe(true);
        if (result.isOk()) return;
        expect(result.error.type).toBe("DocsAuditPathEscapesContentRoot");
        const listed = await workspace.find("*.md");
        if (listed.isErr()) throw new Error(listed.error.type);
        expect(listed.value).not.toContain("linked.md");
      } finally {
        Bun.spawnSync(["rm", "-f", outside]);
      }
    });
  });

  test("read, grep, find, and ls stay inside the root", async () => {
    await withRoot(async (root) => {
      const workspace = await openWorkspace(root);
      const read = await workspace.read("README.md");
      if (read.isErr()) throw new Error(read.error.type);
      expect(read.value.text).toContain(EXCERPT);
      const found = await workspace.find("**/*.md");
      if (found.isErr()) throw new Error(found.error.type);
      expect(found.value).toContain("README.md");
      expect(found.value.every((path) => !path.includes(".."))).toBe(true);
      const listed = await workspace.ls("docs");
      if (listed.isErr()) throw new Error(listed.error.type);
      expect(listed.value).toContain("guide.md");
      const matches = await workspace.grep({ pattern: "Guide" });
      if (matches.isErr()) throw new Error(matches.error.type);
      expect(
        matches.value.some((match) => match.path === "docs/guide.md"),
      ).toBe(true);
    });
  });
});

async function openWorkspace(root: string): Promise<DocsAuditWorkspace> {
  const opened = await DocsAuditWorkspace.open(root);
  if (opened.isErr()) throw new Error(opened.error.type);
  return opened.value;
}

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
