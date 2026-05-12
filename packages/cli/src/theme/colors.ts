/**
 * Weave CLI theme tokens and terminal color helpers.
 *
 * Honors `NO_COLOR` (https://no-color.org/) and non-TTY detection.
 * When color is disabled, all formatting functions return their input
 * unmodified.
 */

// ---------------------------------------------------------------------------
// Color decision
// ---------------------------------------------------------------------------

/** Returns true when ANSI colors should be applied. */
export function supportsColor(): boolean {
  if (typeof process !== "undefined") {
    if (process.env.NO_COLOR !== undefined) return false;
    if (process.env.FORCE_COLOR !== undefined) return true;
    if (process.stdout && "isTTY" in process.stdout) {
      return !!process.stdout.isTTY;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// ANSI helpers
// ---------------------------------------------------------------------------

const ESC = "\x1b[";
const RESET = `${ESC}0m`;

function ansi(code: string): (text: string) => string {
  return (text: string) => `${ESC}${code}m${text}${RESET}`;
}

// ---------------------------------------------------------------------------
// Weave brand palette
// ---------------------------------------------------------------------------

const _cyan = ansi("36");
const _blue = ansi("34");
const _purple = ansi("35");
const _magenta = ansi("95");
const _green = ansi("32");
const _yellow = ansi("33");
const _red = ansi("31");
const _dim = ansi("2");
const _bold = ansi("1");
const _boldCyan = (t: string) => _bold(_cyan(t));
const _boldPurple = (t: string) => _bold(_purple(t));
const _boldGreen = (t: string) => _bold(_green(t));
const _boldRed = (t: string) => _bold(_red(t));
const _boldYellow = (t: string) => _bold(_yellow(t));

const identity = (t: string) => t;

export interface ThemeColors {
  cyan: (t: string) => string;
  blue: (t: string) => string;
  purple: (t: string) => string;
  magenta: (t: string) => string;
  green: (t: string) => string;
  yellow: (t: string) => string;
  red: (t: string) => string;
  dim: (t: string) => string;
  bold: (t: string) => string;
  boldCyan: (t: string) => string;
  boldPurple: (t: string) => string;
  boldGreen: (t: string) => string;
  boldRed: (t: string) => string;
  boldYellow: (t: string) => string;
}

/** Returns themed color functions or identity pass-throughs. */
export function getTheme(colorEnabled?: boolean): ThemeColors {
  const enabled = colorEnabled ?? supportsColor();
  if (!enabled) {
    return {
      cyan: identity,
      blue: identity,
      purple: identity,
      magenta: identity,
      green: identity,
      yellow: identity,
      red: identity,
      dim: identity,
      bold: identity,
      boldCyan: identity,
      boldPurple: identity,
      boldGreen: identity,
      boldRed: identity,
      boldYellow: identity,
    };
  }
  return {
    cyan: _cyan,
    blue: _blue,
    purple: _purple,
    magenta: _magenta,
    green: _green,
    yellow: _yellow,
    red: _red,
    dim: _dim,
    bold: _bold,
    boldCyan: _boldCyan,
    boldPurple: _boldPurple,
    boldGreen: _boldGreen,
    boldRed: _boldRed,
    boldYellow: _boldYellow,
  };
}
