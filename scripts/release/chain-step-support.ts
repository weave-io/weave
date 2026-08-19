import {
  err,
  ok,
  type Result,
  ResultAsync,
  type ResultAsync as ResultAsyncType,
} from "neverthrow";

export const CHAIN_STEP_INPUT_LIMIT_BYTES = 512 * 1024;

export type ChainStepInputError =
  | { type: "InvalidChainStepInput"; issues: readonly string[] }
  | { type: "ChainStepFileError"; path: string; reason: string };

export function parseNamedPathArgs(
  argv: readonly string[],
  command: string,
  required: readonly string[],
): Result<Record<string, string>, ChainStepInputError> {
  const values: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (
      flag === undefined ||
      value === undefined ||
      !flag.startsWith("--") ||
      value.length === 0
    )
      return err({
        type: "InvalidChainStepInput",
        issues: [
          `usage: ${command} ${required.map((item) => `--${item} <path>`).join(" ")}`,
        ],
      });
    values[flag.slice(2)] = value;
    index += 1;
  }
  const missing = required.filter((key) => values[key] === undefined);
  if (missing.length > 0)
    return err({
      type: "InvalidChainStepInput",
      issues: missing.map((key) => `--${key} is required`),
    });
  return ok(values);
}

export function readJsonFile(
  path: string,
): ResultAsyncType<unknown, ChainStepInputError> {
  const file = Bun.file(path);
  if (file.size > CHAIN_STEP_INPUT_LIMIT_BYTES)
    return ResultAsync.fromPromise(
      Promise.reject(
        new Error(`JSON carrier exceeds ${CHAIN_STEP_INPUT_LIMIT_BYTES} bytes`),
      ),
      (cause): ChainStepInputError => ({
        type: "ChainStepFileError",
        path,
        reason: String(cause),
      }),
    );
  return ResultAsync.fromThrowable(
    async () => JSON.parse(await file.text()) as unknown,
    (cause): ChainStepInputError => ({
      type: "ChainStepFileError",
      path,
      reason: String(cause),
    }),
  )();
}

export function writeJsonFile(
  path: string,
  value: unknown,
): ResultAsyncType<void, ChainStepInputError> {
  return ResultAsync.fromThrowable(
    () => Bun.write(path, `${canonicalJson(value)}\n`).then(() => undefined),
    (cause): ChainStepInputError => ({
      type: "ChainStepFileError",
      path,
      reason: String(cause),
    }),
  )();
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
