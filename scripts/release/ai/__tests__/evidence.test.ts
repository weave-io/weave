import { describe, expect, test } from "bun:test";
import type { PublicPackageName } from "../../constants.js";
import {
  assembleEvidence,
  DEFAULT_EVIDENCE_BUDGETS,
  digestEvidence,
  type EvidenceAssemblyInput,
  type EvidenceBudgets,
  type EvidenceChangeset,
  type EvidenceDiff,
  type EvidencePlanContext,
  type EvidencePullRequest,
  evidenceItemBytes,
  type PackageEvidenceInput,
} from "../evidence.js";

const CLI = "@weaveio/weave-cli" as const;
const OPENCODE = "@weaveio/weave-adapter-opencode" as const;
const CLAUDE = "@weaveio/weave-adapter-claude-code" as const;
const PI = "@weaveio/weave-adapter-pi" as const;
const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);

function changeset(
  id: string,
  text: string,
  sourceDigest = DIGEST_A,
): EvidenceChangeset {
  return { identity: { id, sourceDigest }, text };
}

function pullRequest(number: number, title: string): EvidencePullRequest {
  return { number, title };
}

type MutableEvidenceInput = {
  selectedPackages: PublicPackageName[];
  packages: PackageEvidenceInput[];
  budgets: EvidenceBudgets;
  plan?: EvidencePlanContext;
};

function baseInput(packageName: PublicPackageName = CLI): MutableEvidenceInput {
  return {
    selectedPackages: [packageName],
    packages: [
      {
        packageName,
        changesets: [changeset("first", "Add the bounded evidence assembler.")],
        pullRequests: [pullRequest(12, "Add bounded evidence")],
        commits: [{ subject: "add bounded evidence" }],
        diffs: [
          {
            path: `${packageDirectory(packageName)}/src/index.ts`,
            patch: "+export const evidence = true;",
          },
        ],
      },
    ],
    budgets: { ...DEFAULT_EVIDENCE_BUDGETS },
  };
}

function packageDirectory(packageName: PublicPackageName): string {
  switch (packageName) {
    case CLI:
      return "packages/cli";
    case OPENCODE:
      return "packages/adapters/opencode";
    case CLAUDE:
      return "packages/adapters/claude-code";
    case PI:
      return "packages/adapters/pi";
  }
}

function evidenceValue(result: ReturnType<typeof assembleEvidence>) {
  if (result.isErr()) throw new Error(`unexpected error: ${result.error.type}`);
  return result.value;
}

function packageAt(
  input: { packages: readonly PackageEvidenceInput[] },
  index = 0,
): PackageEvidenceInput {
  const entry = input.packages[index];
  if (entry === undefined) throw new Error(`missing package at ${index}`);
  return entry;
}

