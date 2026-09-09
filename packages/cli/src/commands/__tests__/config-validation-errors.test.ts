import { describe, expect, it } from "bun:test";
import type { ConfigLoadError } from "@weaveio/weave-config";
import { errAsync } from "neverthrow";
import type { ParsedArgs } from "../../args.js";
import { BufferTerminal } from "../../io/terminal.js";
import { ThemeManager } from "../../theme/colors.js";
import { runPrompt } from "../prompt.js";

describe("CLI merged config validation diagnostics", () => {
  it("renders the typed layer and bounded validation issue", async () => {
    const terminal = new BufferTerminal();
    const errors: ConfigLoadError[] = [
      {
        type: "MergeError",
        errors: [
          {
            type: "ConfigValidationError",
            layer: "merged",
            errors: [
              {
                type: "ValidationError",
                path: "agents.helper.prompt",
                message: "prompt conflicts with prompt_file",
              },
            ],
          },
        ],
      },
    ];
    const flags: ParsedArgs["flags"] = {
      help: false,
      version: false,
      json: false,
      yes: false,
      force: false,
      allHarnesses: false,
      project: false,
      global: false,
      promptSubcommand: "list",
    };
    const result = await runPrompt({
      terminal,
      theme: new ThemeManager({ isTty: () => false }).getTheme(false),
      flags,
      rest: [],
      cwd: "/project",
      configLoader: () => errAsync(errors),
    });
    expect(result._unsafeUnwrap()).toBe(1);
    expect(terminal.err.join("\n")).toContain(
      "merge:merged:[agents.helper.prompt] prompt conflicts with prompt_file",
    );
  });
});
