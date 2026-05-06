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
};

// ---------------------------------------------------------------------------
// Top-level AST nodes
// ---------------------------------------------------------------------------

export type AgentBlock = {
  type: "agent";
  name: string;
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

export type AstNode =
  | AgentBlock
  | CategoryBlock
  | WorkflowBlock
  | DisableDirective
  | SettingAssignment;
