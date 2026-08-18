/**
 * Ledger-aware pending-set computation and stable version math.
 *
 * Three questions live here, in order:
 *
 * 1. **What is still pending?** Every `.changeset/*.md` file is validated and
 *    identified by the changeset policy, then the consumption ledger is
 *    subtracted. A file whose ID a published version already recorded is
 *    logically consumed and leaves the pending set even though it still sits
 *    on `main` — that is what stops a release from double-bumping while the
 *    cleanup PR is outstanding. A present file whose bytes no longer match the
 *    recorded digest is flagged {@link ModifiedConsumedChangeset} and is
 *    processed by nothing.
 * 2. **What does this release consume?** The pending set is partitioned
 *    against the selection closure: a changeset that releases any closure
 *    member is consumed by this release, everything else is preserved. A
 *    changeset is atomic, so a partially selected one is a typed failure
 *    rather than a partial consumption.
 * 3. **Which versions does that produce?** The Changesets CLI answers, never a
 *    reimplementation of its bump semantics. `changeset version` runs inside a
 *    disposable staging tree whose `.changeset/` holds exactly the consumed
 *    set; preserved files are relocated into a sibling holding directory, so
 *    the CLI can neither read nor delete them. The real worktree is never
 *    written to, and the run's deletions die with the staging tree: only
 *    manifest versions and the raw generated changelog material are read out.
 *
 * The raw changelog text is material for the canonical changelog format, not a
 * format this module defines or validates.
 *
 * `command-runner.ts` owns the argv-shaped command contract this module runs
 * under — {@link CommandResult} and {@link CommandError} — but its
 * `BunCommandRunner` is an npm-only allowlist that always runs in the process
 * working directory. Placing a run inside the staging tree needs a working
 * directory, so {@link BunChangesetCommandRunner} implements the same contract
 * with its own single-command allowlist.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import { err, errAsync, ok, okAsync, Result, ResultAsync } from "neverthrow";
import {
  BunChangesetFileSystem,
  type ChangesetFileSystem,
  type ChangesetIdentity,
  type ChangesetPolicyError,
  ChangesetPolicyValidator,
  type PublicImpactChangeset,
  type ValidatedChangeset,
} from "./changeset-policy.js";
import type { CommandResult } from "./command-runner.js";
import { PUBLIC_PACKAGES, type PublicPackageName } from "./constants.js";
import type { ConsumptionLedger } from "./consumption-ledger.js";
import type { CommandError, FileSystemError } from "./errors.js";
import { BunFileSystem, type FileSystem } from "./filesystem.js";
import {
  type PublishabilityError,
  publishablePackageNames,
  resolvePublishablePackage,
} from "./package-policy.js";

/** Marks every staging tree this module creates, and may delete. */
export const SCRATCH_DIRECTORY_PREFIX = "weave-release-scratch-" as const;

/** Where preserved changesets wait, out of the Changesets CLI's reach. */
export const PRESERVED_CHANGESET_DIRECTORY = ".changeset-preserved" as const;

/** The Changesets CLI entry point the staging run drives. */
export const DEFAULT_CHANGESET_CLI_PATH = join(
  import.meta.dir,
  "..",
  "..",
  "node_modules",
  ".bin",
  "changeset",
);

