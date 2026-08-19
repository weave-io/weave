import { describe, expect, test } from "bun:test";
import { errAsync, okAsync } from "neverthrow";
import type { HeadlessSessionDriver } from "../../ai/headless-session.js";
import type { DocsAuditAgentResult } from "../agent.js";
import { docsAuditDigest } from "../deterministic.js";
import {
  classifyPublicImpact,
  createGitHubFollowUpApi,
  DOCS_AUDIT_FOLLOWUP_CHECK_NAME,
  FOLLOWUP_CONTROLLER_REF,
  type FollowUpApi,
  type FollowUpAuditResult,
  type FollowUpMainInput,
  type FollowUpWriter,
  inspectForkArchive,
  materializeForkArchive,
  parseFollowUpPrNumber,
  parsePullRequestMetadata,
  postFollowUpResult,
  runFollowUpMain,
  validateFollowUpControllerContext,
} from "../followup-main.js";
import type { DocsAuditFinding } from "../policy.js";

const BASE_SHA = "a".repeat(40);
const HEAD_SHA = "b".repeat(40);
const AI_DIGEST = `sha256:${"d".repeat(64)}`;

class MemoryWriter implements FollowUpWriter {
  readonly files = new Map<string, Uint8Array>();
  readonly calls: string[] = [];

  writeFile(_root: string, path: string, contents: Uint8Array) {
    this.calls.push(path);
    this.files.set(path, contents);
    return okAsync(undefined);
  }
}

function metadata(): Record<string, unknown> {
  return {
    number: 42,
    title: "untrusted title is ignored",
    base: {
      ref: "main",
      sha: BASE_SHA,
      repo: { full_name: "weave-io/weave", private: false },
    },
    head: {
      sha: HEAD_SHA,
      ref: "docs",
      repo: {
        full_name: "contributor/fork",
        clone_url: "https://evil.invalid",
      },
    },
  };
}

function fakeAgentResult(
  findings: readonly DocsAuditFinding[] = [],
): DocsAuditAgentResult {
  return {
    promptVersion: 1,
    policyVersion: 1,
    model: "opencode-go/gpt-5.6-luna",
    thinking: "medium",
    attempts: 1,
    auditedSha: HEAD_SHA,
    submission: { findings: [...findings], patches: [] },
    findings,
    patches: [],
    digest: AI_DIGEST,
    session: {} as DocsAuditAgentResult["session"],
  };
}

function fakeApi(
  archive: Uint8Array,
  calls: { check?: unknown; comment?: unknown },
): FollowUpApi {
  return {
    getPullRequest: () =>
      okAsync(parsePullRequestMetadata(metadata())._unsafeUnwrap()),
    listPullRequestFiles: () =>
      okAsync(["packages/cli/src/main.ts", "scripts/evil.sh"]),
    downloadHeadArchive: (sha) =>
      sha === HEAD_SHA
        ? okAsync(archive)
        : errAsync({
            type: "FollowUpApiFailed",
            operation: "archive",
            message: "wrong head",
          }),
    createCheckRun: (input) => {
      calls.check = input;
      return okAsync(undefined);
    },
    createComment: (_pr, body) => {
      calls.comment = body;
      return okAsync(undefined);
    },
  };
}

function tarArchive(
  entries: readonly { path: string; contents?: string; type?: string }[],
): Uint8Array {
  const blocks: Uint8Array[] = [];
  for (const entry of entries) {
    const contents = new TextEncoder().encode(entry.contents ?? "");
    const type = entry.type ?? "0";
    const header = new Uint8Array(512);
    writeAscii(header, 0, entry.path, 100);
    writeAscii(header, 100, "0000644\0", 8);
    writeAscii(header, 108, "0000000\0", 8);
    writeAscii(header, 116, "0000000\0", 8);
    writeAscii(
      header,
      124,
      `${contents.byteLength.toString(8).padStart(11, "0")}\0`,
      12,
    );
    writeAscii(header, 136, "00000000000\0", 12);
    writeAscii(header, 148, "        ", 8);
    writeAscii(header, 156, type, 1);
    writeAscii(header, 257, "ustar\0", 6);
    let checksum = 0;
    for (const byte of header) checksum += byte;
    writeAscii(header, 148, `${checksum.toString(8).padStart(6, "0")}\0 `, 8);
    blocks.push(header);
    if (contents.byteLength > 0) {
      blocks.push(contents);
      const padding = (512 - (contents.byteLength % 512)) % 512;
      if (padding > 0) blocks.push(new Uint8Array(padding));
    }
  }
  blocks.push(new Uint8Array(1024));
  const total = blocks.reduce((sum, block) => sum + block.byteLength, 0);
  const raw = new Uint8Array(total);
  let offset = 0;
  for (const block of blocks) {
    raw.set(block, offset);
    offset += block.byteLength;
  }
  return Bun.gzipSync(raw);
}

