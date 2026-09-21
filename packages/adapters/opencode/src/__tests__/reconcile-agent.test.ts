/**
 * Unit tests for `reconcile-agent.ts`.
 *
 * Almost everything this module promises is now asserted from outside, in
 * `tests/adapters/opencode-runtime.scenario.test.ts`: create, update, collision
 * refusal, the wording of the collision message, ownership tagging, name
 * matching, and the upsert-only rule are all visible in the agents a running
 * OpenCode is left holding. Those 40 cases are gone.
 *
 * What stays is what no OpenCode instance can show:
 *
 * | Kept | Why |
 * | --- | --- |
 * | `classifyExistingAgent` with two same-named agents | OpenCode keys its agents by name, so it cannot hold two. The branch guards a malformed list from the SDK |
 * | `tagWithOwnership` idempotency | Unreachable. Every caller — the config hook and `reconcileAgent` — passes a freshly translated config whose description has never been tagged, so the guard cannot fire. Deleting it turns no scenario red; a mutation that writes the tag twice turns three red, which is what proves the scenarios are watching |
 */

import { describe, expect, it } from "bun:test";
import {
  classifyExistingAgent,
  tagWithOwnership,
  WEAVE_OWNERSHIP_TAG,
} from "../reconcile-agent.js";
import type { OpenCodeAgent, OpenCodeAgentConfig } from "../sdk-types.js";

/** Builds a Weave-managed `OpenCodeAgent` (has ownership tag in description). */
function makeWeaveManagedAgent(name: string): OpenCodeAgent {
  return { name, description: WEAVE_OWNERSHIP_TAG } as OpenCodeAgent;
}

/** Builds a foreign `OpenCodeAgent` (no ownership tag in description). */
function makeForeignAgent(name: string): OpenCodeAgent {
  return { name, description: "A manually created agent" } as OpenCodeAgent;
}

describe("classifyExistingAgent — a malformed agent list", () => {
  it("uses the first matching agent when two share a name", () => {
    const agents = [
      makeWeaveManagedAgent("my-agent"),
      makeForeignAgent("my-agent"),
    ];

    expect(classifyExistingAgent("my-agent", agents)).toBe("update");
  });
});

describe("tagWithOwnership — an already-tagged description", () => {
  it("leaves the tag exactly once rather than appending a second", () => {
    const config: OpenCodeAgentConfig = {
      prompt: "You are a test agent.",
      mode: "subagent",
      description: `My agent ${WEAVE_OWNERSHIP_TAG}`,
    };

    const tagged = tagWithOwnership(config);

    expect(
      (tagged.description ?? "").split(WEAVE_OWNERSHIP_TAG).length - 1,
    ).toBe(1);
  });
});
