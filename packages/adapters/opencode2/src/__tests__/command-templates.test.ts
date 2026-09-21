/**
 * Scenarios in `tests/adapters/opencode2.scenario.test.ts` cover what a
 * user observes of this adapter.
 *
 * Kept: a compatibility surface with no path from the plugin a user
 * loads. `@weaveio/weave-adapter-opencode2/server` — the only entry point the
 * V2 plugin loader accepts — publishes `src/v2/plugin.ts`, and nothing on that
 * path imports this module, so no scenario can reach it. See
 * `docs/opencode2-adapter.md`.
 */

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
