import { expect, test } from "bun:test";
import { z } from "zod";
import {
  GitHubRestClient,
  type GitHubRestClientOptions,
} from "../github-client.js";

test("returns a typed malformed response for invalid GitHub JSON", async () => {
  const client = new GitHubRestClient(
    "weave-io/weave",
    "token",
    async () => new Response("not json"),
  );
  const result = await client.getWorkflowRun(1);
  expect(result.isErr()).toBe(true);
  if (result.isErr())
    expect(result.error).toMatchObject({ type: "GitHubError" });
});

// ---------------------------------------------------------------------------
// The atomic marker-ref, pull-request, and team surfaces the release-PR state
// machine runs on. Every route is a fake, so no live GitHub is ever needed.
// ---------------------------------------------------------------------------

const MARKER_REF = "refs/heads/release-pr/stable";
const BASE = "a".repeat(40);
const MARKER = "b".repeat(40);

type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonObject
  | readonly JsonValue[];
interface JsonObject {
  [key: string]: JsonValue;
}

interface Route {
  status?: number;
  body?: JsonValue;
  reject?: string;
  headers?: Record<string, string>;
}

interface Call {
  method: string;
  url: string;
  body: string | null;
  authorization?: string | null;
}

const REPO_NODE_ID = "R_weave";
const ZERO_OID = "0".repeat(40);

interface GitObject {
  type: "commit" | "tree";
  tree?: string;
  message?: string;
}

interface FakeMutation {
  repositoryId: string | undefined;
  name: string;
  afterOid: string;
  beforeOid: string;
  force: boolean | undefined;
}

type RouteTable = Record<string, Route>;

const CommitRequestSchema = z
  .object({ tree: z.string(), message: z.string() })
  .strip();
const GraphqlRequestSchema = z
  .object({
    query: z.string(),
    variables: z
      .object({
        input: z
          .object({
            repositoryId: z.string(),
            refUpdates: z
              .array(
                z
                  .object({
                    name: z.string(),
                    afterOid: z.string(),
                    beforeOid: z.string(),
                    force: z.boolean(),
                  })
                  .strip(),
              )
              .length(1),
          })
          .strip(),
      })
      .strip(),
  })
  .strip();

/**
 * A GitHub object store plus its atomic `updateRefs` mutation.
 *
 * Commits created through the Git Data REST routes exist only here. A leased
 * ref update may point at those objects; a SHA that was never created is
 * refused. The expected-old-SHA comparison runs inside the same mutation that
 * moves the ref, so a test can land a concurrent writer at that boundary.
 */
class FakeGitHub {
  readonly objects = new Map<string, GitObject>();
  readonly refs = new Map<string, string>();
  readonly calls: Call[] = [];
  readonly mutations: FakeMutation[] = [];
  /** Runs at the server boundary, after the mutation is parsed, before apply. */
  concurrentWriter: (() => void) | null = null;
  /** Injects a failure that is not a lost lease. */
  denied: string | null = null;

  seedCommit(sha: string, tree: string, message: string): void {
    this.objects.set(sha, { type: "commit", tree, message });
  }

  fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? "GET";
    const path = url.replace("https://api.github.com", "");
    const body = await requestBody(init?.body);
    this.calls.push({ method, url, body });
    if (method === "GET" && path === "/repos/weave-io/weave")
      return json({ node_id: REPO_NODE_ID });
    if (
      method === "GET" &&
      path.startsWith("/repos/weave-io/weave/git/commits/")
    ) {
      const sha = path.slice("/repos/weave-io/weave/git/commits/".length);
      const object = this.objects.get(sha);
      if (object?.type !== "commit" || object.tree === undefined)
        return new Response("{}", { status: 404, statusText: "Not Found" });
      const response: JsonObject = {
        sha,
        tree: { sha: object.tree },
      };
      if (object.message !== undefined) response.message = object.message;
      return json(response);
    }
    if (method === "POST" && path === "/repos/weave-io/weave/git/trees") {
      const sha = digest(`tree:${body ?? ""}`);
      this.objects.set(sha, { type: "tree" });
      return json({ sha }, 201);
    }
    if (method === "POST" && path === "/repos/weave-io/weave/git/commits") {
      const parsed = CommitRequestSchema.safeParse(parseJson(body));
      const sha = digest(`commit:${body ?? ""}`);
      this.objects.set(sha, {
        type: "commit",
        tree: parsed.success ? parsed.data.tree : undefined,
        message: parsed.success ? parsed.data.message : undefined,
      });
      return json({ sha }, 201);
    }
    if (method === "POST" && path === "/graphql") return this.graphql(body);
    return new Response("{}", { status: 404, statusText: "Not Found" });
  };

  private graphql(body: string | null): Response {
    const parsed = GraphqlRequestSchema.safeParse(parseJson(body));
    if (!parsed.success || !parsed.data.query.includes("updateRefs"))
      return json({ errors: [{ message: "expected updateRefs mutation" }] });
    const input = parsed.data.variables.input;
    const update = input.refUpdates[0];
    if (update === undefined)
      return json({ errors: [{ message: "invalid updateRefs input" }] });
    this.mutations.push({
      repositoryId: input.repositoryId,
      name: update.name,
      afterOid: update.afterOid,
      beforeOid: update.beforeOid,
      force: update.force,
    });
    this.concurrentWriter?.();
    if (this.denied !== null)
      return json({ errors: [{ message: this.denied }] });
    if (update.afterOid !== ZERO_OID && !this.objects.has(update.afterOid))
      return json({
        data: { updateRefs: null },
        errors: [
          {
            type: "UNPROCESSABLE",
            message: `Could not resolve to a Git object with OID ${update.afterOid}.`,
          },
        ],
      });
    const actual = this.refs.get(update.name) ?? "";
    if (actual !== update.beforeOid)
      return json({
        data: { updateRefs: null },
        errors: [
          {
            type: "UNPROCESSABLE",
            message: `Update failed because the current oid of ${update.name} is ${actual === "" ? "missing" : actual}, which does not match the specified expected oid ${update.beforeOid}.`,
          },
        ],
      });
    if (update.afterOid === ZERO_OID) this.refs.delete(update.name);
    else this.refs.set(update.name, update.afterOid);
    return json({ data: { updateRefs: { clientMutationId: null } } });
  }
}

