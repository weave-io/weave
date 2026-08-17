import { describe, expect, it } from "bun:test";
import { ADAPTER_PREFERENCE_VALUE_MAX_BYTES } from "@weaveio/weave-engine";
import {
  CHILD_EXTENSION_SELECTION_KEY,
  CHILD_EXTENSION_SELECTION_MODES,
  CHILD_EXTENSION_SELECTION_SCHEMA_VERSION,
  ChildExtensionSelectionEntrySchema,
  type ChildExtensionSelectionRecord,
  ChildExtensionSelectionRecordSchema,
  childExtensionEntryId,
  DEFAULT_CHILD_EXTENSION_SELECTION,
  decodeChildExtensionSelection,
  encodeChildExtensionSelection,
  isSafeChildExtensionPath,
  MAX_CHILD_EXTENSION_ENTRIES,
  MAX_CHILD_EXTENSION_FIELD_BYTES,
  MAX_CHILD_EXTENSION_SELECTION_VALUE_BYTES,
  PI_PREFERENCE_NAMESPACE,
  resolveChildExtensionPlan,
} from "../child-extension-selection.js";

const WEAVE = {
  id: "npm:@weaveio/weave-adapter-pi",
  path: "/opt/pi/extensions/weave-adapter-pi/dist/extension.js",
} as const;

function entry(id: string, path: string, label = id) {
  return { id, source: id, path, label };
}

function record(
  mode: "inherit-all" | "explicit",
  entries: ReturnType<typeof entry>[] = [],
): ChildExtensionSelectionRecord {
  return {
    schemaVersion: CHILD_EXTENSION_SELECTION_SCHEMA_VERSION,
    mode,
    entries,
  };
}

describe("child-extension-selection constants", () => {
  it("pins the adapter-owned namespace and key", () => {
    expect(PI_PREFERENCE_NAMESPACE).toBe("adapter-pi");
    expect(CHILD_EXTENSION_SELECTION_KEY).toBe("child-extensions");
    expect(CHILD_EXTENSION_SELECTION_SCHEMA_VERSION).toBe(1);
    expect(CHILD_EXTENSION_SELECTION_MODES).toEqual([
      "inherit-all",
      "explicit",
    ]);
  });

  it("keeps the value bound aligned with the engine repository", () => {
    expect(MAX_CHILD_EXTENSION_SELECTION_VALUE_BYTES).toBe(
      ADAPTER_PREFERENCE_VALUE_MAX_BYTES,
    );
  });

  it("defaults to inherit-all with no entries", () => {
    expect(DEFAULT_CHILD_EXTENSION_SELECTION).toEqual({
      schemaVersion: 1,
      mode: "inherit-all",
      entries: [],
    });
  });
});

describe("isSafeChildExtensionPath", () => {
  it("accepts a bounded absolute path", () => {
    expect(isSafeChildExtensionPath("/opt/pi/ext/a.js")).toBe(true);
  });

  it("rejects relative, traversal, NUL, control, and backslash paths", () => {
    expect(isSafeChildExtensionPath("")).toBe(false);
    expect(isSafeChildExtensionPath("relative/a.js")).toBe(false);
    expect(isSafeChildExtensionPath("./a.js")).toBe(false);
    expect(isSafeChildExtensionPath("/opt/../etc/a.js")).toBe(false);
    expect(isSafeChildExtensionPath("/opt/./a.js")).toBe(false);
    expect(isSafeChildExtensionPath("/opt/a\0.js")).toBe(false);
    expect(isSafeChildExtensionPath("/opt/a\nb.js")).toBe(false);
    expect(isSafeChildExtensionPath("C:\\pi\\a.js")).toBe(false);
  });

  it("bounds the path by UTF-8 bytes, not code units", () => {
    // "é" is two UTF-8 bytes, so 300 of them exceed the 512-byte bound while
    // the string is only 300 UTF-16 code units long.
    const multibyte = `/opt/${"é".repeat(300)}.js`;
    expect(multibyte.length).toBeLessThan(MAX_CHILD_EXTENSION_FIELD_BYTES);
    expect(isSafeChildExtensionPath(multibyte)).toBe(false);
    expect(isSafeChildExtensionPath(`/opt/${"é".repeat(200)}.js`)).toBe(true);
  });
});

