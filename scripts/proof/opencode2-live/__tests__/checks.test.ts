import { describe, expect, it } from "bun:test";
import {
  type CapturedRequest,
  type HostAgent,
  LiveChecks,
  type LiveObservation,
  type LiveVerdict,
} from "../checks.js";

const MARKER = "[weave-managed]";
const LOOM_SYSTEM = "# loom — Main Orchestrator\nYou are loom.";
const SHUTTLE_SYSTEM = "# shuttle — Domain Specialist\nYou are shuttle.";

const checks = new LiveChecks({
  expectedAgents: ["loom", "shuttle"],
  ownershipMarker: MARKER,
  primary: "loom",
  delegate: "shuttle",
  startCommand: "weave:start",
  delegationTool: "subagent",
  subagentForbiddenTools: ["subagent", "question"],
});

const weaveAgents: HostAgent[] = [
  { id: "build", mode: "primary", description: "The default agent." },
  {
    id: "loom",
    mode: "primary",
    description: `${MARKER} Main orchestrator`,
    system: LOOM_SYSTEM,
  },
  {
    id: "shuttle",
    mode: "subagent",
    description: `${MARKER} Implementation worker`,
    system: SHUTTLE_SYSTEM,
  },
];

function tool(name: string, description = ""): object {
  return { type: "function", function: { name, description } };
}

function request(
  system: string,
  tools: readonly object[],
  roles: readonly string[] = ["user"],
): CapturedRequest {
  return {
    body: {
      messages: [
        // The host appends environment details after the agent's prompt.
        { role: "system", content: `${system}\n\n<env>cwd: /project</env>` },
        ...roles.map((role) => ({ role, content: "x" })),
      ],
      tools,
    },
  };
}

const delegatingRun: CapturedRequest[] = [
  request("You are a title generator.", []),
  request(LOOM_SYSTEM, [tool("read"), tool("subagent", "- shuttle: worker")]),
  request(SHUTTLE_SYSTEM, [tool("read"), tool("write")]),
  request(
    LOOM_SYSTEM,
    [tool("read"), tool("subagent", "- shuttle: worker")],
    ["user", "assistant", "tool"],
  ),
];

function observation(
  overrides: Partial<LiveObservation> = {},
): LiveObservation {
  return {
    hostVersion: "opencode v2.0.16",
    expectedHostVersion: "2.0.16",
    plugins: [
      {
        id: "opencode.agent",
        source: { type: "builtin" },
        state: { status: "active" },
      },
      {
        id: "weave",
        source: {
          type: "package",
          target: "@weaveio/weave-adapter-opencode2@next",
          version: "0.2.0",
        },
        state: { status: "active" },
      },
    ],
    agents: weaveAgents,
    commands: ["init", "review", "weave:start"],
    run: { exitCode: 0, requests: delegatingRun },
    ...overrides,
  };
}

function verdict(
  verdicts: readonly LiveVerdict[],
  id: LiveVerdict["id"],
): LiveVerdict {
  const found = verdicts.find((entry) => entry.id === id);
  if (found === undefined) throw new Error(`no verdict ${id}`);
  return found;
}

describe("a host where Weave registers its agents and Loom delegates to Shuttle", () => {
  it("passes every check", () => {
    const verdicts = checks.evaluate(observation());
    expect(verdicts.map((entry) => entry.status)).toEqual(
      Array(verdicts.length).fill("passed"),
    );
    expect(LiveChecks.outcome(verdicts).isOk()).toBe(true);
  });
});

describe("a plugin that loads but registers no Weave agents (issue #209's silent empty install)", () => {
  const verdicts = checks.evaluate(
    observation({
      agents: weaveAgents.filter((agent) => agent.id === "build"),
      commands: ["init", "review"],
      run: null,
    }),
  );

  it("still reports the plugin itself as active", () => {
    expect(verdict(verdicts, "plugin_active").status).toBe("passed");
  });

  it("fails agent registration and names every missing agent", () => {
    const registered = verdict(verdicts, "agents_registered");
    expect(registered.status).toBe("failed");
    expect(registered.evidence).toContain("loom (absent)");
    expect(registered.evidence).toContain("shuttle (absent)");
  });

  it("fails the start command check", () => {
    expect(verdict(verdicts, "start_command").status).toBe("failed");
  });

  it("skips the run checks rather than passing them", () => {
    expect(verdict(verdicts, "loom_prompt").status).toBe("skipped");
    expect(LiveChecks.outcome(verdicts).isErr()).toBe(true);
  });
});