function json(body: JsonValue, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    statusText: status === 201 ? "Created" : "OK",
  });
}

function digest(value: string): string {
  return new Bun.CryptoHasher("sha1").update(value).digest("hex");
}

function parseJson(body: string | null) {
  return body === null ? undefined : JSON.parse(body);
}

async function requestBody(
  body: BodyInit | null | undefined,
): Promise<string | null> {
  if (body === null || body === undefined) return null;
  if (body instanceof Blob) return body.text();
  return String(body);
}

interface ClientHarness {
  client: GitHubRestClient;
  calls: Call[];
}

function client(
  routes: RouteTable,
  options: GitHubRestClientOptions = {},
  token = "token",
): ClientHarness {
  const calls: Call[] = [];
  const fetchLike = async (
    url: string,
    init?: RequestInit,
  ): Promise<Response> => {
    const method = init?.method ?? "GET";
    calls.push({
      method,
      url,
      body: await requestBody(init?.body),
      authorization: new Headers(init?.headers).get("authorization"),
    });
    const key = `${method} ${url.replace("https://api.github.com", "")}`;
    const route = routes[key];
    if (route === undefined)
      return new Response("{}", { status: 404, statusText: "Not Found" });
    if (route.reject !== undefined) throw new Error(route.reject);
    return new Response(JSON.stringify(route.body ?? {}), {
      status: route.status ?? 200,
      statusText: route.status === 422 ? "Unprocessable Entity" : "OK",
      headers: route.headers,
    });
  };
  return {
    client: new GitHubRestClient(
      "weave-io/weave",
      token,
      fetchLike,
      "https://api.github.com",
      options,
    ),
    calls,
  };
}

test("createRefAtomic reports the losing side of the race by type", async () => {
  const conflict = client({
    "POST /repos/weave-io/weave/git/refs": { status: 422 },
  });
  const lost = await conflict.client.createRefAtomic(MARKER_REF, MARKER);
  expect(lost._unsafeUnwrapErr()).toEqual({
    type: "ReferenceAlreadyExists",
    ref: MARKER_REF,
  });

  const won = client({
    "POST /repos/weave-io/weave/git/refs": { status: 201, body: {} },
  });
  expect((await won.client.createRefAtomic(MARKER_REF, MARKER)).isOk()).toBe(
    true,
  );
  expect(won.calls[0]?.body).toBe(
    JSON.stringify({ ref: MARKER_REF, sha: MARKER }),
  );
});

test("readRefOptional reports an absent ref as null", async () => {
  const absent = client({});
  expect(
    (await absent.client.readRefOptional(MARKER_REF))._unsafeUnwrap(),
  ).toBeNull();
  const present = client({
    "GET /repos/weave-io/weave/git/ref/heads/release-pr/stable": {
      body: { object: { sha: MARKER } },
    },
  });
  expect(
    (await present.client.readRefOptional(MARKER_REF))._unsafeUnwrap(),
  ).toBe(MARKER);
});

test("compare-and-swap ref writes send an exact updateRefs lease", async () => {
  const github = new FakeGitHub();
  const next = "d".repeat(40);
  github.seedCommit(next, "t".repeat(40), "next");
  github.refs.set(MARKER_REF, MARKER);
  const rest = new GitHubRestClient("weave-io/weave", "token", github.fetch);

  expect((await rest.updateRefWithLease(MARKER_REF, next, MARKER)).isOk()).toBe(
    true,
  );
  expect(github.mutations[0]).toEqual({
    repositoryId: REPO_NODE_ID,
    name: MARKER_REF,
    afterOid: next,
    beforeOid: MARKER,
    force: true,
  });
  expect(github.refs.get(MARKER_REF)).toBe(next);

  expect((await rest.deleteRefWithLease(MARKER_REF, next)).isOk()).toBe(true);
  expect(github.mutations[1]).toEqual({
    repositoryId: REPO_NODE_ID,
    name: MARKER_REF,
    afterOid: ZERO_OID,
    beforeOid: next,
    force: true,
  });
  expect(github.refs.has(MARKER_REF)).toBe(false);
});

test("a REST-created commit is available for a leased ref update", async () => {
  const github = new FakeGitHub();
  github.seedCommit(BASE, "t".repeat(40), "base");
  github.refs.set(MARKER_REF, MARKER);
  const rest = new GitHubRestClient("weave-io/weave", "token", github.fetch);

  const created = await rest.createCommitOnBase({
    baseSha: BASE,
    message: "chore(release): version packages",
    files: [{ path: "packages/cli/package.json", contents: "{}" }],
  });
  const sha = created._unsafeUnwrap();
  expect(github.objects.has(sha)).toBe(true);
  expect(github.objects.has("f".repeat(40))).toBe(false);

  const update = await rest.updateRefWithLease(MARKER_REF, sha, MARKER);
  expect(update.isOk()).toBe(true);
  expect(github.refs.get(MARKER_REF)).toBe(sha);
  expect(github.mutations[0]).toMatchObject({
    afterOid: sha,
    beforeOid: MARKER,
  });

  const missing = await rest.updateRefWithLease(
    MARKER_REF,
    "f".repeat(40),
    sha,
  );
  expect(missing._unsafeUnwrapErr()).toMatchObject({
    type: "GitHubError",
    operation: "updateRefWithLease",
  });
  expect(github.refs.get(MARKER_REF)).toBe(sha);
});

