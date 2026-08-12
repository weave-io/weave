/**
 * Text normalization and match helpers shared by the overlay controller.
 *
 * These live outside `child-overlay-replay.ts` on purpose: `biome check
 * --write` rewrites that module's `String.raw` control-character pattern into
 * a regex literal and then rejects its own fix, so every commit that touches
 * it fails the pre-commit hook. Keeping the search helpers here leaves that
 * module untouched.
 */
import { boundText } from "./child-overlay-replay.js";
import type { PiChildProviderError } from "./child-provider-error.js";
import { formatPiChildProviderError } from "./child-provider-error-render.js";

/** Bounded entry text with absolute path prefixes removed. */
export function stripPathLike(value: string): string {
  // Drop absolute path prefixes that would leak storage locations.
  return boundText(
    value
      .replace(
        /(?:^|[\s"])(?:\/(?:Users|home|var|tmp|private)\/\S+)/gu,
        " [path]",
      )
      .replace(/(?:[A-Za-z]:\\[^\s"]+)/gu, " [path]"),
  );
}

/**
 * Ids of entries whose rendered text contains the lowercased needle, in the
 * order given. Matching uses the same {@link stripPathLike} normalization the
 * window applies, so a page scanned before it is merged matches exactly what
 * the reader sees afterwards.
 */
export function matchingEntryIds(
  entries: readonly { readonly id: string; readonly text: string }[],
  needle: string,
): string[] {
  const result: string[] = [];
  for (const entry of entries) {
    if (stripPathLike(entry.text).toLowerCase().includes(needle)) {
      result.push(entry.id);
    }
  }
  return result;
}

/** Match the canonical visible terminal error to its transcript entry. */
export function matchingTerminalErrorEntryIds(
  entries: readonly {
    readonly kind: string;
    readonly overlayEntryId?: string;
    readonly terminalError?: PiChildProviderError;
  }[],
  error: PiChildProviderError | undefined,
  needle: string,
): string[] {
  if (
    error === undefined ||
    !formatPiChildProviderError(error).toLowerCase().includes(needle)
  ) {
    return [];
  }
  const entryId = [...entries]
    .reverse()
    .find(
      (entry) =>
        entry.kind === "assistant" && entry.terminalError !== undefined,
    )?.overlayEntryId;
  return entryId === undefined ? [] : [entryId];
}

/** Concatenates two ordered id lists, keeping the first occurrence of each. */
export function mergeMatchIds(
  older: readonly string[],
  newer: readonly string[],
): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const id of [...older, ...newer]) {
    if (seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result;
}
