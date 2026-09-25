/**
 * Scenarios for the prompt the `tapestry-category-routing` suite shows
 * Tapestry.
 *
 * A category routes work only because `.weave` declares it: the engine
 * materializes it as `shuttle-{category}` and lists it among Tapestry's
 * delegation targets. So each case declares its categories and the runner
 * composes Tapestry's prompt from the builtin config plus exactly those — an
 * enabled category appears in the list, a disabled one does not, and nothing
 * from the developer's own `.weave` does (#253).
 *
 * The black box is one `weave eval run` with the model and judge stubbed and
 * prompt composition left real; the observable is the system prompt the model
 * was sent.
 */

import { describe, expect, it } from "bun:test";
import {
  EVAL_MODEL,
  type FixtureSpec,
  runEvalSuite,
  type SuiteRunObservation,
  withEvalFixtures,
} from "../support/evals.js";

const SUITE = "tapestry-category-routing";

/** Every `shuttle` / `shuttle-{category}` entry in Tapestry's delegation list. */
function listedShuttles(systemPrompt: string): string[] {
  return [
    ...systemPrompt.matchAll(/^- \*\*(shuttle(?:-[A-Za-z0-9_-]+)?)\*\*/gm),
  ]
    .map((match) => match[1] ?? "")
    .sort();
}

/** The system prompt the model was sent for the case whose task is `task`. */
function promptFor(run: SuiteRunObservation, task: string): string {
  const call = run.modelCalls.find((c) =>
    c.messages.some((m) => m.role === "user" && m.content.includes(task)),
  );
  return call?.messages.find((m) => m.role === "system")?.content ?? "";
}

function routingCase(
  id: string,
  categories: Array<Record<string, unknown>>,
): FixtureSpec {
  return {
    id,
    suite: SUITE,
    description: `Route the ${id} change.`,
    allowedAgents: [
      "tapestry",
      "shuttle",
      "shuttle-frontend",
      "shuttle-backend",
    ],
    expectedOutcome: {
      kind: "agent_routing",
      target_agent: "shuttle",
      via: [],
    },
    categories,
  };
}

async function runComposed(
  fixtures: FixtureSpec[],
): Promise<SuiteRunObservation> {
  return withEvalFixtures(fixtures, (evalsRoot) =>
    runEvalSuite({
      evalsRoot,
      agent: SUITE,
      answers: ["→ shuttle"],
      composePrompts: true,
    }),
  );
}

