/**
 * Gated, opt-in end-to-end smoke test for the Copilot adapter against a real
 * `copilot` CLI binary.
 *
 * This test is SKIPPED by default. It only runs when both of the following
 * hold:
 *   1. `process.env.WEAVE_COPILOT_LIVE === "1"`
 *   2. a `copilot` binary is discoverable on `PATH` (probed via
 *      `copilot --version`)
 *
 * It never touches `~/.copilot/` — it uses the proven trusted-directory
 * invocation form from Task 1's research spike
 * (`docs/artifacts/copilot-adapter-research.md`, §4):
 *
 *   copilot -p "<prompt>" --agent <name> --add-dir <bundleDir> \
 *     --allow-all-tools -s
 *
 * A fresh, disposable bundle is written to a unique tmp directory per run and
 * removed afterward. On failure, diagnostics (bundle + stdout/stderr, no
 * secrets/env) are copied to `.weave/diagnostics/copilot-e2e-<uuid>/` before
 * cleanup still runs.
 *
 * Run explicitly with:
 *   bun run packages/adapters/copilot/scripts/test-live.ts
 * or:
 *   WEAVE_COPILOT_LIVE=1 bun test packages/adapters/copilot -t "live"
 */

import { describe, expect, it } from "bun:test";
import { mkdir, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentDescriptor } from "@weaveio/weave-engine";
import { CopilotAdapter } from "../adapter.js";

const OVERALL_TIMEOUT_MS = 3 * 60 * 1000;
const PER_CALL_TIMEOUT_MS = 30 * 1000;

// ---------------------------------------------------------------------------
// Gating
// ---------------------------------------------------------------------------

const liveEnvEnabled = process.env.WEAVE_COPILOT_LIVE === "1";

