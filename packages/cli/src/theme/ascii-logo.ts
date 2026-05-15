import figlet from "figlet";
import larry3d from "figlet/fonts/Larry 3D";

import type { ThemeColors } from "./colors.js";

const LOGO_TEXT = "WEAVE";
const FIGLET_FONT = "Larry 3D";
const LOGO_LEFT_MARGIN = "  ";
const LOLCAT_SEED = 27;
const LOLCAT_SPREAD = 2;
const LOLCAT_FREQUENCY = 0.1;
const ESC = "\x1b";
const ANSI_RESET_FOREGROUND = `${ESC}[39m`;

figlet.parseFont(FIGLET_FONT, larry3d);

const FIGLET_LOGO = figlet.textSync(LOGO_TEXT, {
  font: FIGLET_FONT,
  horizontalLayout: "default",
  verticalLayout: "default",
  width: 80,
  whitespaceBreak: false,
});

const PLAIN_FIGLET_LINES = FIGLET_LOGO.split("\n");

/** Plain-text logo lines for width measurement or NO_COLOR output. */
export const PLAIN_LOGO_LINES: string[] = PLAIN_FIGLET_LINES.map(
  (line) => `${LOGO_LEFT_MARGIN}${line}`,
);

/** Maximum width of the ASCII logo (for centering calculations). */
export const LOGO_WIDTH = Math.max(...PLAIN_LOGO_LINES.map((l) => l.length));

/**
 * Render the Weave figlet wordmark with a small left margin and a
 * programmatic lolcat-compatible rainbow equivalent to:
 * `figlet -f "larry3d" WEAVE | lolcat -S 27 --spread 2`.
 */
export function renderLogo(theme: ThemeColors): string[] {
  if (!isColorEnabled(theme)) return [...PLAIN_LOGO_LINES];

  return PLAIN_FIGLET_LINES.map(
    (line, lineIndex) =>
      `${LOGO_LEFT_MARGIN}${colorizeLine(line, LOLCAT_SEED + lineIndex)}`,
  );
}

function isColorEnabled(theme: ThemeColors): boolean {
  return theme.cyan("weave") !== "weave";
}

function colorizeLine(line: string, offset: number): string {
  return Array.from(line)
    .map((char, index) => {
      const color = rainbowColor(offset + index / LOLCAT_SPREAD);
      return `${ESC}[38;2;${color.red};${color.green};${color.blue}m${char}${ANSI_RESET_FOREGROUND}`;
    })
    .join("");
}

function rainbowColor(index: number): {
  red: number;
  green: number;
  blue: number;
} {
  return {
    red: rainbowChannel(index, 0),
    green: rainbowChannel(index, (2 * Math.PI) / 3),
    blue: rainbowChannel(index, (4 * Math.PI) / 3),
  };
}

function rainbowChannel(index: number, phase: number): number {
  return Math.trunc(Math.sin(LOLCAT_FREQUENCY * index + phase) * 127 + 128);
}
