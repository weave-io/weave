import { describe, expect, it } from "bun:test";
import {
  LOGO_WIDTH,
  PLAIN_LOGO_LINES,
  renderLogo,
} from "../theme/ascii-logo.js";
import { getTheme, supportsColor } from "../theme/colors.js";
import {
  getVersion,
  renderBanner,
  renderHelp,
  renderVersion,
} from "../theme/render.js";

describe("theme colors", () => {
  it("returns identity functions when color is disabled", () => {
    const theme = getTheme(false);
    expect(theme.cyan("hello")).toBe("hello");
    expect(theme.bold("world")).toBe("world");
    expect(theme.boldPurple("test")).toBe("test");
  });

  it("returns ANSI-wrapped strings when color is enabled", () => {
    const theme = getTheme(true);
    const result = theme.cyan("hello");
    expect(result).toContain("\x1b[");
    expect(result).toContain("hello");
    expect(result).toContain("\x1b[0m");
  });

  it("bold composites apply both bold and color", () => {
    const theme = getTheme(true);
    const result = theme.boldCyan("test");
    expect(result).toContain("test");
    // Should contain at least two escape sequences (bold + color)
    const ESC = String.fromCharCode(0x1b);
    const escCount = result.split(ESC).length - 1;
    expect(escCount).toBeGreaterThanOrEqual(2);
  });

  it("treats FORCE_COLOR=0 and false as color disabled", () => {
    const originalForceColor = Bun.env.FORCE_COLOR;
    const originalNoColor = Bun.env.NO_COLOR;
    delete Bun.env.NO_COLOR;

    Bun.env.FORCE_COLOR = "0";
    expect(supportsColor()).toBe(false);

    Bun.env.FORCE_COLOR = "false";
    expect(supportsColor()).toBe(false);

    Bun.env.FORCE_COLOR = "1";
    expect(supportsColor()).toBe(true);

    if (originalForceColor === undefined) {
      delete Bun.env.FORCE_COLOR;
    } else {
      Bun.env.FORCE_COLOR = originalForceColor;
    }

    if (originalNoColor === undefined) {
      delete Bun.env.NO_COLOR;
    } else {
      Bun.env.NO_COLOR = originalNoColor;
    }
  });
});

describe("ASCII logo", () => {
  it("has multiple lines", () => {
    expect(PLAIN_LOGO_LINES.length).toBeGreaterThan(3);
  });

  it("LOGO_WIDTH matches the widest line", () => {
    const maxWidth = Math.max(...PLAIN_LOGO_LINES.map((l) => l.length));
    expect(LOGO_WIDTH).toBe(maxWidth);
  });

  it("renderLogo returns same number of lines as PLAIN_LOGO_LINES", () => {
    const theme = getTheme(false);
    const lines = renderLogo(theme);
    expect(lines.length).toBe(PLAIN_LOGO_LINES.length);
  });

  it("renderLogo with color produces ANSI sequences", () => {
    const theme = getTheme(true);
    const lines = renderLogo(theme);
    const allText = lines.join("\n");
    expect(allText).toContain("\x1b[");
  });

  it("renderLogo without color produces plain text", () => {
    const theme = getTheme(false);
    const lines = renderLogo(theme);
    const allText = lines.join("\n");
    expect(allText).not.toContain("\x1b[");
    // Should match the plain lines
    for (let i = 0; i < lines.length; i++) {
      expect(lines[i]).toBe(PLAIN_LOGO_LINES[i]);
    }
  });
});

describe("banner and help rendering", () => {
  it("renderBanner includes logo lines and version", () => {
    const theme = getTheme(false);
    const banner = renderBanner(theme);
    const text = banner.join("\n");
    // Should contain at least some logo character
    expect(text).toContain("╭");
    expect(text).toContain("{weave}");
  });

  it("renderHelp includes banner, commands, and examples", () => {
    const theme = getTheme(false);
    const help = renderHelp(theme);
    const text = help.join("\n");
    expect(text).toContain("USAGE");
    expect(text).toContain("COMMANDS");
    expect(text).toContain("init");
    expect(text).toContain("validate");
    expect(text).toContain("OPTIONS");
    expect(text).toContain("--help");
    expect(text).toContain("--version");
    expect(text).toContain("EXAMPLES");
  });

  it("renderHelp with NO_COLOR produces no ANSI escapes", () => {
    const theme = getTheme(false);
    const help = renderHelp(theme);
    const text = help.join("\n");
    expect(text).not.toContain("\x1b[");
  });

  it("renderHelp with color produces ANSI escapes", () => {
    const theme = getTheme(true);
    const help = renderHelp(theme);
    const text = help.join("\n");
    expect(text).toContain("\x1b[");
  });

  it("getVersion returns a semver-like string", () => {
    const v = getVersion();
    expect(v).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("renderVersion returns the version string", () => {
    const v = renderVersion();
    expect(v).toMatch(/^\d+\.\d+\.\d+/);
    expect(v).toBe(getVersion());
  });
});
