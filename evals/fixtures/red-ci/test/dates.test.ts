import { expect, test } from "bun:test";
import { daysBetween } from "../src/dates.ts";

test("counts the days across a month", () => {
  expect(daysBetween("2026-01-01", "2026-01-31")).toBe(30);
});

test("is zero for the same day", () => {
  expect(daysBetween("2026-03-14", "2026-03-14")).toBe(0);
});
