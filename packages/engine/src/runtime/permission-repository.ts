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
const repositories = new WeakMap<object, PermissionApprovalRepository>();

export function registerPermissionApprovalRepository(
  store: object,
  repository: PermissionApprovalRepository,
): void {
  repositories.set(store, repository);
}

export function getPermissionApprovalRepository(
  store: object,
): Result<PermissionApprovalRepository, PermissionError> {
  const repository = repositories.get(store);
  if (repository === undefined)
    return err({
      type: "repository_failure",
      message: "runtime store has no engine-owned permission repository",
    });
  return ok(repository);
}
