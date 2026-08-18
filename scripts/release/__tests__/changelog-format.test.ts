import { describe, expect, it } from "bun:test";
import {
  CHANGELOG_SECTIONS,
  type ChangelogDocument,
  type ChangelogEntry,
  type ChangelogEvidence,
  type ChangelogFormatError,
  type ChangelogSectionName,
  type ChangelogVersion,
  ENTRY_MARKER,
  ENTRY_MARKER_SCHEMA_VERSION,
  type ParsedChangelog,
  parseChangelog,
  renderChangelog,
} from "../changelog-format.js";
import type { ChangesetIdentity } from "../changeset-policy.js";
import type { PublicPackageName } from "../constants.js";
import {
  type ChangelogSource,
  parseConsumptionLedger,
  renderLedgerBlock,
} from "../consumption-ledger.js";

const CLI = "@weaveio/weave-cli";
const OPENCODE = "@weaveio/weave-adapter-opencode";
const CLAUDE = "@weaveio/weave-adapter-claude-code";
const PI = "@weaveio/weave-adapter-pi";

/** A real SHA-256 digest, so fixtures carry the shape the schema demands. */
function digest(seed: string): string {
  return new Bun.CryptoHasher("sha256").update(seed).digest("hex");
}

function identity(id: string): ChangesetIdentity {
  return { id, sourceDigest: digest(id) };
}

function entry(
  prose: string,
  ids: readonly string[],
  refs?: ChangelogEntry["refs"],
): ChangelogEntry {
  const sourceChangesets = ids.map(identity);
  return refs === undefined
    ? { prose, sourceChangesets }
    : { prose, sourceChangesets, refs };
}

function version(
  value: string,
  sections: readonly {
    name: ChangelogSectionName;
    entries: ChangelogEntry[];
  }[],
): ChangelogVersion {
  return { version: value, sections };
}

function document(
  versions: readonly ChangelogVersion[],
  packageName: PublicPackageName = CLI,
): ChangelogDocument {
  return { packageName, versions };
}

function render(
  input: ChangelogDocument,
  evidence: ChangelogEvidence = {},
): string {
  const rendered = renderChangelog(input, evidence);
  if (rendered.isErr())
    throw new Error(
      `Unexpected render failure: ${JSON.stringify(rendered.error)}`,
    );
  return rendered.value;
}

function renderFailure(
  input: ChangelogDocument,
  evidence: ChangelogEvidence = {},
): ChangelogFormatError {
  const rendered = renderChangelog(input, evidence);
  if (rendered.isOk())
    throw new Error(`Expected a render failure, got:\n${rendered.value}`);
  return rendered.error;
}

function source(
  contents: string,
  packageName: PublicPackageName = CLI,
): ChangelogSource {
  return {
    packageName,
    path: `packages/${packageName}/CHANGELOG.md`,
    contents,
  };
}

function parsed(
  input: ChangelogSource,
  evidence: ChangelogEvidence = {},
): ParsedChangelog {
  const result = parseChangelog(input, evidence);
  if (result.isErr())
    throw new Error(
      `Unexpected parse failure: ${JSON.stringify(result.error)}`,
    );
  return result.value;
}

function parseFailure(
  input: ChangelogSource,
  evidence: ChangelogEvidence = {},
): ChangelogFormatError {
  const result = parseChangelog(input, evidence);
  if (result.isOk())
    throw new Error(
      `Expected a parse failure, got ${JSON.stringify(result.value.document)}`,
    );
  return result.error;
}

/** The Task 6 block, rendered by Task 6, for hand-built fixtures. */
function ledgerBlock(
  packageName: PublicPackageName,
  value: string,
  ids: readonly string[],
): string {
  const rendered = renderLedgerBlock({
    package: packageName,
    version: value,
    changesets: ids.map(identity),
  });
  if (rendered.isErr())
    throw new Error(
      `Fixture block is invalid: ${JSON.stringify(rendered.error)}`,
    );
  return rendered.value;
}

function marker(ids: readonly string[]): string {
  return `<!-- ${ENTRY_MARKER}:${ENTRY_MARKER_SCHEMA_VERSION} ${JSON.stringify(ids)} -->`;
}