describe("a same-named agent that some other plugin registered", () => {
  it("is not counted as a Weave agent", () => {
    const foreign = weaveAgents.map((agent) =>
      agent.id === "shuttle"
        ? { ...agent, description: "Someone else's shuttle" }
        : agent,
    );
    const registered = verdict(
      checks.evaluate(observation({ agents: foreign })),
      "agents_registered",
    );
    expect(registered.status).toBe("failed");
    expect(registered.evidence).toContain("shuttle (not Weave-owned)");
  });
});

describe("a plugin the host failed to load", () => {
  it("fails plugin activation with the host's error", () => {
    const plugins = [
      {
        source: { type: "local", path: "/adapter/package" },
        state: { status: "failed", error: "Plugin failed to load" },
      },
    ];
    const active = verdict(
      checks.evaluate(observation({ plugins })),
      "plugin_active",
    );
    expect(active.status).toBe("failed");
    expect(active.evidence).toContain("Plugin failed to load");
  });
});

describe("a host other than the requested version", () => {
  it("fails the host version check", () => {
    const version = verdict(
      checks.evaluate(observation({ hostVersion: "opencode v2.0.17" })),
      "host_version",
    );
    expect(version.status).toBe("failed");
  });
});

describe("a run where Loom's prompt never reached the model", () => {
  it("fails the prompt check", () => {
    const requests = delegatingRun.map((entry) =>
      JSON.stringify(entry.body).includes("You are loom.")
        ? request("You are some other agent.", [])
        : entry,
    );
    const prompt = verdict(
      checks.evaluate(observation({ run: { exitCode: 0, requests } })),
      "loom_prompt",
    );
    expect(prompt.status).toBe("failed");
  });
});

describe("a run where Loom is not offered Shuttle", () => {
  it("fails the delegation offer check", () => {
    const requests = [
      request(LOOM_SYSTEM, [tool("subagent", "- thread: explorer")]),
    ];
    const offered = verdict(
      checks.evaluate(observation({ run: { exitCode: 0, requests } })),
      "delegation_offered",
    );
    expect(offered.status).toBe("failed");
    expect(offered.evidence).toContain("does not list shuttle");
  });
});

describe("a run where the delegation never reached Shuttle", () => {
  const requests = delegatingRun.filter(
    (entry) => !JSON.stringify(entry.body).includes("You are shuttle."),
  );
  const verdicts = checks.evaluate(
    observation({ run: { exitCode: 1, requests } }),
  );

  it("fails the delegation check", () => {
    expect(verdict(verdicts, "delegation_ran").status).toBe("failed");
  });

  it("skips the subagent policy check", () => {
    expect(verdict(verdicts, "subagent_policy").status).toBe("skipped");
  });
});

describe("a run where Shuttle's result never came back to Loom", () => {
  it("fails the return check", () => {
    const requests = delegatingRun.slice(0, 3);
    const returned = verdict(
      checks.evaluate(observation({ run: { exitCode: 0, requests } })),
      "delegation_returned",
    );
    expect(returned.status).toBe("failed");
  });
});

describe("a delegated Shuttle that is offered the question or subagent tool", () => {
  it("fails the subagent policy check and names the tools", () => {
    const requests = delegatingRun.map((entry) =>
      JSON.stringify(entry.body).includes("You are shuttle.")
        ? request(SHUTTLE_SYSTEM, [
            tool("read"),
            tool("question"),
            tool("subagent"),
          ])
        : entry,
    );
    const policy = verdict(
      checks.evaluate(observation({ run: { exitCode: 0, requests } })),
      "subagent_policy",
    );
    expect(policy.status).toBe("failed");
    expect(policy.evidence).toContain("subagent, question");
  });
});
