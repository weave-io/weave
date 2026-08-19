import { join } from "node:path";
import { logger } from "@weaveio/weave-engine";
import { err, ok, type Result } from "neverthrow";

export const ALLOWED_ACTION_OWNERS = new Set(["actions", "oven-sh"]);
export const REQUIRED_ARTIFACT_ACTION_PINS = {
  "actions/upload-artifact": "ea165f8d65b6e75b540449e92b4886f43607fa02",
  "actions/download-artifact": "d3f86a106a0bac45b974a628896c90dbdf5c8093",
  "actions/create-github-app-token": "bcd2ba49218906704ab6c1aa796996da409d3eb1",
} as const;
const FULL_SHA = /^[a-f0-9]{40}$/i;

export type ActionPinError =
  | { type: "InvalidActionReference"; file: string; value: string }
  | { type: "UnapprovedActionOwner"; file: string; owner: string }
  | { type: "UnresolvedActionReference"; file: string; value: string };

export function verifyActionPins(
  files: Readonly<Record<string, string>>,
): Result<void, ActionPinError[]> {
  const errors: ActionPinError[] = [];
  for (const [file, source] of Object.entries(files)) {
    let scannedActions = 0;
    for (const line of source.split("\n")) {
      const value = actionValue(line);
      if (value === undefined) continue;
      scannedActions += 1;
      if (value === null) {
        errors.push({
          type: "UnresolvedActionReference",
          file,
          value: "uses:",
        });
        continue;
      }
      if (value.startsWith("./")) continue;
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
    if (scannedActions === 0)
      errors.push({ type: "UnresolvedActionReference", file, value: "uses:" });
  }
  if (errors.length > 0) return err(errors);
  return ok();
}

/** Returns undefined for non-uses lines, null for unresolved YAML scalar forms. */
function actionValue(line: string): string | null | undefined {
  if (line.trimStart().startsWith("#")) return undefined;
  const match = /^\s*(?:-\s*)?uses\s*:(.*)$/.exec(line);
  if (match === null) return undefined;
  const raw = match[1]?.trim() ?? "";
  if (raw.length === 0) return null;
  const quoted = /^(["'])(.*)\1(?:\s+#.*)?$/.exec(raw);
  if (quoted !== null) return quoted[2] ?? null;
  const uncommented = raw.replace(/\s+#.*$/, "").trim();
  if (/\s/.test(uncommented)) return null;
  return uncommented.length === 0 ? null : uncommented;
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
