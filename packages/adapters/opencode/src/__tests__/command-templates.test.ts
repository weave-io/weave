import { describe, expect, it } from "bun:test";
import {
  START_WORK_COMMAND_TEMPLATE,
  WEAVE_START_COMMAND_TEMPLATE,
} from "../command-templates.js";

const templates = [
  ["/start-work", START_WORK_COMMAND_TEMPLATE],
  ["/weave:start", WEAVE_START_COMMAND_TEMPLATE],
] as const;

describe("OpenCode command templates", () => {
  it.each(
    templates,
  )("requires an explicit plan argument for %s", (_, template) => {
    expect(template).toContain(
      "Treat the text after the command as the user's explicit plan argument",
    );
    expect(template).toContain(
      "If the argument is absent or blank, ask the user to select a plan",
    );
    expect(template).toContain(
      "use the actual repository tools and files available in this session to validate the named plan",
    );
    expect(template).toContain(".weave/plans/<plan-name>.md");
  });

  it.each(
    templates,
  )("carries empty and explicit arguments for %s", (_, template) => {
    expect(template.replaceAll("$ARGUMENTS", "")).toContain(
      "<user-request></user-request>",
    );
    expect(template.replaceAll("$ARGUMENTS", "remediation-plan")).toContain(
      "<user-request>remediation-plan</user-request>",
    );
  });

  it.each(
    templates,
  )("does not claim system plan state for %s", (_, template) => {
    expect(template).toContain(
      "`.weave/state.json`, if present, as ordinary repository data",
    );
    expect(template).toContain("does not create or update work state");
    expect(template).toContain("does not select or authenticate a plan");
    expect(template).toContain("does not invoke a runtime handler");

    for (const falseClaim of [
      "system has injected context",
      "system has selected a plan",
      "created work state",
      "authenticated plan",
      "active-plan context",
    ]) {
      expect(template).not.toContain(falseClaim);
    }
  });
});
