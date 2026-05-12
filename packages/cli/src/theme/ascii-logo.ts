/**
 * Checked-in ASCII art derived from the Weave logo.
 *
 * The logo represents interlaced strands forming a "W" shape,
 * reflecting the woven/interlaced brand identity. Color-capable
 * terminals render it with gradient-style cyan → blue → purple → magenta.
 *
 * @see https://tryweave.io/assets/weave_logo.png (design reference only)
 */

import type { ThemeColors } from "./colors.js";

// ---------------------------------------------------------------------------
// Raw ASCII lines — each line is a tuple of [text, colorFn-key]
// ---------------------------------------------------------------------------

type ColorKey = keyof ThemeColors;

const LOGO_LINES: [string, ColorKey][] = [
  ["   ╭─╮         ╭─╮   ", "cyan"],
  ["  ╭╯ ╰╮  ╭─╮ ╭╯ ╰╮  ", "cyan"],
  ["  ╰╮ ╭╰──╯ ╰─╯╮ ╭╯  ", "blue"],
  ["   ╰╮╰╮  ╭─╮ ╭╯╭╯   ", "blue"],
  ["    ╰╮╰──╯ ╰─╯╭╯    ", "purple"],
  ["     ╰╮ ╭─╮  ╭╯     ", "purple"],
  ["      ╰─╯ ╰──╯      ", "magenta"],
];

/**
 * Render the Weave ASCII logo with theme colors applied.
 * Returns an array of colorized lines.
 */
export function renderLogo(theme: ThemeColors): string[] {
  return LOGO_LINES.map(([line, key]) => {
    const colorFn = theme[key] as (t: string) => string;
    return colorFn(line);
  });
}

/** Plain-text logo lines for width measurement or NO_COLOR output. */
export const PLAIN_LOGO_LINES: string[] = LOGO_LINES.map(([line]) => line);

/** Maximum width of the ASCII logo (for centering calculations). */
export const LOGO_WIDTH = Math.max(...PLAIN_LOGO_LINES.map((l) => l.length));
