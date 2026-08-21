import { describe, expect, it } from "bun:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { getKeybindings } from "@earendil-works/pi-tui";
import { okAsync } from "neverthrow";
import { createChildInspectionCustomComponent } from "../child-inspection-custom.js";
import { PiChildInspectionEditor } from "../child-inspection-editor.js";
import type { PiChildInspectionRenderInput } from "../child-inspection-render.js";
import { PiChildInspector, type PiInspectorChild } from "../child-inspector.js";
import { EMPTY_PI_CHILD_TRANSCRIPT_STATE } from "../child-transcript.js";
import { PiChildInspectionRegistry } from "../child-tree.js";

/** Pi's components read the process-wide theme; the harness sets it in TUI mode. */
initTheme("default");

const ESCAPE = "\x1b";

const child = (
  childId: string,
  status: PiInspectorChild["status"] = "running",
): PiInspectorChild => ({
  childId,
  name: childId,
  kind: "ordinary",
  status,
  live: status === "running",
  generationId: `g-${childId}`,
});

const renderInput = (childName: string): PiChildInspectionRenderInput => ({
  topologyPath: [],
  childName,
  status: "running",
  interventionCount: 0,
  summary: { queueSize: 0, turnCount: 0 },
  generationId: "gen",
  trimmed: false,
  recoveryContinuation: false,
  recoverableInterruption: false,
  interruptedHistory: false,
  readOnlyCompletion: false,
  transcriptState: EMPTY_PI_CHILD_TRANSCRIPT_STATE,
});

const harness = (view: PiInspectorChild) => {
  const inspector = new PiChildInspector("root", {
    steer: () => okAsync(undefined),
    followUp: () => okAsync(undefined),
    cancel: () => okAsync(undefined),
  });
  const editor = new PiChildInspectionEditor(inspector, {});
  editor.open(view, [child("root"), view]);
  let draft = "";
  let closed = 0;
  const component = createChildInspectionCustomComponent(
    { requestRender: () => undefined } as never,
    {} as never,
    getKeybindings() as never,
    editor,
    () => renderInput(view.childId),
    () => draft,
    (next) => {
      draft = next;
    },
    () => {
      closed += 1;
    },
    { cwd: "/workspace" },
  );
  return { component, closed: () => closed };
};

