import { err, ok, type Result } from "neverthrow";

/** Closed, harness-neutral thinking levels accepted by model intent syntax. */
export const THINKING_LEVEL_VALUES = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type ThinkingLevelDecl = (typeof THINKING_LEVEL_VALUES)[number];

export type ModelIntentEntry = {
  /** Model identifier with any thinking suffix and escape markers removed. */
  baseModel: string;
  /** Requested thinking level, when the entry carries a valid suffix. */
  thinkingLevel?: ThinkingLevelDecl;
};

export type ModelIntentParseError = {
  type: "InvalidThinkingLevelSuffix";
  raw: string;
  foundSuffix: string;
  allowed: readonly ThinkingLevelDecl[];
  message: string;
};

function isThinkingLevel(value: string): value is ThinkingLevelDecl {
  return (THINKING_LEVEL_VALUES as readonly string[]).includes(value);
}

function findLastUnescapedHash(raw: string): number {
  let lastDelimiter = -1;
  let escaped = false;

  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index];
    if (character === "\\") {
      escaped = !escaped;
      continue;
    }

    if (character === "#" && !escaped) lastDelimiter = index;
    escaped = false;
  }

  return lastDelimiter;
}

function unescapeLiteralHashes(value: string): string {
  let result = "";
  let precedingSlashes = 0;

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === "\\") {
      result += character;
      precedingSlashes += 1;
      continue;
    }

    if (character === "#" && precedingSlashes % 2 === 1) {
      result = `${result.slice(0, -1)}#`;
    } else {
      result += character;
    }
    precedingSlashes = 0;
  }

  return result;
}

/**
 * Split one model preference into its base identifier and optional thinking
 * level. The last unescaped `#` is the delimiter; `\#` is a literal hash.
 */
export function parseModelIntentEntry(
  raw: string,
): Result<ModelIntentEntry, ModelIntentParseError> {
  const lastDelimiter = findLastUnescapedHash(raw);
  if (lastDelimiter < 0) {
    return ok({ baseModel: unescapeLiteralHashes(raw) });
  }

  const suffix = raw.slice(lastDelimiter + 1);
  if (!isThinkingLevel(suffix)) {
    return err({
      type: "InvalidThinkingLevelSuffix",
      raw,
      foundSuffix: suffix,
      allowed: THINKING_LEVEL_VALUES,
      message:
        `Invalid model thinking-level suffix "#${suffix}". ` +
        `Allowed levels: ${THINKING_LEVEL_VALUES.join(", ")}.`,
    });
  }

  return ok({
    baseModel: unescapeLiteralHashes(raw.slice(0, lastDelimiter)),
    thinkingLevel: suffix,
  });
}
