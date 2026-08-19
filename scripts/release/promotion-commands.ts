import {
  err,
  errAsync,
  ok,
  okAsync,
  type Result,
  ResultAsync,
} from "neverthrow";
import type { RegistryError } from "./errors.js";
import type { NpmRegistryClient } from "./npm-registry-client.js";
import {
  type PromotionAuthorization,
  PromotionAuthorizationSchema,
} from "./release-orchestrator.js";

type PromotionAuthorizationInput = Parameters<
  typeof PromotionAuthorizationSchema.safeParse
>[0];

export interface PromotionCommandSummary {
  priorLatestCaptureCommands: readonly string[];
  promoteCommands: readonly string[];
  rollbackCommands: readonly string[];
}

export type PromotionCommandError =
  | { type: "InvalidPromotionAuthorization" }
  | { type: "MissingPriorLatest"; packageName: string }
  | RegistryError;

/** Builds manual, version-pinned promotion commands from an authorized package set. */
export function promotionCommands(
  authorization: PromotionAuthorizationInput,
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

/** Reads prior tags in the verified control binary and returns human-only text. */
export function promotionCommandsFromRegistry(
  authorization: PromotionAuthorizationInput,
  registry: NpmRegistryClient,
): ResultAsync<PromotionCommandSummary, PromotionCommandError> {
  const parsed = PromotionAuthorizationSchema.safeParse(authorization);
  if (!parsed.success)
    return errAsync({ type: "InvalidPromotionAuthorization" });
  return ResultAsync.combine(
    parsed.data.packages.map((packageName) =>
      registry.distTagLs(packageName).andThen((tags) => {
        const latest = tags.latest;
        if (!isStringValue(latest))
          return errAsync({ type: "MissingPriorLatest" as const, packageName });
        return okAsync([packageName, latest] as const);
      }),
    ),
  ).andThen((entries) => {
    const commands = promotionCommands(
      parsed.data,
      Object.fromEntries(entries),
    );
    return commands.isOk() ? okAsync(commands.value) : errAsync(commands.error);
  });
}

function isStringValue(value: string | undefined): value is string {
  return value !== undefined;
}

function rollbackCommands(
  authorization: PromotionAuthorization,
  priorLatestVersions: Readonly<Record<string, string>> | undefined,
): Result<readonly string[], { type: "InvalidPromotionAuthorization" }> {
  if (priorLatestVersions === undefined) return ok([]);
  for (const packageName of authorization.packages)
    if (priorLatestVersions[packageName] === undefined)
      return err({ type: "InvalidPromotionAuthorization" });
  return ok(
    authorization.packages.map(
      (packageName) =>
        `npm dist-tag add ${packageName}@${priorLatestVersions[packageName]} latest`,
    ),
  );
}
