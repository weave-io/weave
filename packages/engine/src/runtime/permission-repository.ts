import { err, ok, type Result } from "neverthrow";
import type {
  PermissionApprovalRepository,
  PermissionError,
} from "../permissions/types.js";

/**
 * Runtime stores keep the permission repository in this engine-private
 * association. Adapters receive only the RuntimeStore repositories and cannot
 * mutate durable permission records through the store object.
 */
/** Opaque object identity used to associate engine-private repositories. */
type PermissionRepositoryOwner = object;

const repositories = new WeakMap<object, PermissionApprovalRepository>();

export function registerPermissionApprovalRepository<T extends PermissionRepositoryOwner>(
  store: T,
  repository: PermissionApprovalRepository,
): void {
  repositories.set(store, repository);
}

export function getPermissionApprovalRepository<T extends PermissionRepositoryOwner>(
  store: T,
): Result<PermissionApprovalRepository, PermissionError> {
  const repository = repositories.get(store);
  if (repository === undefined)
    return err({
      type: "repository_failure",
      message: "runtime store has no engine-owned permission repository",
    });
  return ok(repository);
}
