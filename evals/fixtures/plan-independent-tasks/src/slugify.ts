/** Turns a title into a URL slug, e.g. "Hello World" -> "hello-world". */
export function slugify(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-");
}
