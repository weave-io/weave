/**
 * Adapter-owned plan catalog discovery (Pi adapter contract; docs/adapter-
 * boundary.md "Plan State Provider"). `/weave:start [plan]`'s selection
 * list and `/weave:plan`'s plan picker both need to know *which* plan
 * names exist under `.weave/plans` before any one of them can be read via
 * `PlanStateProvider.readSnapshot` - listing is a directory-discovery
 * concern the engine's `PlanStateProvider` deliberately does not own (it
 * only reads/transitions one already-named plan). This module is the
 * adapter-owned, no-follow-safe counterpart: it never parses plan content,
 * never mutates anything, and delegates all real file-descriptor work to
 * `SecureRelativeFileProvider` (`path-containment.ts`) - it must not
 * reimplement FFI/no-follow logic itself.
 */
import {
  err,
  errAsync,
  ok,
  okAsync,
  type Result,
  type ResultAsync,
} from "neverthrow";
import {
  makePlanCatalogUnavailableFailure,
  type PiAdapterFailure,
} from "./errors.js";
import {
  BunSecureRelativeFileProvider,
  type PathContainmentError,
  type SecureRelativeFileProvider,
} from "./path-containment.js";

/** Same safe-name allowlist the engine's plan-name validation and `BunFilesystemPlanStateProvider` use - a catalog entry that would not itself validate as a safe plan name must never be surfaced to a caller. */
const SAFE_PLAN_NAME_RE = /^[a-zA-Z0-9_-]+$/;
const PLAN_FILE_EXTENSION = ".md";
const PLANS_RELATIVE_DIR = ".weave/plans";

function isSafePlanFileName(fileName: string): boolean {
  if (!fileName.endsWith(PLAN_FILE_EXTENSION)) return false;
  const baseName = fileName.slice(0, -PLAN_FILE_EXTENSION.length);
  return baseName.length > 0 && SAFE_PLAN_NAME_RE.test(baseName);
}

function toPlanCatalogFailure(reason: PathContainmentError): PiAdapterFailure {
  return makePlanCatalogUnavailableFailure(reason);
}

/**
 * Adapter-owned plan catalog port. Production and fakes both implement
 * this; command handlers (`workflow-commands.ts`) and the extension's
 * `PiActiveWorkflowTracker` never scan `.weave/plans` themselves.
 */
export interface PiPlanCatalogPort {
  /**
   * Lists safe plan basenames (without `.md`) under `.weave/plans`, sorted
   * deterministically (locale-independent code-point order). A missing
   * `.weave/plans` directory reports `ok([])` - not yet having any plans is
   * not a failure. Every other containment failure (a symlinked ancestor,
   * an escape, or an unsupported platform) reports a typed, degraded
   * failure rather than a silently empty list.
   */
  listPlanNames(
    projectRoot: string,
  ): ResultAsync<readonly string[], PiAdapterFailure>;
}

/**
 * Production plan catalog: lists `.weave/plans` via the same no-follow
 * `SecureRelativeFileProvider.listDirectory` primitive artifact reads use,
 * then filters to basenames that are both provably-regular-file entries
 * (proven by the provider) and safe plan names (this module's own
 * allowlist), and sorts them for a stable, deterministic selection order.
 */
export class BunPiPlanCatalogPort implements PiPlanCatalogPort {
  constructor(
    private readonly provider: SecureRelativeFileProvider = new BunSecureRelativeFileProvider(),
  ) {}

  listPlanNames(
    projectRoot: string,
  ): ResultAsync<readonly string[], PiAdapterFailure> {
    return this.provider
      .listDirectory(projectRoot, PLANS_RELATIVE_DIR)
      .map((listing) =>
        listing.fileNames
          .filter(isSafePlanFileName)
          .map((fileName) => fileName.slice(0, -PLAN_FILE_EXTENSION.length))
          .sort(),
      )
      .orElse((error): Result<readonly string[], PiAdapterFailure> => {
        // A missing `.weave/plans` directory just means no plans exist yet
        // (mirrors `isDirectoryContainmentSafeWith`'s "safe to create
        // later" semantics) - every other containment failure is a real,
        // degraded catalog-unavailable outcome.
        if (error === "path-component-missing") return ok([]);
        return err(toPlanCatalogFailure(error));
      });
  }
}

/** In-memory fake for isolated tests - no real filesystem access. */
export class FakePiPlanCatalogPort implements PiPlanCatalogPort {
  constructor(
    private readonly names: readonly string[] = [],
    private readonly failure?: PiAdapterFailure,
  ) {}

  listPlanNames(
    _projectRoot: string,
  ): ResultAsync<readonly string[], PiAdapterFailure> {
    if (this.failure !== undefined) return errAsync(this.failure);
    return okAsync([...this.names]);
  }
}
