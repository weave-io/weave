import { describe, expect, it } from "bun:test";

import {
  BUILTIN_COMMANDS,
  WEAVE_ABORT_TEMPLATE,
  WEAVE_ADVANCE_TEMPLATE,
  WEAVE_HEALTH_TEMPLATE,
  WEAVE_RUN_TEMPLATE,
  WEAVE_START_TEMPLATE,
  WEAVE_STATUS_TEMPLATE,
} from "../command-templates.js";

describe("command-templates", () => {
  it("declares the canonical built-in command set in order", () => {
    expect(BUILTIN_COMMANDS.map((t) => t.name)).toEqual([
      "weave:start",
      "weave:run",
      "weave:status",
      "weave:abort",
      "weave:advance",
      "weave:health",
    ]);
  });

  it("every template has a non-empty description", () => {
    for (const template of BUILTIN_COMMANDS) {
      expect(template.description.length).toBeGreaterThan(0);
    }
  });

  it("every template's promptTemplate contains an {{arguments}} placeholder", () => {
    for (const template of BUILTIN_COMMANDS) {
      expect(template.promptTemplate).toContain("{{arguments}}");
    }
  });

  it("every template's promptTemplate carries its own command-name in the envelope", () => {
    expect(WEAVE_START_TEMPLATE.promptTemplate).toContain(
      "<command-name>weave:start</command-name>",
    );
    expect(WEAVE_RUN_TEMPLATE.promptTemplate).toContain(
      "<command-name>weave:run</command-name>",
    );
    expect(WEAVE_STATUS_TEMPLATE.promptTemplate).toContain(
      "<command-name>weave:status</command-name>",
    );
    expect(WEAVE_ABORT_TEMPLATE.promptTemplate).toContain(
      "<command-name>weave:abort</command-name>",
    );
    expect(WEAVE_ADVANCE_TEMPLATE.promptTemplate).toContain(
      "<command-name>weave:advance</command-name>",
    );
    expect(WEAVE_HEALTH_TEMPLATE.promptTemplate).toContain(
      "<command-name>weave:health</command-name>",
    );
  });

  it("command names contain no leading slash", () => {
    for (const template of BUILTIN_COMMANDS) {
      expect(template.name.startsWith("/")).toBe(false);
    }
  });
});