function probeCopilotBinary(): boolean {
  if (!liveEnvEnabled) return false;
  try {
    const result = Bun.spawnSync(["copilot", "--version"]);
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

const copilotAvailable = probeCopilotBinary();
const shouldRun = liveEnvEnabled && copilotAvailable;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function runCopilot(args: string[]): Promise<RunResult> {
  const proc = Bun.spawn(["copilot", ...args], {
    stdout: "pipe",
    stderr: "pipe",
    signal: AbortSignal.timeout(PER_CALL_TIMEOUT_MS),
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

async function writeDiagnostics(
  uuid: string,
  bundleDir: string,
  runResult: RunResult | undefined,
  extra: string,
): Promise<void> {
  const diagDir = join(
    process.cwd(),
    ".weave",
    "diagnostics",
    `copilot-e2e-${uuid}`,
  );
  try {
    await mkdir(diagDir, { recursive: true });
    await Bun.write(join(diagDir, "notes.txt"), extra);
    if (runResult) {
      await Bun.write(join(diagDir, "stdout.txt"), runResult.stdout);
      await Bun.write(join(diagDir, "stderr.txt"), runResult.stderr);
      await Bun.write(
        join(diagDir, "exit-code.txt"),
        String(runResult.exitCode),
      );
    }
    // Copy the bundle directory contents (best-effort, shallow files only).
    const bundleFiles = await collectFilesRecursive(bundleDir);
    for (const relPath of bundleFiles) {
      const src = join(bundleDir, relPath);
      const dest = join(diagDir, "bundle", relPath);
      await mkdir(join(dest, ".."), { recursive: true });
      const content = await Bun.file(src)
        .text()
        .catch(() => "<unreadable>");
      await Bun.write(dest, content);
    }
  } catch {
    // Diagnostics are best-effort; never fail the test because diagnostics
    // could not be written.
  }
}

async function collectFilesRecursive(
  dir: string,
  prefix = "",
): Promise<string[]> {
  const entries = await readdir(join(dir, prefix), {
    withFileTypes: true,
  }).catch(() => []);
  const results: string[] = [];
  for (const entry of entries) {
    const rel = prefix ? join(prefix, entry.name) : entry.name;
    if (entry.isDirectory()) {
      results.push(...(await collectFilesRecursive(dir, rel)));
    } else {
      results.push(rel);
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

// biome-ignore lint/suspicious/noConsole: test skip diagnostics
const _skipLog = (msg: string) => console.log(msg);
if (!liveEnvEnabled) {
  _skipLog("Skipping live Copilot CLI test: WEAVE_COPILOT_LIVE != '1'");
} else if (!copilotAvailable) {
  _skipLog(
    "Skipping live Copilot CLI test: 'copilot' binary not found on PATH " +
      "(or 'copilot --version' exited non-zero)",
  );
}

describe("CopilotAdapter — live CLI smoke test (gated)", () => {
  it.skipIf(!shouldRun)(
    "invokes a disposable agent via --add-dir and observes the sentinel in stdout",
    async () => {
      const start = Date.now();
      const uuid = crypto.randomUUID().slice(0, 8);
      const agentName = `weave-copilot-e2e-${uuid}`;
      const sentinel = `WEAVE-COPILOT-SENTINEL-${uuid}`;
      const bundleDir = join(tmpdir(), `weave-copilot-e2e-${uuid}`);

      let runResult: RunResult | undefined;
      let failure: unknown;

      try {
        const descriptor: AgentDescriptor = {
          name: agentName,
          description: "Disposable Weave live-CLI smoke test agent",
          composedPrompt: `You are a disposable smoke-test agent. Reply with exactly this token and nothing else: ${sentinel}`,
          models: ["claude-sonnet-5"],
          mode: "subagent",
          effectiveToolPolicy: {
            read: "allow",
            write: "deny",
            execute: "deny",
            delegate: "deny",
            network: "deny",
          },
          rawToolPolicy: undefined,
          delegationTargets: [],
          skills: [],
        };

        const adapter = new CopilotAdapter({
          projectRoot: bundleDir,
          homeDir: tmpdir(),
          outDir: bundleDir,
        });

        await adapter.init();
        const spawnResult = await adapter.spawnSubagent(descriptor);
        expect(spawnResult.isOk()).toBe(true);
        const flushResult = await adapter.flush();
        expect(flushResult.isOk()).toBe(true);

        // Sanity: the plugin.json's `name` field must satisfy the Agent
        // Plugins 1.0 naming pattern (lowercase, alnum/.-, no leading/trailing
        // separators, no `--`/`..`). The adapter currently always writes
        // `name: "weave"` at the top-level plugin.json regardless of agent
        // name, so no mangling of the uuid-bearing agent name is needed there;
        // the per-run uniqueness lives in the `.agent.md` filename stem and the
        // descriptor `name` used for `--agent` selection instead.
        const agentMdPath = join(
          bundleDir,
          "com.github.copilot",
          "agents",
          `${agentName}.agent.md`,
        );
        const agentMdExists = await Bun.file(agentMdPath).exists();
        expect(agentMdExists).toBe(true);

        if (Date.now() - start > OVERALL_TIMEOUT_MS) {
          throw new Error(
            "Overall live-CLI test timeout exceeded before invocation",
          );
        }

        runResult = await runCopilot([
          "-p",
          `Reply with exactly this token and nothing else: ${sentinel}`,
          "--agent",
          agentName,
          "--add-dir",
          bundleDir,
          "--allow-all-tools",
          "-s",
        ]);

        expect(runResult.stdout).toContain(sentinel);
      } catch (e) {
        failure = e;
      } finally {
        if (failure) {
          await writeDiagnostics(
            uuid,
            bundleDir,
            runResult,
            `Live Copilot CLI smoke test failed.\nAgent: ${agentName}\nBundle dir: ${bundleDir}\nError: ${
              failure instanceof Error ? failure.message : String(failure)
            }`,
          );
        }

        // Cleanup — always runs, even on failure.
        await rm(bundleDir, { recursive: true, force: true });

        // Assert no residual weave-copilot-e2e-* entries remain in tmpdir.
        const tmpEntries = await readdir(tmpdir()).catch(() => [] as string[]);
        const residual = tmpEntries.filter((e) =>
          e.startsWith("weave-copilot-e2e-"),
        );
        if (!failure) {
          expect(residual).toEqual([]);
        }
      }

      if (failure) throw failure;
    },
    OVERALL_TIMEOUT_MS,
  );
});
