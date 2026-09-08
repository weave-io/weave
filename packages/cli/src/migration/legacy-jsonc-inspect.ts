import { type JSONVisitor, visit } from "jsonc-parser";
import { err, type Result as NeverthrowResult, ok, Result } from "neverthrow";
import { createConversionWarnings } from "./legacy-conversion-diagnostics.js";
import { isDangerousDslName } from "./legacy-dsl-identifiers.js";
import type { ConversionWarning } from "./types.js";

export const MAX_LEGACY_JSONC_SOURCE_LENGTH = 1024 * 1024;

export type LegacyJsoncInspectError = {
  type: "ParseFailed" | "SourceTooLarge" | "UnsafeStructure";
  warnings: ConversionWarning[];
};

function inspectError(
  type: LegacyJsoncInspectError["type"],
  reason: string,
): LegacyJsoncInspectError {
  const warnings = createConversionWarnings();
  warnings.push({ field: "<source>", reason });
  return { type, warnings };
}

const visitJsonc = Result.fromThrowable(
  (source: string, visitor: JSONVisitor): void =>
    visit(source, visitor, {
      allowTrailingComma: true,
      disallowComments: false,
      allowEmptyContent: false,
    }),
  (): LegacyJsoncInspectError =>
    inspectError(
      "ParseFailed",
      "failed to parse legacy JSONC source; no fields could be converted",
    ),
);

export function inspectLegacyJsonc(
  source: string,
): NeverthrowResult<void, LegacyJsoncInspectError> {
  if (source.length > MAX_LEGACY_JSONC_SOURCE_LENGTH) {
    return err(
      inspectError(
        "SourceTooLarge",
        "legacy JSONC source exceeds conversion size bounds",
      ),
    );
  }

  const warnings = createConversionWarnings();
  const keys: Array<Set<string>> = [];
  let malformed = false;
  const visited = visitJsonc(source, {
    onObjectBegin: () => {
      keys.push(new Set());
    },
    onObjectProperty: (
      property,
      _offset,
      _length,
      _line,
      _character,
      pathSupplier,
    ) => {
      const current = keys[keys.length - 1];
      if (current === undefined) {
        malformed = true;
        return;
      }
      const rawPath = [...pathSupplier(), property].join(".");
      if (isDangerousDslName(property)) {
        warnings.push({
          field: rawPath,
          reason: "dangerous object key is not allowed",
        });
      }
      if (current.has(property)) {
        warnings.push({
          field: rawPath,
          reason: "duplicate object key; skipped to avoid silent collapse",
        });
      }
      current.add(property);
    },
    onObjectEnd: () => {
      keys.pop();
    },
    onError: () => {
      malformed = true;
    },
  });
  if (visited.isErr()) return err(visited.error);
  if (malformed)
    return err(
      inspectError(
        "ParseFailed",
        "failed to parse legacy JSONC source; no fields could be converted",
      ),
    );
  if (warnings.length > 0) return err({ type: "UnsafeStructure", warnings });
  return ok();
}
