/**
 * Token types, the Token interface, and SourcePos used by the Weave lexer.
 */

export interface SourcePos {
  line: number;
  column: number;
}

export enum TokenType {
  Identifier = "Identifier",
  String = "String",
  Number = "Number",
  LBrace = "LBrace",
  RBrace = "RBrace",
  LBracket = "LBracket",
  RBracket = "RBracket",
  Comma = "Comma",
  Newline = "Newline",
  EOF = "EOF",
}

export interface Token {
  type: TokenType;
  value: string;
  line: number;
  column: number;
}
