import { describe, expect, it } from "bun:test";
import { errAsync, okAsync, type ResultAsync } from "neverthrow";
import type { PublicPackageName } from "../constants.js";
import {
  type ChangelogReader,
  type ChangelogSource,
  type ConsumptionLedger,
  type ConsumptionLedgerError,
  EMPTY_CONSUMPTION_LEDGER,
  LEDGER_BLOCK_MARKER,
  LEDGER_BLOCK_SCHEMA_VERSION,
  type LedgerBlock,
  loadConsumptionLedger,
  parseConsumptionLedger,
  renderLedgerBlock,
} from "../consumption-ledger.js";
import type { FileSystemError } from "../errors.js";

const CLI = "@weaveio/weave-cli";
const OPENCODE = "@weaveio/weave-adapter-opencode";
const PI = "@weaveio/weave-adapter-pi";

/** A real SHA-256 digest, so fixtures carry the shape the schema demands. */
function digest(seed: string): string {
  return new Bun.CryptoHasher("sha256").update(seed).digest("hex");
}

const PORTABLE_LIMITS = digest("portable-delegation-limits");
const SETTLEMENT_BUDGET = digest("pi-settlement-budget");

function block(overrides: Partial<LedgerBlock> = {}): LedgerBlock {
  return {
    package: CLI,
    version: "0.1.0",
    changesets: [
      { id: "portable-delegation-limits", sourceDigest: PORTABLE_LIMITS },
    ],
    ...overrides,
  };
}

function render(input: LedgerBlock): string {
  const rendered = renderLedgerBlock(input);
  if (rendered.isErr())
    throw new Error(
      `Fixture block is invalid: ${JSON.stringify(rendered.error)}`,
    );
  return rendered.value;
}

/** A changelog whose every version section carries its rendered block. */
function changelog(
  packageName: PublicPackageName,
  sections: readonly { version: string; body: string }[],
): ChangelogSource {
  const rendered = sections
    .map((section) => `## ${section.version}\n\n${section.body}\n`)
    .join("\n");
  return {
    packageName,
    path: `packages/${packageName}/CHANGELOG.md`,
    contents: `# ${packageName}\n\n${rendered}`,
  };
}

function parsed(sources: readonly ChangelogSource[]): ConsumptionLedger {
  const result = parseConsumptionLedger(sources);
  if (result.isErr())
    throw new Error(
      `Unexpected ledger failure: ${JSON.stringify(result.error)}`,
    );
  return result.value;
}

function failure(sources: readonly ChangelogSource[]): ConsumptionLedgerError {
  const result = parseConsumptionLedger(sources);
  if (result.isOk())
    throw new Error(
      `Expected a ledger failure, got ${JSON.stringify(result.value.records)}`,
    );
  return result.error;
}

/** A changelog carrying a hand-written block body, valid or not. */
function rawChangelog(
  packageName: PublicPackageName,
  version: string,
  comment: string,
): ChangelogSource {
  return {
    packageName,
    path: `packages/${packageName}/CHANGELOG.md`,
    contents: `# ${packageName}\n\n## ${version}\n\n${comment}\n`,
  };
}

class MemoryChangelogReader implements ChangelogReader {
  constructor(
    private readonly files: ReadonlyMap<string, string>,
    private readonly unreadable: ReadonlySet<string> = new Set(),
  ) {}

  exists(path: string): ResultAsync<boolean, FileSystemError> {
    return okAsync(this.files.has(path) || this.unreadable.has(path));
  }

  readText(path: string): ResultAsync<string, FileSystemError> {
    if (this.unreadable.has(path))
      return errAsync({
        type: "FileSystemError",
        path,
        message: "permission denied",
      });
    const contents = this.files.get(path);
    if (contents === undefined)
      return errAsync({ type: "FileSystemError", path, message: "missing" });
    return okAsync(contents);
  }
}

