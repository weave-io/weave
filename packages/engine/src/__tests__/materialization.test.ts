import { describe, expect, it } from "bun:test";

import {
  type MaterializationError,
  type MaterializationInput,
  type MaterializationPlan,
  type MaterializedAgent,
  materializeAgents,
} from "../index.js";

describe("materialization barrel exports", () => {
  it("exports the public function and types", () => {
    const publicFunction: typeof materializeAgents = materializeAgents;
    const input = {} as MaterializationInput;
    const agent = {} as MaterializedAgent;
    const plan = {} as MaterializationPlan;
    const error = {} as MaterializationError;

    expect(publicFunction).toBe(materializeAgents);
    expect(input).toBeDefined();
    expect(agent).toBeDefined();
    expect(plan).toBeDefined();
    expect(error).toBeDefined();
  });
});
