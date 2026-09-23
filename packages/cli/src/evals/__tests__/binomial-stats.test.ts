/**
 * Unit tests for `binomial-stats.ts`, checked against reference values for
 * Fisher's exact test, the Wilson interval and Holm's adjustment (as R's
 * `fisher.test`, `prop.test`-style Wilson bounds and `p.adjust` give them).
 */

import { describe, expect, it } from "bun:test";
import {
  bestPossibleP,
  fisherExactTwoSided,
  holmAdjust,
  wilsonInterval,
} from "../binomial-stats.js";

describe("fisherExactTwoSided", () => {
  it("matches the reference values on small tables", () => {
    expect(fisherExactTwoSided(3, 1, 1, 3)).toBeCloseTo(0.4857143, 6);
    expect(fisherExactTwoSided(9, 6, 14, 1)).toBeCloseTo(0.08007663, 6);
    expect(fisherExactTwoSided(1, 9, 11, 9)).toBeCloseTo(0.02352999, 6);
  });

  it("gives 1 for identical rows", () => {
    expect(fisherExactTwoSided(3, 2, 3, 2)).toBeCloseTo(1, 10);
  });

  it("gives 1 when a row or a column is empty", () => {
    expect(fisherExactTwoSided(0, 0, 3, 2)).toBe(1);
    expect(fisherExactTwoSided(4, 0, 5, 0)).toBe(1);
    expect(fisherExactTwoSided(0, 4, 0, 5)).toBe(1);
  });

  it("does not depend on which side is the baseline", () => {
    expect(fisherExactTwoSided(2, 8, 7, 3)).toBeCloseTo(
      fisherExactTwoSided(7, 3, 2, 8),
      12,
    );
  });
});

describe("bestPossibleP", () => {
  it("needs four scored attempts a side before any change can show", () => {
    expect(bestPossibleP(2, 2)).toBeCloseTo(1 / 3, 10);
    expect(bestPossibleP(3, 3)).toBeCloseTo(0.1, 10);
    expect(bestPossibleP(4, 4)).toBeCloseTo(2 / 70, 10);
    expect(bestPossibleP(1, 1)).toBe(1);
  });
});

describe("wilsonInterval", () => {
  it("stays inside [0, 1] at 0/n and n/n", () => {
    expect(wilsonInterval(0, 5)?.low).toBe(0);
    expect(wilsonInterval(0, 5)?.high).toBeCloseTo(0.4345, 4);
    expect(wilsonInterval(5, 5)?.low).toBeCloseTo(0.5655, 4);
    expect(wilsonInterval(5, 5)?.high).toBe(1);
  });

  it("matches the Wilson interval for 3/10", () => {
    const interval = wilsonInterval(3, 10);
    expect(interval?.low).toBeCloseTo(0.1078, 4);
    expect(interval?.high).toBeCloseTo(0.6032, 4);
  });

  it("has no interval with no trials", () => {
    expect(wilsonInterval(0, 0)).toBeNull();
  });
});

describe("holmAdjust", () => {
  it("adjusts step-down and returns values in input order", () => {
    const adjusted = holmAdjust([0.01, 0.04, 0.03]);
    expect(adjusted[0]).toBeCloseTo(0.03, 12);
    expect(adjusted[1]).toBeCloseTo(0.06, 12);
    expect(adjusted[2]).toBeCloseTo(0.06, 12);
  });

  it("caps at 1 and leaves a single test unchanged", () => {
    expect(holmAdjust([0.6, 0.7])).toEqual([1, 1]);
    expect(holmAdjust([0.02])).toEqual([0.02]);
    expect(holmAdjust([])).toEqual([]);
  });
});
