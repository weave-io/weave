export interface CliOptions {
  help: boolean;
  separator: string;
  text: string;
}

/** Parses slugctl's command-line arguments (without the runtime and script path). */
export function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { help: false, separator: "-", text: "" };
  const words: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help") {
      options.help = true;
    } else if (arg === "--sep") {
      options.separator = argv[index + 1] ?? options.separator;
      index += 1;
    } else if (arg.startsWith("--")) {
      // Unknown flags are ignored.
    } else {
      words.push(arg);
    }
  }

  options.text = words.join(" ");
  return options;
}