const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const COMMAND_METACHARACTERS = /[;&|`$<>\n\r]/;

/** A consumed changeset whose file on `main` no longer matches the ledger. */
export interface ModifiedConsumedChangeset {
  id: string;
  path: string;
  consumedDigest: string;
  currentDigest: string;
}

/** The pending set, after the ledger is subtracted. */
export interface PendingChangesetSet {
  /** Everything a release may still consume. */
  pending: readonly ValidatedChangeset[];
  /** Logically consumed, still on `main`, awaiting the cleanup PR. */
  consumedPresent: readonly ValidatedChangeset[];
  /** Consumed but edited since; excluded from every downstream set. */
  modified: readonly ModifiedConsumedChangeset[];
}

/** The pending set split by what this release's closure consumes. */
export interface PendingPartition {
  consumedBySelection: readonly PublicImpactChangeset[];
  preserved: readonly ValidatedChangeset[];
}

/** One public package as it stands in the source tree. */
export interface ScratchPackageInput {
  packageName: PublicPackageName;
  /** The current source manifest version. */
  version: string;
  /** Workspace dependency names; non-catalog names are ignored. */
  dependencies?: readonly string[];
}

export interface ScratchVersionRequest {
  /** Every catalog package, exactly once. */
  packages: readonly ScratchPackageInput[];
  /** The selection closure's members. */
  selected: readonly PublicPackageName[];
  /** The pending changesets this release consumes. */
  consumedBySelection: readonly ValidatedChangeset[];
  /** The pending changesets this release leaves alone. */
  preserved: readonly ValidatedChangeset[];
}

/** One released package's version move and the material behind it. */
export interface ScratchPackageVersion {
  packageName: PublicPackageName;
  previousVersion: string;
  version: string;
  /** Raw Changesets CLI changelog output; not a canonical changelog. */
  rawChangelog: string;
}

/** Everything the staging tree is allowed to hand back. */
export interface ScratchVersionResult {
  packages: readonly ScratchPackageVersion[];
}

export type ChangesetConsumptionError =
  | { type: "ChangesetPolicy"; errors: readonly ChangesetPolicyError[] }
  | {
      type: "ConsumedChangesetModified";
      changesets: readonly ModifiedConsumedChangeset[];
    }
  | { type: "EmptySelection" }
  | {
      type: "InvalidSelection";
      packageName: string;
      reason: PublishabilityError["type"] | "duplicate";
    }
  | {
      type: "InvalidScratchCatalog";
      packageName: string;
      reason: "missing" | "duplicate" | "unknown";
    }
  | {
      type: "InvalidScratchVersion";
      packageName: PublicPackageName;
      version: string;
    }
  | {
      type: "InvalidBumpTarget";
      changesetId: string;
      packageName: string;
      reason: PublishabilityError["type"];
    }
  | { type: "NonReleasingChangesetSelected"; changesetId: string }
  | {
      type: "PartialSharedChangeset";
      changesetId: string;
      missing: readonly PublicPackageName[];
    }
  | {
      type: "PreservedChangesetAffectsSelection";
      changesetId: string;
      packageName: PublicPackageName;
    }
  | {
      type: "ChangesetSourceUnreadable";
      changesetId: string;
      path: string;
      error: ChangesetPolicyError;
    }
  | {
      type: "ChangesetSourceChanged";
      changesetId: string;
      path: string;
      expected: string;
      actual: string;
    }
  | {
      type: "ScratchFileSystem";
      operation: "read" | "write" | "remove";
      error: FileSystemError;
    }
  | { type: "ScratchCommandFailed"; error: CommandError }
  | {
      type: "ScratchManifestInvalid";
      packageName: PublicPackageName;
      reason: string;
    }
  | { type: "ScratchChangelogMissing"; packageName: PublicPackageName }
  | {
      type: "UnselectedVersionBump";
      packageName: PublicPackageName;
      version: string;
    }
  | { type: "ClosureMemberNotVersioned"; packageName: PublicPackageName }
  | {
      type: "PreservedChangesetMutated";
      changesetId: string;
      expected: string;
      actual: string;
    };

/**
 * Subtracts the ledger from the validated changeset files.
 *
 * Total by construction: a modified consumption is reported, never thrown, so
 * one edited file cannot hide the rest of the pending set.
 */
export function subtractConsumedLedger(input: {
  changesets: readonly ValidatedChangeset[];
  ledger: ConsumptionLedger;
}): PendingChangesetSet {
  const pending: ValidatedChangeset[] = [];
  const consumedPresent: ValidatedChangeset[] = [];
  const modified: ModifiedConsumedChangeset[] = [];
  for (const changeset of input.changesets) {
    const consumed = input.ledger.identities.get(changeset.identity.id);
    if (consumed === undefined) {
      pending.push(changeset);
      continue;
    }
    if (consumed.sourceDigest === changeset.identity.sourceDigest) {
      consumedPresent.push(changeset);
      continue;
    }
    modified.push({
      id: changeset.identity.id,
      path: changeset.path,
      consumedDigest: consumed.sourceDigest,
      currentDigest: changeset.identity.sourceDigest,
    });
  }
  return { pending, consumedPresent, modified };
}

/** Turns a modified consumption into the typed failure gates report. */
export function assertNoModifiedConsumption(
  set: PendingChangesetSet,
): Result<void, ChangesetConsumptionError> {
  if (set.modified.length === 0) return ok(undefined);
  return err({ type: "ConsumedChangesetModified", changesets: set.modified });
}

/**
 * Splits the pending set against the closure.
 *
 * A changeset that releases some — but not all — of its packages into this
 * selection would be consumed for one member and preserved for another, which
 * is why the closure exists. Reaching that state is a typed failure.
 */
export function partitionPendingBySelection(input: {
  pending: readonly ValidatedChangeset[];
  selected: readonly PublicPackageName[];
}): Result<PendingPartition, ChangesetConsumptionError> {
  const selected = resolveSelection(input.selected);
  if (selected.isErr()) return err(selected.error);
  const consumedBySelection: PublicImpactChangeset[] = [];
  const preserved: ValidatedChangeset[] = [];
  for (const changeset of input.pending) {
    if (changeset.kind === "empty") {
      preserved.push(changeset);
      continue;
    }
    const members = [...changeset.releases.keys()];
    const missing = members.filter((member) => !selected.value.has(member));
    if (missing.length === members.length) {
      preserved.push(changeset);
      continue;
    }
    if (missing.length > 0)
      return err({
        type: "PartialSharedChangeset",
        changesetId: changeset.identity.id,
        missing,
      });
    consumedBySelection.push(changeset);
  }
  return ok({ consumedBySelection, preserved });
}

/** Recursive removal, which the staging tree needs and `FileSystem` lacks. */
export interface ScratchTreeFileSystem extends FileSystem {
  writeBytes(
    path: string,
    contents: Uint8Array,
  ): ResultAsync<void, FileSystemError>;
  removeTree(path: string): ResultAsync<void, FileSystemError>;
}

export class BunScratchTreeFileSystem
  extends BunFileSystem
  implements ScratchTreeFileSystem
{
  writeBytes(
    path: string,
    contents: Uint8Array,
  ): ResultAsync<void, FileSystemError> {
    return ResultAsync.fromPromise(
      Bun.write(path, contents).then(() => undefined),
      (cause) => ({ type: "FileSystemError", path, message: String(cause) }),
    );
  }

  /** Refuses any path this module did not create. */
  removeTree(path: string): ResultAsync<void, FileSystemError> {
    if (!path.includes(SCRATCH_DIRECTORY_PREFIX))
      return errAsync({
        type: "FileSystemError",
        path,
        message: "refused to remove a directory outside the staging tree",
      });
    return ResultAsync.fromPromise(
      Bun.$`rm -rf ${path}`.quiet().then(() => undefined),
      (cause) => ({ type: "FileSystemError", path, message: String(cause) }),
    );
  }
}

/** Runs one command inside the staging tree. */
export interface ScratchCommandRunner {
  runChangesetVersion(cwd: string): ResultAsync<CommandResult, CommandError>;
}

/** Runs only `changeset version`, only in a caller-supplied directory. */
export class BunChangesetCommandRunner implements ScratchCommandRunner {
  constructor(
    private readonly cliPath = DEFAULT_CHANGESET_CLI_PATH,
    private readonly executable = process.execPath,
    private readonly maxOutputBytes = 64 * 1024,
  ) {}

  runChangesetVersion(cwd: string): ResultAsync<CommandResult, CommandError> {
    const argv = [this.executable, this.cliPath, "version"];
    const rejected = this.validate(cwd, argv);
    if (rejected !== undefined)
      return errAsync({ type: "CommandRejected", argv, reason: rejected });
    return ResultAsync.fromPromise(this.spawn(cwd, argv), (cause) => ({
      type: "CommandSpawnFailed" as const,
      argv,
      message: String(cause),
    })).andThen((result) => {
      if (result.exitCode === 0) return okAsync(result);
      return errAsync({
        type: "CommandFailed" as const,
        argv,
        exitCode: result.exitCode,
        stderr: result.stderr,
      });
    });
  }

  private validate(cwd: string, argv: readonly string[]): string | undefined {
    if (!cwd.startsWith("/") || COMMAND_METACHARACTERS.test(cwd))
      return "the working directory must be a plain absolute path";
    if (argv.some((part) => part.length === 0))
      return "every argv value must be non-empty";
    if (argv[0] !== this.executable || argv[1] !== this.cliPath)
      return "only the configured Changesets CLI may run";
    if (argv.length !== 3 || argv[2] !== "version")
      return "only changeset version may run";
    return undefined;
  }

  private async spawn(
    cwd: string,
    argv: readonly string[],
  ): Promise<CommandResult> {
    const child = Bun.spawn([...argv], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return {
      exitCode,
      stdout: stdout.slice(0, this.maxOutputBytes),
      stderr: stderr.slice(0, this.maxOutputBytes),
    };
  }
}

interface ResolvedScratchPackage {
  packageName: PublicPackageName;
  directory: string;
  version: string;
  dependencies: readonly PublicPackageName[];
}

interface ScratchPlan {
  packages: readonly ResolvedScratchPackage[];
  selected: readonly PublicPackageName[];
  consumed: readonly ValidatedChangeset[];
  preserved: readonly ValidatedChangeset[];
}

interface StagedChangeset {
  identity: ChangesetIdentity;
  bytes: Uint8Array;
}

interface StagedSources {
  consumed: readonly StagedChangeset[];
  preserved: readonly StagedChangeset[];
}

interface StagedVersion {
  scratchPackage: ResolvedScratchPackage;
  version: string;
}

/**
 * Reads the pending set and computes the versions a release would produce.
 *
 * Every side effect is injected: the changeset files are read through the
 * policy's filesystem port, the staging tree through its own port, and the
 * Changesets CLI through a command runner.
 */
export class ChangesetConsumptionController {
  private readonly validator: ChangesetPolicyValidator;

  constructor(
    private readonly changesetFiles: ChangesetFileSystem = new BunChangesetFileSystem(),
    private readonly scratch: ScratchTreeFileSystem = new BunScratchTreeFileSystem(),
    private readonly runner: ScratchCommandRunner = new BunChangesetCommandRunner(),
  ) {
    this.validator = new ChangesetPolicyValidator(changesetFiles);
  }

  /**
   * Validates every `.changeset/*.md` file in `directory` and subtracts the
   * ledger. A private or unknown bump target fails here, in the policy.
   */
  enumeratePendingChangesets(
    directory: string,
    ledger: ConsumptionLedger,
  ): ResultAsync<PendingChangesetSet, ChangesetConsumptionError> {
    return this.validator
      .validateDirectory(directory)
      .mapErr(
        (errors): ChangesetConsumptionError => ({
          type: "ChangesetPolicy",
          errors,
        }),
      )
      .map((changesets) => subtractConsumedLedger({ changesets, ledger }));
  }

  /**
   * Computes each selected package's next stable version by running
   * `changeset version` over the consumed set alone, in a staging tree that is
   * discarded whatever the outcome.
   */
  computeStableVersions(
    request: ScratchVersionRequest,
  ): ResultAsync<ScratchVersionResult, ChangesetConsumptionError> {
    const plan = planScratchRun(request);
    if (plan.isErr()) return errAsync(plan.error);
    return this.readSources(plan.value).andThen((sources) =>
      this.runInStagingTree(plan.value, sources),
    );
  }

  private runInStagingTree(
    plan: ScratchPlan,
    sources: StagedSources,
  ): ResultAsync<ScratchVersionResult, ChangesetConsumptionError> {
    const root = join(
      tmpdir(),
      `${SCRATCH_DIRECTORY_PREFIX}${crypto.randomUUID()}`,
    );
    const work = this.stage(root, plan, sources)
      .andThen(() =>
        this.runner.runChangesetVersion(root).mapErr(
          (error): ChangesetConsumptionError => ({
            type: "ScratchCommandFailed",
            error,
          }),
        ),
      )
      .andThen(() => this.readVersions(root, plan))
      .andThen((result) =>
        this.verifyPreserved(root, sources.preserved).map(() => result),
      );
    return work
      .andThen((result) => this.discard(root).map(() => result))
      .orElse((error) => this.discard(root).andThen(() => errAsync(error)));
  }

  /** Reads each changeset's exact bytes and proves they still match its ID. */
  private readSources(
    plan: ScratchPlan,
  ): ResultAsync<StagedSources, ChangesetConsumptionError> {
    return this.readChangesetGroup(plan.consumed).andThen((consumed) =>
      this.readChangesetGroup(plan.preserved).map((preserved) => ({
        consumed,
        preserved,
      })),
    );
  }

  private readChangesetGroup(
    changesets: readonly ValidatedChangeset[],
  ): ResultAsync<readonly StagedChangeset[], ChangesetConsumptionError> {
    let staged: ResultAsync<
      readonly StagedChangeset[],
      ChangesetConsumptionError
    > = okAsync([]);
    for (const changeset of changesets)
      staged = staged.andThen((collected) =>
        this.changesetFiles
          .readBytes(changeset.path)
          .mapErr(
            (error): ChangesetConsumptionError => ({
              type: "ChangesetSourceUnreadable",
              changesetId: changeset.identity.id,
              path: changeset.path,
              error,
            }),
          )
          .andThen((bytes) => {
            const digest = digestOf(bytes);
            if (digest !== changeset.identity.sourceDigest)
              return errAsync<
                readonly StagedChangeset[],
                ChangesetConsumptionError
              >({
                type: "ChangesetSourceChanged",
                changesetId: changeset.identity.id,
                path: changeset.path,
                expected: changeset.identity.sourceDigest,
                actual: digest,
              });
            return okAsync([
              ...collected,
              { identity: changeset.identity, bytes },
            ]);
          }),
      );
    return staged;
  }

  /**
   * Writes the staging tree: a workspace root holding only the four public
   * manifests, the consumed changesets, and the preserved ones parked outside
   * `.changeset/` where the CLI cannot reach them.
   */
  private stage(
    root: string,
    plan: ScratchPlan,
    sources: StagedSources,
  ): ResultAsync<void, ChangesetConsumptionError> {
    const texts: { path: string; contents: string }[] = [
      { path: join(root, "package.json"), contents: rootManifest(plan) },
      {
        path: join(root, ".changeset", "config.json"),
        contents: changesetsConfig(),
      },
    ];
    for (const scratchPackage of plan.packages)
      texts.push({
        path: join(root, scratchPackage.directory, "package.json"),
        contents: packageManifest(scratchPackage),
      });
    const files: { path: string; bytes: Uint8Array }[] = [];
    for (const staged of sources.consumed)
      files.push({
        path: join(root, ".changeset", `${staged.identity.id}.md`),
        bytes: staged.bytes,
      });
    for (const staged of sources.preserved)
      files.push({
        path: join(
          root,
          PRESERVED_CHANGESET_DIRECTORY,
          `${staged.identity.id}.md`,
        ),
        bytes: staged.bytes,
      });
    let written: ResultAsync<void, ChangesetConsumptionError> =
      okAsync(undefined);
    for (const text of texts)
      written = written.andThen(() =>
        this.scratch
          .writeText(text.path, text.contents)
          .mapErr((error) => scratchFailure("write", error)),
      );
    for (const file of files)
      written = written.andThen(() =>
        this.scratch
          .writeBytes(file.path, file.bytes)
          .mapErr((error) => scratchFailure("write", error)),
      );
    return written;
  }

  /**
   * Reads what the run produced: every package's staged version first, so an
   * unexpected or missing bump is reported as such, and the changelog material
   * only for the packages the release actually moves.
   */
  private readVersions(
    root: string,
    plan: ScratchPlan,
  ): ResultAsync<ScratchVersionResult, ChangesetConsumptionError> {
    let read: ResultAsync<readonly StagedVersion[], ChangesetConsumptionError> =
      okAsync([]);
    for (const scratchPackage of plan.packages)
      read = read.andThen((collected) =>
        this.readManifestVersion(root, scratchPackage).map((version) => [
          ...collected,
          { scratchPackage, version },
        ]),
      );
    return read
      .andThen((versions) => verifyBumpedSet(plan, versions))
      .andThen((released) => this.attachChangelogs(root, released));
  }

  private readManifestVersion(
    root: string,
    scratchPackage: ResolvedScratchPackage,
  ): ResultAsync<string, ChangesetConsumptionError> {
    return this.scratch
      .readText(join(root, scratchPackage.directory, "package.json"))
      .mapErr((error) => scratchFailure("read", error))
      .andThen((contents) =>
        parseManifestVersion(scratchPackage.packageName, contents),
      );
  }

  private attachChangelogs(
    root: string,
    released: readonly StagedVersion[],
  ): ResultAsync<ScratchVersionResult, ChangesetConsumptionError> {
    let read: ResultAsync<
      readonly ScratchPackageVersion[],
      ChangesetConsumptionError
    > = okAsync([]);
    for (const staged of released)
      read = read.andThen((collected) =>
        this.readChangelog(
          staged.scratchPackage.packageName,
          join(root, staged.scratchPackage.directory, "CHANGELOG.md"),
        ).map((rawChangelog) => [
          ...collected,
          {
            packageName: staged.scratchPackage.packageName,
            previousVersion: staged.scratchPackage.version,
            version: staged.version,
            rawChangelog,
          },
        ]),
      );
    return read.map((packages) => ({ packages }));
  }

  private readChangelog(
    packageName: PublicPackageName,
    path: string,
  ): ResultAsync<string, ChangesetConsumptionError> {
    return this.scratch
      .exists(path)
      .mapErr((error) => scratchFailure("read", error))
      .andThen((exists) => {
        if (!exists)
          return errAsync<string, ChangesetConsumptionError>({
            type: "ScratchChangelogMissing",
            packageName,
          });
        return this.scratch
          .readText(path)
          .mapErr((error) => scratchFailure("read", error));
      });
  }

  /** Proves the CLI never touched the relocated files. */
  private verifyPreserved(
    root: string,
    preserved: readonly StagedChangeset[],
  ): ResultAsync<void, ChangesetConsumptionError> {
    let verified: ResultAsync<void, ChangesetConsumptionError> =
      okAsync(undefined);
    for (const staged of preserved) {
      const path = join(
        root,
        PRESERVED_CHANGESET_DIRECTORY,
        `${staged.identity.id}.md`,
      );
      verified = verified.andThen(() =>
        this.scratch
          .readBytes(path)
          .mapErr((error) => scratchFailure("read", error))
          .andThen((bytes) => {
            const digest = digestOf(bytes);
            if (digest === staged.identity.sourceDigest) return ok(undefined);
            return err<void, ChangesetConsumptionError>({
              type: "PreservedChangesetMutated",
              changesetId: staged.identity.id,
              expected: staged.identity.sourceDigest,
              actual: digest,
            });
          }),
      );
    }
    return verified;
  }

  /**
   * Discards the staging tree and everything the CLI did inside it, including
   * its `.changeset` deletions. Cleanup never turns a computed release into a
   * failure, so its own error is dropped deliberately.
   */
  private discard(root: string): ResultAsync<void, never> {
    return this.scratch.removeTree(root).orElse(() => okAsync(undefined));
  }
}

