import { errAsync, okAsync, type ResultAsync } from "neverthrow";
import type {
  HarnessInstaller,
  InstallError,
  InstallRequest,
  InstallResult,
} from "./index.js";

/**
 * Runs `weave compose --adapter claude-code --init` for the current project.
 * Resolves with the compose exit code; the compose command prints its own
 * report.
 */
export type ComposeClaudeCode = () => ResultAsync<number, unknown>;

/**
 * Claude Code loads Weave as plugin directories generated per project, so
 * installing it means composing them: the bootstrap plugin that recomposes on
 * session start, and the generated agents and commands.
 */
export class ClaudeCodeInstaller implements HarnessInstaller {
  readonly id = "claude-code" as const;
  readonly supported = true;
  readonly optionalModules = [];

  constructor(private readonly compose: ComposeClaudeCode) {}

  install(request: InstallRequest): ResultAsync<InstallResult, InstallError> {
    if (request.scope === "global") {
      return okAsync({
        harness: this.id,
        changed: false,
        messages: [
          "Claude Code loads Weave per project: run `weave compose --adapter claude-code --init` in each project.",
        ],
      });
    }
    return this.compose()
      .mapErr(
        (cause): InstallError => ({
          type: "InstallFailed",
          harness: this.id,
          path: request.configPath,
          cause,
        }),
      )
      .andThen((exitCode) => {
        if (exitCode !== 0)
          return errAsync<InstallResult, InstallError>({
            type: "InstallFailed",
            harness: this.id,
            path: request.configPath,
            cause: "weave compose --adapter claude-code failed",
          });
        return okAsync<InstallResult, InstallError>({
          harness: this.id,
          changed: true,
          messages: ["Composed the Claude Code plugin."],
        });
      });
  }
}
