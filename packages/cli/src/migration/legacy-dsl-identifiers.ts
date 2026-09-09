const DANGEROUS_DSL_NAMES = new Set(["__proto__", "prototype", "constructor"]);
const DSL_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_-]*$/;

export function isDslIdentifierSyntax(value: string): boolean {
  return DSL_IDENTIFIER.test(value);
}

export function isDangerousDslName(value: string): boolean {
  return DANGEROUS_DSL_NAMES.has(value);
}

export function isSafeDslName(value: string): boolean {
  return isDslIdentifierSyntax(value) && !isDangerousDslName(value);
}