/** Validates the request before anything is written or spawned. */
function planScratchRun(
  request: ScratchVersionRequest,
): Result<ScratchPlan, ChangesetConsumptionError> {
  const selected = resolveSelection(request.selected);
  if (selected.isErr()) return err(selected.error);
  const packages = resolvePackages(request.packages);
  if (packages.isErr()) return err(packages.error);
  for (const changeset of request.consumedBySelection) {
    const targets = validateBumpTargets(changeset);
    if (targets.isErr()) return err(targets.error);
    if (changeset.kind === "empty")
      return err({
        type: "NonReleasingChangesetSelected",
        changesetId: changeset.identity.id,
      });
    const missing = [...changeset.releases.keys()].filter(
      (member) => !selected.value.has(member),
    );
    if (missing.length > 0)
      return err({
        type: "PartialSharedChangeset",
        changesetId: changeset.identity.id,
        missing,
      });
  }
  for (const changeset of request.preserved) {
    const targets = validateBumpTargets(changeset);
    if (targets.isErr()) return err(targets.error);
    if (changeset.kind === "empty") continue;
    for (const member of changeset.releases.keys())
      if (selected.value.has(member))
        return err({
          type: "PreservedChangesetAffectsSelection",
          changesetId: changeset.identity.id,
          packageName: member,
        });
  }
  return ok({
    packages: packages.value,
    selected: publishablePackageNames().filter((packageName) =>
      selected.value.has(packageName),
    ),
    consumed: request.consumedBySelection,
    preserved: request.preserved,
  });
}

