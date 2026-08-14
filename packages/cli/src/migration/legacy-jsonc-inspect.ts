/**
 * JSONC syntax-tree inspection for legacy conversion.
 *
 * jsonc-parser.parse() silently keeps the last duplicate key. This inspector
 * walks the CST first, rejects duplicate keys and dangerous object keys, and
 * bounds raw source length so oversized text cannot bypass graph bounds.
 */

import { type JSONVisitor, visit } from "jsonc-parser";
import { err, ok, Result } from "neverthrow";
import {
  CONVERSION_REASON,
  joinPath,
  PATH_SOURCE,
  pushWarning,
} from "./legacy-conversion-diagnostics.js";
import { isDangerousDslName } from "./legacy-dsl-identifiers.js";
import { MAX_LEGACY_SOURCE_LENGTH } from "./legacy-graph-copy.js";
import type { ConversionWarning } from "./types.js";

export type LegacyJsoncInspectError =
  | {
      type: "ParseFailed";
      warnings: ConversionWarning[];
    }
  | {
      type: "SourceTooLarge";
      warnings: ConversionWarning[];
    }
  | {
      type: "UnsafeStructure";
      warnings: ConversionWarning[];
    };

function parseFailedResult(): LegacyJsoncInspectError {
  const warnings: ConversionWarning[] = [];
  pushWarning(warnings, PATH_SOURCE, CONVERSION_REASON.parseFailed);
  return { type: "ParseFailed", warnings };
}

function sourceTooLargeResult(): LegacyJsoncInspectError {
  const warnings: ConversionWarning[] = [];
  pushWarning(warnings, PATH_SOURCE, CONVERSION_REASON.sourceTooLarge);
  return { type: "SourceTooLarge", warnings };
}

const visitLegacyJsonc = Result.fromThrowable(
  (source: string, visitor: JSONVisitor): void => {
    visit(source, visitor, {
      allowTrailingComma: true,
      disallowComments: false,
      allowEmptyContent: false,
    });
  },
  (): LegacyJsoncInspectError => parseFailedResult(),
);

/**
 * Inspect legacy JSONC before object conversion.
 *
 * On success the source is structurally safe to parse. On failure the caller
 * must not convert a collapsed parse() result.
 */
export function inspectLegacyJsonc(
  source: string,
): Result<void, LegacyJsoncInspectError> {
  if (source.length > MAX_LEGACY_SOURCE_LENGTH) {
    return err(sourceTooLargeResult());
  }

  const warnings: ConversionWarning[] = [];
  const keyStack: Array<Set<string>> = [];
  let sawParseError = false;

  const visited = visitLegacyJsonc(source, {
    onObjectBegin: () => {
      keyStack.push(new Set());
    },
    onObjectProperty: (
      property,
      _offset,
      _length,
      _startLine,
      _startCharacter,
      pathSupplier,
    ) => {
      const keys = keyStack[keyStack.length - 1];
      if (keys === undefined) {
        sawParseError = true;
        return;
      }
      const parent = pathSupplier();
      const field = joinPath([...parent, property]);
      if (isDangerousDslName(property)) {
        pushWarning(warnings, field, CONVERSION_REASON.dangerousKey);
      }
      if (keys.has(property)) {
        pushWarning(warnings, field, CONVERSION_REASON.duplicateKey);
      }
      keys.add(property);
    },
    onObjectEnd: () => {
      keyStack.pop();
    },
    onError: () => {
      sawParseError = true;
    },
  });

  if (visited.isErr()) return err(visited.error);
  if (sawParseError) return err(parseFailedResult());
  if (warnings.length > 0) {
    return err({ type: "UnsafeStructure", warnings });
  }
  return ok(undefined);
}
