/**
 * Normalize a file path to use forward slashes on all platforms.
 *
 * Windows `node:path` functions return backslash-separated paths.  Weave
 * normalizes all stored paths to forward slashes so that config output,
 * logs, and test assertions are consistent regardless of the host OS.
 *
 * Forward slashes are valid path separators on Windows (both in Node/Bun
 * and in the Win32 API), so this conversion is safe for downstream
 * consumers that pass the path back to file-system APIs.
 *
 * Edge cases intentionally **not** handled (irrelevant for Weave's
 * config-file paths):
 * - Extended-length paths (`\\?\C:\...`) — require backslashes.
 * - UNC paths (`\\server\share`) — leading `\\` has special meaning.
 * - Device paths (`\\.\COM1`).
 */
export function normalizePath(p: string): string {
  return p.replace(/\\/g, "/");
}