describe("renderLedgerBlock", () => {
  it("renders a versioned, deterministic hidden block", () => {
    const rendered = render(
      block({
        changesets: [
          { id: "pi-settlement-budget", sourceDigest: SETTLEMENT_BUDGET },
          { id: "portable-delegation-limits", sourceDigest: PORTABLE_LIMITS },
        ],
      }),
    );

    expect(rendered).toBe(
      `<!-- ${LEDGER_BLOCK_MARKER}:${LEDGER_BLOCK_SCHEMA_VERSION}\n${JSON.stringify(
        {
          package: CLI,
          version: "0.1.0",
          changesets: [
            {
              id: "pi-settlement-budget",
              sourceDigest: SETTLEMENT_BUDGET,
            },
            {
              id: "portable-delegation-limits",
              sourceDigest: PORTABLE_LIMITS,
            },
          ],
        },
        null,
        2,
      )}\n-->`,
    );
  });

  it("orders identities by id regardless of input order", () => {
    const ascending = render(
      block({
        changesets: [
          { id: "alpha", sourceDigest: digest("alpha") },
          { id: "beta", sourceDigest: digest("beta") },
        ],
      }),
    );
    const descending = render(
      block({
        changesets: [
          { id: "beta", sourceDigest: digest("beta") },
          { id: "alpha", sourceDigest: digest("alpha") },
        ],
      }),
    );

    expect(descending).toBe(ascending);
  });

  it("rejects a block that repeats a changeset id", () => {
    const result = renderLedgerBlock(
      block({
        changesets: [
          { id: "alpha", sourceDigest: digest("alpha") },
          { id: "alpha", sourceDigest: digest("alpha") },
        ],
      }),
    );

    expect(result.isErr()).toBe(true);
    if (result.isOk()) return;
    expect(result.error.type).toBe("InvalidLedgerBlock");
  });

  it("rejects a block whose payload fails the schema", () => {
    const result = renderLedgerBlock({
      package: CLI,
      version: "0.1",
      changesets: [{ id: "alpha", sourceDigest: "not-a-digest" }],
    });

    expect(result.isErr()).toBe(true);
    if (result.isOk()) return;
    expect(result.error.issues.length).toBeGreaterThan(0);
  });
});

