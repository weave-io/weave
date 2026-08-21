import { afterAll, describe, expect, it } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { errAsync, okAsync, ResultAsync } from "neverthrow";
import {
  assertNoModifiedConsumption,
  BunChangesetCommandRunner,
  ChangesetConsumptionController,
  type ChangesetConsumptionError,
  PRESERVED_CHANGESET_DIRECTORY,
  partitionPendingBySelection,
  type ScratchCommandRunner,
  type ScratchPackageInput,
  type ScratchVersionRequest,
  type ScratchVersionResult,
  subtractConsumedLedger,
} from "../changeset-consumption.js";
import {
  BunChangesetFileSystem,
  type ChangesetIdentity,
  ChangesetPolicyValidator,
  type PublicImpactChangeset,
  type ValidatedChangeset,
} from "../changeset-policy.js";
import type { CommandResult } from "../command-runner.js";
import {
  PUBLIC_PACKAGE_NAMES,
  PUBLIC_PACKAGES,
  type PublicPackageName,
} from "../constants.js";
import {
  type ConsumptionLedger,
  EMPTY_CONSUMPTION_LEDGER,
  parseConsumptionLedger,
  renderLedgerBlock,
} from "../consumption-ledger.js";
import type { CommandError } from "../errors.js";

const CLI = "@weaveio/weave-cli";
const OPENCODE = "@weaveio/weave-adapter-opencode";
const CLAUDE_CODE = "@weaveio/weave-adapter-claude-code";
const PI = "@weaveio/weave-adapter-pi";

const CLI_AND_OPENCODE = `---
"${CLI}": minor
"${OPENCODE}": minor
---

Cap delegation with portable limits that every harness can enforce.
`;

const CLAUDE_CODE_MINOR = `---
"${CLAUDE_CODE}": minor
---

Translate harness-neutral permissions into Claude Code settings.
`;

const PI_PATCH = `---
"${PI}": patch
---

Renew the settlement budget while a child is still reporting activity.
`;

const ALL_FOUR_MINOR = `---
"${CLI}": minor
"${OPENCODE}": minor
"${CLAUDE_CODE}": minor
"${PI}": minor
---

Ship the inaugural harness-agnostic release.
`;

const EMPTY_CHANGESET = `---
---

Reason: contributor documentation only; no published artifact changes.
`;

const PRIVATE_TARGET = `---
"@weaveio/weave-engine": minor
---

Rework the engine boundary.
`;

const UNKNOWN_TARGET = `---
"@weaveio/weave-adapter-imaginary": minor
---

Add an adapter that does not exist.
`;

const createdDirectories: string[] = [];

afterAll(async () => {
  for (const directory of createdDirectories)
    await Bun.$`rm -rf ${directory}`.quiet();
});

/** Writes a disposable `.changeset`-shaped source directory. */
async function sourceDirectory(
  files: Readonly<Record<string, string>>,
): Promise<string> {
  const directory = join(
    tmpdir(),
    `weave-consumption-source-${crypto.randomUUID()}`,
  );
  createdDirectories.push(directory);
  for (const [name, contents] of Object.entries(files))
    await Bun.write(join(directory, name), contents);
  return directory;
}

async function digestsOf(
  directory: string,
): Promise<ReadonlyMap<string, string>> {
  const digests = new Map<string, string>();
  for (const name of await listFiles(directory)) {
    const bytes = await Bun.file(join(directory, name)).bytes();
    digests.set(
      name,
      new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
    );
  }
  return digests;
}

async function listFiles(directory: string): Promise<readonly string[]> {
  const found = await Array.fromAsync(
    new Bun.Glob("**/*").scan({ cwd: directory, dot: true, onlyFiles: true }),
  );
  return found.sort();
}

function controllerFor(
  runner: ScratchCommandRunner,
): ChangesetConsumptionController {
  return new ChangesetConsumptionController(
    new BunChangesetFileSystem(),
    undefined,
    runner,
  );
}