test("a writer that lands first makes the server reject the stale lease", async () => {
  const winner = "c".repeat(40);
  const next = "d".repeat(40);
  const github = new FakeGitHub();
  github.seedCommit(next, "t".repeat(40), "next");
  github.refs.set(MARKER_REF, MARKER);
  const rest = new GitHubRestClient("weave-io/weave", "token", github.fetch);
  // The concurrent writer lands *inside* the mutation, after this client
  // committed to its expected old SHA. Only the server can still catch that.
  github.concurrentWriter = () => {
    github.concurrentWriter = null;
    github.refs.set(MARKER_REF, winner);
  };
  const update = await rest.updateRefWithLease(MARKER_REF, next, MARKER);
  expect(update._unsafeUnwrapErr()).toEqual({
    type: "ReferenceLeaseLost",
    ref: MARKER_REF,
    expectedSha: MARKER,
    actualSha: winner,
  });
  expect(github.refs.get(MARKER_REF)).toBe(winner);

  github.concurrentWriter = () => {
    github.concurrentWriter = null;
    github.refs.set(MARKER_REF, "e".repeat(40));
  };
  const removal = await rest.deleteRefWithLease(MARKER_REF, winner);
  expect(removal._unsafeUnwrapErr()).toMatchObject({
    type: "ReferenceLeaseLost",
    expectedSha: winner,
  });
  expect(github.refs.get(MARKER_REF)).toBe("e".repeat(40));
});

test("generic GraphQL mismatch text is not a lost lease", async () => {
  const next = "d".repeat(40);
  const misleading = [
    "does not match expected value",
    `ref ${MARKER_REF} does not match expected value`,
    `Update failed because ${MARKER} does not match expected value.`,
  ];
  for (const message of misleading) {
    const world = client({
      "GET /repos/weave-io/weave": { body: { node_id: REPO_NODE_ID } },
      "POST /graphql": {
        body: { data: { updateRefs: null }, errors: [{ message }] },
      },
    });
    const update = await world.client.updateRefWithLease(
      MARKER_REF,
      next,
      MARKER,
    );
    expect(update._unsafeUnwrapErr()).toMatchObject({
      type: "GitHubError",
      operation: "updateRefWithLease",
    });
  }
});

test("a current-oid mismatch naming the expected SHA is a lost lease", async () => {
  const next = "d".repeat(40);
  const winner = "c".repeat(40);
  const world = client({
    "GET /repos/weave-io/weave": { body: { node_id: REPO_NODE_ID } },
    "POST /graphql": {
      body: {
        data: { updateRefs: null },
        errors: [
          {
            message: `Update failed because the current oid of ${MARKER_REF} is ${winner}, which does not match the specified expected oid ${MARKER}.`,
          },
        ],
      },
    },
  });
  const update = await world.client.updateRefWithLease(
    MARKER_REF,
    next,
    MARKER,
  );
  expect(update._unsafeUnwrapErr()).toEqual({
    type: "ReferenceLeaseLost",
    ref: MARKER_REF,
    expectedSha: MARKER,
    actualSha: winner,
  });

  const otherExpected = "e".repeat(40);
  const mismatched = client({
    "GET /repos/weave-io/weave": { body: { node_id: REPO_NODE_ID } },
    "POST /graphql": {
      body: {
        data: { updateRefs: null },
        errors: [
          {
            message: `Update failed because the current oid of ${MARKER_REF} is ${winner}, which does not match the specified expected oid ${otherExpected}.`,
          },
        ],
      },
    },
  });
  const other = await mismatched.client.updateRefWithLease(
    MARKER_REF,
    next,
    MARKER,
  );
  expect(other._unsafeUnwrapErr()).toMatchObject({
    type: "GitHubError",
    operation: "updateRefWithLease",
  });
});

test("a mutation failure that is not a stale lease stays a GitHub error", async () => {
  const next = "d".repeat(40);
  const github = new FakeGitHub();
  github.seedCommit(next, "t".repeat(40), "next");
  github.refs.set(MARKER_REF, MARKER);
  github.denied = "Resource not accessible by integration";
  const rest = new GitHubRestClient("weave-io/weave", "token", github.fetch);
  const update = await rest.updateRefWithLease(MARKER_REF, next, MARKER);
  // Reporting this as a lost race would make a caller converge on a writer
  // that never existed.
  expect(update._unsafeUnwrapErr()).toMatchObject({
    type: "GitHubError",
    operation: "updateRefWithLease",
  });
  expect(github.refs.get(MARKER_REF)).toBe(MARKER);
});

test("every lease input is validated before a mutation is attempted", async () => {
  const github = new FakeGitHub();
  github.refs.set(MARKER_REF, MARKER);
  const rest = new GitHubRestClient("weave-io/weave", "token", github.fetch);
  const rejected = [
    ["release-pr/stable", "d".repeat(40), MARKER],
    ["refs/heads/../../etc", "d".repeat(40), MARKER],
    [`${MARKER_REF} --exec=payload`, "d".repeat(40), MARKER],
    [MARKER_REF, "not-a-sha", MARKER],
    [MARKER_REF, "d".repeat(40), "HEAD"],
    [MARKER_REF, ZERO_OID, MARKER],
  ] as const;
  for (const [ref, sha, expected] of rejected) {
    const result = await rest.updateRefWithLease(ref, sha, expected);
    expect(result._unsafeUnwrapErr()).toMatchObject({ type: "GitHubError" });
  }
  expect(github.mutations).toEqual([]);
  expect(github.refs.get(MARKER_REF)).toBe(MARKER);
});

