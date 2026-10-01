import { describe, expect, it } from "bun:test";
import { parseConfig } from "@weaveio/weave-core";
import { modelsField, pinModels } from "../pin-editor.js";

const HEADER = "# pinned";

function pin(source: string, lists: Record<string, string[]>) {
  return pinModels(source, lists, HEADER)._unsafeUnwrap();
}

describe("pinModels", () => {
  it("replaces an existing models field and keeps every other byte", () => {
    const source = [
      "# my global config",
      "agent loom {",
      '  description "Mine"   # keep this comment',
      '  models ["mine"]',
      "  temperature 0.1",
      "}",
      "",
    ].join("\n");
    const edit = pin(source, { loom: ["mine", "claude-opus-5.6"] });
    expect(edit.text).toBe(
      source.replace('models ["mine"]', 'models ["mine", "claude-opus-5.6"]'),
    );
    expect(edit.hunks).toEqual([
      {
        agent: "loom",
        kind: "replace",
        removed: ['  models ["mine"]'],
        added: ['  models ["mine", "claude-opus-5.6"]'],
      },
    ]);
  });

  it("replaces a models list that spans several lines", () => {
    const source = [
      "agent loom {",
      "  models [",
      '    "a",   # first',
      '    "b"',
      "  ]",
      '  prompt "p"',
      "}",
    ].join("\n");
    const edit = pin(source, { loom: ["a", "b", "c"] });
    expect(edit.text).toBe(
      ["agent loom {", '  models ["a", "b", "c"]', '  prompt "p"', "}"].join(
        "\n",
      ),
    );
    expect(edit.hunks[0]?.removed).toHaveLength(4);
  });

  it("inserts a models line before the closing brace at the fields' indentation", () => {
    const source = [
      "agent shuttle {",
      "    temperature 0.2",
      "    tool_policy {",
      "      read allow",
      "    }",
      "}",
      "",
    ].join("\n");
    const edit = pin(source, { shuttle: ["claude-sonnet-5.6"] });
    expect(edit.text).toBe(
      [
        "agent shuttle {",
        "    temperature 0.2",
        "    tool_policy {",
        "      read allow",
        "    }",
        '    models ["claude-sonnet-5.6"]',
        "}",
        "",
      ].join("\n"),
    );
    expect(edit.hunks[0]?.kind).toBe("insert");
  });

  it("breaks a one-line block to add the field", () => {
    const edit = pin('agent thread { prompt "t" }\n', { thread: ["x"] });
    expect(edit.text).toBe('agent thread { prompt "t" \n  models ["x"]\n}\n');
    expect(parseConfig(edit.text)._unsafeUnwrap().agents.thread).toEqual({
      prompt: "t",
      models: ["x"],
    });
  });

  it("finds a models field that follows another field on the same line", () => {
    const edit = pin('agent loom { prompt "p" models ["old"] }\n', {
      loom: ["new"],
    });
    expect(edit.text).toBe('agent loom { prompt "p" models ["new"] }\n');
    expect(edit.hunks[0]?.kind).toBe("replace");
  });

  it("does not mistake a nested models key for the agent's own", () => {
    const source = [
      "agent loom {",
      "  tool_policy {",
      "    read allow",
      "  }",
      "}",
      "category backend {",
      '  description "Backend"',
      '  models ["c"]',
      "}",
    ].join("\n");
    const edit = pin(source, { loom: ["x"] });
    const config = parseConfig(edit.text)._unsafeUnwrap();
    expect(config.agents.loom?.models).toEqual(["x"]);
    expect(config.categories.backend?.models).toEqual(["c"]);
  });

  it("edits the last block when an agent is declared twice, as the parser keeps it", () => {
    const source = [
      "agent loom {",
      '  models ["first"]',
      "}",
      "agent loom {",
      '  models ["second"]',
      "}",
    ].join("\n");
    const edit = pin(source, { loom: ["second", "rec"] });
    expect(edit.text).toContain('models ["first"]');
    expect(edit.text).toContain('models ["second", "rec"]');
  });

  it("appends marked blocks for agents the file does not declare", () => {
    const source = "settings {\n  log_level INFO\n}";
    const edit = pin(source, { thread: ["a"], weft: ["b", "c"] });
    expect(edit.text).toBe(
      [
        "settings {",
        "  log_level INFO",
        "}",
        "",
        HEADER,
        "agent thread {",
        '  models ["a"]',
        "}",
        "agent weft {",
        '  models ["b", "c"]',
        "}",
        "",
      ].join("\n"),
    );
    expect(edit.hunks).toHaveLength(1);
    expect(edit.hunks[0]?.kind).toBe("append");
  });

  it("writes a whole file when there is none yet", () => {
    const edit = pin("", { loom: ["a"] });
    expect(edit.text).toBe(`${HEADER}\nagent loom {\n  models ["a"]\n}\n`);
  });

  it("leaves an agent alone when it already lists exactly those models", () => {
    const source = 'agent loom {\n  models ["a"]\n}\n';
    const edit = pin(source, { loom: ["a"] });
    expect(edit.text).toBe(source);
    expect(edit.hunks).toEqual([]);
  });

  it("refuses a source that does not parse", () => {
    const result = pinModels(
      'agent loom {\n  models ["a"\n',
      { loom: ["b"] },
      HEADER,
    );
    expect(result._unsafeUnwrapErr().type).toBe("SourceInvalid");
  });

  it("escapes quotes and backslashes in model IDs", () => {
    expect(modelsField(['a"b', "c\\d"])).toBe('models ["a\\"b", "c\\\\d"]');
    const edit = pin("", { loom: ['a"b'] });
    expect(parseConfig(edit.text)._unsafeUnwrap().agents.loom?.models).toEqual([
      'a"b',
    ]);
  });
});
