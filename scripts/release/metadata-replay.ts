import {
  err,
  errAsync,
  ok,
  okAsync,
  type Result,
  type ResultAsync,
} from "neverthrow";
import type { Clock } from "./clock.js";
import type { FileSystem } from "./filesystem.js";
import type { GitHubRefClient } from "./github-client.js";
import { canonicalizeJson } from "./json.js";
import {
  MetadataBranchSchema,
  type MetadataReplayRecord,
  MetadataReplayRecordSchema,
  ReleaseBranchSchema,
  type StableTrainRecord,
} from "./model.js";
import { validateStableTrain } from "./stable-train.js";

export type MetadataReplayError =
  | { type: "InvalidReplayRecord"; issues: readonly string[] }
  | { type: "ReplayPolicyViolation"; reason: string }
  | { type: "MetadataConflict"; path: string }
  | { type: "MissingConsumedChangeset"; path: string }
  | {
      type: "ConsumedChangesetDigestMismatch";
      path: string;
      expected: string;
      actual: string;
    }
  | { type: "ReplayWriteFailed"; path: string; message: string }
  | { type: "ReleaseDeletionPrecondition"; reason: string };

export type ReplayMutation =
  | { type: "write"; path: string; contents: string }
  | { type: "delete"; path: string };

export interface ReplayPlan {
  branch: string;
  mutations: readonly ReplayMutation[];
}

export interface ReleaseBranchDeletion {
  releaseBranch: string;
  mergedMetadataPr: { number: number; head: string; merged: boolean };
  manualStopApproved: boolean;
}

/**
 * Replays only content recorded by the stable train onto fresh protected main.
 * This intentionally has no git operations: a maintainer creates the metadata
 * branch and opens the normal, ruleset-protected PR.
 */
export class MetadataReplay {
  constructor(
    private readonly files: FileSystem,
    private readonly clock: Clock,
  ) {}

  generateReplayRecord(
    train: StableTrainRecord,
  ): Result<MetadataReplayRecord, MetadataReplayError> {
    const valid = validateStableTrain(train);
    if (valid.isErr())
      return err({ type: "InvalidReplayRecord", issues: [valid.error.type] });
    if (train.state !== "finalized" && train.state !== "metadata-pending")
      return err({
        type: "ReplayPolicyViolation",
        reason: "train must be finalized",
      });
    const content = {
      schemaVersion: 1 as const,
      sourceTrainRef: train.trainRef,
      sourceTrainDigest: train.recordDigest,
      subjectSha: train.subjectSha,
      generatedAt: this.clock.now().toISOString(),
      versions: train.versions,
      consumedChangesets: train.consumedChangesets ?? [],
      metadataWrites: train.metadataWrites ?? [],
    };
    return ok({ ...content, recordDigest: metadataReplayDigest(content) });
  }

  applyReplay(
    record: MetadataReplayInput,
    branch: string,
  ): ResultAsync<ReplayPlan, MetadataReplayError> {
    const checked = validateReplay(record, branch);
    if (checked.isErr()) return errAsync(checked.error);
    return this.plan(checked.value, branch).andThen((plan) =>
      plan.mutations
        .reduce<ResultAsync<void, MetadataReplayError>>(
          (chain, mutation) =>
            chain.andThen(() => this.applyMutation(mutation)),
          okAsync(),
        )
        .map(() => plan),
    );
  }

  verifyIdempotent(
    record: MetadataReplayInput,
    branch: string,
  ): ResultAsync<boolean, MetadataReplayError> {
    const checked = validateReplay(record, branch);
    if (checked.isErr()) return errAsync(checked.error);
    return this.plan(checked.value, branch).map(
      (plan) => plan.mutations.length === 0,
    );
  }

  deleteReleaseBranch(
    input: ReleaseBranchDeletion,
    refs: GitHubRefClient,
  ): ResultAsync<void, MetadataReplayError> {
    if (!ReleaseBranchSchema.safeParse(input.releaseBranch).success)
      return errAsync({
        type: "ReleaseDeletionPrecondition",
        reason: "invalid release branch",
      });
    if (!input.mergedMetadataPr.merged)
      return errAsync({
        type: "ReleaseDeletionPrecondition",
        reason: "metadata PR is not merged",
      });
    if (!MetadataBranchSchema.safeParse(input.mergedMetadataPr.head).success)
      return errAsync({
        type: "ReleaseDeletionPrecondition",
        reason: "metadata PR head is invalid",
      });
    if (!input.manualStopApproved)
      return errAsync({
        type: "ReleaseDeletionPrecondition",
        reason: "manual STOP gate is not approved",
      });
    return refs.deleteRef(`heads/${input.releaseBranch}`).mapErr((error) => ({
      type: "ReleaseDeletionPrecondition" as const,
      reason: error.message,
    }));
  }