test("createCommitOnBase builds a tree from the base and commits onto it", async () => {
  const world = client({
    [`GET /repos/weave-io/weave/git/commits/${BASE}`]: {
      body: { tree: { sha: "t".repeat(40) }, message: "base" },
    },
    "POST /repos/weave-io/weave/git/trees": { body: { sha: "u".repeat(40) } },
    "POST /repos/weave-io/weave/git/commits": { body: { sha: MARKER } },
  });
  const created = await world.client.createCommitOnBase({
    baseSha: BASE,
    message: "chore(release): version packages",
    files: [{ path: "packages/cli/package.json", contents: "{}" }],
  });
  expect(created._unsafeUnwrap()).toBe(MARKER);
  expect(world.calls[1]?.body).toContain('"base_tree":"tttt');
  expect(world.calls[2]?.body).toContain('"parents":["aaa');
});

test("compareCommits and readCommitMessage read git data by type", async () => {
  const world = client({
    [`GET /repos/weave-io/weave/compare/${BASE}...${MARKER}`]: {
      body: { status: "ahead" },
    },
    [`GET /repos/weave-io/weave/git/commits/${MARKER}`]: {
      body: { message: "chore(release): claim", tree: { sha: "t".repeat(40) } },
    },
  });
  expect(
    (await world.client.compareCommits(BASE, MARKER))._unsafeUnwrap(),
  ).toBe("ahead");
  expect(
    (await world.client.readCommitMessage(MARKER))._unsafeUnwrap(),
  ).toContain("claim");
});

function trunkRoutes(extra: RouteTable = {}) {
  return {
    "GET /repos/weave-io/weave/git/ref/heads/main": {
      body: { object: { sha: BASE } },
    },
    ...extra,
  } satisfies RouteTable;
}

function statusPage(items: readonly { context: string; state: string }[]) {
  return {
    [`GET /repos/weave-io/weave/commits/${BASE}/statuses?per_page=100`]: {
      body: items,
    },
  };
}

function checkRunPage(
  runs: readonly {
    name: string;
    status: string;
    conclusion: string | null;
    app?: { id: number };
  }[],
  extra: Partial<Route> = {},
) {
  return {
    [`GET /repos/weave-io/weave/commits/${BASE}/check-runs?per_page=100&filter=latest`]:
      {
        body: { total_count: runs.length, check_runs: runs },
        ...extra,
      },
  };
}

test("readGreenMainHead proves required Actions checks and legacy statuses", async () => {
  const world = client(
    trunkRoutes({
      ...statusPage([{ context: "legacy-ci", state: "success" }]),
      ...checkRunPage([
        { name: "ci", status: "completed", conclusion: "success" },
      ]),
    }),
    {
      requiredChecks: [
        { name: "ci", source: "check-run" },
        { name: "legacy-ci", source: "status" },
      ],
    },
  );
  expect((await world.client.readGreenMainHead())._unsafeUnwrap()).toBe(BASE);
});

test("readGreenMainHead reads required checks from protection and rulesets", async () => {
  const world = client(
    trunkRoutes({
      "GET /repos/weave-io/weave/branches/main/protection/required_status_checks":
        {
          body: {
            contexts: ["legacy-ci"],
            checks: [{ context: "ci", app_id: 15368 }],
          },
        },
      "GET /repos/weave-io/weave/rules/branches/main": {
        body: [
          {
            type: "required_status_checks",
            parameters: {
              required_status_checks: [
                { context: "release-policy", integration_id: 31415 },
              ],
            },
          },
        ],
      },
      ...statusPage([{ context: "legacy-ci", state: "success" }]),
      ...checkRunPage([
        {
          name: "ci",
          status: "completed",
          conclusion: "success",
          app: { id: 15368 },
        },
        {
          name: "release-policy",
          status: "completed",
          conclusion: "success",
          app: { id: 31415 },
        },
      ]),
    }),
  );
  expect((await world.client.readGreenMainHead())._unsafeUnwrap()).toBe(BASE);
});

test("a required check-run is green only for the configured App", async () => {
  const world = client(
    trunkRoutes({
      "GET /repos/weave-io/weave/branches/main/protection/required_status_checks":
        {
          body: { checks: [{ context: "ci", app_id: 15368 }] },
        },
      ...statusPage([]),
      ...checkRunPage([
        {
          name: "ci",
          status: "completed",
          conclusion: "success",
          app: { id: 15368 },
        },
      ]),
    }),
  );
  expect((await world.client.readGreenMainHead())._unsafeUnwrap()).toBe(BASE);
});

test("a same-name check-run from the wrong App does not satisfy protection", async () => {
  const world = client(
    trunkRoutes({
      "GET /repos/weave-io/weave/branches/main/protection/required_status_checks":
        {
          body: { checks: [{ context: "ci", app_id: 15368 }] },
        },
      ...statusPage([]),
      ...checkRunPage([
        {
          name: "ci",
          status: "completed",
          conclusion: "success",
          app: { id: 99999 },
        },
      ]),
    }),
  );
  expect(
    (await world.client.readGreenMainHead())._unsafeUnwrapErr().message,
  ).toContain("App 15368");
});