describe("parseConsumptionLedger", () => {
  it("round-trips a rendered block", () => {
    const ledger = parsed([
      changelog(CLI, [{ version: "0.1.0", body: render(block()) }]),
    ]);

    expect(ledger.records).toEqual([
      {
        identity: {
          id: "portable-delegation-limits",
          sourceDigest: PORTABLE_LIMITS,
        },
        packageName: CLI,
        version: "0.1.0",
      },
    ]);
    expect(
      ledger.identities.get("portable-delegation-limits")?.sourceDigest,
    ).toBe(PORTABLE_LIMITS);
  });

  it("reads the heading-only stub as an empty ledger", () => {
    const ledger = parsed([
      {
        packageName: CLI,
        path: "packages/cli/CHANGELOG.md",
        contents: `# ${CLI}\n`,
      },
    ]);

    expect(ledger).toEqual(EMPTY_CONSUMPTION_LEDGER);
  });

  it("ignores comments that are not ledger blocks", () => {
    const ledger = parsed([
      rawChangelog(CLI, "0.1.0", "<!-- release notes reviewed by hand -->"),
    ]);

    expect(ledger.records).toEqual([]);
  });

  it("accepts one shared changeset consumed by several packages", () => {
    const ledger = parsed([
      changelog(CLI, [{ version: "0.1.0", body: render(block()) }]),
      changelog(OPENCODE, [
        {
          version: "0.2.0",
          body: render(block({ package: OPENCODE, version: "0.2.0" })),
        },
      ]),
    ]);

    expect(ledger.records.map((record) => record.packageName)).toEqual([
      CLI,
      OPENCODE,
    ]);
    expect(ledger.identities.size).toBe(1);
  });

  it("orders records by package, then version, then id", () => {
    const ledger = parsed([
      changelog(PI, [
        {
          version: "0.2.0",
          body: render(
            block({
              package: PI,
              version: "0.2.0",
              changesets: [{ id: "later", sourceDigest: digest("later") }],
            }),
          ),
        },
        {
          version: "0.1.0",
          body: render(
            block({
              package: PI,
              version: "0.1.0",
              changesets: [
                { id: "second", sourceDigest: digest("second") },
                { id: "first", sourceDigest: digest("first") },
              ],
            }),
          ),
        },
      ]),
    ]);

    expect(ledger.records.map((record) => record.identity.id)).toEqual([
      "first",
      "second",
      "later",
    ]);
  });

  it("rejects a ledger comment that is never closed", () => {
    expect(
      failure([
        {
          packageName: CLI,
          path: "packages/cli/CHANGELOG.md",
          contents: `# ${CLI}\n\n## 0.1.0\n\n<!-- ${LEDGER_BLOCK_MARKER}:1\n{}\n`,
        },
      ]),
    ).toEqual({
      type: "MalformedLedgerBlock",
      path: "packages/cli/CHANGELOG.md",
      reason: "a ledger block comment is never closed",
    });
  });

  it("rejects a malformed block header", () => {
    const error = failure([
      rawChangelog(CLI, "0.1.0", `<!-- ${LEDGER_BLOCK_MARKER}:one\n{}\n-->`),
    ]);

    expect(error.type).toBe("MalformedLedgerBlock");
  });

  it("rejects an unsupported schema version", () => {
    const error = failure([
      rawChangelog(CLI, "0.1.0", `<!-- ${LEDGER_BLOCK_MARKER}:2\n{}\n-->`),
    ]);

    expect(error).toEqual({
      type: "UnsupportedLedgerSchema",
      path: `packages/${CLI}/CHANGELOG.md`,
      schemaVersion: 2,
    });
  });

  it("rejects a block whose payload is not JSON", () => {
    const error = failure([
      rawChangelog(
        CLI,
        "0.1.0",
        `<!-- ${LEDGER_BLOCK_MARKER}:1\nnot json\n-->`,
      ),
    ]);

    expect(error.type).toBe("InvalidLedgerJson");
  });

  it("rejects a payload that fails the schema", () => {
    const error = failure([
      rawChangelog(
        CLI,
        "0.1.0",
        `<!-- ${LEDGER_BLOCK_MARKER}:1\n${JSON.stringify({
          package: CLI,
          version: "0.1.0",
          changesets: [{ id: "alpha" }],
        })}\n-->`,
      ),
    ]);

    expect(error.type).toBe("InvalidLedgerRecord");
  });

  it("rejects an unknown package name in the payload", () => {
    const error = failure([
      rawChangelog(
        CLI,
        "0.1.0",
        `<!-- ${LEDGER_BLOCK_MARKER}:1\n${JSON.stringify({
          package: "@weaveio/weave-engine",
          version: "0.1.0",
          changesets: [{ id: "alpha", sourceDigest: digest("alpha") }],
        })}\n-->`,
      ),
    ]);

    expect(error.type).toBe("InvalidLedgerRecord");
  });

  it("rejects a block recorded under another package's changelog", () => {
    const error = failure([
      {
        ...changelog(OPENCODE, [{ version: "0.1.0", body: render(block()) }]),
      },
    ]);

    expect(error).toEqual({
      type: "LedgerPackageMismatch",
      path: `packages/${OPENCODE}/CHANGELOG.md`,
      expected: OPENCODE,
      actual: CLI,
    });
  });

  it("rejects a block that contradicts its version heading", () => {
    const error = failure([
      changelog(CLI, [{ version: "0.2.0", body: render(block()) }]),
    ]);

    expect(error).toEqual({
      type: "LedgerVersionMismatch",
      path: `packages/${CLI}/CHANGELOG.md`,
      blockVersion: "0.1.0",
      headingVersion: "0.2.0",
    });
  });

  it("rejects a block that precedes every version heading", () => {
    const error = failure([
      {
        packageName: CLI,
        path: "packages/cli/CHANGELOG.md",
        contents: `# ${CLI}\n\n${render(block())}\n`,
      },
    ]);

    expect(error).toEqual({
      type: "LedgerVersionMismatch",
      path: "packages/cli/CHANGELOG.md",
      blockVersion: "0.1.0",
      headingVersion: null,
    });
  });

  it("rejects a repeated block for one package and version", () => {
    const error = failure([
      changelog(CLI, [
        { version: "0.1.0", body: render(block()) },
        { version: "0.1.0", body: render(block()) },
      ]),
    ]);

    expect(error).toEqual({
      type: "DuplicateLedgerBlock",
      path: `packages/${CLI}/CHANGELOG.md`,
      packageName: CLI,
      version: "0.1.0",
    });
  });

  it("rejects one package consuming a changeset twice", () => {
    const error = failure([
      changelog(CLI, [
        { version: "0.2.0", body: render(block({ version: "0.2.0" })) },
        { version: "0.1.0", body: render(block()) },
      ]),
    ]);

    expect(error).toEqual({
      type: "DuplicateConsumedChangeset",
      id: "portable-delegation-limits",
      packageName: CLI,
      versions: ["0.2.0", "0.1.0"],
    });
  });

  it("rejects one changeset id recorded under two digests", () => {
    const error = failure([
      changelog(CLI, [{ version: "0.1.0", body: render(block()) }]),
      changelog(OPENCODE, [
        {
          version: "0.1.0",
          body: render(
            block({
              package: OPENCODE,
              changesets: [
                {
                  id: "portable-delegation-limits",
                  sourceDigest: digest("edited"),
                },
              ],
            }),
          ),
        },
      ]),
    ]);

    expect(error).toEqual({
      type: "ConflictingConsumedChangeset",
      id: "portable-delegation-limits",
      digests: [PORTABLE_LIMITS, digest("edited")],
    });
  });
});

