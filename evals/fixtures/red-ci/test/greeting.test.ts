import { expect, test } from "bun:test";
import { greeting } from "../src/greeting.ts";

test("greets by name", () => {
  expect(greeting("Ada")).toBe("Welcome back, Ada!");
});
