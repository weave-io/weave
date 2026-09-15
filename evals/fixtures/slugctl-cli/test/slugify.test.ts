import { expect, test } from "bun:test";
import { slugify } from "../src/slugify.ts";

test("lowercases and joins words with a dash", () => {
  expect(slugify("Hello, World!")).toBe("hello-world");
});

test("joins words with a custom separator", () => {
  expect(slugify("Hello World", { separator: "_" })).toBe("hello_world");
});