/** Parses a fixture through the real policy, so identities are real. */
function smuggledChangeset(packageName: string): PublicImpactChangeset {
  const changeset = changesetOf(".changeset/pi.md", PI_PATCH);
  if (changeset.kind !== "public-impact")
    throw new Error("fixture changeset is not public-impact");
  Object.defineProperty(changeset, "releases", {
    value: new Map([[packageName, "minor"]]),
    enumerable: true,
  });
  return changeset;
}

function changesetOf(path: string, source: string): ValidatedChangeset {
  const result = new ChangesetPolicyValidator(
    new BunChangesetFileSystem(),
  ).validateFile(path, new TextEncoder().encode(source));
  if (result.isErr())
    throw new Error(
      `Fixture changeset is invalid: ${JSON.stringify(result.error)}`,
    );
  return result.value;
}

async function pendingIn(
  directory: string,
  ledger: ConsumptionLedger = EMPTY_CONSUMPTION_LEDGER,
): Promise<readonly ValidatedChangeset[]> {
  const result = await controllerFor(new BunChangesetCommandRunner())
    .enumeratePendingChangesets(directory, ledger)
    .map((set) => set.pending);
  if (result.isErr())
    throw new Error(
      `Unexpected enumeration failure: ${JSON.stringify(result.error)}`,
    );
  return result.value;
}

/** Builds a ledger the way a published changelog records one. */
function ledgerOf(
  packageName: PublicPackageName,
  version: string,
  identities: readonly ChangesetIdentity[],
): ConsumptionLedger {
  const rendered = renderLedgerBlock({
    package: packageName,
    version,
    changesets: identities.map((identity) => ({
      id: identity.id,
      sourceDigest: identity.sourceDigest,
    })),
  });
  if (rendered.isErr())
    throw new Error(
      `Fixture ledger is invalid: ${JSON.stringify(rendered.error)}`,
    );
  const parsed = parseConsumptionLedger([
    {
      packageName,
      path: `${PUBLIC_PACKAGES[packageName].directory}/CHANGELOG.md`,
      contents: `# ${packageName}\n\n## ${version}\n\n${rendered.value}\n`,
    },
  ]);
  if (parsed.isErr())
    throw new Error(
      `Fixture ledger is unparsable: ${JSON.stringify(parsed.error)}`,
    );
  return parsed.value;
}

function catalogAt(
  version = "0.0.1",
  dependencies: Readonly<
    Partial<Record<PublicPackageName, readonly string[]>>
  > = {},
): readonly ScratchPackageInput[] {
  return PUBLIC_PACKAGE_NAMES.map((packageName) => ({
    packageName,
    version,
    dependencies: dependencies[packageName] ?? [],
  }));
}

function requestOf(
  overrides: Partial<ScratchVersionRequest> & {
    selected: readonly PublicPackageName[];
  },
): ScratchVersionRequest {
  return {
    packages: catalogAt(),
    consumedBySelection: [],
    preserved: [],
    ...overrides,
  };
}

/** Records what the staging tree held, then runs the real Changesets CLI. */
class RecordingRunner implements ScratchCommandRunner {
  readonly runs: { cwd: string; files: readonly string[] }[] = [];

  constructor(
    private readonly delegate: ScratchCommandRunner = new BunChangesetCommandRunner(),
  ) {}

  runChangesetVersion(cwd: string): ResultAsync<CommandResult, CommandError> {
    return ResultAsync.fromSafePromise(listFiles(cwd)).andThen((files) => {
      this.runs.push({ cwd, files });
      return this.delegate.runChangesetVersion(cwd);
    });
  }
}

/** Writes exactly the versions it is told to, instead of computing any. */
class ManifestWritingRunner implements ScratchCommandRunner {
  constructor(
    private readonly versions: Readonly<
      Partial<Record<PublicPackageName, string>>
    >,
    private readonly writeChangelog = true,
  ) {}

  runChangesetVersion(cwd: string): ResultAsync<CommandResult, CommandError> {
    return ResultAsync.fromSafePromise(this.write(cwd));
  }