  private plan(
    record: MetadataReplayRecord,
    branch: string,
  ): ResultAsync<ReplayPlan, MetadataReplayError> {
    const writes: ResultAsync<ReplayMutation[], MetadataReplayError> =
      record.metadataWrites.reduce<
        ResultAsync<ReplayMutation[], MetadataReplayError>
      >(
        (chain, write) =>
          chain.andThen((mutations) =>
            this.files
              .exists(write.path)
              .mapErr((error) => ({
                type: "ReplayWriteFailed" as const,
                path: write.path,
                message: error.message,
              }))
              .andThen((exists) => {
                if (!exists)
                  return okAsync([
                    ...mutations,
                    {
                      type: "write" as const,
                      path: write.path,
                      contents: write.contents,
                    },
                  ]);
                return this.files
                  .readText(write.path)
                  .mapErr((error) => ({
                    type: "ReplayWriteFailed" as const,
                    path: write.path,
                    message: error.message,
                  }))
                  .andThen((contents) => {
                    if (contents !== write.contents)
                      return errAsync({
                        type: "MetadataConflict" as const,
                        path: write.path,
                      });
                    return okAsync(mutations);
                  });
              }),
          ),
        okAsync([]),
      );
    return writes.andThen((writeMutations) =>
      this.planDeletes(record, writeMutations, branch),
    );
  }

  private planDeletes(
    record: MetadataReplayRecord,
    writes: ReplayMutation[],
    branch: string,
  ): ResultAsync<ReplayPlan, MetadataReplayError> {
    const deletions: ResultAsync<
      { mutations: ReplayMutation[]; present: number },
      MetadataReplayError
    > = record.consumedChangesets.reduce<
      ResultAsync<
        { mutations: ReplayMutation[]; present: number },
        MetadataReplayError
      >
    >(
      (chain, changeset) =>
        chain.andThen((state) =>
          this.files
            .exists(changeset.path)
            .mapErr((error) => ({
              type: "ReplayWriteFailed" as const,
              path: changeset.path,
              message: error.message,
            }))
            .andThen((exists) => {
              if (!exists) return okAsync(state);
              return this.files
                .readText(changeset.path)
                .mapErr((error) => ({
                  type: "ReplayWriteFailed" as const,
                  path: changeset.path,
                  message: error.message,
                }))
                .andThen((contents) => {
                  const actual = digest(contents);
                  if (actual !== changeset.preimageDigest)
                    return errAsync({
                      type: "ConsumedChangesetDigestMismatch" as const,
                      path: changeset.path,
                      expected: changeset.preimageDigest,
                      actual,
                    });
                  return okAsync({
                    mutations: [
                      ...state.mutations,
                      { type: "delete" as const, path: changeset.path },
                    ],
                    present: state.present + 1,
                  });
                });
            }),
        ),
      okAsync({ mutations: [], present: 0 }),
    );
    return deletions.andThen((deletions) => {
      if (
        record.consumedChangesets.length > 0 &&
        deletions.present === 0 &&
        writes.length > 0
      )
        return errAsync({
          type: "MissingConsumedChangeset" as const,
          path: record.consumedChangesets.at(0)?.path ?? "",
        });
      return okAsync({
        branch,
        mutations: [...writes, ...deletions.mutations],
      });
    });
  }

  private applyMutation(
    mutation: ReplayMutation,
  ): ResultAsync<void, MetadataReplayError> {
    const operation =
      mutation.type === "write"
        ? this.files.writeText(mutation.path, mutation.contents)
        : this.files.delete(mutation.path);
    return operation.mapErr((error) => ({
      type: "ReplayWriteFailed" as const,
      path: mutation.path,
      message: error.message,
    }));
  }
}

export function metadataReplayDigest(
  record: Omit<MetadataReplayRecord, "recordDigest">,
): string {
  return `sha256:${Bun.CryptoHasher.hash("sha256", canonicalizeJson(record), "hex")}`;
}

type MetadataReplayInput = Parameters<
  typeof MetadataReplayRecordSchema.safeParse
>[0];

export function validateReplay(
  record: MetadataReplayInput,
  branch: string,
): Result<MetadataReplayRecord, MetadataReplayError> {
  if (ReleaseBranchSchema.safeParse(branch).success)
    return err({
      type: "ReplayPolicyViolation",
      reason: "replay target cannot be a release branch",
    });
  if (!MetadataBranchSchema.safeParse(branch).success)
    return err({
      type: "ReplayPolicyViolation",
      reason: "target must be a metadata branch",
    });
  const parsed = MetadataReplayRecordSchema.safeParse(record);
  if (!parsed.success)
    return err({
      type: "InvalidReplayRecord",
      issues: parsed.error.issues.map((issue) => issue.message),
    });
  const { recordDigest, ...content } = parsed.data;
  if (recordDigest !== metadataReplayDigest(content))
    return err({
      type: "InvalidReplayRecord",
      issues: ["record digest does not match canonical content"],
    });
  for (const write of parsed.data.metadataWrites)
    if (digest(write.contents) !== write.contentsDigest)
      return err({
        type: "InvalidReplayRecord",
        issues: [`metadata digest mismatch: ${write.path}`],
      });
  return ok(parsed.data);
}

/** Ruleset enforcement is Task 12; this policy guard rejects release PR heads locally. */
export function validatePullRequestHead(
  head: string,
): Result<void, MetadataReplayError> {
  if (ReleaseBranchSchema.safeParse(head).success)
    return err({
      type: "ReplayPolicyViolation",
      reason: "release branches cannot be PR heads",
    });
  return ok();
}

function digest(contents: string): string {
  return `sha256:${Bun.CryptoHasher.hash("sha256", contents, "hex")}`;
}
