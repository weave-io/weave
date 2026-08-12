# Fast intent and trigger simplification learnings

## Task 3 review remediation

- Gate findings: bare trigger identifiers and bare `fast` crossed the generic parser boundary; AST conversion used prototype-bearing records and overwrote duplicates; Zod diagnostics exposed attacker-controlled key text without global bounds.
- Resolution: preserve bare-flag provenance in the AST, then fail closed for agent/category `fast` unless the source says `fast true`; require trigger AST elements to be quoted strings; reject dangerous names and duplicate declarations/properties before conversion, including nested blocks, workflows, and steps.
- Conversion now uses null-prototype records with explicit own-property definitions. Validation diagnostics cap issues, path length, message length, and aggregate size, with a deterministic truncation marker.
- Intentional bare flags remain valid in their scoped grammar, including `extension_points { before-plan }`.
