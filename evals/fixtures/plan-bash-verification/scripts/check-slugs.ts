// Release smoke check: slugs for real page titles. Exits non-zero on a mismatch.
import { slugify } from "../src/slugify.ts";

const titles: Array<[title: string, slug: string]> = [
  ["Release Notes: v2.0", "release-notes-v2-0"],
  ["  Getting Started  ", "getting-started"],
  ["FAQ?", "faq"],
];

let failures = 0;
for (const [title, slug] of titles) {
  const actual = slugify(title);
  if (actual !== slug) {
    failures += 1;
    console.error(`check-slugs: ${JSON.stringify(title)} -> ${JSON.stringify(actual)}, expected ${JSON.stringify(slug)}`);
  }
}

console.log(failures === 0 ? "check-slugs: ok" : `check-slugs: ${failures} mismatches`);
process.exit(failures === 0 ? 0 : 1);
