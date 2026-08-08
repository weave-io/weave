import { describe, expect, it } from "bun:test";
import { parseConfig, type WeaveConfig } from "@weaveio/weave-core";
import {
  authorizeDelegation,
  type EffectiveDelegationLimits,
  resolveEffectiveDelegationLimits,
} from "../index.js";

function config(source: string) {
  const result = parseConfig(source);
  if (result.isErr()) throw new Error(JSON.stringify(result.error));
  return result.value;
}

const limits: EffectiveDelegationLimits = {
  maxChildren: 9,
  maxConcurrency: 3,
  maxDepth: 3,
  maxProcesses: 9,
};

describe("resolveEffectiveDelegationLimits", () => {
  it("uses the portable defaults", () => {
    const result = resolveEffectiveDelegationLimits(config(""));
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual(limits);
  });

  it("resolves project limits", () => {
    const result = resolveEffectiveDelegationLimits(
      config(`settings {
  delegation {
    max_children 6
    max_concurrency 2
    max_depth 4
    max_processes 12
  }
}`),
    );
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual({
      maxChildren: 6,
      maxConcurrency: 2,
      maxDepth: 4,
      maxProcesses: 12,
    });
  });

  it("clamps omitted project concurrency to max_children", () => {
    const result = resolveEffectiveDelegationLimits(
      config(`settings {
  delegation { max_children 2 }
}`),
    );
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().maxConcurrency).toBe(2);
  });

  it("rejects explicit project concurrency above max_children", () => {
    const result = resolveEffectiveDelegationLimits({
      ...config(`settings {
  delegation { max_children 2 }
}`),
      settings: {
        ...config(`settings {
  delegation { max_children 2 }
}`).settings,
        delegation: { max_children: 2, max_concurrency: 3 },
      },
    } as WeaveConfig);
    expect(result.isErr()).toBe(true);
  });

  it("rejects malformed project limits before agent overrides", () => {
    const base = config(
      `agent tapestry { delegation { max_children 9 max_concurrency 9 } }`,
    );
    const malformed: WeaveConfig = {
      ...base,
      settings: {
        ...base.settings,
        delegation: { max_children: 10, max_concurrency: 9 },
      },
    };
    const result = resolveEffectiveDelegationLimits(malformed, "tapestry");
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().type).toBe("InvalidDelegationLimits");

    const nanProject: WeaveConfig = {
      ...base,
      settings: {
        ...base.settings,
        delegation: { max_children: Number.NaN },
      },
    };
    const nanResult = resolveEffectiveDelegationLimits(nanProject, "tapestry");
    expect(nanResult.isErr()).toBe(true);
    expect(nanResult._unsafeUnwrapErr().type).toBe("InvalidDelegationLimits");
  });

  it("applies narrower agent child and concurrency overrides", () => {
    const result = resolveEffectiveDelegationLimits(
      config(`settings {
  delegation { max_children 6 max_concurrency 3 max_depth 4 max_processes 12 }
}
agent tapestry {
  delegation { max_children 2 max_concurrency 1 }
}`),
      "tapestry",
    );
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual({
      maxChildren: 2,
      maxConcurrency: 1,
      maxDepth: 4,
      maxProcesses: 12,
    });
  });

  it("clamps inherited concurrency when an agent narrows maxChildren", () => {
    const result = resolveEffectiveDelegationLimits(
      config(`agent tapestry {
  delegation { max_children 2 }
}`),
      "tapestry",
    );
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().maxConcurrency).toBe(2);
  });

  it("returns AgentNotFound for an unknown agent", () => {
    const result = resolveEffectiveDelegationLimits(config(""), "missing");
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toEqual({
      type: "AgentNotFound",
      agentName: "missing",
    });
  });
});

describe("authorizeDelegation", () => {
  it("authorizes within every limit", () => {
    const result = authorizeDelegation({
      limits,
      directChildren: 2,
      activeChildren: 1,
      childDepth: 2,
      liveProcesses: 4,
    });
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual({ outcome: "authorized" });
  });

  it("denies when the proposed child exceeds maxDepth", () => {
    const result = authorizeDelegation({
      limits,
      directChildren: 0,
      activeChildren: 0,
      childDepth: 4,
      liveProcesses: 0,
    });
    expect(result._unsafeUnwrap()).toEqual({
      outcome: "denied",
      reason: "max_depth",
    });
  });

  it("denies when active child capacity is exhausted", () => {
    const result = authorizeDelegation({
      limits,
      directChildren: 9,
      activeChildren: 9,
      childDepth: 1,
      liveProcesses: 9,
    });
    expect(result._unsafeUnwrap()).toEqual({
      outcome: "denied",
      reason: "max_children",
    });
  });

  it("does not consume max_children capacity after direct children settle", () => {
    const result = authorizeDelegation({
      limits,
      directChildren: 9,
      activeChildren: 0,
      childDepth: 1,
      liveProcesses: 0,
    });
    expect(result._unsafeUnwrap()).toEqual({ outcome: "authorized" });
  });

  it("queues when parent concurrency is exhausted", () => {
    const result = authorizeDelegation({
      limits,
      directChildren: 3,
      activeChildren: 3,
      childDepth: 1,
      liveProcesses: 3,
    });
    expect(result._unsafeUnwrap()).toEqual({
      outcome: "queued",
      reason: "max_concurrency",
    });
  });

  it("queues when global process capacity is exhausted", () => {
    const result = authorizeDelegation({
      limits,
      directChildren: 3,
      activeChildren: 1,
      childDepth: 1,
      liveProcesses: 9,
    });
    expect(result._unsafeUnwrap()).toEqual({
      outcome: "queued",
      reason: "max_processes",
    });
  });

  it("prioritizes permanent denials over queue reasons", () => {
    const result = authorizeDelegation({
      limits,
      directChildren: 9,
      activeChildren: 3,
      childDepth: 4,
      liveProcesses: 9,
    });
    expect(result._unsafeUnwrap()).toEqual({
      outcome: "denied",
      reason: "max_depth",
    });
  });

  it("returns typed errors for invalid adapter-supplied counts", () => {
    const result = authorizeDelegation({
      limits,
      directChildren: -1,
      activeChildren: 0,
      childDepth: 1,
      liveProcesses: 0,
    });
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toMatchObject({
      type: "InvalidDelegationCount",
      field: "directChildren",
      value: -1,
    });
  });

  it("rejects inconsistent adapter-supplied counts", () => {
    const result = authorizeDelegation({
      limits,
      directChildren: 1,
      activeChildren: 2,
      childDepth: 1,
      liveProcesses: 2,
    });
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toMatchObject({
      type: "InvalidDelegationCount",
      field: "activeChildren",
    });
  });

  it("rejects zero childDepth", () => {
    const result = authorizeDelegation({
      limits,
      directChildren: 0,
      activeChildren: 0,
      childDepth: 0,
      liveProcesses: 0,
    });
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toMatchObject({
      type: "InvalidDelegationCount",
      field: "childDepth",
    });
  });

  it("rejects malformed effective limits defensively", () => {
    const result = authorizeDelegation({
      limits: { ...limits, maxConcurrency: 10 },
      directChildren: 0,
      activeChildren: 0,
      childDepth: 1,
      liveProcesses: 0,
    });
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toMatchObject({
      type: "InvalidDelegationLimits",
      field: "maxConcurrency",
    });
  });
});