/**
 * Re-checks every bump target against the closed publishable catalog.
 *
 * The changeset policy already rejects private and unknown targets, so this
 * only ever fires for input that never passed it — which is exactly why it
 * exists.
 */
function validateBumpTargets(
  changeset: ValidatedChangeset,
): Result<void, ChangesetConsumptionError> {
  if (changeset.kind === "empty") return ok(undefined);
  for (const packageName of changeset.releases.keys()) {
    const resolved = resolvePublishablePackage(packageName);
    if (resolved.isErr())
      return err({
        type: "InvalidBumpTarget",
        changesetId: changeset.identity.id,
        packageName,
        reason: resolved.error.type,
      });
  }
  return ok(undefined);
}

function resolveSelection(
  selected: readonly PublicPackageName[],
): Result<ReadonlySet<PublicPackageName>, ChangesetConsumptionError> {
  if (selected.length === 0) return err({ type: "EmptySelection" });
  const resolved = new Set<PublicPackageName>();
  for (const packageName of selected) {
    const publishable = resolvePublishablePackage(packageName);
    if (publishable.isErr())
      return err({
        type: "InvalidSelection",
        packageName,
        reason: publishable.error.type,
      });
    if (resolved.has(publishable.value))
      return err({
        type: "InvalidSelection",
        packageName,
        reason: "duplicate",
      });
    resolved.add(publishable.value);
  }
  return ok(resolved);
}

