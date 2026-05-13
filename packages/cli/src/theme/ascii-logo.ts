import type { ThemeColors } from "./colors.js";

type ColorKey = keyof ThemeColors;
type LogoSegment = readonly [text: string, color: ColorKey];
type LogoLine = readonly LogoSegment[];

const LOGO_LINES: LogoLine[] = [
  [
    ["       ╭────────────╮              ", "cyan"],
    ["╭────────────╮              ", "blue"],
    ["╭────────────╮", "magenta"],
  ],
  [
    ["╭──────╯░░░░░░░░░░░░╲            ", "cyan"],
    ["╱▒▒▒▒▒▒▒▒▒▒▒▒╲            ", "blue"],
    ["╱▓▓▓▓▓▓▓▓▓▓▓▓╰──────╮", "magenta"],
  ],
  [
    ["╲░░░░░░░░╭────╮░░░░░░╲          ", "cyan"],
    ["╱▒▒▒╭────╮▒▒▒▒╲          ", "blue"],
    ["╱▓▓▓▓╭────╮▓▓▓▓▓▓▓▓╱", "magenta"],
  ],
  [
    [" ╲░░░░░░╱      ╲░░░░░░╲        ", "cyan"],
    ["╱▒▒▒╱      ╲▒▒▒▒╲        ", "blue"],
    ["╱▓▓▓▓╱      ╲▓▓▓▓▓▓╱ ", "magenta"],
  ],
  [
    ["  ╲░░░╱          ╲░░░░░╲      ", "cyan"],
    ["╱▒▒╱          ╲▒▒▒╲      ", "blue"],
    ["╱▓▓▓╱          ╲▓▓▓╱  ", "magenta"],
  ],
  [
    ["   ╲╱              ╲░░░░╲    ", "cyan"],
    ["╱▒▒╱            ╲▒▒▒╲    ", "blue"],
    ["╱▓▓▓╱              ╲╱   ", "magenta"],
  ],
  [
    ["                    ╲░░░╲  ", "cyan"],
    ["╱▒▒╱              ╲▒▒▒╲  ", "blue"],
    ["╱▓▓▓╱                    ", "magenta"],
  ],
  [
    ["        ╭────────╮   ╲░░░╲╱", "cyan"],
    ["▒▒╱                ╲▒▒▒", "blue"],
    ["╲╱▓▓▓╱   ╭────────╮        ", "magenta"],
  ],
  [
    ["       ╱░░░░░░░░░╲   ╲░░", "cyan"],
    ["▒▒╱                    ╲▒▒", "blue"],
    ["▓▓▓╱   ╱▓▓▓▓▓▓▓▓╲       ", "magenta"],
  ],
  [
    ["      ╱░░╭────╮░░░╲   ╲", "cyan"],
    ["▒▒╱╲                    ╱╲", "blue"],
    ["▓▓╱   ╱▓▓▓╭────╮▓▓╲      ", "magenta"],
  ],
  [
    ["     ╱░░╱      ╲░░░╲ ╱", "cyan"],
    ["▒▒╱  ╲                  ╱  ", "blue"],
    ["╲▓▓╲ ╱▓▓▓╱      ╲▓▓╲     ", "magenta"],
  ],
  [
    ["    ╱░░╱        ╲░░░", "cyan"],
    ["▒▒▒╱    ╲                ╱    ", "blue"],
    ["╲▓▓▓▓▓╱        ╲▓▓╲    ", "magenta"],
  ],
  [
    ["   ╱░░╱          ╲░░", "cyan"],
    ["▒▒╱      ╲              ╱      ╲▒", "blue"],
    ["▓▓╱          ╲▓▓╲   ", "magenta"],
  ],
  [
    ["  ╱░░╱            ╲", "cyan"],
    ["▒▒╱        ╲            ╱        ╲▒", "blue"],
    ["╱            ╲▓▓╲  ", "magenta"],
  ],
  [
    [" ╰──╯              ╰╯          ", "cyan"],
    ["╰──────────╯          ", "blue"],
    ["╰╯              ╰──╯ ", "magenta"],
  ],
  [["", "dim"]],
  [["__        __                         ", "boldCyan"]],
  [["\\ \\      / /__  __ ___   _____       ", "blue"]],
  [[" \\ \\ /\\ / / _ \\/ _` \\ \\ / / _ \\      ", "purple"]],
  [["  \\ V  V /  __/ (_| |\\ V /  __/      ", "magenta"]],
  [["   \\_/\\_/ \\___|\\__,_| \\_/ \\___|      ", "boldPurple"]],
];

/**
 * Render the Weave ASCII logo with theme colors applied.
 * Returns an array of colorized lines.
 */
export function renderLogo(theme: ThemeColors): string[] {
  return LOGO_LINES.map((segments) =>
    segments
      .map(([text, key]) => {
        const colorFn = theme[key] as (t: string) => string;
        return colorFn(text);
      })
      .join(""),
  );
}

/** Plain-text logo lines for width measurement or NO_COLOR output. */
export const PLAIN_LOGO_LINES: string[] = LOGO_LINES.map((segments) =>
  segments.map(([text]) => text).join(""),
);

/** Maximum width of the ASCII logo (for centering calculations). */
export const LOGO_WIDTH = Math.max(...PLAIN_LOGO_LINES.map((l) => l.length));
