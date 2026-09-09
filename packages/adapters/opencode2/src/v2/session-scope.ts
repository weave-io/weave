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
  if (session.location.workspaceID !== expectedWorkspaceID)
    return err({ type: "LocationMismatch" });
  return ok({
    sessionID,
    directory,
    workspaceID: session.location.workspaceID,
    agent: session.agent,
  });
}