describe("a maintainer runs the category-routing suite on cases that declare their categories", () => {
  it("shows Tapestry each enabled category as its shuttle, next to the generic shuttle", async () => {
    const run = await runComposed([
      routingCase("two-categories", [
        { name: "frontend", description: "Web frontend pages and components" },
        { name: "backend", description: "HTTP API controllers" },
      ]),
    ]);

    const prompt = promptFor(run, "two-categories");
    expect(listedShuttles(prompt)).toEqual([
      "shuttle",
      "shuttle-backend",
      "shuttle-frontend",
    ]);
    expect(prompt).toContain(
      "- **shuttle-frontend** — Web frontend pages and components",
    );
  });

  it("leaves a disabled category's shuttle out of Tapestry's list, so it is never offered work", async () => {
    const run = await runComposed([
      routingCase("one-disabled", [
        { name: "frontend", description: "Web frontend pages", disabled: true },
        { name: "backend", description: "HTTP API controllers" },
      ]),
    ]);

    expect(listedShuttles(promptFor(run, "one-disabled"))).toEqual([
      "shuttle",
      "shuttle-backend",
    ]);
  });

  it("lists a category whose name has capitals and an underscore under that exact name", async () => {
    const run = await runComposed([
      routingCase("mixed-case-name", [
        { name: "Front_End", description: "Web frontend pages" },
      ]),
    ]);

    expect(listedShuttles(promptFor(run, "mixed-case-name"))).toEqual([
      "shuttle",
      "shuttle-Front_End",
    ]);
  });

  it("lists only the generic shuttle when the case declares no categories", async () => {
    const run = await runComposed([routingCase("no-categories", [])]);

    expect(listedShuttles(promptFor(run, "no-categories"))).toEqual([
      "shuttle",
    ]);
  });

  it("composes each case under its own categories, so one case's categories never reach another's prompt", async () => {
    const run = await runComposed([
      routingCase("frontend-only", [
        { name: "frontend", description: "Web pages" },
      ]),
      routingCase("backend-only", [
        { name: "backend", description: "API controllers" },
      ]),
    ]);

    expect(listedShuttles(promptFor(run, "frontend-only"))).toEqual([
      "shuttle",
      "shuttle-frontend",
    ]);
    expect(listedShuttles(promptFor(run, "backend-only"))).toEqual([
      "shuttle",
      "shuttle-backend",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

/** The hash the run's provenance records for `agentName`, if any. */
function recordedHash(
  run: SuiteRunObservation,
  agentName: string,
): string | undefined {
  const records = (run.provenanceManifest?.records ?? []) as Array<{
    agentName: string;
    hash: string;
  }>;
  return records.find((r) => r.agentName === agentName)?.hash;
}

function sha256(text: string): string {
  return new Bun.CryptoHasher("sha256").update(text).digest("hex");
}

describe("a maintainer compares two category-routing runs by their recorded prompts", () => {
  it("records the hash of each case's prompt as it was sent, as tapestry@<case>", async () => {
    const run = await runComposed([
      routingCase("frontend-only", [
        { name: "frontend", description: "Web pages" },
      ]),
      routingCase("backend-only", [
        { name: "backend", description: "API controllers" },
      ]),
    ]);

    for (const id of ["frontend-only", "backend-only"]) {
      expect(recordedHash(run, `tapestry@${id}`)).toBe(
        sha256(promptFor(run, id)),
      );
    }
  });

  it("records a different hash when only a case's categories change, so eval compare names the prompt change", async () => {
    const before = await runComposed([
      routingCase("same-case", [
        { name: "frontend", description: "Web pages" },
      ]),
    ]);
    const after = await runComposed([
      routingCase("same-case", [
        { name: "frontend", description: "Web pages", disabled: true },
      ]),
    ]);

    const beforeHash = recordedHash(before, "tapestry@same-case");
    const afterHash = recordedHash(after, "tapestry@same-case");
    expect(beforeHash).toBeDefined();
    expect(afterHash).toBeDefined();
    expect(afterHash).not.toBe(beforeHash);
  });
});

// ---------------------------------------------------------------------------
// The shipped corpus
// ---------------------------------------------------------------------------

interface CorpusCase {
  id: string;
  description: string;
  allowed_agents: string[];
  categories?: Array<{ name: string; disabled?: boolean }>;
  expected_outcome: { kind: string; target_agent: string };
  accepted_alternates?: string[];
  transcript_expectations?: Array<Record<string, unknown>>;
  tags?: string[];
}

const CORPUS_IDS = [
  "tcr-01-exact-match",
  "tcr-02-multiple-files",
  "tcr-03-windows-paths",
  "tcr-04-no-match",
  "tcr-05-cross-category",
  "tcr-06-overlap",
  "tcr-07-explicit-hint",
  "tcr-08-misleading-prose",
  "tcr-09-similar-names",
  "tcr-10-disabled-category",
];

const CORPUS: CorpusCase[] = await Promise.all(
  CORPUS_IDS.map(
    (id) =>
      Bun.file(
        new URL(`../../evals/cases/${SUITE}/${id}.json`, import.meta.url),
      ).json() as Promise<CorpusCase>,
  ),
);

function fromCorpus(corpusCase: CorpusCase): FixtureSpec {
  return {
    id: corpusCase.id,
    suite: SUITE,
    description: corpusCase.description,
    allowedAgents: corpusCase.allowed_agents,
    allowedModels: [EVAL_MODEL],
    expectedOutcome: corpusCase.expected_outcome,
    acceptedAlternates: corpusCase.accepted_alternates,
    transcriptExpectations: corpusCase.transcript_expectations,
    tags: corpusCase.tags,
    categories: corpusCase.categories,
  };
}

describe("a maintainer runs the shipped category-routing corpus", () => {
  it.each(
    CORPUS.map((c) => [c.id, c] as const),
  )("%s: Tapestry's list holds exactly the case's enabled category shuttles", async (_id, corpusCase) => {
    const run = await runComposed([fromCorpus(corpusCase)]);

    const enabled = (corpusCase.categories ?? [])
      .filter((category) => category.disabled !== true)
      .map((category) => `shuttle-${category.name}`);
    expect(listedShuttles(promptFor(run, corpusCase.description))).toEqual(
      ["shuttle", ...enabled].sort(),
    );
  });

  it.each(
    CORPUS.map((c) => [c.id, c] as const),
  )("%s: every category shuttle Tapestry is shown is one the case allows", async (_id, corpusCase) => {
    const run = await runComposed([fromCorpus(corpusCase)]);

    for (const shuttle of listedShuttles(
      promptFor(run, corpusCase.description),
    )) {
      expect(corpusCase.allowed_agents).toContain(shuttle);
    }
  });

  it.each(
    CORPUS.map((c) => [c.id, c] as const),
  )("%s: the expected route is an agent Tapestry is shown", async (_id, corpusCase) => {
    const run = await runComposed([fromCorpus(corpusCase)]);

    expect(listedShuttles(promptFor(run, corpusCase.description))).toContain(
      corpusCase.expected_outcome.target_agent,
    );
  });

  it("keeps the disabled category of the disabled-category case out of Tapestry's list", async () => {
    const disabledCase = CORPUS.find(
      (c) => c.id === "tcr-10-disabled-category",
    ) as CorpusCase;
    const run = await runComposed([fromCorpus(disabledCase)]);

    expect(disabledCase.categories?.[0]?.disabled).toBe(true);
    expect(listedShuttles(promptFor(run, disabledCase.description))).toEqual([
      "shuttle",
    ]);
  });
});
