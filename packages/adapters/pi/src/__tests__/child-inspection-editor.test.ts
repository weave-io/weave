import { describe, expect, it } from "bun:test";
import { okAsync } from "neverthrow";
import { PiChildInspectionEditor } from "../child-inspection-editor.js";
import {
  PiChildInspector,
  type PiInspectorChild,
  type PiInspectorRpc,
} from "../child-inspector.js";

const child = (
  childId: string,
  status: PiInspectorChild["status"] = "running",
  extra: Partial<PiInspectorChild> = {},
): PiInspectorChild => ({
  childId,
  name: childId,
  kind: "ordinary",
  status,
  live: status === "running",
  generationId: `g-${childId}`,
  ...extra,
});

describe("PiChildInspectionEditor", () => {
  it("falls parent Enter and Backspace through to the host editor", () => {
    const defaults: string[] = [];
    const inspector = new PiChildInspector("root", {
      steer: () => okAsync(undefined),
      followUp: () => okAsync(undefined),
      cancel: () => okAsync(undefined),
    });
    const editor = new PiChildInspectionEditor(inspector, {
      defaultInput: (input) => defaults.push(input),
    });
    editor.open(child("root"), [child("root")]);

    expect(editor.handleInput("\r")._unsafeUnwrap().kind).toBe("host-default");
    expect(editor.handleInput("\x7f")._unsafeUnwrap().kind).toBe(
      "host-default",
    );
    expect(defaults).toEqual(["\r", "\x7f"]);
  });

  it("opens picker, navigates parent, and preserves state", () => {
    const opened: string[] = [];
    const defaults: string[] = [];
    const rpc: PiInspectorRpc = {
      steer: () => okAsync(undefined),
      followUp: () => okAsync(undefined),
      cancel: () => okAsync(undefined),
    };
    const inspector = new PiChildInspector("root", rpc);
    const root = child("root");
    const nested = child("nested", "running", { parentId: "root" });
    const editor = new PiChildInspectionEditor(inspector, {
      openPicker: () => opened.push("picker"),
      defaultInput: (value) => defaults.push(value),
    });
    editor.open(nested, [root, nested]);
    editor.updateViewState({
      draft: "",
      scrollOffset: 8,
      expandedTools: ["x"],
      thinkingVisible: false,
      imagesVisible: false,
      queue: ["q"],
    });
    editor.handleInput("\x1bi");
    editor.handleInput("\x7f");
    expect(opened).toEqual(["picker"]);
    expect(inspector.current()).toBe("root");
    editor.open(nested, [root, nested]);
    editor.updateDraft("not empty");
    editor.handleInput("\x7f");
    expect(defaults).toContain("\x7f");
    editor.open(root, [root, nested]);
    expect(editor.currentView()?.state).toEqual({
      draft: "",
      scrollOffset: 0,
      expandedTools: [],
      thinkingVisible: true,
      imagesVisible: true,
      queue: [],
    });
  });

  it("returns a top-level child view to the root instead of dead-ending", () => {
    const defaults: string[] = [];
    const inspector = new PiChildInspector("root", {
      steer: () => okAsync(undefined),
      followUp: () => okAsync(undefined),
      cancel: () => okAsync(undefined),
    });
    const editor = new PiChildInspectionEditor(inspector, {
      defaultInput: (input) => defaults.push(input),
    });
    const root = child("root");
    const topLevel = child("thread");
    editor.open(topLevel, [root, topLevel]);

    expect(editor.handleInput("\x7f")._unsafeUnwrap().kind).toBe("handled");
    expect(inspector.current()).toBe("root");
    expect(editor.currentView()?.childId).toBe("root");
    expect(defaults).toEqual([]);
  });

  it("refreshes live child slots before handling Alt+1", () => {
    const inspector = new PiChildInspector("root", {
      steer: () => okAsync(undefined),
      followUp: () => okAsync(undefined),
      cancel: () => okAsync(undefined),
    });
    const root = child("root");
    const liveChild = child("live-child", "running", { parentId: "root" });
    let editor: PiChildInspectionEditor;
    editor = new PiChildInspectionEditor(inspector, {
      beforeInput: () => editor.syncChildren([root, liveChild]),
    });
    editor.open(root, [root]);

    expect(inspector.slots.childAt(1)).toBeUndefined();
    expect(editor.handleInput("\x1b1")._unsafeUnwrap()).toEqual({
      kind: "handled",
      key: { kind: "select-direct-child", index: 1 },
    });
    expect(editor.currentView()?.childId).toBe("live-child");
  });

  it("dispatches steer and follow-up only for a running child", () => {
    const calls: string[] = [];
    const rpc: PiInspectorRpc = {
      steer: () => {
        calls.push("steer");
        return okAsync(undefined);
      },
      followUp: () => {
        calls.push("follow");
        return okAsync(undefined);
      },
      cancel: () => okAsync(undefined),
    };
    const inspector = new PiChildInspector("root", rpc);
    const running = child("a");
    const editor = new PiChildInspectionEditor(inspector);
    editor.open(running, [running]);
    editor.updateDraft("hello");
    editor.handleInput("\r");
    editor.updateDraft("later");
    editor.handleInput("\x1b\r");
    expect(calls).toEqual(["steer", "follow"]);
    editor.open({ ...running, status: "settled", live: false }, [
      { ...running, status: "settled", live: false },
    ]);
    editor.updateDraft("ignored");
    editor.handleInput("\r");
    expect(calls).toEqual(["steer", "follow"]);
  });

  it("does not submit an empty child draft to the parent", () => {
    const defaults: string[] = [];
    const calls: string[] = [];
    const inspector = new PiChildInspector("root", {
      steer: () => {
        calls.push("steer");
        return okAsync(undefined);
      },
      followUp: () => {
        calls.push("follow");
        return okAsync(undefined);
      },
      cancel: () => okAsync(undefined),
    });
    const editor = new PiChildInspectionEditor(inspector, {
      defaultInput: (input) => defaults.push(input),
    });
    editor.open(child("root"), [child("root")]);
    editor.open(child("a"), [child("root"), child("a")]);

    expect(editor.handleInput("\r")._unsafeUnwrap().kind).toBe("handled");
    expect(defaults).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("rejects stale views and child slash commands", () => {
    const rejected: string[] = [];
    const rpc: PiInspectorRpc = {
      steer: () => okAsync(undefined),
      followUp: () => okAsync(undefined),
      cancel: () => okAsync(undefined),
    };
    const inspector = new PiChildInspector("root", rpc);
    const a = child("a");
    const b = child("b");
    const editor = new PiChildInspectionEditor(inspector);
    editor.open(a, [a, b]);
    inspector.open("b", [a, b]);
    const result = editor.handleInput("\r")._unsafeUnwrap();
    if (result.kind === "rejected") rejected.push(result.reason);
    expect(rejected).toContain("stale inspector view");
    editor.open(b, [a, b]);
    expect(
      editor.handleInput("/weave:clear-children")._unsafeUnwrap().kind,
    ).toBe("rejected");
  });

  it("rejects every slash command in child views without host or RPC side effects", () => {
    let defaults = 0;
    let rpcCalls = 0;
    const rpc: PiInspectorRpc = {
      steer: () => {
        rpcCalls += 1;
        return okAsync(undefined);
      },
      followUp: () => {
        rpcCalls += 1;
        return okAsync(undefined);
      },
      cancel: () => {
        rpcCalls += 1;
        return okAsync(undefined);
      },
    };
    const inspector = new PiChildInspector("root", rpc);
    const editor = new PiChildInspectionEditor(inspector, {
      defaultInput: () => {
        defaults += 1;
      },
    });
    const a = child("a");
    editor.open(a, [child("root"), a]);
    for (const input of [
      "/help",
      "/model",
      "/weave:inspect",
      "/weave:unknown",
    ]) {
      expect(editor.handleInput(input)._unsafeUnwrap().kind).toBe("rejected");
    }
    expect(defaults).toBe(0);
    expect(rpcCalls).toBe(0);
  });

  it("falls unknown parent slash commands through and handles only exact inspector commands", () => {
    const defaults: string[] = [];
    const commands: string[] = [];
    const inspector = new PiChildInspector("root", {
      steer: () => okAsync(undefined),
      followUp: () => okAsync(undefined),
      cancel: () => okAsync(undefined),
    });
    const editor = new PiChildInspectionEditor(inspector, {
      defaultInput: (input) => defaults.push(input),
      onSlashCommand: (command) => commands.push(command),
    });
    editor.open(child("root"), [child("root")]);
    expect(editor.handleInput("/help")._unsafeUnwrap().kind).toBe(
      "host-default",
    );
    expect(
      editor.handleInput("/weave:inspect extra")._unsafeUnwrap().kind,
    ).toBe("host-default");
    expect(editor.handleInput("/weave:inspect")._unsafeUnwrap().kind).toBe(
      "handled",
    );
    expect(defaults).toEqual(["/help", "/weave:inspect extra"]);
    expect(commands).toEqual(["inspect"]);
  });

  it("does not dispatch keys after the attached view generation becomes stale", () => {
    const calls: string[] = [];
    const rpc: PiInspectorRpc = {
      steer: () => {
        calls.push("steer");
        return okAsync(undefined);
      },
      followUp: () => {
        calls.push("follow");
        return okAsync(undefined);
      },
      cancel: () => {
        calls.push("cancel");
        return okAsync(undefined);
      },
    };
    const inspector = new PiChildInspector("root", rpc);
    const editor = new PiChildInspectionEditor(inspector, {
      confirm: {
        confirm: () => {
          calls.push("confirm");
          return okAsync(true);
        },
      },
    });
    const a = child("a");
    editor.open(a, [child("root"), a]);
    inspector.setKnownChildren([
      { ...a, generationId: "g-a-next" },
      child("root"),
    ]);
    for (const input of ["\r", "\x1b\r", "\x1b", "\x1b1"])
      editor.handleInput(input);
    expect(calls).toEqual([]);
  });
});
