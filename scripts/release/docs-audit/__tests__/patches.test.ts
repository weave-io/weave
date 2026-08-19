import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  applyDocsAuditPatches,
  validateDocsAuditPatch,
  writeAppliedDocsAuditPatches,
} from "../patches.js";

const README = "# Weave\n\nPublic packages.\n";

describe("docs-audit patches", () => {
  test("rejects a workflow file patch", () => {
    const result = validateDocsAuditPatch(
      {
        path: ".github/workflows/ci.yml",
        unifiedDiff: unifiedDiff(".github/workflows/ci.yml", "name: ci\n", "name: pwn\n"),
      },
      "name: ci\n",
    );
    expect(result.isErr()).toBe(true);
    if (result.isOk()) return;
    expect(result.error.type).toBe("DocsAuditPatchPathRejected");
  });

  test("rejects scripts and product source", () => {
    for (const path of [
      "scripts/release/publish-main.ts",
      "packages/cli/src/index.ts",
      "packages/engine/src/logger.ts",
    ]) {
      const result = validateDocsAuditPatch(
        { path, unifiedDiff: unifiedDiff(path, "a\n", "b\n") },
        "a\n",
      );
      expect(result.isErr()).toBe(true);
      if (result.isOk()) continue;
      expect(result.error.type).toBe("DocsAuditPatchPathRejected");
    }
  });

  test("validates a clean README apply", () => {
    const patch = {
      path: "README.md",
      unifiedDiff: unifiedDiff("README.md", README, "# Weave\n\nPublic packages and adapters.\n"),
    };
    const result = validateDocsAuditPatch(patch, README);
    expect(result.isOk()).toBe(true);
  });

  test("refuses to apply without explicit approval", () => {
    const patch = {
      path: "README.md",
      unifiedDiff: unifiedDiff("README.md", README, "# Weave\n\nPublic packages and adapters.\n"),
    };
    const result = applyDocsAuditPatches({
      contentRoot: "/tmp",
      patches: [patch],
      originals: new Map([["README.md", README]]),
      approval: { approved: false },
    });
    expect(result.isErr()).toBe(true);
    if (result.isOk()) return;
    expect(result.error.type).toBe("DocsAuditPatchNotApproved");
  });

  test("applies an approved patch and writes it", async () => {
    const next = "# Weave\n\nPublic packages and adapters.\n";
    const patch = {
      path: "README.md",
      unifiedDiff: unifiedDiff("README.md", README, next),
    };
    const applied = applyDocsAuditPatches({
      contentRoot: "/tmp",
      patches: [patch],
      originals: new Map([["README.md", README]]),
      approval: { approved: true, approvedBy: "docs-audit-test" },
    });
    if (applied.isErr()) throw new Error(applied.error.type);
    expect(applied.value).toEqual([{ path: "README.md", next }]);
    const root = join(tmpdir(), `docs-audit-patch-${Bun.randomUUIDv7()}`);
    try {
      const written = await writeAppliedDocsAuditPatches({
        contentRoot: root,
        applied: applied.value,
      });
      if (written.isErr()) throw new Error(written.error.type);
      expect(await Bun.file(join(root, "README.md")).text()).toBe(next);
    } finally {
      Bun.spawnSync(["rm", "-rf", root]);
    }
  });

  test("fails a dirty apply whose context does not match", () => {
    const result = validateDocsAuditPatch(
      {
        path: "README.md",
        unifiedDiff: unifiedDiff("README.md", README, "# Other\n"),
      },
      "# Different original\n",
    );
    expect(result.isErr()).toBe(true);
    if (result.isOk()) return;
    expect(result.error.type).toBe("DocsAuditPatchApplyFailed");
  });
});

function unifiedDiff(path: string, before: string, after: string): string {
  const oldLines = splitLines(before);
  const newLines = splitLines(after);
  const body = [
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -1,${oldLines.length} +1,${newLines.length} @@`,
    ...oldLines.map((line) => `-${line}`),
    ...newLines.map((line) => `+${line}`),
  ];
  return `${body.join("\n")}\n`;
}

function splitLines(value: string): string[] {
  if (value.length === 0) return [];
  const trimmed = value.endsWith("\n") ? value.slice(0, -1) : value;
  return trimmed.split("\n");
}
