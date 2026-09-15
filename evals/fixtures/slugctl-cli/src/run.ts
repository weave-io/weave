import { type CliOptions, parseArgs } from "./args.ts";
import { slugify } from "./slugify.ts";

export const USAGE = "Usage: slugctl [--separator <sep>] <text...>";

export interface RunDependencies {
  parse: (argv: string[]) => CliOptions;
}

/** Returns what slugctl prints for the given arguments. */
export function run(
  argv: string[],
  dependencies: RunDependencies = { parse: parseArgs },
): string {
  const options = dependencies.parse(argv);
  if (options.help || options.text.length === 0) {
    return USAGE;
  }
  return slugify(options.text, { separator: options.separator });
}
