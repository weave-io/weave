# Spec 33: Execution Controls

## Scope

The DSL carries optional execution intent. Adapters translate it through public
harness APIs. The engine does not set provider request fields or schedule native
subagents. See the [adapter boundary](../../adapter-boundary.md) and
[DSL reference](../../dsl-reference.md).

## Fast service

Agents and categories accept `fast true` and `fast false`. Other value types
are invalid. Omission preserves the inherited or harness default. Project
values override global values. Category values override the base shuttle value,
including `false`. Normalized agent descriptors retain this optional boolean.

Fast service is independent of model selection, reasoning effort, temperature,
and foreground/background delegation. A request for fast service is not proof
that a provider supplied it. Provider support and billing remain harness-owned.

## Delegation concurrency

`settings { delegation { max_concurrency 5 } }` declares a concurrency limit.
The limit applies separately to each parent session and covers both foreground
and background children. It is not a project-wide limit or a limit on tool
calls. A background launch does not release its slot while the child runs.
The value must be a positive safe integer. Omission preserves the harness
default. The delegation block rejects unknown fields. Config layers deep-merge
this block with the usual project-over-global precedence.

Validation applies to the parsed numeric value, as for other DSL numbers.
Numbers use JavaScript precision; decimal literals that round to an integer
are indistinguishable from that integer after parsing. This field does not
introduce a separate integer-token syntax.

Adapters must document the scope of their enforcement and whether excess work
waits or is rejected. They must not describe a prompt instruction alone as an
enforced concurrency limit. Unsupported harnesses must not claim enforcement.
Rejecting background delegation or counting launches alone does not satisfy
this contract. The pinned OpenCode adapter does not yet enforce this setting.

## Acceptance

- Valid booleans and positive integer limits survive parsing and merging.
- Invalid types, zero, negative limits, and fractions are rejected.
- Generated category agents preserve inheritance and explicit `false`.
- OpenCode behavior and remaining host limits are described in the
  [adapter guide](../../adapters/opencode.md).