describe("bounded AI evidence", () => {
  test("collects required facts and package plus bundled-private diffs", () => {
    const input = baseInput();
    input.packages[0] = {
      ...packageAt(input),
      diffs: [
        ...packageAt(input).diffs,
        {
          path: "packages/core/src/parser.ts",
          patch: "+export const parser = true;",
        },
        {
          path: "packages/adapters/opencode/src/plugin.ts",
          patch: "+export const unrelated = true;",
        },
      ],
    };

    const result = assembleEvidence(input);
    const evidence = evidenceValue(result);
    const packageEvidence = evidence.packages[0];

    expect(packageEvidence?.changesets).toEqual([
      changeset("first", "Add the bounded evidence assembler."),
    ]);
    expect(packageEvidence?.pullRequests).toEqual([
      pullRequest(12, "Add bounded evidence"),
    ]);
    expect(packageEvidence?.commits).toEqual([
      { subject: "add bounded evidence" },
    ]);
    expect(packageEvidence?.diffs.map((diff) => diff.path)).toEqual([
      "packages/cli/src/index.ts",
      "packages/core/src/parser.ts",
    ]);
    expect(evidence.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  test("filters lock, generated, binary, env, aliases, and traversal paths", () => {
    const input = baseInput();
    const diffs: EvidenceDiff[] = [
      {
        path: "packages/cli/src/keep.ts",
        patch: "+const keep = true;",
      },
      { path: "bun.lock", patch: "+lock" },
      { path: "./packages/cli/src/dot.ts", patch: "+dot" },
      { path: "packages/cli/src/../escape.ts", patch: "+escape" },
      {
        path: "packages/cli/../core/src/escape.ts",
        patch: "+escape",
      },
      { path: "packages/cli//src/double.ts", patch: "+double" },
      { path: "packages/cli/src\\windows.ts", patch: "+windows" },
      { path: "packages/cli/dist/index.js", patch: "+dist" },
      { path: "packages/cli/dist-types/index.d.ts", patch: "+declaration" },
      { path: "packages/cli/src/generated.ts", patch: "+generated" },
      { path: "packages/cli/src/types.d.ts", patch: "+declaration" },
      { path: "packages/cli/.env.local", patch: "+secret" },
      { path: "packages/cli/src/image.png", patch: "\u0089PNG\u0000" },
      { path: "packages/cli/src/archive.tgz", patch: "archive" },
    ];
    input.packages[0] = { ...packageAt(input), diffs };

    const evidence = evidenceValue(assembleEvidence(input));
    expect(evidence.packages[0]?.diffs).toEqual([
      { path: "packages/cli/src/keep.ts", patch: "+const keep = true;" },
    ]);
    expect(JSON.stringify(evidence)).not.toContain("declaration");
    expect(JSON.stringify(evidence)).not.toContain("escape");
  });

  test("filters secret-shaped metadata and diffs without exposing the secret", () => {
    const secret = "ghp_1234567890abcdef";
    const input = baseInput();
    input.packages[0] = {
      ...packageAt(input),
      pullRequests: [
        pullRequest(1, `fix API_KEY=${secret}`),
        pullRequest(2, "safe title"),
      ],
      commits: [
        { subject: `repair token=${secret}` },
        { subject: "safe subject" },
      ],
      diffs: [
        { path: "packages/cli/src/secret.ts", patch: `+TOKEN=${secret}` },
        { path: "packages/cli/src/safe.ts", patch: "+const safe = true;" },
      ],
    };

    const evidence = evidenceValue(assembleEvidence(input));
    const serialized = JSON.stringify(evidence);
    expect(serialized).not.toContain(secret);
    expect(evidence.packages[0]?.pullRequests).toEqual([
      pullRequest(2, "safe title"),
    ]);
    expect(evidence.packages[0]?.commits).toEqual([
      { subject: "safe subject" },
    ]);
    expect(evidence.packages[0]?.diffs).toEqual([
      { path: "packages/cli/src/safe.ts", patch: "+const safe = true;" },
    ]);
  });

  test("confines private-source diffs to the package's bundled-source map", () => {
    const input = baseInput(CLAUDE);
    input.packages[0] = {
      ...packageAt(input),
      diffs: [
        {
          path: "packages/adapters/claude-code/src/index.ts",
          patch: "+const publicChange = true;",
        },
        {
          path: "packages/core/src/index.ts",
          patch: "+const coreChange = true;",
        },
        {
          path: "packages/engine/src/index.ts",
          patch: "+const engineChange = true;",
        },
        {
          path: "packages/config/src/index.ts",
          patch: "+const configChange = true;",
        },
        {
          path: "packages/adapters/pi/src/index.ts",
          patch: "+const unrelated = true;",
        },
      ],
    };

    const evidence = evidenceValue(assembleEvidence(input));
    expect(evidence.packages[0]?.diffs.map((diff) => diff.path)).toEqual([
      "packages/adapters/claude-code/src/index.ts",
      "packages/core/src/index.ts",
      "packages/engine/src/index.ts",
    ]);
  });

  test("orders equivalent inputs deterministically and produces one digest", () => {
    const first = baseInput();
    first.selectedPackages = [PI, CLI];
    first.packages = [
      {
        packageName: PI,
        changesets: [changeset("zeta", "Z change", DIGEST_B)],
        pullRequests: [pullRequest(30, "Z"), pullRequest(10, "A")],
        commits: [{ subject: "z commit" }, { subject: "a commit" }],
        diffs: [
          { path: "packages/adapters/pi/src/z.ts", patch: "+z" },
          { path: "packages/core/src/a.ts", patch: "+a" },
        ],
      },
      {
        packageName: CLI,
        changesets: [changeset("alpha", "A change")],
        pullRequests: [pullRequest(20, "C")],
        commits: [{ subject: "c commit" }],
        diffs: [{ path: "packages/cli/src/c.ts", patch: "+c" }],
      },
    ];
    const second: EvidenceAssemblyInput = {
      ...first,
      selectedPackages: [CLI, PI],
      packages: [
        {
          ...packageAt(first, 1),
          changesets: [...packageAt(first, 1).changesets].reverse(),
        },
        {
          ...packageAt(first),
          pullRequests: [...packageAt(first).pullRequests].reverse(),
          commits: [...packageAt(first).commits].reverse(),
          diffs: [...packageAt(first).diffs].reverse(),
        },
      ],
    };

    const firstEvidence = evidenceValue(assembleEvidence(first));
    const secondEvidence = evidenceValue(assembleEvidence(second));
    expect(secondEvidence).toEqual(firstEvidence);
    expect(digestEvidence(firstEvidence)).toBe(firstEvidence.digest);
  });

  test("binds optional Task 8 plan selection and consumed identities", () => {
    const input = baseInput();
    const sourceChangeset = packageAt(input).changesets[0];
    if (sourceChangeset === undefined) throw new Error("missing changeset");
    input.plan = {
      closure: { selected: [CLI] },
      consumed: [sourceChangeset.identity],
    };

    const evidence = evidenceValue(assembleEvidence(input));
    expect(evidence.packages[0]?.packageName).toBe(CLI);

    input.plan = {
      closure: { selected: [CLI] },
      consumed: [{ id: "other", sourceDigest: DIGEST_B }],
    };
    const mismatch = assembleEvidence(input);
    expect(mismatch.isErr()).toBe(true);
    if (mismatch.isOk()) return;
    expect(mismatch.error).toEqual({
      type: "EvidencePlanMismatch",
      reason: "changesets",
    });
  });

  test("records structured truncation for advisory sections", () => {
    const input = baseInput();
    const firstPullRequest = pullRequest(1, "first");
    const secondPullRequest = pullRequest(2, "second");
    input.packages[0] = {
      ...packageAt(input),
      pullRequests: [firstPullRequest, secondPullRequest],
    };
    input.budgets = {
      ...input.budgets,
      pullRequests: evidenceItemBytes(firstPullRequest),
    };

    const evidence = evidenceValue(assembleEvidence(input));
    expect(evidence.packages[0]?.pullRequests).toEqual([firstPullRequest]);
    expect(evidence.packages[0]?.truncations).toContainEqual({
      section: "pullRequests",
      includedBytes: evidenceItemBytes(firstPullRequest),
      omittedCount: 1,
    });
  });

  test("includes an item exactly at its section budget", () => {
    const input = baseInput();
    const required = packageAt(input).changesets[0];
    if (required === undefined) throw new Error("missing required changeset");
    input.budgets = {
      ...input.budgets,
      changesets: evidenceItemBytes(required),
    };

    const evidence = evidenceValue(assembleEvidence(input));
    expect(evidence.packages[0]?.changesets).toEqual([required]);
    expect(evidence.packages[0]?.truncations).toEqual([]);
  });

  test("returns typed EvidenceOverflow instead of truncating changesets", () => {
    const input = baseInput();
    const first = changeset("a", "a body");
    const second = changeset("b", "b body", DIGEST_B);
    input.packages[0] = { ...packageAt(input), changesets: [first, second] };
    input.budgets = {
      ...input.budgets,
      changesets: evidenceItemBytes(first),
    };

    const result = assembleEvidence(input);
    expect(result.isErr()).toBe(true);
    if (result.isOk()) return;
    expect(result.error).toEqual({
      type: "EvidenceOverflow",
      packageName: CLI,
      section: "changesets",
      includedBytes: evidenceItemBytes(first),
      requiredBytes: evidenceItemBytes(second),
      budgetBytes: evidenceItemBytes(first),
      omittedCount: 1,
    });
    expect(JSON.stringify(result.error)).not.toContain("b body");
  });

  test("fails safely when a required changeset is secret-shaped", () => {
    const input = baseInput();
    input.packages[0] = {
      ...packageAt(input),
      changesets: [changeset("secret", "API_KEY=ghp_1234567890abcdef")],
    };

    const result = assembleEvidence(input);
    expect(result.isErr()).toBe(true);
    if (result.isOk()) return;
    expect(result.error).toEqual({
      type: "EvidenceSecretDetected",
      packageName: CLI,
      section: "changesets",
      index: 0,
    });
    expect(JSON.stringify(result.error)).not.toContain("ghp_");
  });

  test("rejects accessor descriptors without evaluating them", () => {
    const input = baseInput();
    const hostile = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(hostile, "selectedPackages", {
      enumerable: true,
      get: () => {
        throw new Error("should never execute secret=do-not-leak");
      },
    });
    Object.assign(hostile, {
      packages: input.packages,
      budgets: input.budgets,
    });

    const result = assembleEvidence(
      hostile as unknown as EvidenceAssemblyInput,
    );
    expect(result.isErr()).toBe(true);
    if (result.isOk()) return;
    expect(result.error.type).toBe("DescriptorUnsafeInput");
    expect(JSON.stringify(result.error)).not.toContain("do-not-leak");
  });
});
