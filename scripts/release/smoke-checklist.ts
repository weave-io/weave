import { err, ok, type Result, ResultAsync } from "neverthrow";

/**
 * Parser for the digest-bound stable TUI smoke checklist (Pi adapter contract).
 *
 * The checklist itself (`scripts/release/pi-acceptance/smoke-checklist.md`)
 * is a manual, human-executed document — this module only extracts its
 * structural facts (checklist version, item IDs) so the acceptance manifest
 * validator can confirm every `liveSmoke.checklistIds` entry actually names
 * a real checklist row, and so release tooling can confirm the manifest's
 * `artifactBinding.checklistVersion` matches the checklist that was bound.
 */
export const SMOKE_CHECKLIST_RESULTS = ["Pending", "Pass", "Fail"] as const;
export type SmokeChecklistResult = (typeof SMOKE_CHECKLIST_RESULTS)[number];

export interface SmokeChecklistItem {
  readonly id: string;
  readonly area: string;
  readonly check: string;
  readonly result: SmokeChecklistResult;
}

export interface ParsedSmokeChecklist {
  readonly version: string;
  readonly items: readonly SmokeChecklistItem[];
}

export type SmokeChecklistParseError =
  | { type: "MissingVersion" }
  | { type: "NoItems" }
  | { type: "DuplicateItemId"; id: string }
  | { type: "MalformedRow"; line: string }
  | { type: "InvalidResult"; id: string; result: string };

const VERSION_LINE = /^Checklist version:\s*(\S+)\s*$/m;
const ROW_LINE =
  /^\|\s*(S\d{3})\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*$/;

/**
 * Parses the checklist markdown source into a structured, ID-addressable
 * form. Only the pipe-table rows whose first cell matches `S\d{3}` are
 * treated as checklist items; the header/separator rows and every other
 * line are ignored.
 */
export function parseSmokeChecklist(
  markdown: string,
): Result<ParsedSmokeChecklist, SmokeChecklistParseError> {
  const versionMatch = VERSION_LINE.exec(markdown);
  if (versionMatch === null) return err({ type: "MissingVersion" });

  const seen = new Set<string>();
  const items: SmokeChecklistItem[] = [];
  for (const line of markdown.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("|") || !/^\|\s*S\d{3}\s*\|/.test(trimmed))
      continue;
    const rowMatch = ROW_LINE.exec(trimmed);
    if (rowMatch === null) return err({ type: "MalformedRow", line });
    const [, id, area, check, result] = rowMatch;
    if (
      id === undefined ||
      area === undefined ||
      check === undefined ||
      result === undefined
    ) {
      return err({ type: "MalformedRow", line });
    }
    if (seen.has(id)) return err({ type: "DuplicateItemId", id });
    if (!(SMOKE_CHECKLIST_RESULTS as readonly string[]).includes(result)) {
      return err({ type: "InvalidResult", id, result });
    }
    seen.add(id);
    items.push({ id, area, check, result: result as SmokeChecklistResult });
  }
  if (items.length === 0) return err({ type: "NoItems" });

  return ok({ version: versionMatch[1] ?? "", items });
}

export type SmokeChecklistReadError = {
  type: "SmokeChecklistReadFailed";
  path: string;
};

export interface SmokeChecklistReader {
  read(): ResultAsync<string, SmokeChecklistReadError>;
}

export class BunSmokeChecklistReader implements SmokeChecklistReader {
  constructor(
    private readonly path: string = new URL(
      "./pi-acceptance/smoke-checklist.md",
      import.meta.url,
    ).pathname,
  ) {}

  read(): ResultAsync<string, SmokeChecklistReadError> {
    return ResultAsync.fromPromise(
      Bun.file(this.path).text(),
      (): SmokeChecklistReadError => ({
        type: "SmokeChecklistReadFailed",
        path: this.path,
      }),
    );
  }
}
