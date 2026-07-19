import { err, ok, type Result } from "neverthrow";
import {
  type STABLE_TRAIN_STATES,
  STABLE_TRAIN_TRANSITIONS,
} from "./constants.js";
import { type StableTrainRecord, StableTrainRecordSchema } from "./model.js";

export type StableTrainError =
  | { type: "InvalidTrainRecord"; issues: readonly string[] }
  | {
      type: "InvalidTransition";
      from: StableTrainRecord["state"];
      to: StableTrainRecord["state"];
    }
  | { type: "DigestMismatch"; expected: string; actual: string };

export interface StableTrainContent {
  schemaVersion: 1;
  trainRef: string;
  subjectSha: string;
  cutAt: string;
  expiresAt: string;
  state: string;
  packages: readonly string[];
  versions: Readonly<Record<string, string>>;
  artifactManifestDigest?: string;
}

export function canonicalTrainJson(record: StableTrainContent): string {
  return JSON.stringify(sortObject(record));
}

export function trainRecordDigest(record: StableTrainContent): string {
  return `sha256:${Bun.CryptoHasher.hash("sha256", canonicalTrainJson(record), "hex")}`;
}

export function validateStableTrain(
  record: unknown,
): Result<StableTrainRecord, StableTrainError> {
  const parsed = StableTrainRecordSchema.safeParse(record);
  if (!parsed.success)
    return err({
      type: "InvalidTrainRecord",
      issues: parsed.error.issues.map((issue) => issue.message),
    });
  const { recordDigest, ...content } = parsed.data;
  const actual = trainRecordDigest(content);
  if (recordDigest !== actual)
    return err({
      type: "DigestMismatch",
      expected: actual,
      actual: recordDigest,
    });
  return ok(parsed.data);
}

export function transitionStableTrain(
  record: StableTrainRecord,
  state: StableTrainRecord["state"],
): Result<StableTrainRecord, StableTrainError> {
  const allowed = STABLE_TRAIN_TRANSITIONS[
    record.state
  ] as readonly (typeof STABLE_TRAIN_STATES)[number][];
  if (!allowed.includes(state))
    return err({ type: "InvalidTransition", from: record.state, to: state });
  const { recordDigest: _recordDigest, ...content } = record;
  const next = { ...content, state };
  return ok({ ...next, recordDigest: trainRecordDigest(next) });
}

function sortObject(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortObject);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => compareKeys(left, right))
        .map(([key, child]) => [key, sortObject(child)]),
    );
  return value;
}

function compareKeys(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
