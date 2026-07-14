/**
 * Scaling test: verifies that category shuttle generation and prompt composition
 * scales correctly with category count.
 *
 * Measured token counts (approximate, chars / 4) from a previous run are
 * documented in docs/category-routing-findings.md under "Token Cost".
 *
 * No file I/O, no real adapter calls, no console output -- pure composition.
 */

import { describe, expect, it } from "bun:test";
import {
  type AgentConfig,
  parseConfig,
  type WeaveConfig,
} from "@weaveio/weave-core";
import { composeAgentDescriptor } from "../compose.js";
import { generateCategoryShuttles } from "../descriptors.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function cfg(source: string): WeaveConfig {
  const result = parseConfig(source);
  if (result.isErr()) throw new Error(JSON.stringify(result.error));
  return result.value;
}

async function composeTapestry(source: string): Promise<string> {
  const config = cfg(source);

  const shuttleMap = generateCategoryShuttles(config);
  if (shuttleMap.isErr()) throw new Error(shuttleMap.error.message);

  const allAgents: Record<string, AgentConfig> = {
    ...config.agents,
    ...Object.fromEntries(
      Object.entries(shuttleMap.value).map(([k, v]) => [k, v.config]),
    ),
  };

  const tapestryConfig = allAgents.tapestry;
  if (tapestryConfig === undefined) throw new Error("tapestry agent not found");

  const result = await composeAgentDescriptor(
    "tapestry",
    tapestryConfig,
    config,
    allAgents,
  );
  if (result.isErr()) throw new Error(JSON.stringify(result.error));

  return result.value.composedPrompt;
}

function approxTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// ---------------------------------------------------------------------------
// DSL fixture builders
// ---------------------------------------------------------------------------

/** Category definitions for the 25-category realistic scenario */
const REALISTIC_CATEGORIES = [
  {
    name: "frontend",
    patterns: ["src/frontend/**", "src/components/**", "**/*.tsx"],
    description: "Frontend UI components and pages",
  },
  {
    name: "backend-api",
    patterns: ["src/api/**", "src/server/**"],
    description: "Backend API routes and controllers",
  },
  {
    name: "database",
    patterns: ["src/db/**", "src/migrations/**", "**/*.sql"],
    description: "Database models, migrations, and queries",
  },
  {
    name: "auth",
    patterns: ["src/auth/**", "src/middleware/auth*"],
    description: "Authentication and authorisation logic",
  },
  {
    name: "testing",
    patterns: ["**/*.test.ts", "**/*.spec.ts", "tests/**"],
    description: "Unit, integration, and e2e test files",
  },
  {
    name: "ci-cd",
    patterns: [".github/**", "scripts/deploy/**", "Dockerfile*"],
    description: "CI/CD pipelines and deployment scripts",
  },
  {
    name: "docs",
    patterns: ["docs/**", "**/*.md", "README*"],
    description: "Documentation and developer guides",
  },
  {
    name: "config",
    patterns: ["config/**", "**/*.config.ts", "**/.env*"],
    description: "Application and environment configuration",
  },
  {
    name: "mobile",
    patterns: ["src/mobile/**", "**/*.native.ts"],
    description: "Mobile-specific components and logic",
  },
  {
    name: "payments",
    patterns: ["src/payments/**", "src/billing/**"],
    description: "Payment processing and billing integration",
  },
  {
    name: "notifications",
    patterns: ["src/notifications/**", "src/email/**"],
    description: "Email, push, and in-app notifications",
  },
  {
    name: "search",
    patterns: ["src/search/**", "src/indexing/**"],
    description: "Search engine integration and indexing",
  },
  {
    name: "analytics",
    patterns: ["src/analytics/**", "src/tracking/**"],
    description: "Analytics events and tracking",
  },
  {
    name: "cdn",
    patterns: ["src/cdn/**", "src/assets/**", "public/**"],
    description: "Static assets and CDN configuration",
  },
  {
    name: "caching",
    patterns: ["src/cache/**", "src/redis/**"],
    description: "Caching strategies and Redis integration",
  },
  {
    name: "logging",
    patterns: ["src/logging/**", "src/observability/**"],
    description: "Structured logging and observability",
  },
  {
    name: "feature-flags",
    patterns: ["src/flags/**", "src/experiments/**"],
    description: "Feature flags and A/B experiment logic",
  },
  {
    name: "i18n",
    patterns: ["src/i18n/**", "**/*.locale.ts", "locales/**"],
    description: "Internationalisation and localisation",
  },
  {
    name: "security",
    patterns: ["src/security/**", "src/crypto/**"],
    description: "Security utilities, encryption, and key management",
  },
  {
    name: "reporting",
    patterns: ["src/reports/**", "src/export/**"],
    description: "Report generation and data export",
  },
  {
    name: "websockets",
    patterns: ["src/ws/**", "src/realtime/**"],
    description: "WebSocket and real-time event handling",
  },
  {
    name: "admin",
    patterns: ["src/admin/**", "src/dashboard/**"],
    description: "Admin panel and internal dashboard",
  },
  {
    name: "graphql",
    patterns: ["src/graphql/**", "**/*.graphql", "**/*.gql"],
    description: "GraphQL schema, resolvers, and subscriptions",
  },
  {
    name: "infra",
    patterns: ["infra/**", "terraform/**", "k8s/**"],
    description: "Infrastructure-as-code and Kubernetes manifests",
  },
  {
    name: "sdk",
    patterns: ["sdk/**", "packages/sdk/**"],
    description: "Public SDK and client library",
  },
];

