import { join } from "node:path";
import { err, type Result } from "neverthrow";
import { runBoundedCommand } from "./command-runner.js";
import {
  ADAPTER_READY_MARKER,
  type CleanupResourceTracker,
  type CommandResult,
  PARENT_TASK,
  ROLLBACK_TASK,
  type ScenarioPaths,
  type SmokeCase,
  type SmokeFailure,
} from "./contract.js";
import { buildExpectDriver, buildPiLaunchCommand } from "./environment.js";
import {
  removeOwnedFile,
  scenarioLauncherPath,
  validateScenarioLauncher,
  writeText,
} from "./fixture-files.js";
export async function runPty(
  paths: ScenarioPaths,
  env: Record<string, string>,
  smokeCase: Exclude<SmokeCase, "all">,
  timeoutMs: number,
  resources?: CleanupResourceTracker,
): Promise<Result<CommandResult, SmokeFailure>> {
  const launcher = validateScenarioLauncher(
    paths.root,
    scenarioLauncherPath(paths.root),
  );
  if (launcher.isErr()) return err(launcher.error);
  const command = buildPiLaunchCommand({
    bunCli: paths.bunCli,
    piCli: paths.piCli,
    launcher: launcher.value,
  });
  // The done marker is only a bounded TUI-driver synchronization point. Both
  // scenarios wait for the adapter-owned Weave badge before sending a task;
  // rollback then invokes the real `/weave:health` command and parses that
  // command's notification below.
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
      readyMarker: ADAPTER_READY_MARKER,
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