/** The 1-based line a fixture snippet sits on. */
function lineOf(contents: string, needle: string): number {
  const index = contents.split("\n").indexOf(needle);
  if (index === -1) throw new Error(`Fixture line not found: ${needle}`);
  return index + 1;
}

/** Joins hand-built blocks the way the renderer does. */
function changelog(
  blocks: readonly string[],
  packageName: PublicPackageName = CLI,
): string {
  return `${[`# ${packageName}`, ...blocks].join("\n\n")}\n`;
}

const RELEASE = document([
  version("0.2.0", [
    {
      name: "Added",
      entries: [
        entry(
          "Weave runs on a third harness",
          ["third-harness"],
          [{ kind: "pull-request", number: 512 }],
        ),
      ],
    },
  ]),
  version("0.1.0", [
    {
      name: "Breaking Changes",
      entries: [entry("The legacy flag is gone", ["drop-legacy-flag"])],
    },
    {
      name: "Added",
      entries: [
        entry(
          "Delegation limits travel with the agent",
          ["portable-delegation-limits", "pi-settlement-budget"],
          [
            { kind: "pull-request", number: 412 },
            { kind: "commit", commit: "abc1234" },
          ],
        ),
      ],
    },
    {
      name: "Fixed",
      entries: [entry("Overlay search reopens", ["overlay-search"])],
    },
  ]),
]);

const RELEASE_EVIDENCE: ChangelogEvidence = {
  pullRequests: [412, 512],
  commits: ["abc1234"],
};

describe("canonical sections", () => {
  it("declares exactly six sections in fixed order", () => {
    expect(CHANGELOG_SECTIONS).toEqual([
      "Breaking Changes",
      "Added",
      "Changed",
      "Fixed",
      "Deprecated",
      "Security",
    ]);
  });
});

