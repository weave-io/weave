/**
 * Turns free text into a URL slug: lowercase ASCII letters and digits
 * separated by single dashes.
 */
export function slugify(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9]+/g, "-");
}
