/**
 * Runtime Store open/migrate wiring (Pi adapter contract,). The engine
 * owns the `RuntimeStore` type and its SQLite implementation
 * (`@weaveio/weave-engine`'s `createSqliteRuntimeStore`); this module only
 * owns *when* the adapter opens it (only after project trust is confirmed)
 * and maps open/migration failure onto the closed, health-only
 * `RuntimeStoreOpenFailed`/`RuntimeStoreMigrationFailed` failures - it must
 * never reimplement store internals.
 */
import { join } from "node:path";
import {
  createSqliteRuntimeStore,
  type RuntimeStore,
} from "@weaveio/weave-engine";
import { ResultAsync } from "neverthrow";
import {
  makeRuntimeStoreMigrationFailedFailure,
  makeRuntimeStoreOpenFailedFailure,
  type PiAdapterFailure,
} from "./errors.js";

export interface PiRuntimeStoreFactory {
  /**
   * Opens the Runtime Store rooted at the already-trusted `projectRoot`
   * (Pi adapter contract). The canonical `.weave/runtime/weave.db` layout is
   * computed internally so callers never construct a `dbPath` that could
   * drift from the no-follow guard's expectations.
   */
  open(projectRoot: string): ResultAsync<RuntimeStore, PiAdapterFailure>;
}

/** Distinguishes a fresh-open failure (unopenable file/directory) from a schema-migration failure using the RuntimeStoreError's closed `type` field - never inspecting raw messages. */
function classifyStoreOpenFailure(cause: unknown): "migration" | "open" {
  if (
    typeof cause === "object" &&
    cause !== null &&
    "type" in cause &&
    (cause as { type?: unknown }).type === "migration_version"
  ) {
    return "migration";
  }
  return "open";
}

function safeStoreErrorReason(cause: unknown): string {
  if (typeof cause === "object" && cause !== null && "type" in cause) {
    const typed = cause as { type?: unknown };
    return typeof typed.type === "string" ? typed.type : "runtime-store-error";
  }
  return "runtime-store-error";
}

export class SqliteRuntimeStoreFactory implements PiRuntimeStoreFactory {
  open(projectRoot: string): ResultAsync<RuntimeStore, PiAdapterFailure> {
    const dbPath = join(projectRoot, ".weave", "runtime", "weave.db");
    const store = createSqliteRuntimeStore({ dbPath, projectRoot });
    return store
      .ensureInitialized()
      .map(() => store)
      .mapErr((cause) => {
        const reason = safeStoreErrorReason(cause);
        return classifyStoreOpenFailure(cause) === "migration"
          ? makeRuntimeStoreMigrationFailedFailure(reason)
          : makeRuntimeStoreOpenFailedFailure(reason);
      });
  }
}

/** In-memory factory for tests - never touches disk. */
export class InMemoryRuntimeStoreFactory implements PiRuntimeStoreFactory {
  constructor(private readonly store: RuntimeStore) {}

  open(_projectRoot: string): ResultAsync<RuntimeStore, PiAdapterFailure> {
    return ResultAsync.fromSafePromise(Promise.resolve(this.store));
  }
}

/** Scripted factory for exercising open/migration failure paths in tests. */
export class FailingRuntimeStoreFactory implements PiRuntimeStoreFactory {
  constructor(private readonly failure: PiAdapterFailure) {}

  open(_projectRoot: string): ResultAsync<RuntimeStore, PiAdapterFailure> {
    return ResultAsync.fromPromise(
      Promise.reject(this.failure),
      (cause) => cause as PiAdapterFailure,
    );
  }
}
