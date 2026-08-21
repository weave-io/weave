import { describe, expect, it } from "bun:test";
import {
  loadCodeowners,
  matchesCodeownersPattern,
  parseCodeowners,
  RELEASE_MAINTAINERS,
  REQUIRED_RELEASE_OWNER_PATHS,
  resolveCodeowners,
  verifyCodeowners,
} from "../verify-codeowners.js";

const OWNER = RELEASE_MAINTAINERS;
const protectedRules = `
/.github/workflows/ ${OWNER}
/.github/CODEOWNERS ${OWNER}
/.github/dependabot.yml ${OWNER}
/scripts/ci/ ${OWNER}
/.changeset/ ${OWNER}
/package.json ${OWNER}
/packages/*/package.json ${OWNER}
/packages/adapters/*/package.json ${OWNER}
/bun.lock ${OWNER}
/config/ ${OWNER}
/tsconfig.build.json ${OWNER}
/packages/*/api-extractor*.json ${OWNER}
/packages/*/tsconfig.build.json ${OWNER}
/packages/adapters/*/api-extractor*.json ${OWNER}
/packages/adapters/*/tsconfig.build.json ${OWNER}
/scripts/release/ ${OWNER}
/scripts/build-public-packages.ts ${OWNER}
/packages/cli/ ${OWNER}
/packages/adapters/opencode/ ${OWNER}
/packages/adapters/claude-code/ ${OWNER}
`;

describe("matchesCodeownersPattern", () => {
  it.each([
    ["root directory", "/.github/workflows/", ".github/workflows/ci.yml", true],
    [
      "directory excludes sibling",
      "/.github/workflows/",
      ".github/actions/action.yml",
      false,
    ],
    [
      "single star stays in a segment",
      "/packages/*/package.json",
      "packages/core/package.json",
      true,
    ],
    [
      "single star cannot span directories",
      "/packages/*/package.json",
      "packages/a/b/package.json",
      false,
    ],
    [
      "double star spans directories",
      "docs/**/*.md",
      "docs/guides/setup.md",
      true,
    ],
    [
      "double star allows no nested directory",
      "docs/**/*.md",
      "docs/setup.md",
      true,
    ],
    [
      "unanchored basename matches anywhere",
      "CODEOWNERS",
      ".github/CODEOWNERS",
      true,
    ],
    [
      "question mark matches one non-slash",
      "config?.json",
      "nested/config1.json",
      true,
    ],
    [
      "negation is unsupported by GitHub",
      "!package.json",
      "package.json",
      false,
    ],
  ])("%s", (_name, pattern, path, expected) => {
    expect(matchesCodeownersPattern(pattern, path)).toBe(expected);
  });
});

describe("verifyCodeowners", () => {
  it("covers every sensitive representative path in the repository", async () => {
    expect(verifyCodeowners(await loadCodeowners()).isOk()).toBe(true);
    expect(REQUIRED_RELEASE_OWNER_PATHS).toContain(".github/CODEOWNERS");
    expect(REQUIRED_RELEASE_OWNER_PATHS).toContain(
      "scripts/ci/verify-codeowners.ts",
    );
  });

  it("uses the last matching rule", () => {
    const parsed = parseCodeowners(
      `/scripts/ ${OWNER}\n/scripts/ci/ @other/team`,
    );
    expect(parsed.isOk()).toBe(true);
    if (parsed.isErr()) return;
    expect(
      resolveCodeowners(parsed.value, "scripts/ci/verify-codeowners.ts"),
    ).toEqual(["@other/team"]);
  });

  it.each([
    [
      "required rule removed",
      protectedRules.replace(`/.github/CODEOWNERS ${OWNER}\n`, ""),
    ],
    [
      "later broad rule overrides protection",
      `${protectedRules}\n/.github/ @other/team`,
    ],
    ["wrong team", protectedRules.replaceAll(OWNER, "@other/team")],
  ])("rejects %s", (_name, fixture) => {
    expect(verifyCodeowners(fixture).isErr()).toBe(true);
  });

  it.each([
    ["missing owner", "/package.json"],
    ["inline comment", "/package.json @owner # comment"],
    ["unsupported negation", "!/package.json @owner"],
    ["unsupported character range", "/package[0-9].json @owner"],
    ["invalid owner", "/package.json owner"],
  ])("rejects malformed %s lines", (_name, fixture) => {
    const result = parseCodeowners(fixture);
    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error[0]?.type).toBe("MalformedLine");
  });
});
