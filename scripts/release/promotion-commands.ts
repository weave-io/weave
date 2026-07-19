import { err, ok, type Result } from "neverthrow";
import {
  type PromotionAuthorization,
  PromotionAuthorizationSchema,
} from "./release-orchestrator.js";

export interface PromotionCommandSummary {
  priorLatestCaptureCommands: readonly string[];
  promoteCommands: readonly string[];
  rollbackCommands: readonly string[];
}

/** Builds manual, version-pinned promotion commands from an authorized package set. */
export function promotionCommands(
  authorization: unknown,
  priorLatestVersions?: Readonly<Record<string, string>>,
): Result<PromotionCommandSummary, { type: "InvalidPromotionAuthorization" }> {
  const parsed = PromotionAuthorizationSchema.safeParse(authorization);
  if (!parsed.success) return err({ type: "InvalidPromotionAuthorization" });
  const rollback = rollbackCommands(parsed.data, priorLatestVersions);
  if (rollback.isErr()) return err(rollback.error);
  return ok({
    priorLatestCaptureCommands: parsed.data.packages.map(
      (packageName) => `npm dist-tag ls ${packageName} --json`,
    ),
    promoteCommands: parsed.data.packages.map(
      (packageName) =>
        `npm dist-tag add ${packageName}@${parsed.data.versions[packageName]} latest`,
    ),
    rollbackCommands: rollback.value,
  });
}

function rollbackCommands(
  authorization: PromotionAuthorization,
  priorLatestVersions: Readonly<Record<string, string>> | undefined,
): Result<readonly string[], { type: "InvalidPromotionAuthorization" }> {
  if (priorLatestVersions === undefined) return ok([]);
  for (const packageName of authorization.packages)
    if (typeof priorLatestVersions[packageName] !== "string")
      return err({ type: "InvalidPromotionAuthorization" });
  return ok(
    authorization.packages.map(
      (packageName) =>
        `npm dist-tag add ${packageName}@${priorLatestVersions[packageName]} latest`,
    ),
  );
}
