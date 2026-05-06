/**
 * Discriminated union error types for the Weave DSL pipeline.
 *
 * Error flow:
 *   LexError  → produced by the Lexer
 *   ParseError → produced by the Parser
 *   ValidationError → produced by the Validator (Zod)
 *   ConfigError → union of all three; used as the public-facing error type
 */

// ---------------------------------------------------------------------------
// LexError
// ---------------------------------------------------------------------------

export type LexError =
	| {
			type: "UnterminatedString";
			line: number;
			column: number;
	  }
	| {
			type: "InvalidNumber";
			line: number;
			column: number;
			value: string;
	  }
	| {
			type: "UnexpectedCharacter";
			line: number;
			column: number;
			char: string;
	  };

// ---------------------------------------------------------------------------
// ParseError
// ---------------------------------------------------------------------------

export type ParseError =
	| {
			type: "UnexpectedToken";
			line: number;
			column: number;
			found: string;
			expected: string;
	  }
	| {
			type: "MissingBlockName";
			line: number;
			column: number;
			blockType: string;
	  }
	| {
			type: "UnclosedBlock";
			line: number;
			column: number;
	  };

// ---------------------------------------------------------------------------
// ValidationError
// ---------------------------------------------------------------------------

export type ValidationError = {
	type: "ValidationError";
	path: string;
	message: string;
	line?: number;
	column?: number;
};

// ---------------------------------------------------------------------------
// ConfigError — public-facing union
// ---------------------------------------------------------------------------

export type ConfigError = LexError | ParseError | ValidationError;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns a human-readable `"line:column: message"` string for any ConfigError.
 */
export function formatError(error: ConfigError): string {
	switch (error.type) {
		case "UnterminatedString":
			return `${error.line}:${error.column}: unterminated string literal`;

		case "InvalidNumber":
			return `${error.line}:${error.column}: invalid number literal '${error.value}'`;

		case "UnexpectedCharacter":
			return `${error.line}:${error.column}: unexpected character '${error.char}'`;

		case "UnexpectedToken":
			return `${error.line}:${error.column}: unexpected token '${error.found}', expected ${error.expected}`;

		case "MissingBlockName":
			return `${error.line}:${error.column}: missing name for '${error.blockType}' block`;

		case "UnclosedBlock":
			return `${error.line}:${error.column}: unclosed block`;

		case "ValidationError": {
			const location =
				error.line != null ? `${error.line}:${error.column ?? 0}: ` : "";
			const path = error.path ? `[${error.path}] ` : "";
			return `${location}${path}${error.message}`;
		}
	}
}