test("a same-name check-run without an App does not satisfy protection", async () => {
  const world = client(
    trunkRoutes({
      "GET /repos/weave-io/weave/branches/main/protection/required_status_checks":
        {
          body: { checks: [{ context: "ci", app_id: 15368 }] },
        },
      ...statusPage([]),
      ...checkRunPage([
        { name: "ci", status: "completed", conclusion: "success" },
      ]),
    }),
  );
  expect(
    (await world.client.readGreenMainHead())._unsafeUnwrapErr().message,
  ).toContain("App 15368");
});

test("readGreenMainHead refuses a missing required check", async () => {
  const world = client(
    trunkRoutes({
      ...statusPage([]),
      ...checkRunPage([]),
    }),
    { requiredChecks: [{ name: "ci", source: "check-run" }] },
  );
  expect(
    (await world.client.readGreenMainHead())._unsafeUnwrapErr().message,
  ).toContain("missing");
});

test("readGreenMainHead refuses a failing required Actions check", async () => {
  const world = client(
    trunkRoutes({
      ...statusPage([]),
      ...checkRunPage([
        { name: "ci", status: "completed", conclusion: "failure" },
      ]),
    }),
    { requiredChecks: [{ name: "ci", source: "check-run" }] },
  );
  expect(
    (await world.client.readGreenMainHead())._unsafeUnwrapErr().message,
  ).toContain("not green");
});

test("readGreenMainHead refuses a pending required status", async () => {
  const world = client(
    trunkRoutes({
      ...statusPage([{ context: "legacy-ci", state: "pending" }]),
      ...checkRunPage([]),
    }),
    { requiredChecks: [{ name: "legacy-ci", source: "status" }] },
  );
  expect(
    (await world.client.readGreenMainHead())._unsafeUnwrapErr().message,
  ).toContain("pending");
});

test("readGreenMainHead refuses an in-progress required check run", async () => {
  const world = client(
    trunkRoutes({
      ...statusPage([]),
      ...checkRunPage([
        { name: "ci", status: "in_progress", conclusion: null },
      ]),
    }),
    { requiredChecks: [{ name: "ci", source: "check-run" }] },
  );
  expect(
    (await world.client.readGreenMainHead())._unsafeUnwrapErr().message,
  ).toContain("in_progress");
});

test("readGreenMainHead refuses an unknown conclusion or status", async () => {
  const unknownConclusion = client(
    trunkRoutes({
      ...statusPage([]),
      ...checkRunPage([{ name: "ci", status: "completed", conclusion: "wat" }]),
    }),
    { requiredChecks: [{ name: "ci", source: "check-run" }] },
  );
  expect(
    (await unknownConclusion.client.readGreenMainHead())._unsafeUnwrapErr()
      .message,
  ).toContain("unknown conclusion");

  const unknownStatus = client(
    trunkRoutes({
      ...statusPage([{ context: "legacy-ci", state: "mystery" }]),
      ...checkRunPage([]),
    }),
    { requiredChecks: [{ name: "legacy-ci", source: "status" }] },
  );
  expect(
    (await unknownStatus.client.readGreenMainHead())._unsafeUnwrapErr().message,
  ).toContain("unknown state");
});

test("readGreenMainHead follows check-run pages and fails closed on truncation", async () => {
  const paged = client(
    trunkRoutes({
      [`GET /repos/weave-io/weave/commits/${BASE}/statuses?per_page=1`]: {
        body: [],
      },
      [`GET /repos/weave-io/weave/commits/${BASE}/check-runs?per_page=1&filter=latest`]:
        {
          body: {
            total_count: 2,
            check_runs: [
              { name: "other", status: "completed", conclusion: "success" },
            ],
          },
          headers: {
            link: `<https://api.github.com/repos/weave-io/weave/commits/${BASE}/check-runs?per_page=1&filter=latest&page=2>; rel="next"`,
          },
        },
      [`GET /repos/weave-io/weave/commits/${BASE}/check-runs?per_page=1&filter=latest&page=2`]:
        {
          body: {
            total_count: 2,
            check_runs: [
              { name: "ci", status: "completed", conclusion: "success" },
            ],
          },
        },
    }),
    {
      requiredChecks: [{ name: "ci", source: "check-run" }],
      greenHeadBounds: { pageSize: 1, maxPages: 3 },
    },
  );
  expect((await paged.client.readGreenMainHead())._unsafeUnwrap()).toBe(BASE);

  const truncated = client(
    trunkRoutes({
      [`GET /repos/weave-io/weave/commits/${BASE}/statuses?per_page=1`]: {
        body: [],
      },
      [`GET /repos/weave-io/weave/commits/${BASE}/check-runs?per_page=1&filter=latest`]:
        {
          body: {
            total_count: 3,
            check_runs: [
              { name: "other", status: "completed", conclusion: "success" },
            ],
          },
          headers: {
            link: `<https://api.github.com/repos/weave-io/weave/commits/${BASE}/check-runs?per_page=1&filter=latest&page=2>; rel="next"`,
          },
        },
    }),
    {
      requiredChecks: [{ name: "ci", source: "check-run" }],
      greenHeadBounds: { pageSize: 1, maxPages: 1 },
    },
  );
  expect(
    (await truncated.client.readGreenMainHead())._unsafeUnwrapErr().message,
  ).toContain("truncated");
});

test("readGreenMainHead fails closed when no required checks are configured", async () => {
  const world = client(
    trunkRoutes({
      "GET /repos/weave-io/weave/branches/main/protection/required_status_checks":
        { status: 404 },
      "GET /repos/weave-io/weave/rules/branches/main": { body: [] },
    }),
  );
  expect(
    (await world.client.readGreenMainHead())._unsafeUnwrapErr().message,
  ).toContain("no required checks");
});

