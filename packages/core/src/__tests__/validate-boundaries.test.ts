import { describe, expect, it } from "bun:test";
import { tokenize } from "../lexer.js";
import { parse } from "../parser.js";
import { validate } from "../validate.js";

describe("validate — output setter boundary", () => {
  it("rejects AST schema materialization before a throwing type setter runs", () => {
    const previous = Object.getOwnPropertyDescriptor(Object.prototype, "type");
    let setterExecutions = 0;
    try {
      Object.defineProperty(Object.prototype, "type", {
        configurable: true,
        set() {
          setterExecutions += 1;
          throw new Error("AST type setter must not run");
        },
      });

      const lexed = tokenize("agent helper {}");
      expect(lexed.isOk()).toBe(true);
      if (lexed.isErr()) return;
      const parsed = parse(lexed.value);
      expect(parsed.isOk()).toBe(true);
      if (parsed.isErr()) return;

      let result: ReturnType<typeof validate> | undefined;
      expect(() => {
        result = validate(parsed.value);
      }).not.toThrow();
      expect(result?.isErr()).toBe(true);
      expect(setterExecutions).toBe(0);
      if (result?.isErr()) {
        expect(result.error.length).toBeGreaterThan(0);
        expect(
          result.error.every((error) => error.type === "ValidationError"),
        ).toBe(true);
      }
    } finally {
      if (previous === undefined)
        Reflect.deleteProperty(Object.prototype, "type");
      else Object.defineProperty(Object.prototype, "type", previous);
    }
  });

  it("rejects AST schema materialization before an inherited non-writable type can swallow it", () => {
    const previous = Object.getOwnPropertyDescriptor(Object.prototype, "type");
    try {
      Object.defineProperty(Object.prototype, "type", {
        configurable: true,
        value: "inherited",
        writable: false,
      });

      const lexed = tokenize("agent helper {}");
      expect(lexed.isOk()).toBe(true);
      if (lexed.isErr()) return;
      const parsed = parse(lexed.value);
      expect(parsed.isOk()).toBe(true);
      if (parsed.isErr()) return;

      let result: ReturnType<typeof validate> | undefined;
      expect(() => {
        result = validate(parsed.value);
      }).not.toThrow();
      expect(result?.isErr()).toBe(true);
      if (result?.isErr()) {
        expect(result.error.length).toBeGreaterThan(0);
        expect(
          result.error.every((error) => error.type === "ValidationError"),
        ).toBe(true);
      }
    } finally {
      if (previous === undefined)
        Reflect.deleteProperty(Object.prototype, "type");
      else Object.defineProperty(Object.prototype, "type", previous);
    }
  });

  it("preserves category descriptions or fails closed without invoking an inherited setter", () => {
    const previous = Object.getOwnPropertyDescriptor(
      Object.prototype,
      "description",
    );
    let setterExecutions = 0;
    try {
      Object.defineProperty(Object.prototype, "description", {
        configurable: true,
        set() {
          setterExecutions += 1;
        },
      });

      const lexed = tokenize('category helper { description "Helper" }');
      expect(lexed.isOk()).toBe(true);
      if (lexed.isErr()) return;
      const parsed = parse(lexed.value);
      expect(parsed.isOk()).toBe(true);
      if (parsed.isErr()) return;

      const result = validate(parsed.value);
      expect(setterExecutions).toBe(0);
      if (result.isOk()) {
        expect(result.value.categories.helper?.description).toBe("Helper");
      } else {
        expect(result.error.length).toBeGreaterThan(0);
        expect(
          result.error.every((error) => error.type === "ValidationError"),
        ).toBe(true);
      }
    } finally {
      if (previous === undefined)
        Reflect.deleteProperty(Object.prototype, "description");
      else Object.defineProperty(Object.prototype, "description", previous);
    }
  });
});
