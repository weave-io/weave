import { posix } from "node:path";
import { normalizePath } from "@weaveio/weave-config";
import { err, ok, ResultAsync } from "neverthrow";
import { SAFE_PLAN_NAME } from "./plan-name.js";

const MAX_PLAN_NAMES = 256;

export type PlanCatalogError =
  | { readonly type: "MissingDirectory" }
  | { readonly type: "Unreadable" };

function runPathCommand(
  command: string[],
): ResultAsync<{ code: number; stdout: string }, PlanCatalogError> {
  return ResultAsync.fromThrowable(
    async () => {
      const process = Bun.spawn(command, {
        stdout: "pipe",
        stderr: "ignore",
      });
      const [code, stdout] = await Promise.all([
        process.exited,
        new Response(process.stdout).text(),
      ]);
      return { code, stdout };
    },
    (): PlanCatalogError => ({ type: "Unreadable" }),
  )();
}

function readDirectory(path: string): ResultAsync<void, PlanCatalogError> {
  // Check links before stat: stat follows links, including dangling ones.
  return runPathCommand(["test", "-L", path]).andThen(({ code }) => {
    if (code !== 1) return err({ type: "Unreadable" as const });
    return ResultAsync.fromThrowable(
      () => Bun.file(path).stat(),
      (cause): PlanCatalogError => {
        if (
          typeof cause === "object" &&
          cause !== null &&
          "code" in cause &&
          cause.code === "ENOENT"
        ) {
          return { type: "MissingDirectory" };
        }
        return { type: "Unreadable" };
      },
    )().andThen((info) =>
      info.isDirectory() ? ok(undefined) : err({ type: "Unreadable" as const }),
    );
  });
}

function canonicalPath(path: string): ResultAsync<string, PlanCatalogError> {
  return runPathCommand(["realpath", path]).andThen(({ code, stdout }) => {
    if (code !== 0) return err({ type: "Unreadable" as const });
    return ok(normalizePath(stdout.trim()));
  });
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
