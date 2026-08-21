import { describe, expect, test } from "bun:test";
import { okAsync, type ResultAsync } from "neverthrow";
import type { ParsedChangeset } from "../changeset-policy.js";
import type { Clock } from "../clock.js";
import type { RegistryError } from "../errors.js";
import { validateReleaseInvocation } from "../input-validation.js";
import { NightlyPlanner, runPreflight } from "../nightly-plan.js";
import type { NpmRegistryClient } from "../npm-registry-client.js";

const sha = "abcdef123456".padEnd(40, "a");
const clock: Clock = {
  now: () => new Date("2026-07-19T12:00:00.000Z"),
  sleep: () => okAsync(),
};
const invocation = validateReleaseInvocation({
  repository: "weave-io/weave",
  workflowPath: ".github/workflows/publish.yml",
  eventName: "schedule",
  ref: "refs/heads/main",
});
if (invocation.isErr()) throw new Error("fixture invocation is invalid");

class Registry implements NpmRegistryClient {
  constructor(
    private readonly versions: Readonly<Record<string, readonly string[]>>,
  ) {}
  publish(): ResultAsync<void, RegistryError> {
    return okAsync();
  }
  viewVersion(): ResultAsync<string, RegistryError> {
    return okAsync("");
  }
  viewDistTags(): ResultAsync<Record<string, string>, RegistryError> {
    return okAsync({});
  }
  distTagLs(): ResultAsync<Record<string, string>, RegistryError> {
    return okAsync({});
  }
  verifyPublished(): ResultAsync<void, RegistryError> {
    return okAsync();
  }
  listVersions(name: string): ResultAsync<readonly string[], RegistryError> {
    return okAsync(this.versions[name] ?? []);
  }
}

const changesets: readonly ParsedChangeset[] = [
  {
    path: ".changeset/cli.md",
    releases: new Map([["@weaveio/weave-cli", "minor"]]),
  },
];
const packageVersions = {
  "@weaveio/weave-cli": "0.1.0",
  "@weaveio/weave-adapter-opencode": "0.1.0",
  "@weaveio/weave-adapter-claude-code": "0.1.0",
  "@weaveio/weave-adapter-pi": "0.1.0",
} as const;

describe("NightlyPlanner", () => {
  test("uses the highest published stable version and canonical nightly suffix", async () => {
    const result = await new NightlyPlanner(
      new Registry({
        "@weaveio/weave-cli": [
          "1.2.3",
          "1.9.0",
          "2.0.0-nightly.20260101.aaaaaaaaaaaa",
        ],
      }),
      clock,
    ).plan({
      invocation: invocation.value,
      changesets,
      subjectSha: sha,
      packageVersions,
    });
    expect(result._unsafeUnwrap()).toEqual({
      skip: undefined,
      subjectSha: sha,
      packages: [
        {
          name: "@weaveio/weave-cli",
          version: "1.10.0-nightly.20260719.abcdef123456",
          tag: "nightly",
        },
      ],
    });
  });

  test("uses package version only when the registry has no stable version", async () => {
    const result = await new NightlyPlanner(new Registry({}), clock).plan({
      invocation: invocation.value,
      changesets,
      subjectSha: sha,
      packageVersions,
    });
    expect(result._unsafeUnwrap().skip).toBeUndefined();
    if (result.isErr() || result.value.skip !== undefined) return;
    expect(result.value.packages[0]?.version).toBe(
      "0.2.0-nightly.20260719.abcdef123456",
    );
  });

  test("is a green no-public-change skip", async () => {
    const result = await new NightlyPlanner(new Registry({}), clock).plan({
      invocation: invocation.value,
      changesets: [],
      subjectSha: sha,
      packageVersions,
    });
    expect(result._unsafeUnwrap()).toEqual({
      skip: "no-public-change",
      subjectSha: sha,
    });
  });

  test("is a green same-sha skip only when every package has the SHA", async () => {
    const result = await new NightlyPlanner(
      new Registry({
        "@weaveio/weave-cli": ["1.2.3-nightly.20260718.abcdef123456"],
      }),
      clock,
    ).plan({
      invocation: invocation.value,
      changesets,
      subjectSha: sha,
      packageVersions,
    });
    expect(result._unsafeUnwrap()).toEqual({
      skip: "same-sha",
      subjectSha: sha,
    });
  });

  test("rejects a stable operation before registry access", async () => {
    const dispatch = validateReleaseInvocation({
      repository: "weave-io/weave",
      workflowPath: ".github/workflows/publish.yml",
      eventName: "workflow_dispatch",
      ref: "refs/heads/main",
      operation: "stable-cut",
      channel: "stable",
      subjectSha: sha,
      packages: ["@weaveio/weave-cli"],
      versions: { "@weaveio/weave-cli": "1.0.0" },
    });
    if (dispatch.isErr()) throw new Error("fixture invocation is invalid");
    const result = await new NightlyPlanner(new Registry({}), clock).plan({
      invocation: dispatch.value,
      changesets,
      subjectSha: sha,
      packageVersions,
    });
    expect(result._unsafeUnwrapErr().type).toBe("InvalidNightlyInvocation");
  });
});

interface PreflightEnvironment {
  [key: string]: string;
}

