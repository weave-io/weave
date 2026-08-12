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

## Task 3 final direct-export remediation

- Descriptor inspection alone was insufficient because the schema preprocessor returned the original plain object. Zod could still find an enumerable field on `Object.prototype`; an inherited category `description` getter executed once and entered validation. The schema boundary now passes a descriptor-copied graph to Zod. Objects use null prototypes, arrays are rebuilt from validated own index and length descriptors, and source values are obtained only from data descriptors.
- Direct crafted workflow and step ASTs could supply generic properties that conversion later overwrote with dedicated AST fields. Destination ownership now also reserves workflow `extends` and step `insert_before` plus `insert_after`, in addition to the prior workflow `steps`, step `name`/`display_name`, and completion `method` checks.
- Exported `validate()` previously traversed caller-owned AST objects before descriptor checks. Inherited `key` fields and accessor-backed `value` fields could enter conversion and execute getters. Schema and AST boundaries now share one descriptor-safe graph copier. `validate()` copies the complete AST before any AST property access and rejects inherited fields, accessors, symbols, unsafe descriptors, cycles, sparse or extended arrays, and unexpected prototypes as bounded `ValidationError` results. Valid parser ASTs and safe plain or null-prototype direct ASTs remain accepted.

## Task 3 callable-node remediation

- The safe graph copier treated every non-object `typeof` result as a primitive. Because JavaScript reports callables as `"function"`, a callable AST node with an own `type` getter bypassed the descriptor checks and reached exported `validate()`, where the getter ran repeatedly.
- `copyGraph()` now rejects callable values before its primitive return path. Direct `validate()` and exported-schema regressions prove that callable graph nodes fail without executing their getters, while the existing suite continues to cover valid primitive values and prior graph protections.

## Task 4 conversion boundary

- Legacy JSONC conversion must copy the parsed graph through own enumerable writable data descriptors before any field read. jsonc-parser output is untrusted even though it usually creates plain objects.
- Trigger conversion selects nonblank `routing_hint`, else nonblank `trigger`, preserves source order, and drops only exact duplicate strings. Every discarded structured field and every malformed or empty entry gets a warning.
- Valid category patterns are dropped with a warning; malformed patterns also warn. A category with a nonblank description still converts. Generated DSL must not emit `patterns`, trigger objects, or inferred `fast`.
- Task 5 owns engine descriptor, category-shuttle inheritance, and normalized pattern removal. This slice does not change engine production files.
