import { describe, expect, it } from "bun:test";
import {
  MODEL_FALLBACK_DESTINATION_MIN,
  MODEL_FALLBACK_MIN_WIDTH,
  MODEL_FALLBACK_ORIGIN_MIN,
  MODEL_FALLBACK_TITLE_MIN,
  MODEL_FALLBACK_WIDE_MIN,
  modelFallbackEntryRenderer,
  modelFallbackWidthBand,
  renderModelFallbackEvent,
} from "../model-fallback-event-render.js";
import { measureWidth } from "../render-width.js";
import { plainPaint } from "../ui-paint.js";

const RECORD = {
  schemaVersion: 1,
  transitionId: "123e4567-e89b-42d3-a456-426614174000",
  failureClass: "provider_unavailable",
  from: { provider: "openai", id: "gpt-5.6-sol" },
  to: { provider: "anthropic", id: "claude-sonnet-4-5" },
} as const;

const PLAIN = plainPaint();

function visibleLines(width: number): readonly string[] {
  return renderModelFallbackEvent(RECORD, width, PLAIN);
}

describe("model fallback event renderer", () => {
  it("uses the measured width ladder at every boundary", () => {
    expect(modelFallbackWidthBand(MODEL_FALLBACK_WIDE_MIN)).toBe("wide");
    expect(modelFallbackWidthBand(MODEL_FALLBACK_WIDE_MIN - 1)).toBe(
      "secondary-dropped",
    );
    expect(modelFallbackWidthBand(MODEL_FALLBACK_ORIGIN_MIN)).toBe(
      "secondary-dropped",
    );
    expect(modelFallbackWidthBand(MODEL_FALLBACK_ORIGIN_MIN - 1)).toBe(
      "origin-dropped",
    );
    expect(modelFallbackWidthBand(MODEL_FALLBACK_DESTINATION_MIN)).toBe(
      "origin-dropped",
    );
    expect(modelFallbackWidthBand(MODEL_FALLBACK_DESTINATION_MIN - 1)).toBe(
      "fallback-title",
    );
    expect(modelFallbackWidthBand(MODEL_FALLBACK_TITLE_MIN)).toBe(
      "fallback-title",
    );
    expect(modelFallbackWidthBand(MODEL_FALLBACK_TITLE_MIN - 1)).toBe(
      "short-title",
    );
    expect(modelFallbackWidthBand(MODEL_FALLBACK_MIN_WIDTH)).toBe(
      "short-title",
    );
    expect(modelFallbackWidthBand(MODEL_FALLBACK_MIN_WIDTH - 1)).toBe("micro");
  });

  it("keeps the exact wide copy and explicit degradation markers", () => {
    const wide = visibleLines(MODEL_FALLBACK_WIDE_MIN);
    expect(wide).toEqual([
      "▌ MODEL FALLBACK",
      "openai/gpt-5.6-sol → anthropic/claude-sonnet-4-5",
      "provider unavailable · native recovery exhausted · continuing in this session",
    ]);

    const secondaryDropped = visibleLines(MODEL_FALLBACK_WIDE_MIN - 1);
    expect(secondaryDropped[0]).toContain("MODEL FALLBACK");
    expect(secondaryDropped[1]).toContain("openai/gpt-5.6-sol");
    expect(secondaryDropped[2]).toBe("…");

    const originDropped = visibleLines(MODEL_FALLBACK_ORIGIN_MIN - 1);
    expect(originDropped[1]).toContain("→ anthropic/claude-sonnet-4-5");
    expect(originDropped[1]).not.toContain("openai/gpt-5.6-sol");
    expect(originDropped[2]).toBe("…");

    const shortTitle = visibleLines(MODEL_FALLBACK_TITLE_MIN - 1);
    expect(shortTitle[0]).toBe("▌ FALLBACK");
    expect(shortTitle[2]).toBe("…");

    const micro = visibleLines(MODEL_FALLBACK_MIN_WIDTH - 1);
    expect(micro).toHaveLength(3);
    expect(micro[0]).toBe("▌ FALLBA…");
    for (const line of micro) {
      expect(measureWidth(line)).toBeLessThanOrEqual(
        MODEL_FALLBACK_MIN_WIDTH - 1,
      );
    }
  });

  it("renders invalid facts nowhere and exposes one read-only primary descriptor", () => {
    expect(
      renderModelFallbackEvent({ ...RECORD, extra: true }, 100, PLAIN),
    ).toEqual([]);
    expect(modelFallbackEntryRenderer.customType).toBe("weave.model-failover");
    expect(modelFallbackEntryRenderer.readOnly).toBe(true);
    expect(modelFallbackEntryRenderer.render(RECORD, 77, PLAIN)).toEqual(
      visibleLines(77),
    );
  });

  it("keeps every emitted row inside the requested width", () => {
    for (let width = 1; width <= 120; width += 1) {
      for (const line of visibleLines(width)) {
        expect(measureWidth(line)).toBeLessThanOrEqual(width);
      }
    }
  });
});