describe("loadConsumptionLedger", () => {
  it("reads every public changelog under the root", async () => {
    const reader = new MemoryChangelogReader(
      new Map([
        [
          "/repo/packages/cli/CHANGELOG.md",
          changelog(CLI, [{ version: "0.1.0", body: render(block()) }])
            .contents,
        ],
        [
          "/repo/packages/adapters/pi/CHANGELOG.md",
          changelog(PI, [
            {
              version: "0.1.0",
              body: render(
                block({
                  package: PI,
                  changesets: [
                    {
                      id: "pi-settlement-budget",
                      sourceDigest: SETTLEMENT_BUDGET,
                    },
                  ],
                }),
              ),
            },
          ]).contents,
        ],
      ]),
    );

    const result = await loadConsumptionLedger(reader, "/repo");

    expect(result.isOk()).toBe(true);
    if (result.isErr()) return;
    expect(result.value.records.map((record) => record.identity.id)).toEqual([
      "portable-delegation-limits",
      "pi-settlement-budget",
    ]);
  });

  it("treats a missing changelog as no consumption", async () => {
    const result = await loadConsumptionLedger(
      new MemoryChangelogReader(new Map()),
      "/repo",
    );

    expect(result.isOk()).toBe(true);
    if (result.isErr()) return;
    expect(result.value).toEqual(EMPTY_CONSUMPTION_LEDGER);
  });

  it("fails typed when a changelog cannot be read", async () => {
    const result = await loadConsumptionLedger(
      new MemoryChangelogReader(
        new Map(),
        new Set(["/repo/packages/cli/CHANGELOG.md"]),
      ),
      "/repo",
    );

    expect(result.isErr()).toBe(true);
    if (result.isOk()) return;
    expect(result.error).toEqual({
      type: "ChangelogUnreadable",
      path: "/repo/packages/cli/CHANGELOG.md",
      message: "permission denied",
    });
  });
});
