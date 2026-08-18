import { describe, expect, it } from "bun:test";
import type { Result } from "neverthrow";
import {
  type ChangelogDocument,
  type ChangelogEntry,
  renderChangelog,
} from "../changelog-format.js";
import type { ChangesetIdentity } from "../changeset-policy.js";
import type { PublicPackageName } from "../constants.js";
import {
  composeReleaseNotes,
  extractChangelogSection,
  type ReleaseNotesInput,
  releaseInstallCommand,
  releaseProvenanceUrl,
  releaseSourceComparisonUrl,
  releaseTagName,
  unscopedPackageName,
} from "../notes-wrapper.js";

const CLI = "@weaveio/weave-cli";
const PI = "@weaveio/weave-adapter-pi";
const RELEASED_SHA = "c".repeat(40);
const OTHER_SHA = "d".repeat(40);

function digest(seed: string): string {
  return new Bun.CryptoHasher("sha256").update(seed).digest("hex");
}

function tarballDigest(seed: string): string {
  return `sha256:${digest(seed)}`;
}

function identity(id: string): ChangesetIdentity {
  return { id, sourceDigest: digest(id) };
}

function entry(prose: string, id: string): ChangelogEntry {
  return { prose, sourceChangesets: [identity(id)] };
}

function changelog(packageName: PublicPackageName = CLI): string {
  const document: ChangelogDocument = {
    packageName,
    versions: [
      {
        version: "0.2.0",
        sections: [
          {
            name: "Changed",
            entries: [entry("Clarify the install command.", "install-docs")],
          },
        ],
      },
      {
        version: "0.1.0",
        sections: [
          {
            name: "Added",
            entries: [
              entry(
                "Delegation limits are portable across harnesses.",
                "portable-delegation-limits",
              ),
            ],
          },
        ],
      },
    ],
  };
  const rendered = renderChangelog(document);
  if (rendered.isErr())
    throw new Error(`Fixture render failed: ${JSON.stringify(rendered.error)}`);
  return rendered.value;
}

function notesInput(
  overrides: Partial<ReleaseNotesInput> = {},
): ReleaseNotesInput {
  return {
    packageName: CLI,
    version: "0.1.0",
    previousVersion: "0.0.1",
    releasedSha: RELEASED_SHA,
    tarballSha256: tarballDigest("cli-tarball"),
    changelog: changelog(),
    ...overrides,
  };
}

function expectOk<T, E>(result: Result<T, E>): T {
  if (result.isErr())
    throw new Error(`Unexpected failure: ${JSON.stringify(result.error)}`);
  return result.value;
}

function expectErr<T, E>(result: Result<T, E>): E {
  if (result.isOk())
    throw new Error(`Unexpected success: ${JSON.stringify(result.value)}`);
  return result.error;
}

describe("release tag naming", () => {
  it("uses the unscoped package name and version", () => {
    expect(unscopedPackageName(CLI)).toBe("weave-cli");
    expect(unscopedPackageName(PI)).toBe("weave-adapter-pi");
    expect(releaseTagName(CLI, "0.1.0")).toBe("weave-cli@0.1.0");
    expect(releaseTagName(PI, "0.1.0")).toBe("weave-adapter-pi@0.1.0");
    expect(releaseTagName(PI, "0.2.0-next.20260818.abcdef123456")).toBe(
      "weave-adapter-pi@0.2.0-next.20260818.abcdef123456",
    );
  });
});

describe("composeReleaseNotes", () => {
  it("snapshots the deterministic wrapper plus the verbatim section", () => {
    const notes = expectOk(composeReleaseNotes(notesInput()));
    expect(notes).toMatchSnapshot();
    expect(notes.startsWith("# weave-cli@0.1.0\n")).toBe(true);
    expect(notes).toContain(`- Package: \`${CLI}\``);
    expect(notes).toContain("- Version: `0.1.0`");
    expect(notes).toContain(
      `- Install: \`${releaseInstallCommand(CLI, "0.1.0")}\``,
    );
    expect(notes).toContain(
      `- Source: ${releaseSourceComparisonUrl({
        packageName: CLI,
        version: "0.1.0",
        previousVersion: "0.0.1",
        releasedSha: RELEASED_SHA,
      })}`,
    );
    expect(notes).toContain(
      `- Tarball digest: \`${tarballDigest("cli-tarball")}\``,
    );
    expect(notes).toContain(
      `- Provenance: ${releaseProvenanceUrl(CLI, "0.1.0")}`,
    );
    expect(notes).toContain(
      expectOk(extractChangelogSection(changelog(), "0.1.0")),
    );
    expect(notes).not.toContain("## 0.2.0");
  });

  it("copies the canonical section verbatim", () => {
    const source = changelog();
    const section = expectOk(extractChangelogSection(source, "0.1.0"));
    const notes = expectOk(
      composeReleaseNotes(notesInput({ changelog: source })),
    );
    expect(notes.endsWith(section)).toBe(true);
    expect(section).toContain("## 0.1.0");
    expect(section).toContain(
      "Delegation limits are portable across harnesses.",
    );
    expect(section).toContain("weave-release-ledger:1");
  });

  it("falls back to the released commit when there is no previous version", () => {
    const notes = expectOk(
      composeReleaseNotes(notesInput({ previousVersion: undefined })),
    );
    expect(notes).toContain(
      `https://github.com/weave-io/weave/commit/${RELEASED_SHA}`,
    );
  });

  it("rejects invalid wrapper facts", () => {
    expect(
      expectErr(composeReleaseNotes(notesInput({ version: "01.0.0" }))),
    ).toEqual({ type: "InvalidReleaseNotesVersion", field: "version" });
    expect(
      expectErr(composeReleaseNotes(notesInput({ previousVersion: "0.1.0" }))),
    ).toEqual({ type: "InvalidReleaseNotesVersion", field: "previousVersion" });
    expect(
      expectErr(
        composeReleaseNotes(notesInput({ releasedSha: OTHER_SHA.slice(0, 7) })),
      ),
    ).toEqual({
      type: "InvalidReleaseNotesSha",
      sha: OTHER_SHA.slice(0, 7),
    });
    expect(
      expectErr(
        composeReleaseNotes(notesInput({ tarballSha256: "not-a-digest" })),
      ),
    ).toEqual({
      type: "InvalidReleaseNotesDigest",
      digest: "not-a-digest",
    });
  });
});

describe("extractChangelogSection", () => {
  it("selects only the requested version", () => {
    const newer = expectOk(extractChangelogSection(changelog(), "0.2.0"));
    expect(newer.startsWith("## 0.2.0\n")).toBe(true);
    expect(newer).toContain("Clarify the install command.");
    expect(newer).not.toContain("## 0.1.0");
  });

  it("fails when the version is missing, duplicated, or empty", () => {
    expect(expectErr(extractChangelogSection(changelog(), "9.9.9"))).toEqual({
      type: "ChangelogSectionMissing",
      version: "9.9.9",
    });
    expect(
      expectErr(
        extractChangelogSection(
          "# pkg\n\n## 0.1.0\n\n## 0.1.0\n\ntext\n",
          "0.1.0",
        ),
      ),
    ).toEqual({ type: "DuplicateChangelogSection", version: "0.1.0" });
    expect(
      expectErr(extractChangelogSection("# pkg\n\n## 0.1.0\n", "0.1.0")),
    ).toEqual({
      type: "ChangelogSectionEmpty",
      version: "0.1.0",
    });
  });
});