describe("ChildExtensionSelectionEntrySchema", () => {
  it("accepts a well-formed entry", () => {
    const parsed = ChildExtensionSelectionEntrySchema.safeParse(
      entry("npm:pi-vim", "/opt/pi/pkgs/pi-vim/dist/extension.js", "pi-vim"),
    );
    expect(parsed.success).toBe(true);
  });

  it("rejects unknown keys", () => {
    const parsed = ChildExtensionSelectionEntrySchema.safeParse({
      ...entry("npm:pi-vim", "/opt/a.js"),
      extra: 1,
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects empty, control-bearing, and oversized fields", () => {
    const base = entry("npm:pi-vim", "/opt/a.js");
    for (const field of ["id", "source", "label"] as const) {
      expect(
        ChildExtensionSelectionEntrySchema.safeParse({ ...base, [field]: "" })
          .success,
      ).toBe(false);
      expect(
        ChildExtensionSelectionEntrySchema.safeParse({
          ...base,
          [field]: "bad\0value",
        }).success,
      ).toBe(false);
      expect(
        ChildExtensionSelectionEntrySchema.safeParse({
          ...base,
          [field]: "bad\u001bvalue",
        }).success,
      ).toBe(false);
      expect(
        ChildExtensionSelectionEntrySchema.safeParse({
          ...base,
          [field]: "a".repeat(MAX_CHILD_EXTENSION_FIELD_BYTES + 1),
        }).success,
      ).toBe(false);
    }
  });

  it("bounds text fields by UTF-8 bytes", () => {
    const base = entry("npm:pi-vim", "/opt/a.js");
    const multibyte = "é".repeat(MAX_CHILD_EXTENSION_FIELD_BYTES / 2 + 1);
    expect(multibyte.length).toBeLessThanOrEqual(
      MAX_CHILD_EXTENSION_FIELD_BYTES,
    );
    expect(
      ChildExtensionSelectionEntrySchema.safeParse({
        ...base,
        label: multibyte,
      }).success,
    ).toBe(false);
    expect(
      ChildExtensionSelectionEntrySchema.safeParse({
        ...base,
        label: "é".repeat(MAX_CHILD_EXTENSION_FIELD_BYTES / 2),
      }).success,
    ).toBe(true);
  });

  it("rejects a relative or unsafe path", () => {
    expect(
      ChildExtensionSelectionEntrySchema.safeParse(
        entry("npm:pi-vim", "pkgs/pi-vim/extension.js"),
      ).success,
    ).toBe(false);
    expect(
      ChildExtensionSelectionEntrySchema.safeParse(
        entry("npm:pi-vim", "/opt/../etc/passwd"),
      ).success,
    ).toBe(false);
  });
});

describe("ChildExtensionSelectionRecordSchema", () => {
  it("accepts both modes", () => {
    expect(
      ChildExtensionSelectionRecordSchema.safeParse(record("inherit-all"))
        .success,
    ).toBe(true);
    expect(
      ChildExtensionSelectionRecordSchema.safeParse(
        record("explicit", [entry("npm:pi-vim", "/opt/a.js")]),
      ).success,
    ).toBe(true);
  });

  it("rejects unknown modes, unknown keys, and other schema versions", () => {
    expect(
      ChildExtensionSelectionRecordSchema.safeParse({
        schemaVersion: 1,
        mode: "everything",
        entries: [],
      }).success,
    ).toBe(false);
    expect(
      ChildExtensionSelectionRecordSchema.safeParse({
        ...record("inherit-all"),
        extra: true,
      }).success,
    ).toBe(false);
    expect(
      ChildExtensionSelectionRecordSchema.safeParse({
        schemaVersion: 2,
        mode: "explicit",
        entries: [],
      }).success,
    ).toBe(false);
  });

  it("caps the entry count", () => {
    const build = (count: number) =>
      Array.from({ length: count }, (_, index) =>
        entry(`/opt/e${index}.js`, `/opt/e${index}.js`),
      );
    expect(
      ChildExtensionSelectionRecordSchema.safeParse(
        record("explicit", build(MAX_CHILD_EXTENSION_ENTRIES)),
      ).success,
    ).toBe(true);
    expect(
      ChildExtensionSelectionRecordSchema.safeParse(
        record("explicit", build(MAX_CHILD_EXTENSION_ENTRIES + 1)),
      ).success,
    ).toBe(false);
  });
});

describe("childExtensionEntryId", () => {
  it("uses the configured source for package-origin extensions", () => {
    const id = childExtensionEntryId({
      origin: "package",
      source: "npm:pi-vim",
      path: "/tmp/install-a/pi-vim/dist/extension.js",
    });
    expect(id.isOk() && id.value).toBe("npm:pi-vim");
  });

  it("uses the absolute resolved path for non-package extensions", () => {
    const id = childExtensionEntryId({
      origin: "top-level",
      source: "local",
      path: "/home/u/.pi/agent/extensions/learn.ts",
    });
    expect(id.isOk() && id.value).toBe("/home/u/.pi/agent/extensions/learn.ts");
  });

  it("rejects an unusable package source", () => {
    const id = childExtensionEntryId({
      origin: "package",
      source: "",
      path: "/opt/a.js",
    });
    expect(id.isErr() && id.error.reason).toBe("package-source-unusable");
  });

  it("rejects an unsafe non-package path", () => {
    const id = childExtensionEntryId({
      origin: "top-level",
      source: "local",
      path: "relative/a.js",
    });
    expect(id.isErr() && id.error.reason).toBe("path-unsafe");
  });
});

describe("decodeChildExtensionSelection", () => {
  it("returns the inherit-all default with no diagnostic when absent", () => {
    for (const stored of [undefined, null, ""]) {
      const decoded = decodeChildExtensionSelection(stored);
      expect(decoded.record).toEqual(DEFAULT_CHILD_EXTENSION_SELECTION);
      expect(decoded.diagnostic).toBeUndefined();
    }
  });

  it("round-trips an encoded record", () => {
    const original = record("explicit", [
      entry("npm:pi-vim", "/opt/pi/pkgs/pi-vim/dist/extension.js", "pi-vim"),
    ]);
    const encoded = encodeChildExtensionSelection(original);
    expect(encoded.isOk()).toBe(true);
    const decoded = decodeChildExtensionSelection(encoded._unsafeUnwrap());
    expect(decoded.diagnostic).toBeUndefined();
    expect(decoded.record).toEqual(original);
  });

  it("degrades malformed JSON to inherit-all with a bounded diagnostic", () => {
    const decoded = decodeChildExtensionSelection("{not json");
    expect(decoded.record).toEqual(DEFAULT_CHILD_EXTENSION_SELECTION);
    expect(decoded.diagnostic?.reason).toBe("invalid-json");
    expect(decoded.diagnostic?.detail.length).toBeLessThanOrEqual(160);
  });

  it("degrades an unknown schema version and names it", () => {
    const decoded = decodeChildExtensionSelection(
      JSON.stringify({ schemaVersion: 7, mode: "explicit", entries: [] }),
    );
    expect(decoded.record).toEqual(DEFAULT_CHILD_EXTENSION_SELECTION);
    expect(decoded.diagnostic?.reason).toBe("unsupported-schema-version");
    expect(decoded.diagnostic?.detail).toBe("schemaVersion 7");
  });

  it("degrades a structurally invalid record with a field-path detail", () => {
    const decoded = decodeChildExtensionSelection(
      JSON.stringify({
        schemaVersion: 1,
        mode: "explicit",
        entries: [{ id: "a", source: "a", path: "relative.js", label: "a" }],
      }),
    );
    expect(decoded.record).toEqual(DEFAULT_CHILD_EXTENSION_SELECTION);
    expect(decoded.diagnostic?.reason).toBe("invalid-record");
    expect(decoded.diagnostic?.detail).toContain("entries.0.path");
  });

  it("does not treat a prototype-polluting payload as versioned", () => {
    const decoded = decodeChildExtensionSelection(
      '{"__proto__":{"schemaVersion":1},"mode":"explicit"}',
    );
    expect(decoded.record).toEqual(DEFAULT_CHILD_EXTENSION_SELECTION);
    expect(decoded.diagnostic?.reason).toBe("invalid-record");
  });

  it("rejects an oversized stored value before parsing it", () => {
    const oversized = `"${"a".repeat(MAX_CHILD_EXTENSION_SELECTION_VALUE_BYTES)}"`;
    const decoded = decodeChildExtensionSelection(oversized);
    expect(decoded.record).toEqual(DEFAULT_CHILD_EXTENSION_SELECTION);
    expect(decoded.diagnostic?.reason).toBe("value-too-large");
  });

  it("rejects a JSON scalar or array payload", () => {
    for (const stored of ["4", '"explicit"', "[]", "null"]) {
      const decoded = decodeChildExtensionSelection(stored);
      expect(decoded.record).toEqual(DEFAULT_CHILD_EXTENSION_SELECTION);
      expect(decoded.diagnostic?.reason).toBe("invalid-record");
    }
  });
});

describe("encodeChildExtensionSelection", () => {
  it("rejects an invalid record", () => {
    const encoded = encodeChildExtensionSelection({
      schemaVersion: 1,
      mode: "explicit",
    });
    expect(encoded.isErr()).toBe(true);
    expect(encoded._unsafeUnwrapErr().reason).toBe("invalid-record");
  });

  it("rejects a valid record that exceeds the storage budget", () => {
    const entries = Array.from(
      { length: MAX_CHILD_EXTENSION_ENTRIES },
      (_, i) =>
        entry(
          `npm:${"p".repeat(400)}${i}`,
          `/opt/${"q".repeat(400)}${i}.js`,
          "x".repeat(400),
        ),
    );
    const encoded = encodeChildExtensionSelection(record("explicit", entries));
    expect(encoded.isErr()).toBe(true);
    const error = encoded._unsafeUnwrapErr();
    expect(error.reason).toBe("value-too-large");
    expect(
      error.reason === "value-too-large" ? error.byteLength : 0,
    ).toBeGreaterThan(MAX_CHILD_EXTENSION_SELECTION_VALUE_BYTES);
  });
});

describe("resolveChildExtensionPlan", () => {
  it("inherits everything when no record is stored", () => {
    const plan = resolveChildExtensionPlan({
      inventory: [{ id: "npm:pi-vim", path: "/opt/a.js" }],
      weaveEntry: WEAVE,
    });
    expect(plan.mode).toBe("inherit-all");
    expect(plan.paths).toEqual([]);
    expect(plan.diagnostics).toEqual([]);
  });

  it("inherits everything for an explicit inherit-all record", () => {
    const plan = resolveChildExtensionPlan({
      record: record("inherit-all", [entry("npm:pi-vim", "/opt/a.js")]),
      inventory: [{ id: "npm:pi-vim", path: "/opt/a.js" }],
      weaveEntry: WEAVE,
    });
    expect(plan.mode).toBe("inherit-all");
    expect(plan.paths).toEqual([]);
  });

  it("inherits everything after a malformed record decode", () => {
    const decoded = decodeChildExtensionSelection("{oops");
    const plan = resolveChildExtensionPlan({
      record: decoded.record,
      inventory: [],
      weaveEntry: WEAVE,
    });
    expect(plan.mode).toBe("inherit-all");
    expect(plan.paths).toEqual([]);
  });

  it("puts Weave first and keeps selection order for available entries", () => {
    const plan = resolveChildExtensionPlan({
      record: record("explicit", [
        entry("npm:pi-vim", "/opt/vim.js"),
        entry("/home/u/.pi/agent/extensions/learn.ts", "/home/u/x.ts"),
      ]),
      inventory: [
        { id: "npm:pi-vim", path: "/opt/vim.js" },
        {
          id: "/home/u/.pi/agent/extensions/learn.ts",
          path: "/home/u/.pi/agent/extensions/learn.ts",
        },
      ],
      weaveEntry: WEAVE,
    });
    expect(plan.mode).toBe("explicit");
    expect(plan.paths).toEqual([
      WEAVE.path,
      "/opt/vim.js",
      "/home/u/.pi/agent/extensions/learn.ts",
    ]);
    expect(plan.diagnostics).toEqual([]);
  });

  it("prefers the live inventory path over a stale stored path", () => {
    const plan = resolveChildExtensionPlan({
      record: record("explicit", [
        entry("npm:pi-vim", "/tmp/old-install/pi-vim/extension.js"),
      ]),
      inventory: [{ id: "npm:pi-vim", path: "/opt/new-install/extension.js" }],
      weaveEntry: WEAVE,
    });
    expect(plan.paths).toEqual([WEAVE.path, "/opt/new-install/extension.js"]);
  });

  it("drops entries missing from the inventory and reports them", () => {
    const plan = resolveChildExtensionPlan({
      record: record("explicit", [
        entry("npm:pi-vim", "/opt/vim.js"),
        entry("npm:pi-gone", "/opt/gone.js"),
      ]),
      inventory: [{ id: "npm:pi-vim", path: "/opt/vim.js" }],
      weaveEntry: WEAVE,
    });
    expect(plan.mode).toBe("explicit");
    expect(plan.paths).toEqual([WEAVE.path, "/opt/vim.js"]);
    expect(plan.diagnostics).toEqual([
      { reason: "entry-dropped", id: "npm:pi-gone", cause: "missing" },
    ]);
  });

  it("drops entries the inventory marks unavailable or unsafe", () => {
    const plan = resolveChildExtensionPlan({
      record: record("explicit", [
        entry("npm:pi-off", "/opt/off.js"),
        entry("npm:pi-bad", "/opt/bad.js"),
      ]),
      inventory: [
        { id: "npm:pi-off", path: "/opt/off.js", available: false },
        { id: "npm:pi-bad", path: "relative/bad.js" },
      ],
      weaveEntry: WEAVE,
    });
    expect(plan.paths).toEqual([WEAVE.path]);
    expect(plan.diagnostics).toEqual([
      { reason: "entry-dropped", id: "npm:pi-off", cause: "unavailable" },
      { reason: "entry-dropped", id: "npm:pi-bad", cause: "path-unsafe" },
    ]);
  });

  it("stays explicit and Weave-only when every entry disappeared", () => {
    const plan = resolveChildExtensionPlan({
      record: record("explicit", [
        entry("npm:pi-gone", "/opt/gone.js"),
        entry("npm:pi-also-gone", "/opt/also.js"),
      ]),
      inventory: [],
      weaveEntry: WEAVE,
    });
    expect(plan.mode).toBe("explicit");
    expect(plan.paths).toEqual([WEAVE.path]);
    expect(plan.diagnostics).toHaveLength(2);
  });

  it("stays explicit and Weave-only for an empty explicit record", () => {
    const plan = resolveChildExtensionPlan({
      record: record("explicit"),
      inventory: [{ id: "npm:pi-vim", path: "/opt/vim.js" }],
      weaveEntry: WEAVE,
    });
    expect(plan.mode).toBe("explicit");
    expect(plan.paths).toEqual([WEAVE.path]);
  });

  it("never duplicates Weave, by id or by path", () => {
    const plan = resolveChildExtensionPlan({
      record: record("explicit", [
        entry(WEAVE.id, WEAVE.path, "weave"),
        entry("/other/weave.js", WEAVE.path, "weave copy"),
        entry("npm:pi-vim", "/opt/vim.js"),
      ]),
      inventory: [
        { id: WEAVE.id, path: WEAVE.path },
        { id: "/other/weave.js", path: WEAVE.path },
        { id: "npm:pi-vim", path: "/opt/vim.js" },
      ],
      weaveEntry: WEAVE,
    });
    expect(plan.paths).toEqual([WEAVE.path, "/opt/vim.js"]);
    expect(plan.paths.filter((path) => path === WEAVE.path)).toHaveLength(1);
    expect(plan.diagnostics).toEqual([
      { reason: "entry-duplicate", id: WEAVE.id },
      { reason: "entry-duplicate", id: "/other/weave.js" },
    ]);
  });

  it("deduplicates repeated stored ids", () => {
    const plan = resolveChildExtensionPlan({
      record: record("explicit", [
        entry("npm:pi-vim", "/opt/vim.js"),
        entry("npm:pi-vim", "/opt/vim.js"),
      ]),
      inventory: [{ id: "npm:pi-vim", path: "/opt/vim.js" }],
      weaveEntry: WEAVE,
    });
    expect(plan.paths).toEqual([WEAVE.path, "/opt/vim.js"]);
    expect(plan.diagnostics).toEqual([
      { reason: "entry-duplicate", id: "npm:pi-vim" },
    ]);
  });

  it("uses the first inventory row when ids repeat", () => {
    const plan = resolveChildExtensionPlan({
      record: record("explicit", [entry("npm:pi-vim", "/opt/vim.js")]),
      inventory: [
        { id: "npm:pi-vim", path: "/opt/first.js" },
        { id: "npm:pi-vim", path: "/opt/second.js" },
      ],
      weaveEntry: WEAVE,
    });
    expect(plan.paths).toEqual([WEAVE.path, "/opt/first.js"]);
  });

  it("degrades to inherit-all when the Weave path is unusable", () => {
    for (const path of ["", "relative/extension.js", "/opt/../x.js"]) {
      const plan = resolveChildExtensionPlan({
        record: record("explicit", [entry("npm:pi-vim", "/opt/vim.js")]),
        inventory: [{ id: "npm:pi-vim", path: "/opt/vim.js" }],
        weaveEntry: { id: WEAVE.id, path },
      });
      expect(plan.mode).toBe("inherit-all");
      expect(plan.paths).toEqual([]);
      expect(plan.diagnostics).toEqual([{ reason: "weave-entry-unusable" }]);
    }
  });

  it("emits at most one diagnostic per stored entry", () => {
    const entries = Array.from(
      { length: MAX_CHILD_EXTENSION_ENTRIES },
      (_, i) => entry(`npm:gone-${i}`, `/opt/gone-${i}.js`),
    );
    const plan = resolveChildExtensionPlan({
      record: record("explicit", entries),
      inventory: [],
      weaveEntry: WEAVE,
    });
    expect(plan.diagnostics).toHaveLength(MAX_CHILD_EXTENSION_ENTRIES);
  });
});