describe("renderChangelog", () => {
  it("renders version-only headings, non-empty sections, and one block", () => {
    const rendered = render(RELEASE, RELEASE_EVIDENCE);
    expect(rendered).toBe(
      changelog([
        "## 0.2.0",
        ledgerBlock(CLI, "0.2.0", ["third-harness"]),
        "### Added",
        `${marker(["third-harness"])}\n- Weave runs on a third harness (#512)`,
        "## 0.1.0",
        ledgerBlock(CLI, "0.1.0", [
          "drop-legacy-flag",
          "overlay-search",
          "pi-settlement-budget",
          "portable-delegation-limits",
        ]),
        "### Breaking Changes",
        `${marker(["drop-legacy-flag"])}\n- The legacy flag is gone`,
        "### Added",
        `${marker(["portable-delegation-limits", "pi-settlement-budget"])}\n- Delegation limits travel with the agent (#412, \`abc1234\`)`,
        "### Fixed",
        `${marker(["overlay-search"])}\n- Overlay search reopens`,
      ]),
    );
    expect(rendered).not.toContain("Changed");
    expect(rendered).not.toContain("Deprecated");
    expect(rendered).not.toContain("Security");
    expect(/^## \d+\.\d+\.\d+$/m.test(rendered)).toBe(true);
  });

  it("is deterministic and independent of input ordering", () => {
    const shuffled = document([
      version("0.1.0", [
        {
          name: "Fixed",
          entries: [entry("Overlay search reopens", ["overlay-search"])],
        },
        {
          name: "Added",
          entries: [
            entry(
              "Delegation limits travel with the agent",
              ["portable-delegation-limits", "pi-settlement-budget"],
              [
                { kind: "pull-request", number: 412 },
                { kind: "commit", commit: "abc1234" },
              ],
            ),
          ],
        },
        {
          name: "Breaking Changes",
          entries: [entry("The legacy flag is gone", ["drop-legacy-flag"])],
        },
      ]),
      version("0.2.0", [
        {
          name: "Added",
          entries: [
            entry(
              "Weave runs on a third harness",
              ["third-harness"],
              [{ kind: "pull-request", number: 512 }],
            ),
          ],
        },
      ]),
    ]);
    expect(render(shuffled, RELEASE_EVIDENCE)).toBe(
      render(RELEASE, RELEASE_EVIDENCE),
    );
    expect(render(RELEASE, RELEASE_EVIDENCE)).toBe(
      render(RELEASE, RELEASE_EVIDENCE),
    );
  });

  it("groups several changesets under one entry", () => {
    const grouped = document([
      version("0.1.0", [
        {
          name: "Changed",
          entries: [
            entry("One statement, three changesets", [
              "alpha-change",
              "beta-change",
              "gamma-change",
            ]),
          ],
        },
      ]),
    ]);
    const rendered = render(grouped);
    expect(rendered).toContain(
      marker(["alpha-change", "beta-change", "gamma-change"]),
    );
    expect(rendered).toContain(
      ledgerBlock(CLI, "0.1.0", [
        "alpha-change",
        "beta-change",
        "gamma-change",
      ]),
    );
    expect(rendered.split("- One statement").length - 1).toBe(1);
  });

  it("renders the ledger block through the Task 6 renderer", () => {
    const rendered = render(RELEASE, RELEASE_EVIDENCE);
    expect(rendered).toContain(ledgerBlock(CLI, "0.2.0", ["third-harness"]));
    expect(rendered.split("weave-release-ledger:1").length - 1).toBe(2);
  });

  it("renders a heading-only stub for an empty history", () => {
    expect(render(document([]))).toBe(`# ${CLI}\n`);
  });

  it("rejects a ref the evidence set does not carry", () => {
    const cited = document([
      version("0.1.0", [
        {
          name: "Fixed",
          entries: [
            entry(
              "Cites an unproven pull request",
              ["overlay-search"],
              [{ kind: "pull-request", number: 999 }],
            ),
          ],
        },
      ]),
    ]);
    expect(renderFailure(cited, { pullRequests: [412] })).toEqual({
      type: "UnsupportedEntryRef",
      path: null,
      version: "0.1.0",
      ref: "#999",
    });
    expect(renderFailure(cited)).toEqual({
      type: "UnsupportedEntryRef",
      path: null,
      version: "0.1.0",
      ref: "#999",
    });
  });

  it("rejects a commit ref the evidence set does not carry", () => {
    const cited = document([
      version("0.1.0", [
        {
          name: "Fixed",
          entries: [
            entry(
              "Cites an unproven commit",
              ["overlay-search"],
              [{ kind: "commit", commit: "0badc0de" }],
            ),
          ],
        },
      ]),
    ]);
    expect(renderFailure(cited, { commits: ["abc1234"] })).toEqual({
      type: "UnsupportedEntryRef",
      path: null,
      version: "0.1.0",
      ref: "0badc0de",
    });
  });

  it("rejects a repeated ref inside one entry", () => {
    const repeated = document([
      version("0.1.0", [
        {
          name: "Fixed",
          entries: [
            entry(
              "Cites the same pull request twice",
              ["overlay-search"],
              [
                { kind: "pull-request", number: 412 },
                { kind: "pull-request", number: 412 },
              ],
            ),
          ],
        },
      ]),
    ]);
    expect(renderFailure(repeated, { pullRequests: [412] })).toEqual({
      type: "DuplicateEntryRef",
      path: null,
      version: "0.1.0",
      ref: "#412",
    });
  });

  it("rejects one changeset claimed by two entries", () => {
    const doubled = document([
      version("0.1.0", [
        {
          name: "Added",
          entries: [entry("First claim", ["overlay-search"])],
        },
        {
          name: "Fixed",
          entries: [entry("Second claim", ["overlay-search"])],
        },
      ]),
    ]);
    expect(renderFailure(doubled)).toEqual({
      type: "DuplicateEntryChangeset",
      path: null,
      version: "0.1.0",
      id: "overlay-search",
    });
  });

  it("rejects an empty section and an empty entry", () => {
    const emptySection = renderFailure(
      document([version("0.1.0", [{ name: "Added", entries: [] }])]),
    );
    expect(emptySection.type).toBe("InvalidChangelogDocument");
    const emptyProse = renderFailure(
      document([
        version("0.1.0", [
          { name: "Added", entries: [entry("", ["overlay-search"])] },
        ]),
      ]),
    );
    expect(emptyProse.type).toBe("InvalidChangelogDocument");
    const emptySources = renderFailure(
      document([
        version("0.1.0", [
          { name: "Added", entries: [entry("No source at all", [])] },
        ]),
      ]),
    );
    expect(emptySources.type).toBe("InvalidChangelogDocument");
    const noSections = renderFailure(document([version("0.1.0", [])]));
    expect(noSections.type).toBe("InvalidChangelogDocument");
  });

  it("rejects a dated or non-version heading in the model", () => {
    const dated = renderFailure(
      document([
        version("0.1.0 - 2026-02-01", [
          { name: "Added", entries: [entry("Anything", ["overlay-search"])] },
        ]),
      ]),
    );
    expect(dated.type).toBe("InvalidChangelogDocument");
  });

  it("rejects prose that would read as a reference list", () => {
    const ambiguous = document([
      version("0.1.0", [
        {
          name: "Added",
          entries: [entry("Prose ending in (#412)", ["overlay-search"])],
        },
      ]),
    ]);
    expect(renderFailure(ambiguous, { pullRequests: [412] })).toEqual({
      type: "InvalidEntryProse",
      version: "0.1.0",
      reason: "prose ends with text that reads as a reference list",
    });
  });

  it("rejects multi-line prose and comment delimiters in prose", () => {
    const multiline = document([
      version("0.1.0", [
        {
          name: "Added",
          entries: [entry("First line\nSecond line", ["overlay-search"])],
        },
      ]),
    ]);
    expect(renderFailure(multiline)).toEqual({
      type: "InvalidEntryProse",
      version: "0.1.0",
      reason: "prose spans more than one line",
    });
    const commented = document([
      version("0.1.0", [
        {
          name: "Added",
          entries: [entry("Sneaks in <!-- a comment", ["overlay-search"])],
        },
      ]),
    ]);
    expect(renderFailure(commented)).toEqual({
      type: "InvalidEntryProse",
      version: "0.1.0",
      reason: "prose contains an HTML comment delimiter",
    });
  });

  it("rejects a duplicated version or section in the model", () => {
    const twiceVersioned = document([
      version("0.1.0", [
        { name: "Added", entries: [entry("First", ["alpha-change"])] },
      ]),
      version("0.1.0", [
        { name: "Fixed", entries: [entry("Second", ["beta-change"])] },
      ]),
    ]);
    expect(renderFailure(twiceVersioned)).toEqual({
      type: "DuplicateDocumentVersion",
      version: "0.1.0",
    });
    const twiceSectioned = document([
      version("0.1.0", [
        { name: "Added", entries: [entry("First", ["alpha-change"])] },
        { name: "Added", entries: [entry("Second", ["beta-change"])] },
      ]),
    ]);
    expect(renderFailure(twiceSectioned)).toEqual({
      type: "DuplicateDocumentSection",
      version: "0.1.0",
      section: "Added",
    });
  });

  it("rejects an unusable evidence set", () => {
    const failure = renderFailure(RELEASE, {
      pullRequests: [0],
      commits: ["not-a-sha"],
    });
    expect(failure.type).toBe("InvalidChangelogEvidence");
  });
});

describe("parseChangelog round trip", () => {
  it("round-trips canonical output", () => {
    const rendered = render(RELEASE, RELEASE_EVIDENCE);
    const result = parsed(source(rendered), RELEASE_EVIDENCE);
    expect(result.document).toEqual(RELEASE);
    expect(render(result.document, RELEASE_EVIDENCE)).toBe(rendered);
  });

  it("normalizes section and version order on the way back", () => {
    const rendered = render(RELEASE, RELEASE_EVIDENCE);
    const result = parsed(source(rendered), RELEASE_EVIDENCE);
    expect(result.document.versions.map((each) => each.version)).toEqual([
      "0.2.0",
      "0.1.0",
    ]);
    expect(
      result.document.versions[1]?.sections.map((each) => each.name),
    ).toEqual(["Breaking Changes", "Added", "Fixed"]);
  });

  it("validates the heading-only stubs every public package ships today", () => {
    for (const packageName of [CLI, OPENCODE, CLAUDE, PI] as const) {
      const result = parsed(source(`# ${packageName}\n`, packageName));
      expect(result.document).toEqual({ packageName, versions: [] });
      expect(result.ledger.records).toEqual([]);
    }
  });

  it("keeps the mapping when a human rewrites the prose", () => {
    const rendered = render(RELEASE, RELEASE_EVIDENCE);
    const edited = rendered.replace(
      "- Delegation limits travel with the agent (#412, `abc1234`)",
      "- Delegation limits now travel with the agent, across every harness (#412, `abc1234`)",
    );
    const before = parsed(source(rendered), RELEASE_EVIDENCE);
    const after = parsed(source(edited), RELEASE_EVIDENCE);
    expect(after.ledger).toEqual(before.ledger);
    const editedEntry = after.document.versions[1]?.sections[1]?.entries[0];
    expect(editedEntry?.prose).toBe(
      "Delegation limits now travel with the agent, across every harness",
    );
    expect(editedEntry?.sourceChangesets).toEqual([
      identity("portable-delegation-limits"),
      identity("pi-settlement-budget"),
    ]);
    expect(render(after.document, RELEASE_EVIDENCE)).toContain(
      ledgerBlock(CLI, "0.1.0", [
        "drop-legacy-flag",
        "overlay-search",
        "pi-settlement-budget",
        "portable-delegation-limits",
      ]),
    );
  });

  it("extracts exactly what the Task 6 ledger parser extracts", () => {
    const rendered = source(render(RELEASE, RELEASE_EVIDENCE));
    const ledger = parseConsumptionLedger([rendered]);
    if (ledger.isErr())
      throw new Error(`Unexpected ledger failure: ${ledger.error.type}`);
    expect(parsed(rendered, RELEASE_EVIDENCE).ledger).toEqual(ledger.value);
    const stub = source(`# ${PI}\n`, PI);
    const stubLedger = parseConsumptionLedger([stub]);
    if (stubLedger.isErr())
      throw new Error(`Unexpected ledger failure: ${stubLedger.error.type}`);
    expect(parsed(stub).ledger).toEqual(stubLedger.value);
  });
});

describe("parseChangelog rejections", () => {
  it("rejects a dated version heading", () => {
    const dated = changelog([
      "## 0.1.0 - 2026-02-01",
      ledgerBlock(CLI, "0.1.0", ["overlay-search"]),
      "### Fixed",
      `${marker(["overlay-search"])}\n- Overlay search reopens`,
    ]);
    expect(parseFailure(source(dated))).toEqual({
      type: "DatedVersionHeading",
      path: `packages/${CLI}/CHANGELOG.md`,
      heading: "0.1.0 - 2026-02-01",
    });
  });

  it("rejects a non-version heading", () => {
    const unreleased = changelog([
      "## Unreleased",
      ledgerBlock(CLI, "0.1.0", ["overlay-search"]),
    ]);
    expect(parseFailure(source(unreleased))).toEqual({
      type: "InvalidVersionHeading",
      path: `packages/${CLI}/CHANGELOG.md`,
      heading: "Unreleased",
    });
  });

  it("rejects duplicate and ascending version headings", () => {
    const duplicated = changelog([
      "## 0.1.0",
      ledgerBlock(CLI, "0.1.0", ["overlay-search"]),
      "### Fixed",
      `${marker(["overlay-search"])}\n- Overlay search reopens`,
      "## 0.1.0",
      ledgerBlock(CLI, "0.1.0", ["alpha-change"]),
      "### Added",
      `${marker(["alpha-change"])}\n- Something else`,
    ]);
    expect(parseFailure(source(duplicated))).toEqual({
      type: "DuplicateVersionHeading",
      path: `packages/${CLI}/CHANGELOG.md`,
      version: "0.1.0",
    });
    const ascending = changelog([
      "## 0.1.0",
      ledgerBlock(CLI, "0.1.0", ["overlay-search"]),
      "### Fixed",
      `${marker(["overlay-search"])}\n- Overlay search reopens`,
      "## 0.2.0",
      ledgerBlock(CLI, "0.2.0", ["alpha-change"]),
      "### Added",
      `${marker(["alpha-change"])}\n- Something newer`,
    ]);
    expect(parseFailure(source(ascending))).toEqual({
      type: "VersionHeadingOutOfOrder",
      path: `packages/${CLI}/CHANGELOG.md`,
      version: "0.2.0",
      previous: "0.1.0",
    });
  });

  it("rejects a version without a ledger block", () => {
    const missing = changelog([
      "## 0.1.0",
      "### Fixed",
      `${marker(["overlay-search"])}\n- Overlay search reopens`,
    ]);
    expect(parseFailure(source(missing))).toEqual({
      type: "MissingLedgerBlock",
      path: `packages/${CLI}/CHANGELOG.md`,
      version: "0.1.0",
    });
  });

  it("rejects two ledger blocks under one version", () => {
    const twice = changelog([
      "## 0.1.0",
      ledgerBlock(CLI, "0.1.0", ["overlay-search"]),
      ledgerBlock(CLI, "0.1.0", ["alpha-change"]),
      "### Fixed",
      `${marker(["overlay-search"])}\n- Overlay search reopens`,
    ]);
    expect(parseFailure(source(twice))).toEqual({
      type: "MultipleLedgerBlocks",
      path: `packages/${CLI}/CHANGELOG.md`,
      version: "0.1.0",
    });
  });

  it("rejects a ledger block outside its version position", () => {
    const afterSection = changelog([
      "## 0.1.0",
      "### Fixed",
      `${marker(["overlay-search"])}\n- Overlay search reopens`,
      ledgerBlock(CLI, "0.1.0", ["overlay-search"]),
    ]);
    expect(parseFailure(source(afterSection))).toEqual({
      type: "MisplacedLedgerBlock",
      path: `packages/${CLI}/CHANGELOG.md`,
      version: "0.1.0",
    });
    const beforeVersion = changelog([
      ledgerBlock(CLI, "0.1.0", ["overlay-search"]),
      "## 0.1.0",
      "### Fixed",
      `${marker(["overlay-search"])}\n- Overlay search reopens`,
    ]);
    expect(parseFailure(source(beforeVersion))).toEqual({
      type: "MisplacedLedgerBlock",
      path: `packages/${CLI}/CHANGELOG.md`,
      version: null,
    });
  });

  it("rejects an empty section body and an empty entry", () => {
    const emptySection = changelog([
      "## 0.1.0",
      ledgerBlock(CLI, "0.1.0", ["overlay-search"]),
      "### Added",
      "### Fixed",
      `${marker(["overlay-search"])}\n- Overlay search reopens`,
    ]);
    expect(parseFailure(source(emptySection))).toEqual({
      type: "EmptySectionBody",
      path: `packages/${CLI}/CHANGELOG.md`,
      version: "0.1.0",
      section: "Added",
    });
    const trailingSection = changelog([
      "## 0.1.0",
      ledgerBlock(CLI, "0.1.0", ["overlay-search"]),
      "### Fixed",
      `${marker(["overlay-search"])}\n- Overlay search reopens`,
      "### Security",
    ]);
    expect(parseFailure(source(trailingSection))).toEqual({
      type: "EmptySectionBody",
      path: `packages/${CLI}/CHANGELOG.md`,
      version: "0.1.0",
      section: "Security",
    });
    const emptyEntry = changelog([
      "## 0.1.0",
      ledgerBlock(CLI, "0.1.0", ["overlay-search"]),
      "### Fixed",
      `${marker(["overlay-search"])}\n-`,
    ]);
    const failure = parseFailure(source(emptyEntry));
    expect(failure.type).toBe("EmptyEntryProse");
  });

  it("rejects unknown and out-of-order section headings", () => {
    const unknown = changelog([
      "## 0.1.0",
      ledgerBlock(CLI, "0.1.0", ["overlay-search"]),
      "### Miscellaneous",
      `${marker(["overlay-search"])}\n- Overlay search reopens`,
    ]);
    expect(parseFailure(source(unknown))).toEqual({
      type: "UnknownSectionHeading",
      path: `packages/${CLI}/CHANGELOG.md`,
      version: "0.1.0",
      heading: "Miscellaneous",
    });
    const outOfOrder = changelog([
      "## 0.1.0",
      ledgerBlock(CLI, "0.1.0", ["overlay-search", "alpha-change"]),
      "### Fixed",
      `${marker(["overlay-search"])}\n- Overlay search reopens`,
      "### Added",
      `${marker(["alpha-change"])}\n- Something added`,
    ]);
    expect(parseFailure(source(outOfOrder))).toEqual({
      type: "SectionHeadingOutOfOrder",
      path: `packages/${CLI}/CHANGELOG.md`,
      version: "0.1.0",
      section: "Added",
      previous: "Fixed",
    });
    const repeated = changelog([
      "## 0.1.0",
      ledgerBlock(CLI, "0.1.0", ["overlay-search", "alpha-change"]),
      "### Fixed",
      `${marker(["overlay-search"])}\n- Overlay search reopens`,
      "### Fixed",
      `${marker(["alpha-change"])}\n- Something else fixed`,
    ]);
    expect(parseFailure(source(repeated))).toEqual({
      type: "DuplicateSectionHeading",
      path: `packages/${CLI}/CHANGELOG.md`,
      version: "0.1.0",
      section: "Fixed",
    });
  });

  it("rejects prose and mapping divergence in both directions", () => {
    const extra = changelog([
      "## 0.1.0",
      ledgerBlock(CLI, "0.1.0", ["overlay-search"]),
      "### Fixed",
      `${marker(["overlay-search", "unrecorded-change"])}\n- Overlay search reopens`,
    ]);
    expect(parseFailure(source(extra))).toEqual({
      type: "EntrySourceNotInLedger",
      path: `packages/${CLI}/CHANGELOG.md`,
      version: "0.1.0",
      id: "unrecorded-change",
    });
    const missing = changelog([
      "## 0.1.0",
      ledgerBlock(CLI, "0.1.0", ["overlay-search", "alpha-change"]),
      "### Fixed",
      `${marker(["overlay-search"])}\n- Overlay search reopens`,
    ]);
    expect(parseFailure(source(missing))).toEqual({
      type: "LedgerSourceNotInEntries",
      path: `packages/${CLI}/CHANGELOG.md`,
      version: "0.1.0",
      id: "alpha-change",
    });
  });

  it("rejects one changeset claimed by two entries", () => {
    const doubled = changelog([
      "## 0.1.0",
      ledgerBlock(CLI, "0.1.0", ["overlay-search"]),
      "### Added",
      `${marker(["overlay-search"])}\n- First claim`,
      "### Fixed",
      `${marker(["overlay-search"])}\n- Second claim`,
    ]);
    expect(parseFailure(source(doubled))).toEqual({
      type: "DuplicateEntryChangeset",
      path: `packages/${CLI}/CHANGELOG.md`,
      version: "0.1.0",
      id: "overlay-search",
    });
  });

  it("rejects malformed, missing, and orphaned entry markers", () => {
    const malformed = changelog([
      "## 0.1.0",
      ledgerBlock(CLI, "0.1.0", ["overlay-search"]),
      "### Fixed",
      `<!-- ${ENTRY_MARKER}:1 {"ids":["overlay-search"]} -->\n- Overlay search reopens`,
    ]);
    const malformedFailure = parseFailure(source(malformed));
    expect(malformedFailure.type).toBe("MalformedEntryMarker");
    const unsupported = changelog([
      "## 0.1.0",
      ledgerBlock(CLI, "0.1.0", ["overlay-search"]),
      "### Fixed",
      `<!-- ${ENTRY_MARKER}:2 ["overlay-search"] -->\n- Overlay search reopens`,
    ]);
    expect(parseFailure(source(unsupported))).toEqual({
      type: "MalformedEntryMarker",
      path: `packages/${CLI}/CHANGELOG.md`,
      version: "0.1.0",
      line: lineOf(
        unsupported,
        `<!-- ${ENTRY_MARKER}:2 ["overlay-search"] -->`,
      ),
      issues: ["unsupported entry marker schema 2"],
    });
    const unmarked = changelog([
      "## 0.1.0",
      ledgerBlock(CLI, "0.1.0", ["overlay-search"]),
      "### Fixed",
      "- Overlay search reopens",
    ]);
    expect(parseFailure(source(unmarked))).toEqual({
      type: "MissingEntryMarker",
      path: `packages/${CLI}/CHANGELOG.md`,
      version: "0.1.0",
      line: lineOf(unmarked, "- Overlay search reopens"),
    });
    const orphaned = changelog([
      "## 0.1.0",
      ledgerBlock(CLI, "0.1.0", ["overlay-search"]),
      "### Fixed",
      marker(["overlay-search"]),
    ]);
    const orphanFailure = parseFailure(source(orphaned));
    expect(orphanFailure.type).toBe("MissingEntryProse");
  });

  it("rejects an entry ref the evidence set does not carry", () => {
    const cited = changelog([
      "## 0.1.0",
      ledgerBlock(CLI, "0.1.0", ["overlay-search"]),
      "### Fixed",
      `${marker(["overlay-search"])}\n- Overlay search reopens (#999)`,
    ]);
    expect(parseFailure(source(cited), { pullRequests: [412] })).toEqual({
      type: "UnsupportedEntryRef",
      path: `packages/${CLI}/CHANGELOG.md`,
      version: "0.1.0",
      ref: "#999",
    });
    const supplied = parsed(source(cited), { pullRequests: [999] });
    expect(
      supplied.document.versions[0]?.sections[0]?.entries[0]?.refs,
    ).toEqual([{ kind: "pull-request", number: 999 }]);
  });

  it("rejects a missing or mismatched package heading", () => {
    expect(parseFailure(source(""))).toEqual({
      type: "MissingPackageHeading",
      path: `packages/${CLI}/CHANGELOG.md`,
    });
    expect(parseFailure(source(`# ${OPENCODE}\n`))).toEqual({
      type: "PackageHeadingMismatch",
      path: `packages/${CLI}/CHANGELOG.md`,
      expected: CLI,
      actual: OPENCODE,
    });
  });

  it("rejects stray content, stray comments, and misplaced entries", () => {
    const prose = changelog([
      "## 0.1.0",
      ledgerBlock(CLI, "0.1.0", ["overlay-search"]),
      "### Fixed",
      `${marker(["overlay-search"])}\n- Overlay search reopens`,
      "A loose sentence outside any entry.",
    ]);
    const stray = parseFailure(source(prose));
    expect(stray.type).toBe("UnexpectedChangelogContent");
    const comment = changelog([
      "## 0.1.0",
      ledgerBlock(CLI, "0.1.0", ["overlay-search"]),
      "<!-- a hand-written note -->",
      "### Fixed",
      `${marker(["overlay-search"])}\n- Overlay search reopens`,
    ]);
    expect(parseFailure(source(comment)).type).toBe(
      "UnexpectedChangelogContent",
    );
    const sectionless = changelog([
      "## 0.1.0",
      ledgerBlock(CLI, "0.1.0", ["overlay-search"]),
      `${marker(["overlay-search"])}\n- Overlay search reopens`,
    ]);
    expect(parseFailure(source(sectionless)).type).toBe("EntryOutsideSection");
    const versionless = changelog([
      "### Fixed",
      `${marker(["overlay-search"])}\n- Overlay search reopens`,
    ]);
    expect(parseFailure(source(versionless))).toEqual({
      type: "SectionOutsideVersion",
      path: `packages/${CLI}/CHANGELOG.md`,
      heading: "Fixed",
    });
  });

  it("reports a ledger failure through the Task 6 parser", () => {
    const foreign = changelog([
      "## 0.1.0",
      ledgerBlock(OPENCODE, "0.1.0", ["overlay-search"]),
      "### Fixed",
      `${marker(["overlay-search"])}\n- Overlay search reopens`,
    ]);
    const failure = parseFailure(source(foreign));
    expect(failure).toEqual({
      type: "ChangelogLedgerUnreadable",
      path: `packages/${CLI}/CHANGELOG.md`,
      error: {
        type: "LedgerPackageMismatch",
        path: `packages/${CLI}/CHANGELOG.md`,
        expected: CLI,
        actual: OPENCODE,
      },
    });
  });
});
