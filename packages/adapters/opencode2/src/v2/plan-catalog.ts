import { lstat, realpath, stat } from "node:fs/promises";
import { posix } from "node:path";
import { normalizePath } from "@weaveio/weave-config";
import { err, ResultAsync } from "neverthrow";
import { SAFE_PLAN_NAME } from "./plan-name.js";

const MAX_PLAN_NAMES = 256;

export type PlanCatalogError =
  | { readonly type: "MissingDirectory" }
  | { readonly type: "Unreadable" };

function isMissing(cause: unknown): boolean {
  return (
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    cause.code === "ENOENT"
  );
}

/**
 * Link and directory checks go through `node:fs` rather than the POSIX
 * `test`/`realpath` binaries: a host launched outside a POSIX shell (Windows
 * TUI, OpenChamber's managed server) has neither on PATH, which made every
 * plan catalog read fail as `Unreadable`.
 */
function readDirectory(path: string): ResultAsync<void, PlanCatalogError> {
  return ResultAsync.fromThrowable(
    async () => {
      // Inspect the link before following it: `stat` follows links, including
      // dangling ones, so a link would otherwise pass as its target.
      const entry = await lstat(path);
      if (entry.isSymbolicLink()) throw new Error("symbolic link");
      const info = await stat(path);
      if (!info.isDirectory()) throw new Error("not a directory");
    },
    (cause): PlanCatalogError =>
      isMissing(cause) ? { type: "MissingDirectory" } : { type: "Unreadable" },
  )();
}

function canonicalPath(path: string): ResultAsync<string, PlanCatalogError> {
  return ResultAsync.fromThrowable(
    () => realpath(path),
    (): PlanCatalogError => ({ type: "Unreadable" }),
  )().map((resolved) => normalizePath(resolved));
}

function readPlanBasenames(
  plansDir: string,
): ResultAsync<readonly string[], PlanCatalogError> {
  return ResultAsync.fromThrowable(
    async () => {
      const names: string[] = [];
      const glob = new Bun.Glob("*.md");
      for await (const file of glob.scan({
        cwd: plansDir,
        onlyFiles: true,
        followSymlinks: false,
      })) {
        if (file.includes("/") || file.includes("\\")) continue;
        const name = file.slice(0, -".md".length);
        if (!SAFE_PLAN_NAME.test(name)) continue;
        names.push(name);
        if (names.length >= MAX_PLAN_NAMES) break;
      }
      names.sort();
      return names;
    },
    (): PlanCatalogError => ({ type: "Unreadable" }),
  )();
}

/**
 * List safe plan basenames under `<location>/.weave/plans`.
 * A missing directory is typed, not an empty success. Scan I/O is Unreadable.
 */
export function listPlanNames(
  location: string,
): ResultAsync<readonly string[], PlanCatalogError> {
  const root = normalizePath(location);
  const weave = posix.join(root, ".weave");
  const plansDir = posix.join(weave, "plans");
  return readDirectory(root)
    .andThen(() => readDirectory(weave))
    .andThen(() => readDirectory(plansDir))
    .andThen(() => canonicalPath(root))
    .andThen((canonicalRoot) =>
      canonicalPath(plansDir).andThen((canonicalPlans) => {
        if (canonicalPlans !== posix.join(canonicalRoot, ".weave", "plans")) {
          return err({ type: "Unreadable" as const });
        }
        return readPlanBasenames(canonicalPlans);
      }),
    );
}

export function choosePlanMessage(names: readonly string[]): string {
  if (names.length === 0) {
    return "No plans found under .weave/plans. Create a plan file, then run /weave:start <plan-name>.";
  }
  return `Choose one plan: /weave:start <plan-name>\nAvailable: ${names.join(", ")}`;
}
