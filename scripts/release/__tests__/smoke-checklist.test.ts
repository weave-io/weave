import { describe, expect, it } from "bun:test";
import {
  BunSmokeChecklistReader,
  parseSmokeChecklist,
} from "../smoke-checklist.js";

const VALID_MARKDOWN = `# Stable TUI Smoke Checklist

Checklist version: 1

| ID | Area | Check | Result |
| --- | --- | --- | --- |
| S001 | Install | Install the tarball. | Pending |
| S002 | Health | Run /weave:health. | Pending |
`;

describe("parseSmokeChecklist", () => {
  it("parses the checklist version and every S### row", () => {
    const result = parseSmokeChecklist(VALID_MARKDOWN);
    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;
    expect(result.value.version).toBe("1");
    expect(result.value.items.map((item) => item.id)).toEqual(["S001", "S002"]);
    expect(result.value.items[0]?.area).toBe("Install");
    expect(result.value.items[0]?.check).toBe("Install the tarball.");
    expect(result.value.items[0]?.result).toBe("Pending");
  });

  it("rejects markdown with no checklist version line", () => {
    const result = parseSmokeChecklist(
      VALID_MARKDOWN.replace("Checklist version: 1\n\n", ""),
    );
    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.type).toBe("MissingVersion");
  });

  it("rejects a duplicate item ID", () => {
    const withDuplicate = `${VALID_MARKDOWN}| S001 | Health | Duplicate. | Pending |\n`;
    const result = parseSmokeChecklist(withDuplicate);
    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.type).toBe("DuplicateItemId");
  });

  it("rejects a checklist with no items", () => {
    const result = parseSmokeChecklist("Checklist version: 1\n");
    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.type).toBe("NoItems");
  });

  it("rejects a checklist row with an unknown result", () => {
    const result = parseSmokeChecklist(
      VALID_MARKDOWN.replace("| Pending |", "| Skipped |"),
    );
    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.type).toBe("InvalidResult");
  });

  it("rejects a malformed row that starts with an S### cell but has too few columns", () => {
    const malformed = `Checklist version: 1\n\n| S001 | Only two cells |\n`;
    const result = parseSmokeChecklist(malformed);
    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.type).toBe("MalformedRow");
  });

  it("parses the real committed checklist document", async () => {
    const read = await new BunSmokeChecklistReader().read();
    expect(read.isOk()).toBe(true);
    if (!read.isOk()) return;
    const result = parseSmokeChecklist(read.value);
    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;
    expect(result.value.version).toBe("3");
    expect(result.value.items).toHaveLength(53);
    expect(new Set(result.value.items.map((item) => item.id)).size).toBe(53);
    const byId = new Map(
      result.value.items.map((item) => [item.id, item.result]),
    );
    for (const id of ["S010", "S011", "S012", "S013", "S040", "S049"])
      expect(byId.get(id)).toBe("Pending");
    for (const id of ["S050", "S057", "S063", "S064", "S067"])
      expect(byId.get(id)).toBe("Pass");
    for (const id of ["S042", "S054", "S060", "S062", "S068", "S069"])
      expect(byId.get(id)).toBe("Pending");
  });
});