/** The staging tree mirrors the whole catalog, never a subset of it. */
function resolvePackages(
  packages: readonly ScratchPackageInput[],
): Result<readonly ResolvedScratchPackage[], ChangesetConsumptionError> {
  const catalog = publishablePackageNames();
  const resolved = new Map<PublicPackageName, ResolvedScratchPackage>();
  for (const input of packages) {
    const publishable = resolvePublishablePackage(input.packageName);
    if (publishable.isErr())
      return err({
        type: "InvalidScratchCatalog",
        packageName: input.packageName,
        reason: "unknown",
      });
    if (resolved.has(publishable.value))
      return err({
        type: "InvalidScratchCatalog",
        packageName: input.packageName,
        reason: "duplicate",
      });
    if (!STABLE_VERSION.test(input.version))
      return err({
        type: "InvalidScratchVersion",
        packageName: publishable.value,
        version: input.version,
      });
    resolved.set(publishable.value, {
      packageName: publishable.value,
      directory: PUBLIC_PACKAGES[publishable.value].directory,
      version: input.version,
      dependencies: catalog.filter(
        (candidate) =>
          candidate !== publishable.value &&
          (input.dependencies ?? []).includes(candidate),
      ),
    });
  }
  const ordered: ResolvedScratchPackage[] = [];
  for (const packageName of catalog) {
    const scratchPackage = resolved.get(packageName);
    if (scratchPackage === undefined)
      return err({
        type: "InvalidScratchCatalog",
        packageName,
        reason: "missing",
      });
    ordered.push(scratchPackage);
  }
  return ok(ordered);
}