  private async write(cwd: string): Promise<CommandResult> {
    for (const packageName of PUBLIC_PACKAGE_NAMES) {
      const version = this.versions[packageName];
      if (version === undefined) continue;
      const directory = PUBLIC_PACKAGES[packageName].directory;
      await Bun.write(
        join(cwd, directory, "package.json"),
        `${JSON.stringify({ name: packageName, version }, null, 2)}\n`,
      );
      if (!this.writeChangelog) continue;
      await Bun.write(
        join(cwd, directory, "CHANGELOG.md"),
        `# ${packageName}\n\n## ${version}\n`,
      );
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  }
}

class FailingRunner implements ScratchCommandRunner {
  readonly runs: string[] = [];

  runChangesetVersion(cwd: string): ResultAsync<CommandResult, CommandError> {
    this.runs.push(cwd);
    return errAsync({
      type: "CommandFailed",
      argv: ["bun", "changeset", "version"],
      exitCode: 1,
      stderr: "changeset version failed",
    });
  }
}

class UnusedRunner implements ScratchCommandRunner {
  calls = 0;

  runChangesetVersion(_cwd: string): ResultAsync<CommandResult, CommandError> {
    this.calls += 1;
    return okAsync({ exitCode: 0, stdout: "", stderr: "" });
  }
}

async function versionsOf(
  request: ScratchVersionRequest,
  runner: ScratchCommandRunner = new BunChangesetCommandRunner(),
): Promise<ScratchVersionResult> {
  const result = await controllerFor(runner).computeStableVersions(request);
  if (result.isErr())
    throw new Error(
      `Unexpected version failure: ${JSON.stringify(result.error)}`,
    );
  return result.value;
}

async function versionFailure(
  request: ScratchVersionRequest,
  runner: ScratchCommandRunner,
): Promise<ChangesetConsumptionError> {
  const result = await controllerFor(runner).computeStableVersions(request);
  if (result.isOk())
    throw new Error(`Expected a failure, got ${JSON.stringify(result.value)}`);
  return result.error;
}

describe("subtractConsumedLedger", () => {
  it("keeps changesets the ledger never recorded", () => {
    const pending = changesetOf(".changeset/pi.md", PI_PATCH);

    const set = subtractConsumedLedger({
      changesets: [pending],
      ledger: EMPTY_CONSUMPTION_LEDGER,
    });

    expect(set.pending).toEqual([pending]);
    expect(set.consumedPresent).toEqual([]);
    expect(set.modified).toEqual([]);
  });

  it("excludes a consumed changeset whose file is still present", () => {
    const consumed = changesetOf(".changeset/claude.md", CLAUDE_CODE_MINOR);
    const pending = changesetOf(".changeset/pi.md", PI_PATCH);

    const set = subtractConsumedLedger({
      changesets: [consumed, pending],
      ledger: ledgerOf(CLAUDE_CODE, "0.1.0", [consumed.identity]),
    });

    expect(set.pending).toEqual([pending]);
    expect(set.consumedPresent).toEqual([consumed]);
    expect(set.modified).toEqual([]);
  });

  it("flags a consumed changeset that was edited afterwards", () => {
    const consumed = changesetOf(".changeset/claude.md", CLAUDE_CODE_MINOR);
    const edited = changesetOf(
      ".changeset/claude.md",
      `${CLAUDE_CODE_MINOR}\nEdited after publication.\n`,
    );

    const set = subtractConsumedLedger({
      changesets: [edited],
      ledger: ledgerOf(CLAUDE_CODE, "0.1.0", [consumed.identity]),
    });

    expect(set.pending).toEqual([]);
    expect(set.consumedPresent).toEqual([]);
    expect(set.modified).toEqual([
      {
        id: "claude",
        path: ".changeset/claude.md",
        consumedDigest: consumed.identity.sourceDigest,
        currentDigest: edited.identity.sourceDigest,
      },
    ]);

    const asserted = assertNoModifiedConsumption(set);
    expect(asserted.isErr()).toBe(true);
    if (asserted.isOk()) return;
    expect(asserted.error).toEqual({
      type: "ConsumedChangesetModified",
      changesets: set.modified,
    });
  });
});

describe("enumeratePendingChangesets", () => {
  it("validates the directory and subtracts the ledger", async () => {
    const directory = await sourceDirectory({
      "claude-code-permissions.md": CLAUDE_CODE_MINOR,
      "pi-settlement-budget.md": PI_PATCH,
      "README.md": "# Changesets\n",
    });
    const consumed = changesetOf(
      join(directory, "claude-code-permissions.md"),
      CLAUDE_CODE_MINOR,
    );

    const result = await controllerFor(
      new BunChangesetCommandRunner(),
    ).enumeratePendingChangesets(
      directory,
      ledgerOf(CLAUDE_CODE, "0.1.0", [consumed.identity]),
    );

    expect(result.isOk()).toBe(true);
    if (result.isErr()) return;
    expect(
      result.value.pending.map((changeset) => changeset.identity.id),
    ).toEqual(["pi-settlement-budget"]);
    expect(
      result.value.consumedPresent.map((changeset) => changeset.identity.id),
    ).toEqual(["claude-code-permissions"]);
  });

  it("rejects a private bump target through the changeset policy", async () => {
    const directory = await sourceDirectory({ "private.md": PRIVATE_TARGET });

    const result = await controllerFor(
      new BunChangesetCommandRunner(),
    ).enumeratePendingChangesets(directory, EMPTY_CONSUMPTION_LEDGER);

    expect(result.isErr()).toBe(true);
    if (result.isOk()) return;
    if (result.error.type !== "ChangesetPolicy") throw new Error("wrong error");
    expect(result.error.errors).toEqual([
      {
        type: "PrivateTarget",
        path: join(directory, "private.md"),
        packageName: "@weaveio/weave-engine",
      },
    ]);
  });

  it("rejects an unknown bump target through the changeset policy", async () => {
    const directory = await sourceDirectory({ "unknown.md": UNKNOWN_TARGET });

    const result = await controllerFor(
      new BunChangesetCommandRunner(),
    ).enumeratePendingChangesets(directory, EMPTY_CONSUMPTION_LEDGER);

    expect(result.isErr()).toBe(true);
    if (result.isOk()) return;
    if (result.error.type !== "ChangesetPolicy") throw new Error("wrong error");
    expect(result.error.errors).toEqual([
      {
        type: "UnknownPackage",
        path: join(directory, "unknown.md"),
        packageName: "@weaveio/weave-adapter-imaginary",
      },
    ]);
  });
});

describe("partitionPendingBySelection", () => {
  it("consumes a changeset that releases a closure member", () => {
    const shared = changesetOf(".changeset/shared.md", CLI_AND_OPENCODE);
    const unrelated = changesetOf(".changeset/pi.md", PI_PATCH);
    const empty = changesetOf(".changeset/docs.md", EMPTY_CHANGESET);

    const result = partitionPendingBySelection({
      pending: [shared, unrelated, empty],
      selected: [CLI, OPENCODE],
    });

    expect(result.isOk()).toBe(true);
    if (result.isErr()) return;
    expect(
      result.value.consumedBySelection.map(
        (changeset) => changeset.identity.id,
      ),
    ).toEqual(["shared"]);
    expect(
      result.value.preserved.map((changeset) => changeset.identity.id),
    ).toEqual(["pi", "docs"]);
  });

  it("rejects a partially selected shared changeset", () => {
    const shared = changesetOf(".changeset/shared.md", CLI_AND_OPENCODE);

    const result = partitionPendingBySelection({
      pending: [shared],
      selected: [CLI],
    });

    expect(result.isErr()).toBe(true);
    if (result.isOk()) return;
    expect(result.error).toEqual({
      type: "PartialSharedChangeset",
      changesetId: "shared",
      missing: [OPENCODE],
    });
  });

  it("rejects an empty selection", () => {
    const result = partitionPendingBySelection({ pending: [], selected: [] });

    expect(result.isErr()).toBe(true);
    if (result.isOk()) return;
    expect(result.error).toEqual({ type: "EmptySelection" });
  });
});

describe("computeStableVersions", () => {
  it("raises 0.0.1 to 0.1.0 for a minor changeset", async () => {
    const directory = await sourceDirectory({
      "claude-code-permissions.md": CLAUDE_CODE_MINOR,
    });
    const pending = await pendingIn(directory);

    const result = await versionsOf(
      requestOf({ selected: [CLAUDE_CODE], consumedBySelection: pending }),
    );

    expect(result.packages).toHaveLength(1);
    const released = result.packages[0];
    expect(Object.keys(released ?? {}).sort()).toEqual([
      "packageName",
      "previousVersion",
      "rawChangelog",
      "version",
    ]);
    expect(released?.packageName).toBe(CLAUDE_CODE);
    expect(released?.previousVersion).toBe("0.0.1");
    expect(released?.version).toBe("0.1.0");
    expect(released?.rawChangelog).toContain("## 0.1.0");
    expect(released?.rawChangelog).toContain("### Minor Changes");
    expect(released?.rawChangelog).toContain(
      "Translate harness-neutral permissions into Claude Code settings.",
    );
  }, 30_000);

  it("produces exactly 0.1.0 for all four inaugural packages", async () => {
    const directory = await sourceDirectory({
      "inaugural-release.md": ALL_FOUR_MINOR,
    });
    const pending = await pendingIn(directory);

    const result = await versionsOf(
      requestOf({
        selected: [CLI, OPENCODE, CLAUDE_CODE, PI],
        consumedBySelection: pending,
      }),
    );

    expect(
      result.packages.map((released) => [
        released.packageName,
        released.version,
      ]),
    ).toEqual([
      [CLI, "0.1.0"],
      [OPENCODE, "0.1.0"],
      [CLAUDE_CODE, "0.1.0"],
      [PI, "0.1.0"],
    ]);
  }, 30_000);

  it("lets the Changesets CLI bump a dependent of a released package", async () => {
    const directory = await sourceDirectory({
      "pi-settlement-budget.md": PI_PATCH,
    });
    const pending = await pendingIn(directory);

    const result = await versionsOf(
      requestOf({
        packages: catalogAt("0.0.1", { [CLI]: [PI] }),
        selected: [CLI, PI],
        consumedBySelection: pending,
      }),
    );

    expect(
      result.packages.map((released) => [
        released.packageName,
        released.version,
      ]),
    ).toEqual([
      [CLI, "0.0.2"],
      [PI, "0.0.2"],
    ]);
    const cli = result.packages.find(
      (released) => released.packageName === CLI,
    );
    expect(cli?.rawChangelog).toContain("Updated dependencies");
  }, 30_000);

  it("stages only the consumed set and leaves preserved changesets untouched", async () => {
    const directory = await sourceDirectory({
      "claude-code-permissions.md": CLAUDE_CODE_MINOR,
      "pi-settlement-budget.md": PI_PATCH,
      "contributor-docs-only.md": EMPTY_CHANGESET,
    });
    const before = await digestsOf(directory);
    const pending = await pendingIn(directory);
    const partition = partitionPendingBySelection({
      pending,
      selected: [CLAUDE_CODE],
    });
    if (partition.isErr()) throw new Error("unexpected partition failure");
    const runner = new RecordingRunner();

    const result = await versionsOf(
      requestOf({
        selected: [CLAUDE_CODE],
        consumedBySelection: partition.value.consumedBySelection,
        preserved: partition.value.preserved,
      }),
      runner,
    );

    expect(result.packages.map((released) => released.packageName)).toEqual([
      CLAUDE_CODE,
    ]);
    const staged = runner.runs[0];
    expect(staged?.files).toEqual([
      `${PRESERVED_CHANGESET_DIRECTORY}/contributor-docs-only.md`,
      `${PRESERVED_CHANGESET_DIRECTORY}/pi-settlement-budget.md`,
      ".changeset/claude-code-permissions.md",
      ".changeset/config.json",
      "package.json",
      "packages/adapters/claude-code/package.json",
      "packages/adapters/opencode/package.json",
      "packages/adapters/pi/package.json",
      "packages/cli/package.json",
    ]);
    expect(await digestsOf(directory)).toEqual(before);
  }, 30_000);

  it("discards the staging tree, so its changeset deletions reach nothing", async () => {
    const directory = await sourceDirectory({
      "claude-code-permissions.md": CLAUDE_CODE_MINOR,
    });
    const pending = await pendingIn(directory);
    const runner = new RecordingRunner();

    await versionsOf(
      requestOf({ selected: [CLAUDE_CODE], consumedBySelection: pending }),
      runner,
    );

    const staged = runner.runs[0];
    expect(staged?.files).toContain(".changeset/claude-code-permissions.md");
    expect(
      await Bun.file(join(staged?.cwd ?? "", "package.json")).exists(),
    ).toBe(false);
    expect(await listFiles(directory)).toEqual(["claude-code-permissions.md"]);
  }, 30_000);

  it("never bumps a ledger-consumed changeset that is still present", async () => {
    const directory = await sourceDirectory({
      "claude-code-permissions.md": CLAUDE_CODE_MINOR,
      "pi-settlement-budget.md": PI_PATCH,
    });
    const consumed = changesetOf(
      join(directory, "claude-code-permissions.md"),
      CLAUDE_CODE_MINOR,
    );
    const pending = await pendingIn(
      directory,
      ledgerOf(CLAUDE_CODE, "0.1.0", [consumed.identity]),
    );

    const result = await versionsOf(
      requestOf({ selected: [PI], consumedBySelection: pending }),
    );

    expect(
      result.packages.map((released) => [
        released.packageName,
        released.version,
      ]),
    ).toEqual([[PI, "0.0.2"]]);
  }, 30_000);

  it("rejects a changeset whose bytes changed after it was identified", async () => {
    const runner = new UnusedRunner();
    const directory = await sourceDirectory({
      "claude-code-permissions.md": CLAUDE_CODE_MINOR,
    });
    const pending = await pendingIn(directory);
    const identified = pending[0];
    await Bun.write(
      join(directory, "claude-code-permissions.md"),
      `${CLAUDE_CODE_MINOR}\nEdited after the pending set was computed.\n`,
    );

    const error = await versionFailure(
      requestOf({ selected: [CLAUDE_CODE], consumedBySelection: pending }),
      runner,
    );

    expect(error).toEqual({
      type: "ChangesetSourceChanged",
      changesetId: "claude-code-permissions",
      path: join(directory, "claude-code-permissions.md"),
      expected: identified?.identity.sourceDigest ?? "",
      actual: new Bun.CryptoHasher("sha256")
        .update(
          await Bun.file(join(directory, "claude-code-permissions.md")).bytes(),
        )
        .digest("hex"),
    });
    expect(runner.calls).toBe(0);
  });

  it("rejects a private bump target that never passed the policy", async () => {
    const runner = new UnusedRunner();
    const smuggled = smuggledChangeset("@weaveio/weave-engine");

    const error = await versionFailure(
      requestOf({ selected: [PI], consumedBySelection: [smuggled] }),
      runner,
    );

    expect(error).toEqual({
      type: "InvalidBumpTarget",
      changesetId: "pi",
      packageName: "@weaveio/weave-engine",
      reason: "PrivateWorkspace",
    });
    expect(runner.calls).toBe(0);
  });

  it("rejects an unknown bump target that never passed the policy", async () => {
    const runner = new UnusedRunner();
    const smuggled = smuggledChangeset("@weaveio/weave-adapter-imaginary");

    const error = await versionFailure(
      requestOf({ selected: [PI], consumedBySelection: [smuggled] }),
      runner,
    );

    expect(error).toEqual({
      type: "InvalidBumpTarget",
      changesetId: "pi",
      packageName: "@weaveio/weave-adapter-imaginary",
      reason: "UnknownPackage",
    });
    expect(runner.calls).toBe(0);
  });

  it("rejects a preserved changeset that releases a selected package", async () => {
    const runner = new UnusedRunner();
    const preserved = changesetOf(".changeset/pi.md", PI_PATCH);

    const error = await versionFailure(
      requestOf({ selected: [PI], preserved: [preserved] }),
      runner,
    );

    expect(error).toEqual({
      type: "PreservedChangesetAffectsSelection",
      changesetId: "pi",
      packageName: PI,
    });
    expect(runner.calls).toBe(0);
  });

  it("rejects a staging catalog that omits a public package", async () => {
    const runner = new UnusedRunner();

    const error = await versionFailure(
      requestOf({
        selected: [PI],
        packages: catalogAt().filter(
          (scratchPackage) => scratchPackage.packageName !== OPENCODE,
        ),
      }),
      runner,
    );

    expect(error).toEqual({
      type: "InvalidScratchCatalog",
      packageName: OPENCODE,
      reason: "missing",
    });
    expect(runner.calls).toBe(0);
  });

  it("reports a failed Changesets CLI run and still discards the tree", async () => {
    const runner = new FailingRunner();
    const directory = await sourceDirectory({
      "claude-code-permissions.md": CLAUDE_CODE_MINOR,
    });
    const pending = await pendingIn(directory);

    const error = await versionFailure(
      requestOf({ selected: [CLAUDE_CODE], consumedBySelection: pending }),
      runner,
    );

    expect(error).toEqual({
      type: "ScratchCommandFailed",
      error: {
        type: "CommandFailed",
        argv: ["bun", "changeset", "version"],
        exitCode: 1,
        stderr: "changeset version failed",
      },
    });
    expect(
      await Bun.file(join(runner.runs[0] ?? "", "package.json")).exists(),
    ).toBe(false);
  });

  it("rejects a version bump outside the selection", async () => {
    const error = await versionFailure(
      requestOf({ selected: [CLAUDE_CODE] }),
      new ManifestWritingRunner({
        [CLAUDE_CODE]: "0.1.0",
        [OPENCODE]: "0.1.0",
      }),
    );

    expect(error).toEqual({
      type: "UnselectedVersionBump",
      packageName: OPENCODE,
      version: "0.1.0",
    });
  });

  it("rejects a selected package the run never versioned", async () => {
    const error = await versionFailure(
      requestOf({ selected: [CLAUDE_CODE] }),
      new ManifestWritingRunner({}),
    );

    expect(error).toEqual({
      type: "ClosureMemberNotVersioned",
      packageName: CLAUDE_CODE,
    });
  });

  it("rejects a released package with no generated changelog", async () => {
    const error = await versionFailure(
      requestOf({ selected: [CLAUDE_CODE] }),
      new ManifestWritingRunner({ [CLAUDE_CODE]: "0.1.0" }, false),
    );

    expect(error).toEqual({
      type: "ScratchChangelogMissing",
      packageName: CLAUDE_CODE,
    });
  });
});

describe("BunChangesetCommandRunner", () => {
  it("refuses a working directory outside an absolute plain path", async () => {
    const result = await new BunChangesetCommandRunner().runChangesetVersion(
      "relative/scratch",
    );

    expect(result.isErr()).toBe(true);
    if (result.isOk()) return;
    expect(result.error.type).toBe("CommandRejected");
  });

  it("runs only the configured Changesets CLI entry point", async () => {
    const result = await new BunChangesetCommandRunner(
      "/does/not/exist/changeset",
      "/does/not/exist/bun",
    ).runChangesetVersion(tmpdir());

    expect(result.isErr()).toBe(true);
    if (result.isOk()) return;
    expect(result.error.type).toBe("CommandSpawnFailed");
  });
});
