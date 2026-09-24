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
  const directory = posix.normalize(normalizePath(session.location.directory));
  if (directory !== posix.normalize(normalizePath(expectedDirectory)))
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
