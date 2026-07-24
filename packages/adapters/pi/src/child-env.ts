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
