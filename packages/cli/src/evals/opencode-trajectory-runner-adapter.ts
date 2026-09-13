/**
 * Thin production bridge between the eval orchestrator (`loom-routing-runner.ts`)
 * and the OpenCode adapter's `TrajectoryRunner` implementation.
 *
 * This module is the ONLY place in `@weaveio/weave-cli` that imports from
 * `@weaveio/weave-adapter-opencode`'s trajectory surface. Keeping the import
 * isolated here (and always behind a dynamic `import()` at the call site)
 * means:
 *
 *   - Unit tests for `loom-routing-runner.ts` never load this module — they
 *     inject a stub `TrajectoryRunner` directly.
 *   - The adapter's real dependencies (`Bun.spawn` via `BunPodmanClient`,
 *     real file I/O via `EphemeralWorkspaceFactory`) are only constructed on
 *     the live-run path, never during `--dry-run` case scoring.
 *
 * # Prompt provider
 *
 * `TrajectoryCase` (the engine/adapter-owned projection) does not carry the
 * eval case description. The `PromptProvider` below closes over a lookup
 * from `testCaseId` to the original `EvalCase.description` so the sandboxed
 * harness receives the same task text a text-only case would.
 *
 * # Dry-run sandbox image check
 *
 * `checkSandboxImageExists` shells out to `podman image inspect <tag>` — a
 * read-only inspection call, never `podman run`. It resolves to `false`
 * (rather than rejecting) when podman is not installed or the image is
 * missing, so a dev box without podman can still complete a dry run; the
 * caller decides whether a missing image should be surfaced as a warning.
 */

import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ResultAsync } from "neverthrow";
import { EVALS_ROOT } from "./case-loader.js";
import type { EvalCase } from "./types.js";

// ---------------------------------------------------------------------------
// Working-tree plugin bundle (Spec 35, `opencode-local`)
// ---------------------------------------------------------------------------

/** Sandbox profiles that run the working tree's plugin instead of npm. */
const LOCAL_PLUGIN_PROFILES: ReadonlySet<string> = new Set(["opencode-local"]);

const PLUGIN_ENTRYPOINT = join(
  dirname(EVALS_ROOT),
  "packages",
  "adapters",
  "opencode",
  "src",
  "plugin.ts",
);

function needsLocalPluginBundle(cases: readonly EvalCase[]): boolean {
  return cases.some(
    (evalCase) =>
      evalCase.expected_outcome.kind === "harness_trajectory" &&
      LOCAL_PLUGIN_PROFILES.has(evalCase.expected_outcome.sandbox_profile),
  );
}

/**
 * Bundles the working tree's OpenCode plugin into one file (builtin prompts
 * are embedded at bundle time), so `opencode-local` sessions run the prompts
 * in this checkout rather than the published package. Throws with the
 * bundler's log messages on failure; the caller turns that into a typed
 * runner-construction error.
 */
async function buildLocalPluginBundle(): Promise<string> {
  const outdir = join(
    tmpdir(),
    "weave-trajectory",
    `plugin-${crypto.randomUUID()}`,
  );
  const result = await Bun.build({
    entrypoints: [PLUGIN_ENTRYPOINT],
    outdir,
    target: "bun",
    format: "esm",
    naming: "weave-plugin.js",
  });
  if (!result.success) {
    throw new Error(
      `Failed to bundle ${PLUGIN_ENTRYPOINT}: ${result.logs.map(String).join("\n")}`,
    );
  }
  return join(outdir, "weave-plugin.js");
}

// ---------------------------------------------------------------------------
// Production TrajectoryRunner construction
// ---------------------------------------------------------------------------

/**
 * Build a production `TrajectoryRunner` (the OpenCode adapter's
 * `OpenCodeTrajectoryRunner`) wired with real collaborators:
 *
 *   - `BunPodmanClient` — real `podman run` / `podman kill` via `Bun.spawn`.
 *   - `DefaultLogParser` — wraps `parseTrajectoryEvents`.
 *   - `EphemeralWorkspaceFactory` — real temp-directory workspace creation.
 *   - A `PromptProvider` that resolves each case's prompt text from the
 *     supplied `cases` list by `testCaseId` (== `EvalCase.id`).
 *   - A working-tree plugin bundle, built only when a case uses the
 *     `opencode-local` sandbox profile (Spec 35).
 *
 * @param cases - The loaded eval cases for the current suite run, used to
 *   resolve prompt text by case ID.
 * @param env - Environment map to read `OPENROUTER_API_KEY` from.
 */
