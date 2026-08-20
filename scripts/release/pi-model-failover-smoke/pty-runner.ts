import { join } from "node:path";
import { err, type Result } from "neverthrow";
import { runBoundedCommand } from "./command-runner.js";
import {
  type CleanupResourceTracker,
  type CommandResult,
  PARENT_TASK,
  ROLLBACK_TASK,
  type ScenarioPaths,
  type SmokeCase,
  type SmokeFailure,
} from "./contract.js";
import { buildExpectDriver, buildPiLaunchCommand } from "./environment.js";
import { removeOwnedFile, writeText } from "./fixture-files.js";
export async function runPty(
  paths: ScenarioPaths,
  env: Record<string, string>,
  smokeCase: Exclude<SmokeCase, "all">,
  timeoutMs: number,
  resources?: CleanupResourceTracker,
): Promise<Result<CommandResult, SmokeFailure>> {
  const command = buildPiLaunchCommand({
    bunCli: paths.bunCli,
    piCli: paths.piCli,
    launcher: join(paths.root, "bin/pi"),
  });
  // The done marker is only a bounded TUI-driver synchronization point. The
  // rollback health observation waits for Pi's real Weave badge, invokes the
  // real `/weave:health` command, and parses that command's notification below.
  const doneMarker = "PI_MODEL_FAILOVER_SMOKE_DONE";
  const task = smokeCase === "rollback" ? ROLLBACK_TASK : PARENT_TASK;
  const rollbackHealth = smokeCase === "rollback";
  const driverPath = join(paths.root, `driver-${crypto.randomUUID()}.exp`);
  resources?.registerOwnedPath(driverPath);
  const driver = await writeText(
    driverPath,
    buildExpectDriver({
      command,
      doneMarker,
      ...(rollbackHealth ? { readyMarker: "◆ WEAVE" } : {}),
      ...(rollbackHealth
        ? {
            healthCommand: "/weave:health",
            healthMarker: "Weave adapter mode: (ready|health-only)",
          }
        : {}),
      task,
      timeoutSeconds: Math.ceil(timeoutMs / 1_000),
    }),
  );
  if (driver.isErr()) return err(driver.error);
  const result = await runBoundedCommand([paths.expectCli, "-f", driverPath], {
    cwd: paths.project,
    env,
    timeoutMs,
    resources,
    processKind: "pty",
  });
  const removed = await removeOwnedFile(driverPath);
  if (removed.isErr()) return err(removed.error);
  return result;
}