function buildDslFixture(count: number): string {
  const categories = REALISTIC_CATEGORIES.slice(0, count);

  const categoryBlocks = categories
    .map(
      ({ name, patterns, description }) =>
        `category ${name} {\n  description "${description}"\n  patterns [${patterns.map((p) => `"${p}"`).join(", ")}]\n}`,
    )
    .join("\n\n");

  return `
agent tapestry {
  prompt "You are Tapestry, the category routing agent."
  models ["claude-sonnet-4-5"]
  mode primary
  tool_policy { delegate allow }
}

agent shuttle {
  prompt "You are Shuttle, the domain specialist."
  models ["claude-sonnet-4-5"]
  mode subagent
}

${categoryBlocks}
`;
}

// ---------------------------------------------------------------------------
// Category generation tests
// ---------------------------------------------------------------------------

describe("category shuttle generation -- scaling", () => {
  it("generates the correct number of category shuttles for 3 categories", () => {
    const config = cfg(buildDslFixture(3));
    const shuttleMap = generateCategoryShuttles(config);
    expect(shuttleMap.isOk()).toBe(true);
    expect(Object.keys(shuttleMap._unsafeUnwrap())).toHaveLength(3);
  });

  it("generates the correct number of category shuttles for 10 categories", () => {
    const config = cfg(buildDslFixture(10));
    const shuttleMap = generateCategoryShuttles(config);
    expect(shuttleMap.isOk()).toBe(true);
    expect(Object.keys(shuttleMap._unsafeUnwrap())).toHaveLength(10);
  });

  it("generates the correct number of category shuttles for 25 categories", () => {
    const config = cfg(buildDslFixture(25));
    const shuttleMap = generateCategoryShuttles(config);
    expect(shuttleMap.isOk()).toBe(true);
    expect(Object.keys(shuttleMap._unsafeUnwrap())).toHaveLength(25);
  });

  it("each generated shuttle name follows the shuttle-{category} convention", () => {
    const config = cfg(buildDslFixture(3));
    const shuttleMap = generateCategoryShuttles(config);
    expect(shuttleMap.isOk()).toBe(true);
    for (const name of Object.keys(shuttleMap._unsafeUnwrap())) {
      expect(name).toMatch(/^shuttle-/);
    }
  });

  it("each category name appears in the shuttle map for 3 categories", () => {
    const config = cfg(buildDslFixture(3));
    const shuttleMap = generateCategoryShuttles(config);
    expect(shuttleMap.isOk()).toBe(true);
    const names = Object.keys(shuttleMap._unsafeUnwrap());
    for (let i = 0; i < 3; i++) {
      expect(names).toContain(`shuttle-${REALISTIC_CATEGORIES[i]?.name}`);
    }
  });
});

// ---------------------------------------------------------------------------
// Prompt composition -- delegation targets scale with category count
// ---------------------------------------------------------------------------

describe("category shuttle delegation -- composition scaling", () => {
  const scales = [3, 10, 25] as const;

  for (const count of scales) {
    it(`${count} categories -- tapestry prompt composes and delegation targets include all shuttles`, async () => {
      const dsl = buildDslFixture(count);
      const config = cfg(dsl);

      const shuttleMap = generateCategoryShuttles(config);
      expect(shuttleMap.isOk()).toBe(true);

      const allAgents: Record<string, AgentConfig> = {
        ...config.agents,
        ...Object.fromEntries(
          Object.entries(shuttleMap._unsafeUnwrap()).map(([k, v]) => [
            k,
            v.config,
          ]),
        ),
      };

      const tapestryConfig = allAgents.tapestry;
      if (tapestryConfig === undefined)
        throw new Error("tapestry agent not found in allAgents");

      const result = await composeAgentDescriptor(
        "tapestry",
        tapestryConfig,
        config,
        allAgents,
      );
      expect(result.isOk()).toBe(true);

      const descriptor = result._unsafeUnwrap();

      // All category shuttles appear as delegation targets
      for (let i = 0; i < count; i++) {
        const expectedName = `shuttle-${REALISTIC_CATEGORIES[i]?.name}`;
        const found = descriptor.delegationTargets.find(
          (t) => t.name === expectedName,
        );
        expect(found).toBeDefined();
        expect(found?.isCategory).toBe(true);
      }

      // Prompt is non-empty and token growth is at most linear (sanity bound)
      expect(descriptor.composedPrompt.length).toBeGreaterThan(0);
      const tokens = approxTokens(descriptor.composedPrompt);
      // Upper bound: base prompt + at most 200 tokens per category is generous
      expect(tokens).toBeLessThan(count * 200 + 500);
    });
  }

  it("prompt token count stays below 2000 tokens at 25 categories (no routing table overhead)", async () => {
    // With the routing table removed, the base prompt is not inflated by category count.
    // Verify total prompt tokens stay compact even at the largest scale.
    const prompt = await composeTapestry(buildDslFixture(25));
    const tokens = approxTokens(prompt);
    // The routing table previously added ~751 tokens at 25 categories.
    // Without it, the base should remain well below 500 tokens.
    expect(tokens).toBeLessThan(2000);
    expect(tokens).toBeGreaterThan(0);
  });
});
