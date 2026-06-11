import { describe, expect, it } from "bun:test";
import {
  LOGO_WIDTH,
  PLAIN_LOGO_LINES,
  renderLogo,
} from "../theme/ascii-logo.js";
import { ThemeManager } from "../theme/colors.js";
import { ThemeRenderer } from "../theme/render.js";

const themeManager = new ThemeManager({ isTty: () => false });
const themeRenderer = new ThemeRenderer();

describe("theme colors", () => {
  it("returns identity functions when color is disabled", () => {
    const theme = themeManager.getTheme(false);
    expect(theme.cyan("hello")).toBe("hello");
    expect(theme.bold("world")).toBe("world");
    expect(theme.boldPurple("test")).toBe("test");
  });

  it("returns ANSI-wrapped strings when color is enabled", () => {
    const theme = themeManager.getTheme(true);
    const result = theme.cyan("hello");
    expect(result).toContain("\x1b[");
    expect(result).toContain("hello");
    expect(result).toContain("\x1b[0m");
  });

  it("bold composites apply both bold and color", () => {
    const theme = themeManager.getTheme(true);
    const result = theme.boldCyan("test");
    expect(result).toContain("test");
    const ESC = String.fromCharCode(0x1b);
    const escCount = result.split(ESC).length - 1;
    expect(escCount).toBeGreaterThanOrEqual(2);
  });

  it("treats FORCE_COLOR false values as color disabled", () => {
    expect(
      new ThemeManager({
        env: { FORCE_COLOR: "0" },
        isTty: () => true,
      }).supportsColor(),
    ).toBe(false);
    expect(
      new ThemeManager({
        env: { FORCE_COLOR: "false" },
        isTty: () => true,
      }).supportsColor(),
    ).toBe(false);
  });

  it("lets FORCE_COLOR override NO_COLOR", () => {
    expect(
      new ThemeManager({
        env: { FORCE_COLOR: "1", NO_COLOR: "1" },
        isTty: () => false,
      }).supportsColor(),
    ).toBe(true);
  });

  it("falls back to TTY detection when color env vars are unset", () => {
    expect(
      new ThemeManager({ env: {}, isTty: () => true }).supportsColor(),
    ).toBe(true);
    expect(
      new ThemeManager({ env: {}, isTty: () => false }).supportsColor(),
    ).toBe(false);
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
    const theme = themeManager.getTheme(false);
    const lines = renderLogo(theme);
    expect(lines.length).toBe(PLAIN_LOGO_LINES.length);
  });

  it("renderLogo with color produces ANSI sequences", () => {
    const theme = themeManager.getTheme(true);
    const lines = renderLogo(theme);
    const allText = lines.join("\n");
    expect(allText).toContain("\x1b[");
  });

  it("renderLogo without color produces plain text", () => {
    const theme = themeManager.getTheme(false);
    const lines = renderLogo(theme);
    const allText = lines.join("\n");
    expect(allText).toContain("____");
    expect(allText).not.toContain("⣿");
    expect(allText).not.toContain("\x1b[");
    for (let i = 0; i < lines.length; i++) {
      expect(lines[i]).toBe(PLAIN_LOGO_LINES[i]);
    }
  });

  it("renderLogo with color keeps the figlet mark and does not toggle cursor", () => {
    const theme = themeManager.getTheme(true);
    const allText = renderLogo(theme).join("\n");
    expect(allText).toContain("\x1b[38;2;");
    expect(allText).not.toContain("⣿");
    expect(allText).not.toContain("\x1b[?25l");
    expect(allText).not.toContain("\x1b[?25h");
  });
});

describe("banner and help rendering", () => {
  it("renderBanner includes logo lines and version", () => {
    const theme = themeManager.getTheme(false);
    const banner = themeRenderer.renderBanner(theme);
    const text = banner.join("\n");
    expect(text).toContain("____");
    expect(text).toContain("{weave}");
  });

  it("renderHelp includes banner, commands, and examples", () => {
    const theme = themeManager.getTheme(false);
    const help = themeRenderer.renderHelp(theme);
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

  it("renderHelp includes prompt self-modify in commands", () => {
    const theme = themeManager.getTheme(false);
    const help = themeRenderer.renderHelp(theme);
    const text = help.join("\n");
    expect(text).toContain("prompt self-modify");
  });

  it("renderHelp with NO_COLOR produces no ANSI escapes", () => {
    const theme = themeManager.getTheme(false);
    const help = themeRenderer.renderHelp(theme);
    const text = help.join("\n");
    expect(text).not.toContain("\x1b[");
  });

  it("renderHelp with color produces ANSI escapes", () => {
    const theme = themeManager.getTheme(true);
    const help = themeRenderer.renderHelp(theme);
    const text = help.join("\n");
    expect(text).toContain("\x1b[");
  });

  it("renderVersion returns a semver-like string", () => {
    const v = themeRenderer.renderVersion();
    expect(v).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("uses the injected version source", () => {
    const renderer = new ThemeRenderer({ version: "9.8.7" });
    expect(renderer.renderVersion()).toBe("9.8.7");
  });
});
