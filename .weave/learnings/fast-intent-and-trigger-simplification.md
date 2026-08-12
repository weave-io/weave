# Fast intent and trigger simplification learnings

## Task 3 review remediation

- Gate findings: bare trigger identifiers and bare `fast` crossed the generic parser boundary; AST conversion used prototype-bearing records and overwrote duplicates; Zod diagnostics exposed attacker-controlled key text without global bounds.
- Resolution: preserve bare-flag provenance in the AST, then fail closed for agent/category `fast` unless the source says `fast true`; require trigger AST elements to be quoted strings; reject dangerous names and duplicate declarations/properties before conversion, including nested blocks, workflows, and steps.
- Conversion now uses null-prototype records with explicit own-property definitions. Validation diagnostics cap issues, path length, message length, and aggregate size, with a deterministic truncation marker.
- Intentional bare flags remain valid in their scoped grammar, including `extension_points { before-plan }`.

## Task 3 repeat-audit remediation

- Generated and normalized destinations are also ownership boundaries. Source properties must not target a field already supplied by declaration syntax or normalization. A reusable pre-conversion check now rejects workflow `steps`, step `name` plus `display_name`, and completion-block `method` when the named completion already generates it. This prevents silent overwrite before schema validation.
- Diagnostic bounds apply to the complete `ConfigError` union, not only Zod issues. One shared policy caps issue count, every source-controlled string field, and aggregate diagnostic size for direct lexer, parser, validator, and end-to-end parse boundaries. It uses deterministic truncation and a stable marker. A duplicate 20,000-character key now returns bounded, repeatable diagnostics.
- Exported agent, category, and root schemas now inspect the complete input graph through descriptors before Zod reads values. They accept ordinary own writable data properties on plain and null-prototype records. They reject inherited input, accessors, unexpected prototypes, symbols, and unsafe descriptors. Getter rejection occurs without getter execution.