/**
 * Confirms the Changesets CLI moved exactly the selected packages.
 *
 * A bump outside the closure means the selection is wrong, and a selected
 * package that did not move would republish an already-published version;
 * both fail closed here rather than downstream at npm.
 */
function verifyBumpedSet(
  plan: ScratchPlan,
  versions: readonly StagedVersion[],
): Result<readonly StagedVersion[], ChangesetConsumptionError> {
  const released: StagedVersion[] = [];
  for (const staged of versions) {
    const packageName = staged.scratchPackage.packageName;
    const bumped = staged.version !== staged.scratchPackage.version;
    const selected = plan.selected.includes(packageName);
    if (bumped && !selected)
      return err({
        type: "UnselectedVersionBump",
        packageName,
        version: staged.version,
      });
    if (!bumped && selected)
      return err({ type: "ClosureMemberNotVersioned", packageName });
    if (selected) released.push(staged);
  }
  return ok(released);
}

function parseManifestVersion(
  packageName: PublicPackageName,
  contents: string,
): Result<string, ChangesetConsumptionError> {
  const parsed = Result.fromThrowable(
    () => JSON.parse(contents) as unknown,
    (cause) => String(cause),
  )();
  if (parsed.isErr())
    return err({
      type: "ScratchManifestInvalid",
      packageName,
      reason: parsed.error,
    });
  const manifest = parsed.value;
  if (typeof manifest !== "object" || manifest === null)
    return err({
      type: "ScratchManifestInvalid",
      packageName,
      reason: "manifest is not an object",
    });
  const version = (manifest as { version?: unknown }).version;
  if (typeof version !== "string" || !STABLE_VERSION.test(version))
    return err({
      type: "ScratchManifestInvalid",
      packageName,
      reason: `version ${String(version)} is not a stable version`,
    });
  return ok(version);
}

