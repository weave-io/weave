import {
  isDangerousDslName,
  isDslIdentifierSyntax,
} from "./legacy-dsl-identifiers.js";
import type { ConversionWarning } from "./types.js";

export const MAX_CONVERSION_WARNINGS = 32;
export const MAX_WARNING_FIELD_LENGTH = 256;
export const MAX_WARNING_REASON_LENGTH = 512;
export const MAX_WARNING_DIAGNOSTIC_SIZE = 8 * 1024;
export const WARNING_TRUNCATION_SUFFIX = "... [truncated]";
export const WARNINGS_TRUNCATED_REASON =
  "additional conversion diagnostics were truncated";

const TRUNCATION_WARNING: ConversionWarning = {
  field: "<diagnostics>",
  reason: WARNINGS_TRUNCATED_REASON,
};

function truncate(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit - WARNING_TRUNCATION_SUFFIX.length)}${WARNING_TRUNCATION_SUFFIX}`;
}

function sanitizePathSegment(segment: string): string {
  if (segment.startsWith("<") && segment.endsWith(">")) return segment;
  if (/^\d+$/.test(segment)) return segment;
  if (!isDslIdentifierSyntax(segment) || isDangerousDslName(segment))
    return "<entry>";
  return segment;
}

export function boundConversionWarning(
  warning: ConversionWarning,
): ConversionWarning {
  return {
    field: truncate(
      warning.field.split(".").map(sanitizePathSegment).join("."),
      MAX_WARNING_FIELD_LENGTH,
    ),
    reason: truncate(warning.reason, MAX_WARNING_REASON_LENGTH),
  };
}

function diagnosticSize(warning: ConversionWarning): number {
  return warning.field.length + warning.reason.length;
}

/** A warning collection that stays bounded even while conversion is in progress. */
export class ConversionWarnings extends Array<ConversionWarning> {
  #size = 0;
  #truncated = false;

  override push(...items: ConversionWarning[]): number {
    for (const item of items) this.#pushOne(boundConversionWarning(item));
    return this.length;
  }

  #pushOne(item: ConversionWarning): void {
    if (this.#truncated) return;
    const tooMany = this.length >= MAX_CONVERSION_WARNINGS;
    const tooLarge =
      this.#size + diagnosticSize(item) > MAX_WARNING_DIAGNOSTIC_SIZE;
    if (!tooMany && !tooLarge) {
      super.push(item);
      this.#size += diagnosticSize(item);
      return;
    }

    this.#truncated = true;
    if (this.length >= MAX_CONVERSION_WARNINGS) {
      const removed = this[this.length - 1];
      if (removed !== undefined) this.#size -= diagnosticSize(removed);
      this[this.length - 1] = TRUNCATION_WARNING;
      this.#size += diagnosticSize(TRUNCATION_WARNING);
      return;
    }
    super.push(TRUNCATION_WARNING);
    this.#size += diagnosticSize(TRUNCATION_WARNING);
  }
}

export function createConversionWarnings(): ConversionWarning[] {
  return new ConversionWarnings();
}
