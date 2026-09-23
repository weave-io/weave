import { expect, test } from "bun:test";
import { formatPrice } from "../src/price.ts";
import { slugify } from "../src/slugify.ts";

test("slugify lowercases and joins words with a dash", () => {
  expect(slugify("Hello World")).toBe("hello-world");
});

test("formatPrice shows a dollar sign", () => {
  expect(formatPrice(1250).startsWith("$")).toBe(true);
});
