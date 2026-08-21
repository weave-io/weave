import { describe, expect, it } from "bun:test";
import type { PiUiThemeFgColor, PiUiThemePort } from "../types.js";
import {
  type Ink,
  makePaint,
  type Paint,
  paintTone,
  plainPaint,
  type Tone,
  toneInk,
} from "../ui-paint.js";

const INKS: readonly Ink[] = [
  "text",
  "acc",
  "alt",
  "frame",
  "dim",
  "muted",
  "ok",
  "warn",
  "bad",
  "rule",
  "think",
  "match",
  "bold",
  "inv",
];

const TONES: readonly Tone[] = ["run", "ok", "warn", "bad", "mute"];

/**
 * SGR escapes only, so a strip is a pure inverse of the paint applied below.
 * Built with `RegExp` because the pattern needs a literal ESC byte, which a
 * regex literal may not carry.
 */
const SGR = new RegExp(`${String.fromCharCode(0x1b)}\\[[0-9;]*m`, "g");

function stripAnsi(text: string): string {
  return text.replace(SGR, "");
}

interface RecordingTheme extends PiUiThemePort {
  readonly fgCalls: PiUiThemeFgColor[];
}

function recordingTheme(options?: {
  readonly inverse?: boolean;
}): RecordingTheme {
  const fgCalls: PiUiThemeFgColor[] = [];
  return {
    fgCalls,
    fg: (color, text) => {
      fgCalls.push(color);
      return `\u001B[31m${text}\u001B[0m`;
    },
    bold: (text) => `\u001B[1m${text}\u001B[0m`,
    ...(options?.inverse === true
      ? { inverse: (text: string) => `\u001B[7m${text}\u001B[0m` }
      : {}),
  };
}

function inkTokens(theme: RecordingTheme, paint: Paint, ink: Ink): string[] {
  theme.fgCalls.length = 0;
  paint[ink]("x");
  return [...theme.fgCalls];
}

describe("ui-paint ink vocabulary", () => {
  it("binds every ink to a callable on a themed paint", () => {
    const paint = makePaint(recordingTheme());
    for (const ink of INKS) {
      expect(typeof paint[ink]).toBe("function");
      expect(stripAnsi(paint[ink]("sample"))).toBe("sample");
    }
  });

  it("binds every ink to identity on the plain paint", () => {
    const paint = plainPaint();
    for (const ink of INKS) {
      expect(paint[ink]("sample")).toBe("sample");
    }
  });

  it("routes each ink to its documented theme token", () => {
    const theme = recordingTheme({ inverse: true });
    const paint = makePaint(theme);
    expect(inkTokens(theme, paint, "text")).toEqual(["text"]);
    expect(inkTokens(theme, paint, "acc")).toEqual(["accent"]);
    expect(inkTokens(theme, paint, "alt")).toEqual(["customMessageLabel"]);
    expect(inkTokens(theme, paint, "frame")).toEqual(["borderAccent"]);
    expect(inkTokens(theme, paint, "dim")).toEqual(["dim"]);
    expect(inkTokens(theme, paint, "muted")).toEqual(["muted"]);
    expect(inkTokens(theme, paint, "ok")).toEqual(["success"]);
    expect(inkTokens(theme, paint, "warn")).toEqual(["warning"]);
    expect(inkTokens(theme, paint, "bad")).toEqual(["error"]);
    expect(inkTokens(theme, paint, "rule")).toEqual(["borderMuted"]);
    expect(inkTokens(theme, paint, "think")).toEqual(["thinkingText"]);
    expect(inkTokens(theme, paint, "match")).toEqual(["searchMatchText"]);
    // Supplied by the host: no `fg()` call at all.
    expect(inkTokens(theme, paint, "bold")).toEqual([]);
    expect(inkTokens(theme, paint, "inv")).toEqual([]);
  });
});

describe("ui-paint degradation", () => {
  it("paints `match` with the searchMatchText token, which Pi degrades to ordinary text itself", () => {
    const theme = recordingTheme();
    const paint = makePaint(theme);
    expect(inkTokens(theme, paint, "match")).toEqual(["searchMatchText"]);
  });

  it("degrades `inv` to bold when the theme has no inverse", () => {
    const paint = makePaint(recordingTheme());
    expect(paint.inv("BADGE")).toBe("\u001B[1mBADGE\u001B[0m");
    expect(paint.inv("BADGE")).toBe(paint.bold("BADGE"));
  });

  it("uses inverse when the theme provides it", () => {
    const paint = makePaint(recordingTheme({ inverse: true }));
    expect(paint.inv("BADGE")).toBe("\u001B[7mBADGE\u001B[0m");
    expect(paint.inv("BADGE")).not.toBe(paint.bold("BADGE"));
  });

  it("degrades without throwing on a minimal port with no optional methods", () => {
    const minimal: PiUiThemePort = {
      fg: (_color, text) => text,
      bold: (text) => text,
    };
    const paint = makePaint(minimal);
    for (const ink of INKS) expect(paint[ink]("x")).toBe("x");
  });
});

describe("ui-paint plain twin", () => {
  it("equals the themed paint with escapes stripped, for every ink", () => {
    const themed = makePaint(recordingTheme({ inverse: true }));
    const plain = plainPaint();
    const samples = [
      "",
      "plain",
      "宽字 CJK",
      "emoji 🚀 tail",
      " · separator · ",
    ];
    for (const ink of INKS) {
      for (const sample of samples) {
        expect(stripAnsi(themed[ink](sample))).toBe(plain[ink](sample));
      }
    }
  });
});

describe("ui-paint tones", () => {
  it("maps each tone to its documented ink", () => {
    expect(toneInk("run")).toBe("acc");
    expect(toneInk("ok")).toBe("ok");
    expect(toneInk("warn")).toBe("warn");
    expect(toneInk("bad")).toBe("bad");
    expect(toneInk("mute")).toBe("muted");
  });

  it("paintTone paints with exactly the ink toneInk names", () => {
    const paint = makePaint(recordingTheme());
    for (const tone of TONES) {
      expect(paintTone(paint, tone, "word")).toBe(paint[toneInk(tone)]("word"));
    }
  });

  it("paintTone is a no-op on the plain paint", () => {
    const paint = plainPaint();
    for (const tone of TONES) {
      expect(paintTone(paint, tone, "word")).toBe("word");
    }
  });
});
