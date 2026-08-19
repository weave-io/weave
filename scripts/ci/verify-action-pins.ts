import { join } from "node:path";
import { logger } from "@weaveio/weave-engine";
import { err, ok, type Result } from "neverthrow";

export const ALLOWED_ACTION_OWNERS = new Set(["actions", "oven-sh"]);
const FULL_SHA = /^[a-f0-9]{40}$/i;

export type ActionPinError =
  | { type: "InvalidActionReference"; file: string; value: string }
  | { type: "UnapprovedActionOwner"; file: string; owner: string };

export function verifyActionPins(
  files: Readonly<Record<string, string>>,
): Result<void, ActionPinError[]> {
  const errors: ActionPinError[] = [];
  for (const [file, source] of Object.entries(files)) {
    for (const match of source.matchAll(/^\s*uses:\s*([^\s#]+)/gm)) {
      const value = match[1];
      if (value === undefined || value.startsWith("./")) continue;
      const action = /^([^/]+)\/([^@]+)@(.+)$/.exec(value);
      if (action === null || !FULL_SHA.test(action[3] ?? "")) {
        errors.push({ type: "InvalidActionReference", file, value });
        continue;
      }
      const owner = action[1];
      if (owner === undefined || !ALLOWED_ACTION_OWNERS.has(owner)) {
        errors.push({
          type: "UnapprovedActionOwner",
          file,
          owner: owner ?? "",
        });
      }
    }
  }
  if (errors.length > 0) return err(errors);
  return ok(undefined);
}

export async function loadActionFiles(
  root = ".",
): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const pattern of ["*.yml", "*.yaml"]) {
    for await (const path of new Bun.Glob(pattern).scan({
      cwd: join(root, ".github/workflows"),
    })) {
      const workflowPath = `.github/workflows/${path}`;
      files[workflowPath] = await Bun.file(join(root, workflowPath)).text();
    }
  }
  for (const pattern of ["**/action.yml", "**/action.yaml"]) {
    for await (const path of new Bun.Glob(pattern).scan({ cwd: root })) {
      files[path] = await Bun.file(join(root, path)).text();
    }
  }
  return files;
}

if (import.meta.main) {
  const files = await loadActionFiles();
  const result = verifyActionPins(files);
  if (result.isOk()) {
    logger.info(
      { files: Object.keys(files).length },
      "Verified GitHub Action pins",
    );
  } else {
    logger.error(
      { errors: result.error },
      "GitHub Action pin verification failed",
    );
    process.exitCode = 1;
  }
}
