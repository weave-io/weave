export interface SlugifyOptions {
  /** String placed between words. Defaults to "-". */
  separator?: string;
}

/**
 * Turns free text into a URL slug: lowercase ASCII letters and digits
 * joined by the separator, never starting or ending with it.
 */
export function slugify(input: string, options: SlugifyOptions = {}): string {
  const separator = options.separator ?? "-";
  return input
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 0)
    .join(separator);
}
