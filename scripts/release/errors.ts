export type CommandError =
  | { type: "CommandRejected"; argv: readonly string[]; reason: string }
  | {
      type: "CommandFailed";
      argv: readonly string[];
      exitCode: number;
      stderr: string;
    }
  | { type: "CommandSpawnFailed"; argv: readonly string[]; message: string };

export type FileSystemError = {
  type: "FileSystemError";
  path: string;
  message: string;
};
export type RegistryError = {
  type: "RegistryError";
  operation: string;
  message: string;
};
export type GitHubError = {
  type: "GitHubError";
  operation: string;
  status?: number;
  message: string;
};
export type ReleaseError =
  | CommandError
  | FileSystemError
  | RegistryError
  | { type: "InvalidManifest"; issues: readonly string[] }
  | { type: "DigestMismatch"; expected: string; actual: string }
  | { type: "TarPreflightFailed"; reason: string }
  | { type: "CredentialSourceDetected"; source: string }
  | { type: "BindingVerificationFailed"; reason: string }
  | { type: "RegistryDigestConflict"; packageName: string; version: string }
  | { type: "UnsupportedOperation"; operation: string };