test("release PRs are read by label and by owner-qualified head state", async () => {
  const openOnHead = [
    {
      number: 7,
      html_url: "https://github.com/weave-io/weave/pull/7",
      state: "open",
      title: "release",
      body: "body",
      head: { ref: "release-pr/stable", sha: MARKER },
      base: { ref: "main" },
      labels: [{ name: "release:stable" }],
    },
    {
      number: 8,
      html_url: "https://github.com/weave-io/weave/pull/8",
      state: "open",
      title: "other",
      body: "",
      head: { ref: "feature", sha: BASE },
      base: { ref: "main" },
      labels: [],
    },
  ];
  const closedOnHead = [
    {
      number: 9,
      html_url: "https://github.com/weave-io/weave/pull/9",
      state: "closed",
      title: "stale",
      body: "",
      head: { ref: "release-pr/stable", sha: BASE },
      base: { ref: "main" },
      labels: [],
    },
  ];
  const world = client({
    "GET /repos/weave-io/weave/pulls?state=open&per_page=100": {
      body: openOnHead,
    },
    // GitHub matches the head filter as `<owner>:<ref>`; a bare ref name
    // matches nothing, which would report a live release PR as absent.
    "GET /repos/weave-io/weave/pulls?state=open&per_page=100&head=weave-io%3Arelease-pr%2Fstable":
      { body: openOnHead },
    "GET /repos/weave-io/weave/pulls?state=closed&per_page=100&head=weave-io%3Arelease-pr%2Fstable":
      { body: closedOnHead },
  });
  const labelled =
    await world.client.listOpenPullRequestsByLabel("release:stable");
  expect(labelled._unsafeUnwrap().map((pull) => pull.number)).toEqual([7]);
  const openByHead = await world.client.listPullRequestsForHead(
    "release-pr/stable",
    "open",
  );
  expect(openByHead._unsafeUnwrap().map((pull) => pull.number)).toEqual([7]);
  const closedByHead = await world.client.listPullRequestsForHead(
    "release-pr/stable",
    "closed",
  );
  expect(closedByHead._unsafeUnwrap().map((pull) => pull.number)).toEqual([9]);
  expect(world.calls[1]?.url).toBe(
    "https://api.github.com/repos/weave-io/weave/pulls?state=open&per_page=100&head=weave-io%3Arelease-pr%2Fstable",
  );
  expect(world.calls[2]?.url).toBe(
    "https://api.github.com/repos/weave-io/weave/pulls?state=closed&per_page=100&head=weave-io%3Arelease-pr%2Fstable",
  );
});

test("release PR collection follows Link pagination before filtering", async () => {
  const firstPage = {
    number: 6,
    html_url: "https://github.com/weave-io/weave/pull/6",
    state: "open",
    title: "other",
    body: "",
    head: { ref: "feature", sha: BASE },
    base: { ref: "main" },
    labels: [],
  };
  const stablePage = {
    number: 7,
    html_url: "https://github.com/weave-io/weave/pull/7",
    state: "open",
    title: "release",
    body: "body",
    head: { ref: "release-pr/stable", sha: MARKER },
    base: { ref: "main" },
    labels: [{ name: "release:stable" }],
  };
  const world = client(
    {
      "GET /repos/weave-io/weave/pulls?state=open&per_page=1": {
        body: [firstPage],
        headers: {
          link: '<https://api.github.com/repos/weave-io/weave/pulls?state=open&per_page=1&page=2>; rel="next"',
        },
      },
      "GET /repos/weave-io/weave/pulls?state=open&per_page=1&page=2": {
        body: [stablePage],
      },
      "GET /repos/weave-io/weave/pulls?state=open&per_page=1&head=weave-io%3Arelease-pr%2Fstable":
        {
          body: [firstPage],
          headers: {
            link: '<https://api.github.com/repos/weave-io/weave/pulls?state=open&per_page=1&head=weave-io%3Arelease-pr%2Fstable&page=2>; rel="next"',
          },
        },
      "GET /repos/weave-io/weave/pulls?state=open&per_page=1&head=weave-io%3Arelease-pr%2Fstable&page=2":
        {
          body: [stablePage],
        },
    },
    { pullRequestBounds: { pageSize: 1, maxPages: 3 } },
  );

  const labelled =
    await world.client.listOpenPullRequestsByLabel("release:stable");
  expect(labelled._unsafeUnwrap().map((pull) => pull.number)).toEqual([7]);
  const byHead = await world.client.listPullRequestsForHead(
    "release-pr/stable",
    "open",
  );
  expect(byHead._unsafeUnwrap().map((pull) => pull.number)).toEqual([7]);
});

const PAGINATION_TOKEN = "release-pagination-token-sentinel";
const PULLS_PAGE_ONE = "/repos/weave-io/weave/pulls?state=open&per_page=1";

function pagedPullClient(link: string) {
  return client(
    {
      [`GET ${PULLS_PAGE_ONE}`]: {
        body: [],
        headers: { link },
      },
    },
    { pullRequestBounds: { pageSize: 1, maxPages: 3 } },
    PAGINATION_TOKEN,
  );
}

async function expectRejectedPullContinuation(link: string): Promise<void> {
  const world = pagedPullClient(link);
  const result =
    await world.client.listOpenPullRequestsByLabel("release:stable");
  expect(result.isErr()).toBe(true);
  if (result.isErr()) expect(result.error.type).toBe("GitHubError");
  expect(world.calls).toHaveLength(1);
  expect(world.calls[0]?.authorization).toBe(`Bearer ${PAGINATION_TOKEN}`);
}

