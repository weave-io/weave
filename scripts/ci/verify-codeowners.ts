import { join } from "node:path";
import { logger } from "@weaveio/weave-engine";
import { err, ok, type Result } from "neverthrow";

export const RELEASE_MAINTAINERS = "@weave-io/release-maintainers";

/**
 * Every path here must resolve to only RELEASE_MAINTAINERS after CODEOWNERS'
 * last-match evaluation. Keep this explicit so review coverage is auditable.
 */
export const REQUIRED_RELEASE_OWNER_PATHS = [
  ".github/workflows/agent-evals.yml",
  ".github/workflows/ci.yml",
  ".github/workflows/deploy-docs.yml",
  ".github/workflows/publish.yml",
  ".github/CODEOWNERS",
  ".github/dependabot.yml",
  "scripts/ci/verify-action-pins.ts",
  "scripts/ci/verify-codeowners.ts",
  "scripts/ci/__tests__/verify-action-pins.test.ts",
  "scripts/ci/__tests__/verify-codeowners.test.ts",
  "scripts/validate-api-extractor-configs.ts",
  ".changeset/example.md",
  "package.json",
  "packages/core/package.json",
  "packages/engine/package.json",
  "packages/config/package.json",
  "packages/cli/package.json",
  "packages/adapters/opencode/package.json",
  "packages/adapters/claude-code/package.json",
  "bun.lock",
  "config/api-extractor.base.json",
  "tsconfig.build.json",
  "packages/core/tsconfig.build.json",
  "packages/engine/tsconfig.build.json",
  "packages/config/tsconfig.build.json",
  "packages/cli/api-extractor.json",
  "packages/cli/tsconfig.build.json",
  "packages/adapters/opencode/api-extractor.index.json",
  "packages/adapters/opencode/api-extractor.plugin.json",
  "packages/adapters/opencode/tsconfig.build.json",
  "packages/adapters/claude-code/api-extractor.json",
  "packages/adapters/claude-code/tsconfig.build.json",
  "scripts/release/constants.ts",
  "scripts/release/model.ts",
  "scripts/release/packager.ts",
  "scripts/build-public-packages.ts",
  "packages/cli/src/main.ts",
  "packages/core/src/index.ts",
  "packages/config/src/index.ts",
  "packages/engine/src/index.ts",
  "packages/adapters/opencode/src/index.ts",
  "packages/adapters/claude-code/src/index.ts",
] as const;

export type CodeownersRule = { pattern: string; owners: readonly string[] };

export type CodeownersError =
  | { type: "MalformedLine"; line: number; content: string; reason: string }
  | { type: "MissingRequiredOwnership"; path: string }
  | {
      type: "IncorrectRequiredOwnership";
      path: string;
      owners: readonly string[];
    };

function isOwner(value: string): boolean {
  return value.startsWith("@") || /^[^\s@]+@[^\s@]+$/.test(value);
}

export function parseCodeowners(
  source: string,
): Result<readonly CodeownersRule[], CodeownersError[]> {
  const rules: CodeownersRule[] = [];
  const errors: CodeownersError[] = [];
  for (const [index, rawLine] of source.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const fields = line.split(/\s+/);
    const pattern = fields[0];
    const owners = fields.slice(1);
    if (pattern === undefined || owners.length === 0) {
      errors.push({
        type: "MalformedLine",
        line: index + 1,
        content: rawLine,
        reason: "a pattern must be followed by at least one owner",
      });
      continue;
    }
    if (
      pattern.startsWith("!") ||
      pattern.includes("#") ||
      pattern.includes("[") ||
      pattern.includes("]")
    ) {
      errors.push({
        type: "MalformedLine",
        line: index + 1,
        content: rawLine,
        reason:
          "patterns cannot use negation, character ranges, or inline comments",
      });
      continue;
    }
    if (owners.some((owner) => !isOwner(owner))) {
      errors.push({
        type: "MalformedLine",
        line: index + 1,
        content: rawLine,
        reason: "owners must be GitHub users, teams, or email addresses",
      });
      continue;
    }
    rules.push({ pattern, owners });
  }
  if (errors.length > 0) return err(errors);
  return ok(rules);
}

function escapeRegex(character: string): string {
  return /[\\^$+?.()|{}[\]]/.test(character) ? `\\${character}` : character;
}

/** Matches the GitHub CODEOWNERS gitignore-style subset (no negation). */
export function matchesCodeownersPattern(
  pattern: string,
  path: string,
): boolean {
  if (pattern.startsWith("!")) return false;
  const normalizedPath = path.replace(/^\/+/, "");
  const anchored = pattern.startsWith("/");
  const directory = pattern.endsWith("/");
  const rawPattern = pattern.replace(/^\/+/, "").replace(/\/$/, "");
  if (rawPattern.length === 0) return false;

  let expression = "";
  for (let index = 0; index < rawPattern.length; index += 1) {
    const character = rawPattern[index];
    const next = rawPattern[index + 1];
    if (character === "*" && next === "*") {
      if (rawPattern[index + 2] === "/") {
        expression += "(?:.*/)?";
        index += 2;
        continue;
      }
      expression += ".*";
      index += 1;
      continue;
    }
    if (character === "*") {
      expression += "[^/]*";
      continue;
    }
    if (character === "?") {
      expression += "[^/]";
      continue;
    }
    expression += escapeRegex(character ?? "");
  }

  const hasSlash = rawPattern.includes("/");
  const prefix = anchored || hasSlash ? "^" : "(?:^|.*/)";
  const suffix = directory || !hasSlash ? "(?:/.*)?$" : "$";
  return new RegExp(`${prefix}${expression}${suffix}`).test(normalizedPath);
}

export function resolveCodeowners(
  rules: readonly CodeownersRule[],
  path: string,
): readonly string[] | undefined {
  let owners: readonly string[] | undefined;
  for (const rule of rules) {
    if (matchesCodeownersPattern(rule.pattern, path)) owners = rule.owners;
  }
  return owners;
}

export function verifyCodeowners(
  source: string,
): Result<void, CodeownersError[]> {
  return parseCodeowners(source).andThen((rules) => {
    const errors: CodeownersError[] = [];
    for (const path of REQUIRED_RELEASE_OWNER_PATHS) {
      const owners = resolveCodeowners(rules, path);
      if (owners === undefined) {
        errors.push({ type: "MissingRequiredOwnership", path });
        continue;
      }
      if (owners.length !== 1 || owners[0] !== RELEASE_MAINTAINERS) {
        errors.push({ type: "IncorrectRequiredOwnership", path, owners });
      }
    }
    if (errors.length > 0) return err(errors);
    return ok(undefined);
  });
}

export async function loadCodeowners(root = "."): Promise<string> {
  return Bun.file(join(root, ".github/CODEOWNERS")).text();
}

if (import.meta.main) {
  const result = verifyCodeowners(await loadCodeowners());
  if (result.isOk()) {
    logger.info(
      { paths: REQUIRED_RELEASE_OWNER_PATHS.length },
      "Verified CODEOWNERS release-maintainer coverage",
    );
  } else {
    logger.error({ errors: result.error }, "CODEOWNERS verification failed");
    process.exitCode = 1;
  }
}
