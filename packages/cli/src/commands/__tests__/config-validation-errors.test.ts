import { describe, expect, it } from "bun:test";
import type { ConfigLoadError } from "@weaveio/weave-config";
import { mapConfigLoadErrors as mapCompose } from "../compose.js";
import { mapConfigLoadErrors as mapPrompt } from "../prompt.js";
import { mapConfigLoadErrors as mapValidate } from "../validate.js";

const mergeFailure: ConfigLoadError = {
  type: "MergeError",
  errors: [
    {
      type: "ConfigValidationError",
      errors: [
        {
          path: "agents.loom.delegation.max_children",
          message: "agent max_children may not exceed the project cap",
        },
      ],
    },
  ],
};

describe("CLI cross-layer validation errors", () => {
  it.each([
    ["compose", mapCompose],
    ["prompt", mapPrompt],
    ["validate", mapValidate],
  ])("formats %s ConfigValidationError without throwing", (_name, mapper) => {
    const error = mapper("/project", [mergeFailure]);
    expect(error.type).toBe("ParseFailure");
    if (error.type !== "ParseFailure") return;
    expect(error.errors).toEqual([
      "merge:ConfigValidationError:agents.loom.delegation.max_children:agent max_children may not exceed the project cap",
    ]);
  });
});
