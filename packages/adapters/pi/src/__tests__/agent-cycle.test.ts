import { describe, expect, it } from "bun:test";
import type { AgentDescriptor } from "@weaveio/weave-engine";
import {
  listCycleablePrimaryAgents,
  nextCycleablePrimaryAgent,
  PI_AGENT_BADGE_BG_TOKENS,
  renderActiveAgentBadge,
  selectAgentBadgeBg,
} from "../agent-cycle.js";
import type { PiUiThemePort } from "../types.js";

function descriptor(
  name: string,
  mode: AgentDescriptor["mode"],
): AgentDescriptor {
  return {
    name,
    composedPrompt: `You are ${name}.`,
    models: [],
    mode,
    effectiveToolPolicy: {
      read: "allow",
      write: "allow",
      execute: "allow",
      delegate: "allow",
      network: "ask",
    },
    rawToolPolicy: undefined,
    delegationTargets: [],
    skills: [],
  };
}

describe("primary-agent cycle helpers", () => {
  const descriptors = new Map([
    ["loom", descriptor("loom", "primary")],
    ["shuttle", descriptor("shuttle", "subagent")],
    ["tapestry", descriptor("tapestry", "all")],
  ]);

  it("keeps primary and all descriptors in materialization order", () => {
    expect(
      listCycleablePrimaryAgents(descriptors).map((agent) => agent.name),
    ).toEqual(["loom", "tapestry"]);
  });

  it("cycles with wraparound and skips subagents", () => {
    expect(nextCycleablePrimaryAgent(descriptors, "loom")?.name).toBe(
      "tapestry",
    );
    expect(nextCycleablePrimaryAgent(descriptors, "tapestry")?.name).toBe(
      "loom",
    );
  });

  it("does not cycle when fewer than two primary agents exist", () => {
    expect(
      nextCycleablePrimaryAgent(
        new Map([["loom", descriptor("loom", "primary")]]),
        "loom",
      ),
    ).toBeUndefined();
  });

  it("renders a readable fallback badge without a theme", () => {
    expect(renderActiveAgentBadge("tapestry")).toBe("◆ WEAVE · TAPESTRY");
  });

  it("uses Pi theme tokens when the host exposes them", () => {
    expect(renderActiveAgentBadge("loom", themeWithoutBg)).toBe(
      "<accent>◆</accent> <bold>WEAVE</bold> <muted>·</muted> <accent><bold>LOOM</bold></accent>",
    );
  });
});

/** Records every `bg()` call so wrapper order and token can both be asserted. */
const themeWithoutBg: PiUiThemePort = {
  fg: (color, text) => `<${color}>${text}</${color}>`,
  bold: (text) => `<bold>${text}</bold>`,
};

const themeWithBg: PiUiThemePort = {
  ...themeWithoutBg,
  bg: (color, text) => `<${color}>${text}</${color}>`,
};

/** The exact tokens Pi's own `Theme.bg()` accepts, in the contracted order. */
const SUPPORTED_BG_TOKENS = [
  "selectedBg",
  "userMessageBg",
  "customMessageBg",
  "toolPendingBg",
  "toolSuccessBg",
  "toolErrorBg",
] as const;

const BUILTIN_AGENT_NAMES = [
  "loom",
  "pattern",
  "shuttle",
  "spindle",
  "tapestry",
  "thread",
  "warp",
  "weft",
] as const;