export async function createProductionTrajectoryRunner(
  cases: readonly EvalCase[],
  env: Record<string, string | undefined>,
) {
  const {
    BunPodmanClient,
    DefaultLogParser,
    EphemeralWorkspaceFactory,
    OpenCodeTrajectoryRunner,
  } = await import("@weaveio/weave-adapter-opencode");

  const descriptionByCaseId = new Map(
    cases.map((c) => [c.id, c.description] as const),
  );
  const localPluginBundlePath = needsLocalPluginBundle(cases)
    ? await buildLocalPluginBundle()
    : undefined;

  return new OpenCodeTrajectoryRunner({
    ...(localPluginBundlePath !== undefined ? { localPluginBundlePath } : {}),
    podmanClient: new BunPodmanClient(),
    logParser: new DefaultLogParser(),
    workspaceFactory: new EphemeralWorkspaceFactory(),
    promptProvider: {
      getPrompt: (testCase) => {
        const prompt = descriptionByCaseId.get(testCase.testCaseId);
        if (prompt !== undefined) {
          return ResultAsync.fromSafePromise(Promise.resolve(prompt));
        }
        return ResultAsync.fromSafePromise(
          Promise.resolve(`Task to route: ${testCase.testCaseId}`),
        );
      },
    },
    openRouterApiKey: env.OPENROUTER_API_KEY ?? "",
    repoRoot: process.cwd(),
  });
}

// ---------------------------------------------------------------------------
// Dry-run sandbox image existence check
// ---------------------------------------------------------------------------

export type SandboxImageCheckError = {
  type: "SandboxImageCheckFailed";
  sandboxProfile: string;
  message: string;
};

/**
 * Read-only check for whether the sandbox image tag for a given symbolic
 * `sandbox_profile` already exists in the local podman image store.
 *
 * Invokes `podman image inspect <tag>` ONLY — never `podman run`, so this is
 * safe to call from the `--dry-run` path. Never spawns a container.
 *
 * Resolves `ok(false)` (not an error) when:
 *   - the `podman` binary is not installed/available, or
 *   - the image tag is not present locally.
 *
 * This keeps dry runs green on dev boxes / CI runners that have not yet
 * built the sandbox image, while still exercising the read-only inspection
 * call the task requires.
 */
export function checkSandboxImageExists(
  sandboxProfile: string,
): ResultAsync<boolean, SandboxImageCheckError> {
  return ResultAsync.fromPromise(
    resolveAndInspect(sandboxProfile),
    (cause): SandboxImageCheckError => ({
      type: "SandboxImageCheckFailed",
      sandboxProfile,
      message: cause instanceof Error ? cause.message : String(cause),
    }),
  );
}

async function resolveAndInspect(sandboxProfile: string): Promise<boolean> {
  const { resolveSandboxProfileImage } = await import(
    "@weaveio/weave-adapter-opencode"
  );
  const imageTag = resolveSandboxProfileImage(sandboxProfile);
  if (imageTag === undefined) {
    return false;
  }

  try {
    const proc = Bun.spawn(["podman", "image", "inspect", imageTag], {
      stdout: "ignore",
      stderr: "ignore",
    });

    const timeoutMs = 3000;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill();
    }, timeoutMs);

    const exitCode = await proc.exited;
    clearTimeout(timer);

    if (timedOut) {
      // `podman image inspect` hung (e.g. waiting on a podman machine
      // socket that doesn't exist on this host) — treat as "not present"
      // rather than blocking the caller indefinitely.
      return false;
    }

    return exitCode === 0;
  } catch {
    // podman binary not installed/available — treat as "not present" rather
    // than a hard failure so dry runs remain usable without podman.
    return false;
  }
}
