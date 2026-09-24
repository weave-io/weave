import { posix } from "node:path";
import { normalizePath } from "@weaveio/weave-config";
import { err, ok, type Result } from "neverthrow";

export interface OpenCode2SessionScope {
  readonly sessionID: string;
  readonly directory: string;
  readonly workspaceID?: string;
  readonly agent?: string;
}

export type SessionScopeError = { readonly type: "LocationMismatch" };

/**
 * The one directory spelling every scope comparison uses. Session location
 * refs arrive in the host's native form (`C:\project` on Windows); anything
 * stored or compared against `OpenCode2SessionScope.directory` must go
 * through this first.
 */
export function normalizeScopeDirectory(directory: string): string {
  return posix.normalize(normalizePath(directory));
}

export function validateSessionScope(
  sessionID: string,
  session: {
    readonly location: {
      readonly directory: string;
      readonly workspaceID?: string;
    };
    readonly agent?: string;
  },
  expectedDirectory: string,
  expectedWorkspaceID?: string,
): Result<OpenCode2SessionScope, SessionScopeError> {
  const directory = normalizeScopeDirectory(session.location.directory);
  if (directory !== normalizeScopeDirectory(expectedDirectory))
    return err({ type: "LocationMismatch" });
  // OpenCode 2.0.x session descriptors carry a public location ref
  // (`{ directory }`) without a workspace ID. Only compare the workspace when
  // the host still reports one on the session.
  const workspaceID = session.location.workspaceID;
  if (workspaceID !== undefined && workspaceID !== expectedWorkspaceID)
    return err({ type: "LocationMismatch" });
  return ok({
    sessionID,
    directory,
    workspaceID: workspaceID ?? expectedWorkspaceID,
    agent: session.agent,
  });
}
