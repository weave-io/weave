/**
 * Centralized terminal output boundary.
 *
 * All user-facing CLI output flows through this module so
 * `noConsole` lint rules remain enforceable across the package.
 * Tests can inject a `TerminalIO` to capture output.
 */

export interface TerminalIO {
  /** Write a line to stdout. */
  stdout(msg: string): void;
  /** Write a line to stderr. */
  stderr(msg: string): void;
}

/**
 * Real terminal writer backed by `process.stdout` / `process.stderr`.
 * Biome `noConsole` is bypassed here intentionally — this is the
 * single authorised output boundary.
 */
export class RealTerminal implements TerminalIO {
  stdout(msg: string): void {
    // biome-ignore lint/suspicious/noConsole: authorised output boundary
    console.log(msg);
  }

  stderr(msg: string): void {
    // biome-ignore lint/suspicious/noConsole: authorised output boundary
    console.error(msg);
  }
}

/**
 * In-memory terminal for test capture.
 */
export class BufferTerminal implements TerminalIO {
  readonly out: string[] = [];
  readonly err: string[] = [];

  stdout(msg: string): void {
    this.out.push(msg);
  }

  stderr(msg: string): void {
    this.err.push(msg);
  }
}