function writeAscii(
  target: Uint8Array,
  offset: number,
  value: string,
  width: number,
): void {
  target.set(new TextEncoder().encode(value).subarray(0, width), offset);
}

function archive(): Uint8Array {
  return tarArchive([
    { path: "fork-root/", type: "5" },
    { path: "fork-root/README.md", contents: "# Fork\n" },
    {
      path: "fork-root/package.json",
      contents: '{"scripts":{"postinstall":"evil"}}',
    },
    { path: "fork-root/scripts/evil.sh", contents: "#!/bin/sh\necho evil\n" },
  ]);
}

describe("docs-audit trusted fork follow-up", () => {
  test("bounds the workflow-dispatch pull request number", () => {
    expect(parseFollowUpPrNumber(1)._unsafeUnwrap()).toBe(1);
    expect(parseFollowUpPrNumber(1_000_001).isErr()).toBe(true);
    expect(parseFollowUpPrNumber(1.5).isErr()).toBe(true);
    expect(parseFollowUpPrNumber("42").isErr()).toBe(true);
  });

  test("requires a disjoint controller main root", () => {
    expect(
      validateFollowUpControllerContext({
        controllerRef: "refs/heads/feature",
        controllerRoot: "/tmp/controller",
        dataRoot: "/tmp/data",
      })._unsafeUnwrapErr().type,
    ).toBe("FollowUpControllerNotMain");
    expect(
      validateFollowUpControllerContext({
        controllerRef: FOLLOWUP_CONTROLLER_REF,
        controllerRoot: "/tmp/controller",
        dataRoot: "/tmp/controller/fork",
      })._unsafeUnwrapErr().type,
    ).toBe("FollowUpControllerRootInvalid");
  });

  test("accepts normal GitHub metadata while projecting away untrusted fields", () => {
    const result = parsePullRequestMetadata(metadata());
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual({
      number: 42,
      base: {
        ref: "main",
        sha: BASE_SHA,
        repo: { full_name: "weave-io/weave" },
      },
      head: { sha: HEAD_SHA, repo: { full_name: "contributor/fork" } },
    });
  });

  test("paginates bounded GitHub file listings and contains fetch failures", async () => {
    const requests: string[] = [];
    const fetcher = (async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      requests.push(url);
      const page = Number(new URL(url).searchParams.get("page"));
      const files =
        page === 1
          ? Array.from({ length: 100 }, (_, index) => ({
              filename: `docs/page-${index}.md`,
            }))
          : [{ filename: "README.md" }];
      return new Response(JSON.stringify(files), { status: 200 });
    }) as unknown as typeof fetch;
    const api = createGitHubFollowUpApi("token", fetcher);
    const listed = await api.listPullRequestFiles(42);
    expect(listed.isOk()).toBe(true);
    expect(listed._unsafeUnwrap()).toHaveLength(101);
    expect(requests).toHaveLength(2);
    expect(requests[0]).toContain("per_page=100&page=1");
    expect(requests[1]).toContain("per_page=100&page=2");

    const failingApi = createGitHubFollowUpApi("token", (() => {
      throw new Error("network failure");
    }) as unknown as typeof fetch);
    const failed = await failingApi.getPullRequest(42);
    expect(failed.isErr()).toBe(true);
    expect(failed._unsafeUnwrapErr().type).toBe("FollowUpApiFailed");
  });

  test("rejects traversal, links, and archive bombs before materialization", () => {
    const traversal = tarArchive([{ path: "../outside.txt", contents: "x" }]);
    expect(inspectForkArchive(traversal)._unsafeUnwrapErr().type).toBe(
      "FollowUpArchiveUnsafePath",
    );
    const symlink = tarArchive([{ path: "fork-root/link", type: "2" }]);
    expect(inspectForkArchive(symlink)._unsafeUnwrapErr().type).toBe(
      "FollowUpArchiveUnsupportedEntry",
    );
    const writer = new MemoryWriter();
    expect(
      materializeForkArchive(traversal, "/tmp/data", writer).then((r) =>
        r.isErr(),
      ),
    ).resolves.toBe(true);
  });

  test("fetches fork bytes as data and never executes scripts or installs", async () => {
    const writer = new MemoryWriter();
    const seenRoots: string[] = [];
    const calls: { check?: unknown; comment?: unknown } = {};
    const api = fakeApi(archive(), calls);
    const input: FollowUpMainInput = {
      schemaVersion: 1,
      phase: "audit",
      prNumber: 42,
      controllerRef: FOLLOWUP_CONTROLLER_REF,
      controllerRoot: "/tmp/controller",
      dataRoot: "/tmp/quarantine",
    };
    const result = await runFollowUpMain(input, {
      api,
      writer,
      readControllerSha: () => okAsync(BASE_SHA),
      deterministic: (root) => {
        seenRoots.push(root);
        return okAsync({
          schemaVersion: 1,
          passed: true,
          issues: [],
          digest: `sha256:${"c".repeat(64)}`,
        });
      },
      agent: (agentInput) => {
        seenRoots.push(agentInput.contentRoot);
        return okAsync(fakeAgentResult());
      },
      driver: {} as HeadlessSessionDriver,
    });
    expect(result.isOk()).toBe(true);
    const value = result._unsafeUnwrap();
    expect(value.publicImpact).toBe("public-impact");
    expect(value.ai.status).toBe("submitted");
    expect(seenRoots).toEqual(["/tmp/quarantine", "/tmp/quarantine"]);
    expect(writer.calls).toEqual([
      "README.md",
      "package.json",
      "scripts/evil.sh",
    ]);
    expect(writer.calls.some((path) => path.includes("outside"))).toBe(false);
    expect(JSON.stringify(value)).not.toContain("postinstall");
  });

  test("posts a result whose check and comment carry the exact digest", async () => {
    const calls: { check?: unknown; comment?: unknown } = {};
    const resultPayload = {
      schemaVersion: 1 as const,
      kind: "follow-up" as const,
      prNumber: 42,
      controllerRef: FOLLOWUP_CONTROLLER_REF,
      controllerSha: BASE_SHA,
      baseSha: BASE_SHA,
      auditedSha: HEAD_SHA,
      headRepo: "contributor/fork",
      headSha: HEAD_SHA,
      archiveDigest: `sha256:${"a".repeat(64)}`,
      publicImpact: "no-impact" as const,
      deterministic: {
        schemaVersion: 1 as const,
        kind: "deterministic" as const,
        auditedSha: HEAD_SHA,
        passed: true,
        digest: `sha256:${"c".repeat(64)}`,
        issues: [],
      },
      ai: {
        status: "not-required" as const,
        auditedSha: HEAD_SHA,
        findings: [],
        patches: [],
      },
      followUp: { auditedSha: HEAD_SHA, status: "passed" as const },
    };
    const result: FollowUpAuditResult = {
      ...resultPayload,
      resultDigest: docsAuditDigest(resultPayload),
    };
    const resultDigest = result.resultDigest;
    const published = await postFollowUpResult(
      result,
      fakeApi(new Uint8Array(), calls),
    );
    expect(published.isOk()).toBe(true);
    expect(JSON.stringify(calls.check)).toContain(
      DOCS_AUDIT_FOLLOWUP_CHECK_NAME,
    );
    expect(JSON.stringify(calls.check)).toContain(resultDigest);
    expect(String(calls.comment)).toContain(resultDigest);

    const tampered = await postFollowUpResult(
      { ...result, resultDigest: `sha256:${"e".repeat(64)}` },
      fakeApi(new Uint8Array(), {}),
    );
    expect(tampered.isErr()).toBe(true);
  });

  test("classifies only public-impact paths", () => {
    expect(classifyPublicImpact(["packages/adapters/pi/src/index.ts"])).toBe(
      "public-impact",
    );
    expect(classifyPublicImpact(["scripts/release/secret.ts"])).toBe(
      "no-impact",
    );
  });
});
