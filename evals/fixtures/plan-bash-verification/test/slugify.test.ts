import { expect, test } from "bun:test";
import { slugify } from "../src/slugify.ts";

test("lowercases and joins words with a dash", () => {
  expect(slugify("Hello World")).toBe("hello-world");
});

test("collapses runs of separators", () => {
  expect(slugify("one, two & three")).toBe("one-two-three");
});
