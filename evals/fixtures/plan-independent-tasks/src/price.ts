/** Formats an amount in cents for display, e.g. 1250 -> "$12.50". */
export function formatPrice(cents: number): string {
  return `$${cents / 100}`;
}