describe("active-agent badge background mapping", () => {
  it("exposes exactly the supported Pi background tokens in a fixed order", () => {
    expect(PI_AGENT_BADGE_BG_TOKENS).toEqual([...SUPPORTED_BG_TOKENS]);
  });

  it("only ever selects a supported token", () => {
    for (const name of [...BUILTIN_AGENT_NAMES, "", "   ", "a", "ünïcødé"]) {
      expect(SUPPORTED_BG_TOKENS).toContain(selectAgentBadgeBg(name));
    }
  });

  it("maps case and whitespace variants of one name to one token", () => {
    const canonical = selectAgentBadgeBg("shuttle mini");
    for (const variant of [
      "shuttle mini",
      "Shuttle Mini",
      "SHUTTLE MINI",
      "  shuttle   mini  ",
      "\tshuttle\nmini ",
    ]) {
      expect(selectAgentBadgeBg(variant)).toBe(canonical);
    }
  });

  it("is pure: repeated calls and interleaved names never drift", () => {
    const first = BUILTIN_AGENT_NAMES.map(selectAgentBadgeBg);
    for (let round = 0; round < 5; round += 1) {
      for (const other of ["weft", "warp", "unknown-agent"]) {
        selectAgentBadgeBg(other);
      }
      expect(BUILTIN_AGENT_NAMES.map(selectAgentBadgeBg)).toEqual(first);
    }
  });

  it("is order independent: reversed input yields the same per-name token", () => {
    const forward = new Map(
      BUILTIN_AGENT_NAMES.map((name) => [name, selectAgentBadgeBg(name)]),
    );
    const reversed = new Map(
      [...BUILTIN_AGENT_NAMES]
        .reverse()
        .map((name) => [name, selectAgentBadgeBg(name)]),
    );
    expect(reversed).toEqual(forward);
  });

  it("pins the builtin agent tokens so they stay stable across releases", () => {
    // Frozen expectations: a change here means users' learned colours moved.
    expect(
      Object.fromEntries(
        BUILTIN_AGENT_NAMES.map((name) => [name, selectAgentBadgeBg(name)]),
      ),
    ).toEqual({
      loom: "toolSuccessBg",
      pattern: "userMessageBg",
      shuttle: "toolSuccessBg",
      spindle: "customMessageBg",
      tapestry: "toolErrorBg",
      thread: "userMessageBg",
      warp: "toolErrorBg",
      weft: "toolErrorBg",
    });
  });

  it("distributes distinct agents across several tokens", () => {
    const used = new Set(BUILTIN_AGENT_NAMES.map(selectAgentBadgeBg));
    expect(used.size).toBeGreaterThanOrEqual(4);

    const wide = new Set(
      Array.from({ length: 200 }, (_unused, index) =>
        selectAgentBadgeBg(`agent-${index}`),
      ),
    );
    expect([...wide].sort()).toEqual([...SUPPORTED_BG_TOKENS].sort());
  });
});

describe("renderActiveAgentBadge theming", () => {
  it("wraps the accent+bold name inside the background token", () => {
    expect(renderActiveAgentBadge("loom", themeWithBg)).toBe(
      "<accent>◆</accent> <bold>WEAVE</bold> <muted>·</muted> <toolSuccessBg><accent><bold>LOOM</bold></accent></toolSuccessBg>",
    );
  });

  it("passes the selected token for each agent", () => {
    const seen: string[] = [];
    const theme: PiUiThemePort = {
      ...themeWithoutBg,
      bg: (color, text) => {
        seen.push(color);
        return text;
      },
    };
    for (const name of BUILTIN_AGENT_NAMES) {
      renderActiveAgentBadge(name, theme);
    }
    expect(seen).toEqual(BUILTIN_AGENT_NAMES.map(selectAgentBadgeBg));
  });

  it("paints one colour for case and whitespace variants of one agent", () => {
    const seen: string[] = [];
    const theme: PiUiThemePort = {
      ...themeWithoutBg,
      bg: (color, text) => {
        seen.push(color);
        return text;
      },
    };
    for (const variant of ["tapestry", "TAPESTRY", " Tapestry "]) {
      renderActiveAgentBadge(variant, theme);
    }
    expect(new Set(seen).size).toBe(1);
  });

  it("falls back to the exact foreground-only badge without theme.bg", () => {
    expect(renderActiveAgentBadge("tapestry", themeWithoutBg)).toBe(
      "<accent>◆</accent> <bold>WEAVE</bold> <muted>·</muted> <accent><bold>TAPESTRY</bold></accent>",
    );
    expect(() =>
      renderActiveAgentBadge("tapestry", themeWithoutBg),
    ).not.toThrow();
  });
});