test("absent Link means complete, but malformed Link is a typed error", async () => {
  const complete = client(
    { [`GET ${PULLS_PAGE_ONE}`]: { body: [] } },
    { pullRequestBounds: { pageSize: 1, maxPages: 3 } },
    PAGINATION_TOKEN,
  );
  expect(
    (
      await complete.client.listOpenPullRequestsByLabel("release:stable")
    )._unsafeUnwrap(),
  ).toEqual([]);

  await expectRejectedPullContinuation("not a Link value");
});

test("rejects an off-origin next URL before sending the bearer token", async () => {
  await expectRejectedPullContinuation(
    '<https://evil.example.invalid/repos/weave-io/weave/pulls?state=open&per_page=1&page=2>; rel="next"',
  );
});

test("rejects userinfo and fragments before fetching the next page", async () => {
  for (const link of [
    '<https://user:password@api.github.com/repos/weave-io/weave/pulls?state=open&per_page=1&page=2>; rel="next"',
    '<https://@api.github.com/repos/weave-io/weave/pulls?state=open&per_page=1&page=2>; rel="next"',
    '<https://api.github.com/repos/weave-io/weave/pulls?state=open&per_page=1&page=2#fragment>; rel="next"',
    '<https://api.github.com/repos/weave-io/weave/pulls?state=open&per_page=1&page=2#>; rel="next"',
  ])
    await expectRejectedPullContinuation(link);
});

test("rejects same-origin repository and collection-path changes", async () => {
  await expectRejectedPullContinuation(
    '<https://api.github.com/repos/other/repo/pulls?state=open&per_page=1&page=2>; rel="next"',
  );
  await expectRejectedPullContinuation(
    '<https://api.github.com/repos/weave-io/weave/issues?state=open&per_page=1&page=2>; rel="next"',
  );
});

test("rejects duplicate rel=next links", async () => {
  await expectRejectedPullContinuation(
    '<https://api.github.com/repos/weave-io/weave/pulls?state=open&per_page=1&page=2>; rel="next", <https://api.github.com/repos/weave-io/weave/pulls?state=open&per_page=1&page=2>; rel="next"',
  );
});

test("rejects duplicate, bad, and skipped page values", async () => {
  for (const page of ["2&page=2", "0", "not-a-number", "3"]) {
    await expectRejectedPullContinuation(
      `<https://api.github.com/repos/weave-io/weave/pulls?state=open&per_page=1&page=${page}>; rel="next"`,
    );
  }
});

test("rejects a changed state query before fetching the next page", async () => {
  await expectRejectedPullContinuation(
    '<https://api.github.com/repos/weave-io/weave/pulls?state=closed&per_page=1&page=2>; rel="next"',
  );
});

test("rejects a changed head query before fetching the next page", async () => {
  const initial =
    "/repos/weave-io/weave/pulls?state=open&per_page=1&head=weave-io%3Arelease-pr%2Fstable";
  const world = client(
    {
      [`GET ${initial}`]: {
        body: [],
        headers: {
          link: '<https://api.github.com/repos/weave-io/weave/pulls?state=open&per_page=1&head=weave-io%3Aother&page=2>; rel="next"',
        },
      },
    },
    { pullRequestBounds: { pageSize: 1, maxPages: 3 } },
    PAGINATION_TOKEN,
  );
  const result = await world.client.listPullRequestsForHead(
    "release-pr/stable",
    "open",
  );
  expect(result.isErr()).toBe(true);
  expect(world.calls).toHaveLength(1);
  expect(world.calls[0]?.authorization).toBe(`Bearer ${PAGINATION_TOKEN}`);
});

test("rejects a changed check-run filter before fetching the next page", async () => {
  const world = client(
    {
      "GET /repos/weave-io/weave/git/ref/heads/main": {
        body: { object: { sha: BASE } },
      },
      [`GET /repos/weave-io/weave/commits/${BASE}/statuses?per_page=1`]: {
        body: [],
      },
      [`GET /repos/weave-io/weave/commits/${BASE}/check-runs?per_page=1&filter=latest`]:
        {
          body: { total_count: 0, check_runs: [] },
          headers: {
            link: `<https://api.github.com/repos/weave-io/weave/commits/${BASE}/check-runs?per_page=1&filter=other&page=2>; rel="next"`,
          },
        },
    },
    {
      requiredChecks: [{ name: "ci", source: "check-run" }],
      greenHeadBounds: { pageSize: 1, maxPages: 3 },
    },
    PAGINATION_TOKEN,
  );
  const result = await world.client.readGreenMainHead();
  expect(result.isErr()).toBe(true);
  if (result.isErr()) expect(result.error.message).toContain("pagination");
  expect(world.calls).toHaveLength(3);
  expect(world.calls[2]?.authorization).toBe(`Bearer ${PAGINATION_TOKEN}`);
});

test("accepts the canonical page-two continuation", async () => {
  const world = client(
    {
      [`GET ${PULLS_PAGE_ONE}`]: {
        body: [],
        headers: {
          link: '<https://api.github.com/repos/weave-io/weave/pulls?state=open&per_page=1&page=2>; rel="next"',
        },
      },
      "GET /repos/weave-io/weave/pulls?state=open&per_page=1&page=2": {
        body: [],
      },
    },
    { pullRequestBounds: { pageSize: 1, maxPages: 3 } },
    PAGINATION_TOKEN,
  );
  const result =
    await world.client.listOpenPullRequestsByLabel("release:stable");
  expect(result.isOk()).toBe(true);
  expect(world.calls.map((call) => call.url)).toEqual([
    "https://api.github.com/repos/weave-io/weave/pulls?state=open&per_page=1",
    "https://api.github.com/repos/weave-io/weave/pulls?state=open&per_page=1&page=2",
  ]);
  expect(
    world.calls.every(
      (call) => call.authorization === `Bearer ${PAGINATION_TOKEN}`,
    ),
  ).toBe(true);
});