function rootManifest(plan: ScratchPlan): string {
  return `${JSON.stringify(
    {
      name: "weave-release-scratch",
      version: "0.0.0",
      private: true,
      workspaces: plan.packages.map(
        (scratchPackage) => scratchPackage.directory,
      ),
    },
    null,
    2,
  )}\n`;
}

/**
 * The staging configuration deliberately ignores nothing: the tree holds only
 * the four public packages, so the private workspaces the real configuration
 * skips are simply absent.
 */
function changesetsConfig(): string {
  return `${JSON.stringify(
    {
      changelog: "@changesets/cli/changelog",
      commit: false,
      fixed: [],
      linked: [],
      access: "restricted",
      baseBranch: "main",
      updateInternalDependencies: "patch",
      ignore: [],
    },
    null,
    2,
  )}\n`;
}

function packageManifest(scratchPackage: ResolvedScratchPackage): string {
  const dependencies = Object.fromEntries(
    scratchPackage.dependencies.map((dependency) => [
      dependency,
      "workspace:*",
    ]),
  );
  const manifest = {
    name: scratchPackage.packageName,
    version: scratchPackage.version,
    private: false,
    ...(scratchPackage.dependencies.length > 0 ? { dependencies } : {}),
  };
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

function scratchFailure(
  operation: "read" | "write" | "remove",
  error: FileSystemError,
): ChangesetConsumptionError {
  return { type: "ScratchFileSystem", operation, error };
}

function digestOf(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}
