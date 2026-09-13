/**
 * Legacy prompt file loading.
 *
 * Legacy Weave resolved custom agent `prompt_file` values relative to the
 * directory holding the legacy config and trimmed the file contents. Migration
 * reads the same files up front so conversion can carry them over.
 */

import { dirname, resolve } from "node:path";
import type { FileSystem } from "../fs/file-system.js";
import {
  convertLegacyJsonc,
  listLegacyPromptFileReferences,
} from "./legacy-jsonc-converter.js";
import type { ConversionResult, LegacyPromptFileContents } from "./types.js";

/**
 * Read every safe custom agent `prompt_file` reference relative to the legacy
 * config directory. References that do not exist or cannot be read are left
 * out; conversion warns about them.
 */
export async function readLegacyPromptFiles(
  fs: FileSystem,
  legacySourcePath: string,
  sourceContent: string,
): Promise<LegacyPromptFileContents> {
  const configDir = dirname(legacySourcePath);
  const contents = new Map<string, string>();
  for (const reference of listLegacyPromptFileReferences(sourceContent)) {
    const text = await fs.readText(resolve(configDir, reference));
    if (text.isOk() && text.value.trim().length > 0) {
      contents.set(reference, text.value.trim());
    }
  }
  return contents;
}

/** Convert a legacy source, loading its prompt files from disk first. */
export async function convertLegacySource(
  fs: FileSystem,
  legacySourcePath: string,
  sourceContent: string,
): Promise<ConversionResult> {
  const promptFileContents = await readLegacyPromptFiles(
    fs,
    legacySourcePath,
    sourceContent,
  );
  return convertLegacyJsonc(sourceContent, { promptFileContents });
}