test("release PR collection fails closed when a next link exceeds its page bound", async () => {
  const page = {
    number: 6,
    html_url: "https://github.com/weave-io/weave/pull/6",
    state: "open",
    title: "other",
    body: "",
    head: { ref: "feature", sha: BASE },
    base: { ref: "main" },
    labels: [],
  };
  const listPath = "/repos/weave-io/weave/pulls?state=open&per_page=1";
  const headPath =
    "/repos/weave-io/weave/pulls?state=open&per_page=1&head=weave-io%3Arelease-pr%2Fstable";
  const routes: Record<string, Route> = {};
  for (const [path, next] of [
    [listPath, `${listPath}&page=2`],
    [`${listPath}&page=2`, `${listPath}&page=3`],
    [`${listPath}&page=3`, `${listPath}&page=4`],
    [headPath, `${headPath}&page=2`],
    [`${headPath}&page=2`, `${headPath}&page=3`],
    [`${headPath}&page=3`, `${headPath}&page=4`],
  ] as const) {
    routes[`GET ${path}`] = {
      body: [page],
      headers: {
        link: `<https://api.github.com${next}>; rel="next"`,
      },
    };
  }
  const world = client(routes, {
    pullRequestBounds: { pageSize: 1, maxPages: 3 },
  });

  const labelled =
    await world.client.listOpenPullRequestsByLabel("release:stable");
  expect(labelled._unsafeUnwrapErr()).toMatchObject({ type: "GitHubError" });
  expect(labelled._unsafeUnwrapErr().message).toContain("truncated");
  const byHead = await world.client.listPullRequestsForHead(
    "release-pr/stable",
    "open",
  );
  expect(byHead._unsafeUnwrapErr().message).toContain("truncated");
  expect(world.calls.some((call) => call.url.includes("page=4"))).toBe(false);
});

test("a created PR whose body cannot be parsed is an ambiguous write", async () => {
  const world = client({
    "POST /repos/weave-io/weave/pulls": { body: { not: "a pull request" } },
  });
  const result = await world.client.createPullRequest({
    title: "release",
    body: "body",
    headRef: "release-pr/stable",
    baseRef: "main",
    labels: ["release:stable"],
  });
  expect(result._unsafeUnwrapErr()).toEqual({
    type: "PullRequestWriteAmbiguous",
    operation: "createPullRequest",
    message: "created pull request could not be parsed",
  });
});

test("a label failure after create is an ambiguous write", async () => {
  const world = client({
    "POST /repos/weave-io/weave/pulls": {
      body: {
        number: 9,
        html_url: "https://github.com/weave-io/weave/pull/9",
        state: "open",
        title: "release",
        body: "body",
        head: { ref: "release-pr/stable", sha: MARKER },
        base: { ref: "main" },
        labels: [],
      },
    },
    "POST /repos/weave-io/weave/issues/9/labels": { status: 500 },
  });
  const result = await world.client.createPullRequest({
    title: "release",
    body: "body",
    headRef: "release-pr/stable",
    baseRef: "main",
    labels: ["release:stable"],
  });
  expect(result._unsafeUnwrapErr()).toMatchObject({
    type: "PullRequestWriteAmbiguous",
    operation: "addLabels",
  });
  expect(world.calls.map((call) => `${call.method} ${call.url}`)).toEqual([
    "POST https://api.github.com/repos/weave-io/weave/pulls",
    "POST https://api.github.com/repos/weave-io/weave/issues/9/labels",
  ]);
});

test("an unobserved create is ambiguous, a rejected one is definite", async () => {
  const timeout = client({
    "POST /repos/weave-io/weave/pulls": { reject: "socket hang up" },
  });
  const ambiguous = await timeout.client.createPullRequest({
    title: "release",
    body: "body",
    headRef: "release-pr/stable",
    baseRef: "main",
    labels: ["release:stable"],
  });
  expect(ambiguous._unsafeUnwrapErr()).toMatchObject({
    type: "PullRequestWriteAmbiguous",
  });

  const rejected = client({
    "POST /repos/weave-io/weave/pulls": { status: 422 },
  });
  const definite = await rejected.client.createPullRequest({
    title: "release",
    body: "body",
    headRef: "release-pr/stable",
    baseRef: "main",
    labels: ["release:stable"],
  });
  expect(definite._unsafeUnwrapErr()).toMatchObject({ type: "GitHubError" });
});

test("team membership is read-only and fails closed on an unknown member", async () => {
  const member = client({
    "GET /orgs/weave-io/teams/release-maintainers/memberships/maintainer": {
      body: { state: "active" },
    },
  });
  expect(
    (
      await member.client.isTeamMember({
        organization: "weave-io",
        teamSlug: "release-maintainers",
        login: "maintainer",
      })
    )._unsafeUnwrap(),
  ).toBe(true);

  const outsider = client({});
  expect(
    (
      await outsider.client.isTeamMember({
        organization: "weave-io",
        teamSlug: "release-maintainers",
        login: "outsider",
      })
    )._unsafeUnwrap(),
  ).toBe(false);
});
