const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Whole days from `from` to `to`, both ISO dates (YYYY-MM-DD). */
export function daysBetween(from: string, to: string): number {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  return Math.round((end - start) / MS_PER_DAY) + 1;
}
