/**
 * AST node types produced by the Weave parser.
 *
 * Every node carries a `pos: SourcePos` for error reporting.
 */

export type { SourcePos } from "./tokens.js";

import type { SourcePos } from "./tokens.js";

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

export type StringValue = { kind: "string"; value: string; pos: SourcePos };
export type NumberValue = { kind: "number"; value: number; pos: SourcePos };
export type BooleanValue = { kind: "boolean"; value: boolean; pos: SourcePos };
export type IdentifierValue = {
  kind: "identifier";
  value: string;
  pos: SourcePos;
};
export type ArrayValue = {
  kind: "array";
  elements: AstValue[];
  pos: SourcePos;
};
export type BlockValue = {
  kind: "block";
  properties: Property[];
  pos: SourcePos;
};

export type AstValue =
  | StringValue
  | NumberValue
  | BooleanValue
  | IdentifierValue
  | ArrayValue
  | BlockValue;

// ---------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------

export type Property = {
  key: string;
  value: AstValue;
  pos: SourcePos;
};

// ---------------------------------------------------------------------------
// Step blocks (inside workflow)
// ---------------------------------------------------------------------------

export type StepBlock = {
  name: string;
  properties: Property[];
  pos: SourcePos;
  /**
   * When set, this step is inserted immediately before the named anchor step
   * in the base workflow. Only meaningful on extension workflows.
   * Mutually exclusive with `insert_after`.
   */
  insert_before?: string;
  /**
   * When set, this step is inserted immediately after the named anchor step
   * in the base workflow. Only meaningful on extension workflows.
   * Mutually exclusive with `insert_before`.
   */
  insert_after?: string;
};

// ---------------------------------------------------------------------------
// Top-level AST nodes
// ---------------------------------------------------------------------------

export type AgentBlock = {
  type: "agent";
  name: string;
  /**
   * Flat property bag for all agent fields.
   *
   * Notable nested blocks stored here as `BlockValue` properties:
   * - `tool_policy` — capability permission map
   * - `routing`     — per-agent routing knobs (e.g. `delegation_exclude`)
   */
  properties: Property[];
  pos: SourcePos;
};

export type CategoryBlock = {
  type: "category";
  name: string;
  properties: Property[];
  pos: SourcePos;
};

export type WorkflowBlock = {
  type: "workflow";
  name: string;
  properties: Property[];
  steps: StepBlock[];
  pos: SourcePos;
  /**
   * When set, this workflow extends the named base workflow.
   * Extension workflows may have zero or more steps (each step may carry
   * `insert_before` / `insert_after` to position itself relative to the base).
   */
  extends?: string;
};

export type DisableDirective = {
  type: "disable";
  target: "agents" | "hooks" | "skills";
  items: string[];
  pos: SourcePos;
};

export type SettingAssignment = {
  type: "setting";
  key: string;
  value: AstValue;
  pos: SourcePos;
};

/**
 * Top-level `extend before-plan ["step-a", "step-b"]` directive.
 *
 * Declares that the listed step names should be inserted into the `before-plan`
 * slot of the named workflow. This is the **composition** syntax — distinct from
 * the `extension_points { before-plan }` **publication** syntax inside a workflow.
 *
 * The `workflow` field is optional in the DSL; when absent the directive applies
 * to the default plan-oriented workflow. The validator resolves the target after
 * config-merge is complete.
 */
export type ExtendBeforePlanDirective = {
  type: "extend_before_plan";
  /** Target workflow name, or undefined when targeting the default workflow. */
  workflow?: string;
  /** Ordered list of step names to insert into the before-plan slot. */
  steps: string[];
  pos: SourcePos;
};

export type AstNode =
  | AgentBlock
  | CategoryBlock
  | WorkflowBlock
  | DisableDirective
  | SettingAssignment
  | ExtendBeforePlanDirective;
