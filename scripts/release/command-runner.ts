import { errAsync, okAsync, ResultAsync } from "neverthrow";
import type { CommandError } from "./errors.js";

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}
export interface CommandRunner {
  run(argv: readonly string[]): ResultAsync<CommandResult, CommandError>;
}

const META = /[;&|`$<>\n\r]/;
const TAGS = new Set(["nightly", "next"]);
const safe = (value: string): boolean => value.length > 0 && !META.test(value);

/** Runs only argv-shaped npm publication and read-only verification commands. */
export class BunCommandRunner implements CommandRunner {
  constructor(private readonly maxOutputBytes = 64 * 1024) {}
  run(argv: readonly string[]): ResultAsync<CommandResult, CommandError> {
    const rejected = validate(argv);
    if (rejected !== undefined)
      return errAsync({
        type: "CommandRejected" as const,
        argv,
        reason: rejected,
      });
    return ResultAsync.fromPromise(this.spawn([...argv]), (cause) => ({
      type: "CommandSpawnFailed" as const,
      argv,
      message: String(cause),
    })).andThen((result) => {
      if (result.exitCode !== 0)
        return errAsync({
          type: "CommandFailed" as const,
          argv,
          exitCode: result.exitCode,
          stderr: result.stderr,
        });
      return okAsync(result);
    });
  }
  private async spawn(argv: string[]): Promise<CommandResult> {
    const process = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
    const [exitCode, stdout, stderr] = await Promise.all([
      process.exited,
      process.stdout ? new Response(process.stdout).text() : "",
      process.stderr ? new Response(process.stderr).text() : "",
    ]);
    return {
      exitCode,
      stdout: stdout.slice(0, this.maxOutputBytes),
      stderr: stderr.slice(0, this.maxOutputBytes),
    };
  }
}

function validate(argv: readonly string[]): string | undefined {
  if (argv[0] !== "npm" || argv.some((part) => !safe(part)))
    return "only safe npm argv values are permitted";
  if (argv[1] === "publish") {
    if (
      argv.length !== 7 ||
      !argv[2]?.endsWith(".tgz") ||
      argv[3] !== "--access" ||
      argv[4] !== "public" ||
      argv[5] !== "--tag" ||
      !TAGS.has(argv[6] ?? "")
    )
      return "publish must be npm publish <tarball.tgz> --access public --tag <nightly|next>";
    return undefined;
  }
  if (argv[1] === "ping" && argv.length === 2) return undefined;
  if (
    argv[1] === "view" &&
    (argv.length === 3 ||
      (argv.length === 4 && argv[3] === "dist-tags") ||
      (argv.length === 5 && argv[3] === "versions" && argv[4] === "--json"))
  )
    return undefined;
  return "npm subcommand or arguments are not allowlisted";
}