describe("child inspection custom component", () => {
  it("closes the view on escape at the root", () => {
    const { component, closed } = harness(child("root"));
    component.handleInput(ESCAPE);
    expect(closed()).toBe(1);
  });

  it("closes a completed child view on escape instead of trapping input", () => {
    const { component, closed } = harness(child("thread", "settled"));
    component.handleInput(ESCAPE);
    expect(closed()).toBe(1);
  });

  it("keeps a running child view open so escape can still cancel the child", () => {
    const { component, closed } = harness(child("thread"));
    component.handleInput(ESCAPE);
    expect(closed()).toBe(0);
  });

  it("renders the inspection view above the editor", () => {
    const { component } = harness(child("thread"));
    const lines = component.render(60);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join("\n")).toContain("thread");
  });

  it("repaints with new child output when the registry reports a transcript update", async () => {
    const registry = new PiChildInspectionRegistry();
    await registry.register({
      id: "thread",
      parentId: "root",
      name: "thread",
      kind: "ordinary",
      snapshot: () =>
        ({
          id: "thread",
          parentId: "root",
          name: "thread",
          kind: "ordinary",
          status: "running",
          currentTurn: 1,
          usage: {},
        }) as never,
    });
    const inspector = new PiChildInspector("root", {
      steer: () => okAsync(undefined),
      followUp: () => okAsync(undefined),
      cancel: () => okAsync(undefined),
    });
    const editor = new PiChildInspectionEditor(inspector, {});
    const view = child("thread");
    editor.open(view, [child("root"), view]);

    let repaints = 0;
    const component = createChildInspectionCustomComponent(
      { requestRender: () => undefined } as never,
      {} as never,
      getKeybindings() as never,
      editor,
      () => ({
        ...renderInput("thread"),
        transcriptState: registry.getTranscriptState("thread"),
      }),
      () => "",
      () => undefined,
      () => undefined,
      { cwd: "/workspace" },
    );
    // Mirrors the extension wiring: a registry update invalidates and repaints.
    registry.onTranscriptUpdate((childId) => {
      if (editor.currentView()?.childId !== childId) return;
      component.invalidate();
      repaints += 1;
    });

    const before = component.render(80).join("\n");
    await registry.checkpointEvent("thread", {
      type: "text",
      text: "STREAMED CHILD OUTPUT",
    });
    const after = component.render(80).join("\n");

    expect(before).not.toContain("STREAMED CHILD OUTPUT");
    expect(after).toContain("STREAMED CHILD OUTPUT");
    expect(repaints).toBe(1);
  });

  it("keeps the newest streamed output visible inside Pi's editor region", async () => {
    const registry = new PiChildInspectionRegistry();
    await registry.register({
      id: "thread",
      parentId: "root",
      name: "thread",
      kind: "ordinary",
      snapshot: () =>
        ({
          id: "thread",
          parentId: "root",
          name: "thread",
          kind: "ordinary",
          status: "running",
          currentTurn: 1,
          usage: {},
        }) as never,
    });
    const inspector = new PiChildInspector("root", {
      steer: () => okAsync(undefined),
      followUp: () => okAsync(undefined),
      cancel: () => okAsync(undefined),
    });
    const editor = new PiChildInspectionEditor(inspector, {});
    const view = child("thread");
    editor.open(view, [child("root"), view]);
    const component = createChildInspectionCustomComponent(
      {
        requestRender: () => undefined,
        terminal: { rows: 24 },
      } as never,
      {} as never,
      getKeybindings() as never,
      editor,
      () => ({
        ...renderInput("thread"),
        transcriptState: registry.getTranscriptState("thread"),
      }),
      () => "",
      () => undefined,
      () => undefined,
      { cwd: "/workspace" },
    );

    for (let index = 0; index < 60; index += 1)
      await registry.checkpointEvent("thread", {
        type: "text",
        text: `line ${index}`,
      });
    component.invalidate();
    const rendered = component.render(80);

    expect(rendered.length).toBeLessThanOrEqual(24);
    expect(rendered.join("\n")).toContain("line 59");
    expect(rendered.join("\n")).not.toContain("line 0\n");
  });

  it("shows the child's model and reasoning level, and scrolls its history", async () => {
    const registry = new PiChildInspectionRegistry();
    await registry.register({
      id: "thread",
      parentId: "root",
      name: "thread",
      kind: "ordinary",
      model: "gpt-5.6-sol",
      thinkingLevel: "high",
      snapshot: () =>
        ({
          id: "thread",
          parentId: "root",
          name: "thread",
          kind: "ordinary",
          status: "running",
          currentTurn: 1,
          usage: {},
        }) as never,
    });
    const inspector = new PiChildInspector("root", {
      steer: () => okAsync(undefined),
      followUp: () => okAsync(undefined),
      cancel: () => okAsync(undefined),
    });
    const editor = new PiChildInspectionEditor(inspector, {});
    const view = child("thread");
    editor.open(view, [child("root"), view]);
    const meta = registry.getChildRuntimeMeta("thread");
    const component = createChildInspectionCustomComponent(
      { requestRender: () => undefined, terminal: { rows: 24 } } as never,
      {} as never,
      getKeybindings() as never,
      editor,
      () => ({
        ...renderInput("thread"),
        ...(meta.model === undefined ? {} : { model: meta.model }),
        ...(meta.thinkingLevel === undefined
          ? {}
          : { reasoningLevel: meta.thinkingLevel }),
        transcriptState: registry.getTranscriptState("thread"),
      }),
      () => "",
      () => undefined,
      () => undefined,
      { cwd: "/workspace" },
    );

    for (let index = 0; index < 80; index += 1)
      await registry.checkpointEvent("thread", {
        type: "text",
        text: `entry ${index}`,
      });
    component.invalidate();
    const tail = component.render(80).join("\n");
    expect(tail).toContain("model:gpt-5.6-sol");
    expect(tail).toContain("reasoning:high");
    expect(tail).toContain("entry 79");

    component.handleInput("\x1b[H");
    const top = component.render(80).join("\n");
    expect(top).toContain("entry 0");
    expect(top).toContain("newer line(s) below");

    component.handleInput("\x1b[F");
    expect(component.render(80).join("\n")).toContain("entry 79");
  });
});
