/**
 * Legacy prompt file loading.
 *
 * Legacy Weave resolved custom agent `prompt_file` values relative to the
 * directory holding the legacy config and trimmed the file contents. Migration
 * reads the same files up front so conversion can carry them over.
 */

import { dirname, isAbsolute, relative, resolve } from "node:path";
import { ResultAsync } from "neverthrow";
import type { FileSystem } from "../fs/file-system.js";
import {
  convertLegacyJsonc,
  listLegacyPromptFileReferences,
} from "./legacy-jsonc-converter.js";
import type {
  ConversionResult,
  LegacyConversionError,
  LegacyPromptFileContents,
} from "./types.js";

function isContained(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path.length > 0 && !path.startsWith("..") && !isAbsolute(path);
}

/**
 * Read one reference, but only when its canonical path (symlinks resolved)
 * stays inside the canonical legacy config directory. A symlink pointing
 * elsewhere would otherwise copy an unrelated file into `.weave/prompts/`
 * and send it to the model as an agent prompt.
 */
async function readContainedPromptFile(
  fs: FileSystem,
  canonicalConfigDir: string,
  path: string,
): Promise<string | undefined> {
  const canonical = await fs.realPath(path);
  if (canonical.isErr() || !isContained(canonicalConfigDir, canonical.value)) {
    return undefined;
  }
  const text = await fs.readText(canonical.value);
  if (text.isErr() || text.value.trim().length === 0) return undefined;
  return text.value.trim();
}

/**
 * Read every safe custom agent `prompt_file` reference relative to the legacy
 * config directory. References that do not exist, cannot be read, or resolve
 * outside the directory are left out; conversion warns about them.
 */
export async function readLegacyPromptFiles(
  fs: FileSystem,
  legacySourcePath: string,
  sourceContent: string,
): Promise<LegacyPromptFileContents> {
  const contents = new Map<string, string>();
  const references = listLegacyPromptFileReferences(sourceContent);
  if (references.length === 0) return contents;

  const configDir = dirname(legacySourcePath);
  const canonicalConfigDir = await fs.realPath(configDir);
  if (canonicalConfigDir.isErr()) return contents;

  for (const reference of references) {
    const text = await readContainedPromptFile(
      fs,
      canonicalConfigDir.value,
      resolve(configDir, reference),
    );
    if (text !== undefined) contents.set(reference, text);
  }
  return contents;
}

/** Convert a legacy source, loading its prompt files from disk first. */
export function convertLegacySource(
  fs: FileSystem,
  legacySourcePath: string,
  sourceContent: string,
): ResultAsync<ConversionResult, LegacyConversionError> {
  return ResultAsync.fromSafePromise(
    readLegacyPromptFiles(fs, legacySourcePath, sourceContent),
  ).andThen((promptFileContents) =>
    convertLegacyJsonc(sourceContent, { promptFileContents }),
  );
}