const PRE_FLIGHT_OPERATIONS: readonly [string, number][] = [
  ["nightly", 1],
  ["stable-cut", 0],
  ["stable-fix", 0],
  ["metadata-replay", 0],
];

describe("release preflight operation routing", () => {
  const originalFetch = globalThis.fetch;
  const environment = (operation: string): PreflightEnvironment => ({
    RELEASE_PUBLISH_ENABLED: "true",
    RELEASE_EVENT_NAME: "workflow_dispatch",
    RELEASE_OPERATION: operation,
    RELEASE_REF: "refs/heads/main",
    RELEASE_WORKFLOW_REF:
      "weave-io/weave/.github/workflows/publish.yml@refs/heads/main",
    RELEASE_SHA: sha,
    GITHUB_TOKEN: "test-token",
  });

  test.each(
    PRE_FLIGHT_OPERATIONS,
  )("%s passes shared gates and routes to its planner path", async (operation, exitCode) => {
    const fetchStub = Object.assign(
      async (input: URL | RequestInfo): Promise<Response> => {
        const url = String(input);
        if (url.endsWith("/git/ref/heads/main"))
          return new Response(JSON.stringify({ object: { sha } }), {
            headers: { date: "Sun, 19 Jul 2026 00:00:00 GMT" },
          });
        return new Response(
          JSON.stringify({
            check_runs: [
              {
                name: "Lint, Typecheck, Build & Test",
                conclusion: "success",
              },
            ],
          }),
        );
      },
      { preconnect: globalThis.fetch.preconnect },
    );
    globalThis.fetch = fetchStub;
    // Nightly deliberately proceeds into the real changeset/registry planner;
    // stable operations return after their planner hand-off is serialized.
    expect(await runPreflight(environment(operation))).toBe(exitCode);
  });

  test("rejects an unknown operation before planner routing", async () => {
    expect(await runPreflight(environment("unknown"))).toBe(1);
    globalThis.fetch = originalFetch;
  });

  test("accepts a green required check beside an incomplete check", async () => {
    const fetchStub = Object.assign(
      async (input: URL | RequestInfo): Promise<Response> => {
        if (String(input).endsWith("/git/ref/heads/main"))
          return new Response(JSON.stringify({ object: { sha } }), {
            headers: { date: "Sun, 19 Jul 2026 00:00:00 GMT" },
          });
        return new Response(
          JSON.stringify({
            check_runs: [
              {
                name: "Lint, Typecheck, Build & Test",
                conclusion: "success",
              },
              { name: "unrelated", status: "in_progress", conclusion: null },
            ],
          }),
          { headers: { date: "Sun, 19 Jul 2026 00:00:00 GMT" } },
        );
      },
      { preconnect: globalThis.fetch.preconnect },
    );
    globalThis.fetch = fetchStub;
    try {
      expect(await runPreflight(environment("stable-cut"))).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("rejects a GitHub response with an own __proto__ key", async () => {
    const fetchStub = Object.assign(
      async (): Promise<Response> =>
        new Response(`{"__proto__":{"object":{"sha":"${sha}"}}}`, {
          headers: { date: "Sun, 19 Jul 2026 00:00:00 GMT" },
        }),
      { preconnect: globalThis.fetch.preconnect },
    );
    globalThis.fetch = fetchStub;
    try {
      expect(await runPreflight(environment("stable-cut"))).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("rejects an inherited GitHub object.sha", async () => {
    const previous = Object.getOwnPropertyDescriptor(
      Object.prototype,
      "object",
    );
    Object.defineProperty(Object.prototype, "object", {
      configurable: true,
      value: { sha },
      writable: true,
    });
    const fetchStub = Object.assign(
      async (): Promise<Response> =>
        new Response("{}", {
          headers: { date: "Sun, 19 Jul 2026 00:00:00 GMT" },
        }),
      { preconnect: globalThis.fetch.preconnect },
    );
    globalThis.fetch = fetchStub;
    try {
      expect(await runPreflight(environment("stable-cut"))).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
      if (previous === undefined)
        Reflect.deleteProperty(Object.prototype, "object");
      else Object.defineProperty(Object.prototype, "object", previous);
    }
  });

  test("rejects inherited accessor check runs without reading the getter", async () => {
    const previous = Object.getOwnPropertyDescriptor(
      Object.prototype,
      "check_runs",
    );
    let reads = 0;
    Object.defineProperty(Object.prototype, "check_runs", {
      configurable: true,
      get: () => {
        reads += 1;
        return [];
      },
    });
    const fetchStub = Object.assign(
      async (input: URL | RequestInfo): Promise<Response> =>
        new Response(
          String(input).endsWith("/git/ref/heads/main")
            ? JSON.stringify({ object: { sha } })
            : "{}",
          { headers: { date: "Sun, 19 Jul 2026 00:00:00 GMT" } },
        ),
      { preconnect: globalThis.fetch.preconnect },
    );
    globalThis.fetch = fetchStub;
    try {
      expect(await runPreflight(environment("stable-cut"))).toBe(1);
      expect(reads).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
      if (previous === undefined)
        Reflect.deleteProperty(Object.prototype, "check_runs");
      else Object.defineProperty(Object.prototype, "check_runs", previous);
    }
  });
});
