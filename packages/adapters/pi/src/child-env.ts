import type { PiEnvPort } from "./types.js";

/** Non-secret env vars used to bootstrap a private child (Spec 33 §11.2-§11.3). */
export const WEAVE_CHILD_SECRET_ENV = "WEAVE_CHILD_SECRET";
export const WEAVE_CHILD_ID_ENV = "WEAVE_CHILD_ID";
export const WEAVE_CONTROLLER_GENERATION_ENV = "WEAVE_CONTROLLER_GENERATION";
export const WEAVE_CHILD_AGENT_NAME_ENV = "WEAVE_CHILD_AGENT_NAME";
export const WEAVE_CHILD_DEPTH_ENV = "WEAVE_CHILD_DEPTH";
export const WEAVE_CHILD_PARENT_ID_ENV = "WEAVE_CHILD_PARENT_ID";

/** Production env port: reads and deletes from `Bun.env` (Bun's own environment object), never Node's `process.env`. */
export class BunEnvPort implements PiEnvPort {
  read(name: string): string | undefined {
    return Bun.env[name];
  }
  deleteValue(name: string): void {
    delete Bun.env[name];
  }
}

/** Fallback child executable name, used only when the exact launching executable cannot be determined (Spec 33 §11.2 finding 1). */
export const DEFAULT_PI_CHILD_EXECUTABLE = "pi";

/** The env var every POSIX shell sets, in a spawned process's own environment, to the resolved path of the command that actually launched it. */
const LAST_COMMAND_ENV = "_";

/**
 * Resolves the exact executable that launched the current Pi host process
 * (Spec 33 §11.2 finding 1), via the injected `PiEnvPort` rather than a bare
 * command name a spawner would have to re-resolve via `PATH`. `Bun.spawn`ing
 * a bare `"pi"` lets `PATH` order silently pick an unrelated `pi` install
 * (e.g. a different toolchain's shim) shadowing the real host - whose Node
 * runtime then fails packed-extension import with `Cannot find module
 * 'bun:ffi'`. `_` is exact host identity: read it, never re-derive it.
 * Returns `undefined` (never a fabricated guess) when `_` is absent, empty,
 * or not an absolute path.
 */
export function resolveCurrentPiExecutablePath(
  envPort: PiEnvPort,
): string | undefined {
  const raw = envPort.read(LAST_COMMAND_ENV);
  if (raw === undefined || raw.length === 0) return undefined;
  if (!raw.startsWith("/")) return undefined;
  return raw;
}

/**
 * Builds the private RPC child's default spawn command (Spec 33 §11.2
 * finding 1): the exact executable that launched this host process,
 * falling back to the bare `"pi"` name only when that cannot be determined.
 * Production wiring (`createDefaultPiExtensionDeps`) always calls this with
 * the real `BunEnvPort`; tests that need a fixed, PATH-independent command
 * override `PiExtensionDeps.childCommand` directly instead.
 */
export function buildDefaultPiChildCommand(
  envPort: PiEnvPort,
): readonly string[] {
  const executable =
    resolveCurrentPiExecutablePath(envPort) ?? DEFAULT_PI_CHILD_EXECUTABLE;
  return [executable, "--mode", "rpc", "--no-session"];
}

/**
 * A sanitized snapshot of the current process's own environment, safe to
 * use as the base environment for a spawned private child - preserves
 * ordinary runtime necessities (`PATH`, `HOME`, etc.) so the child process
 * can actually locate and run `pi`, while never forwarding any
 * credential/secret-shaped variable (Spec 33 §19.1's sensitive-key policy)
 * and never forwarding this adapter's own private child-bootstrap
 * variables (the caller always sets those explicitly, per child).
 */
export function sanitizedBaseEnv(
  isDeniedKey: (key: string) => boolean,
): Record<string, string> {
  const reserved = new Set<string>([
    WEAVE_CHILD_SECRET_ENV,
    WEAVE_CHILD_ID_ENV,
    WEAVE_CONTROLLER_GENERATION_ENV,
    WEAVE_CHILD_AGENT_NAME_ENV,
    WEAVE_CHILD_DEPTH_ENV,
    WEAVE_CHILD_PARENT_ID_ENV,
  ]);
  const sanitized: Record<string, string> = {};
  for (const [key, value] of Object.entries(Bun.env)) {
    if (value === undefined) continue;
    if (reserved.has(key)) continue;
    if (isDeniedKey(key)) continue;
    sanitized[key] = value;
  }
  return sanitized;
}
