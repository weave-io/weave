/**
 * Weave CLI theme tokens and terminal color helpers.
 *
 * Honors `FORCE_COLOR`, `NO_COLOR` (https://no-color.org/), and TTY detection.
 * When color is disabled, all formatting functions return their input
 * unmodified.
 */

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

export interface ThemeManagerDeps {
  env?: Record<string, string | undefined>;
  isTty?: () => boolean;
}

export class ThemeManager {
  private readonly esc = "\x1b[";
  private readonly reset = `${this.esc}0m`;

  constructor(private readonly deps: ThemeManagerDeps = {}) {}

  supportsColor(): boolean {
    const env = this.deps.env ?? Bun.env;
    const forceColor = env.FORCE_COLOR;
    if (forceColor !== undefined) {
      return forceColor !== "" && forceColor !== "0" && forceColor !== "false";
    }

    if (env.NO_COLOR !== undefined) return false;
    return this.isTty();
  }

  getTheme(colorEnabled?: boolean): ThemeColors {
    const enabled = colorEnabled ?? this.supportsColor();
    if (!enabled) return this.disabledTheme();
    return this.enabledTheme();
  }

  private ansi(code: string): (text: string) => string {
    return (text: string) => `${this.esc}${code}m${text}${this.reset}`;
  }

  private identity(text: string): string {
    return text;
  }

  private isTty(): boolean {
    if (this.deps.isTty !== undefined) return this.deps.isTty();
    return Boolean(process.stdout?.isTTY);
  }

  private disabledTheme(): ThemeColors {
    return {
      cyan: this.identity,
      blue: this.identity,
      purple: this.identity,
      magenta: this.identity,
      green: this.identity,
      yellow: this.identity,
      red: this.identity,
      dim: this.identity,
      bold: this.identity,
      boldCyan: this.identity,
      boldPurple: this.identity,
      boldGreen: this.identity,
      boldRed: this.identity,
      boldYellow: this.identity,
    };
  }

  private enabledTheme(): ThemeColors {
    const cyan = this.ansi("36");
    const blue = this.ansi("34");
    const purple = this.ansi("35");
    const magenta = this.ansi("95");
    const green = this.ansi("32");
    const yellow = this.ansi("33");
    const red = this.ansi("31");
    const dim = this.ansi("2");
    const bold = this.ansi("1");

    return {
      cyan,
      blue,
      purple,
      magenta,
      green,
      yellow,
      red,
      dim,
      bold,
      boldCyan: (text: string) => bold(cyan(text)),
      boldPurple: (text: string) => bold(purple(text)),
      boldGreen: (text: string) => bold(green(text)),
      boldRed: (text: string) => bold(red(text)),
      boldYellow: (text: string) => bold(yellow(text)),
    };
  }
}

export const defaultThemeManager = new ThemeManager();
