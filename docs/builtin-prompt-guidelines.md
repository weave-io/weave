# Builtin Prompt Guidelines

This guide defines the durable contract for Weave's shipped builtin prompts. It
is a product contract, not a harness prompt, provider configuration, or
repository policy file. The canonical prompt sources live in
[`packages/config/prompts/`](../packages/config/prompts/); the engine composes
them into a `Composed Prompt` before an adapter receives them.

**Related:** [Prompt Composition](prompt-composition.md) · [Adapter Boundary](adapter-boundary.md) · [Config Loading](config-loading.md) · [Spec 10 — Builtin Prompt Defaults](specs/10-spec-builtin-prompt-defaults/10-spec-builtin-prompt-defaults.md)

## Contract in brief

Every builtin prompt should answer five questions, once and in a compact form:

1. **Role:** What job does this agent do?
2. **Constraints:** What must it not do, and what authority does it have?
3. **Autonomy:** What may it decide and execute without another approval?
4. **Success:** What observable result counts as done?
5. **Output:** What small, stable handoff shape should it return?

Prompts describe intent and behavior. They do not reproduce the engine,
adapter, tool, or skill implementation.

## Reduction checkpoint

The eight source prompts were reduced against the baseline captured in
`/tmp/weave-builtin-prompt-baseline/metrics/source-prompts.tsv`
(the path is a local verification input, not a repository artifact). Metrics
use UTF-8 bytes and whitespace-delimited words; no raw prompt text is stored.

| Builtin | Baseline bytes / words | Current bytes / words | Per-agent target | Target |
| --- | ---: | ---: | ---: | :---: |
| Loom | 7,649 / 1,108 | 2,513 / 357 | 4,500 / 650 | pass |
| Tapestry | 8,830 / 1,296 | 2,493 / 329 | 4,000 / 600 | pass |
| Pattern | 3,612 / 566 | 2,197 / 321 | 2,800 / 420 | pass |
| Shuttle | 2,802 / 410 | 1,422 / 214 | 1,900 / 280 | pass |
| Thread | 1,662 / 255 | 1,143 / 179 | 1,200 / 180 | pass |
| Spindle | 2,367 / 341 | 1,411 / 203 | 1,600 / 230 | pass |
| Weft | 3,438 / 527 | 1,569 / 231 | 2,300 / 350 | pass |
| Warp | 5,283 / 765 | 1,917 / 285 | 3,000 / 450 | pass |
| **All eight** | **35,643 / 5,268** | **14,665 / 2,119** | **23,200 / 3,400** | **pass** |

The aggregate is **58.9% smaller by bytes** and **59.8% smaller by words**
than baseline, with no missed per-agent target. The aggregate is below both
hard ceilings. Verify it with:

```bash
for f in packages/config/prompts/{loom,tapestry,pattern,shuttle,thread,spindle,weft,warp}.md; do
  printf '%s\t' "${f##*/}"; wc -c -w < "$f"
done
wc -c -w packages/config/prompts/{loom,tapestry,pattern,shuttle,thread,spindle,weft,warp}.md
```

### What changed

Reduction removed contradictory or duplicated instructions: repeated role and
completion checklists, copied tool choreography, fixed concurrency and wait
promises, provider/model controls, hand-maintained delegation inventories, and
repository-specific procedures. It retained each role's authority boundary,
planning or implementation stop, routing intent, read-only limits, evidence
requirements, review/audit verdicts, and compact handoff shape. The full
behavior contract is summarized in [What reduction must preserve](#what-reduction-must-preserve)
and composed by the [Prompt Composition contract](prompt-composition.md).

Provider-specific recommendations remain evidence for evaluation, not prompt
content. Model selection, reasoning/effort, verbosity, caching, tool routing,
concurrency, and other provider controls belong at the [Adapter Boundary](adapter-boundary.md),
adapter/runtime configuration, or future model-config work. This keeps the
source prompts portable across providers and prevents tokenizer or API changes
from becoming prompt-contract changes.


## Universal rules

These rules apply to every provider and every builtin:

- State one clear role and one authority boundary. Prefer positive instructions
  such as “inspect and report” or “implement the authorized change” over a long
  list of warnings.
- Make the smallest useful response the default. Ask for exact paths, findings,
  decisions, or evidence when those facts matter; omit ceremony and preambles.
- Give the model a compact output contract. Use headings or labels only when a
  consumer needs them. A gate may require a top-level `APPROVE` or `BLOCK`.
- Treat tool results and repository evidence as facts. Separate observation,
  inference, and unknowns when the distinction affects a decision.
- Verify the outcome that the role owns. Verification means checking the
  changed behavior or evidence, not repeating a generic “ensure quality” line.
- Use progressive disclosure: put stable role policy in the builtin prompt and
  put detailed procedures in a skill, reference file, or tool description.
- Keep prompts skill-agnostic. Skills are optional extensions; a builtin must
  remain useful when no skill is installed.
- Refer to delegation through the composed `delegation.targets` data. Do not
  hand-maintain a target inventory in a prompt file.

### What reduction must preserve

Prompt reduction must not change named Weave behavior. The eight builtins must
continue to express and compose the following semantics where applicable:

- Loom can handle small, bounded, local work directly; it routes substantial
  planning to Pattern at most once per request, implementation to an eligible
  Shuttle, evidence work to Thread or Spindle, requested review to Weft, and
  security audits to Warp. It reports an invalid completed Pattern handoff
  instead of repeating it.
- Tapestry remains the non-implementation coordinator: it may schedule and
  delegate authorized work, but it does not perform implementation itself. It
  verifies each settled task, records valid completion in the canonical plan,
  re-reads that plan, and continues through ready work.
- Pattern produces dependency-aware plans with scope, exact file ownership, and
  acceptance criteria, saves the canonical plan artifact, reports its path,
  then stops at plan creation.
- Shuttle implements an authorized plan or bounded change and reports evidence;
  it does not invent authorization or silently claim completion.
- Thread is a read-only local explorer. Spindle is a read-only external
  researcher that cites sources and distinguishes facts from interpretation.
- Weft reviews and returns a concise gate verdict. Warp audits security and
  blocks concrete critical issues or missing required evidence.
- Delegation, category routing, review variants, plan state, authorization,
  gates, and delegation limits remain defined by Weave's configuration and
  engine contracts, not by copied prompt choreography.

These are semantic requirements. Equivalent wording is valid.

## Ownership matrix

| Concern | Owner | Builtin prompt may say |
| --- | --- | --- |
| Stable role and responsibility | Builtin prompt | The role, scope, and handoff it owns |
| Hard behavioral constraints | Builtin prompt | Read-only, planning-only, review-only, or no-delegation boundaries |
| Autonomy and approval boundary | Builtin prompt + engine contract | When it may act, stop, or request authorization |
| Role-specific success criteria | Builtin prompt | The observable evidence needed for its result |
| Compact output shape | Builtin prompt | Required labels or gate verdicts |
| Tool invocation contract | Tool definition | What a tool accepts, returns, and permits |
| Detailed procedures and checklists | Skills and reference files | A reusable method loaded when relevant |
| Authorization, plan state, gates, and portable limits | Engine/runtime | Enforced lifecycle and policy decisions |
| Concrete tools, commands, UI, model controls, and harness discovery | Adapter | Harness-specific materialization and runtime behavior |
| Delegation inventory and eligibility | Config + engine composition | Generated routing data, not a copied list |

The ownership boundary follows [Adapter Boundary](adapter-boundary.md). This
guide links that contract; it does not change it.

## Autonomy and approval boundaries

Use the narrowest autonomy that still completes the role:

- **Read-only roles** inspect, retrieve, compare, and report. They do not edit
  files, run mutating operations, or present an action as completed.
- **Planning roles** may inspect and design. They produce a plan and stop; plan
  creation is not implementation authorization.
- **Implementation roles** act only within the user's authorized scope and the
  supplied plan or request. They may choose ordinary implementation details,
  but must stop on scope, permission, or material ambiguity.
- **Review and audit roles** assess evidence and return a decision. They do not
  silently repair the subject they review.
- **Coordinators** may route or schedule work within declared delegation and
  runtime limits. They must not turn a suggestion into execution or bypass a
  gate.

Prompts should state the boundary once. The engine and adapter enforce it; a
prompt is not a substitute for authorization or permission checks.

## Verification and completion

Verification is role-specific and outcome-based:

- Explorers cite the paths, symbols, or source URLs that support findings.
- Planners check that tasks have scope, file ownership, ordering, and acceptance
  criteria.
- Implementers inspect the resulting diff and run the relevant available
  checks, reporting the commands or checks used and any failures.
- Reviewers and auditors cite concrete findings and distinguish a clean result
  from an unverified result. A gate uses `APPROVE` or `BLOCK` when its caller
  needs a machine-visible decision.
- Coordinators verify that delegated outcomes and required artifacts exist,
  record the plan transitions they own, and re-read plan state before reporting
  the coordinated work complete.

Do not repeat the same success criteria in every section. Define it once in the
role contract and let the engine, workflow, or evaluator own the rest.

## Anthropic-specific findings

Anthropic's current Claude 5 context-engineering guidance is useful evidence for
provider evaluation, not a builtin prompt dependency. It reports that newer
models benefit from fewer overlapping rules and more room to use judgment. It
also favors designing expressive tool and file interfaces over constraining the
model with examples, loading detailed guidance through progressive disclosure,
keeping tool descriptions simple instead of repeating them in the system
prompt, and using rich references when a task needs them.

These findings reinforce Weave's portable rules to state the role and authority
boundary once, avoid duplicated tool instructions, and move detailed procedures
to skills or references. They do not require XML, Claude model names, Claude
commands, thinking budgets, effort settings, or API syntax in shipped prompts.
The source also describes Claude Code features such as auto-memory and deferred
tool loading; those remain harness-owned concerns.

**Source:** [Anthropic — The new rules of context engineering for Claude 5 generation models](https://claude.com/blog/the-new-rules-of-context-engineering-for-claude-5-generation-models)

**Research input:** This section was checked against a local extract of the
linked article. The extract is evidence for these provider-specific findings,
not a durable file dependency.

## OpenAI-specific findings

OpenAI's latest-model guidance reports that GPT-5.6 better infers user intent,
so prompts often need less step-by-step prescription while still stating domain
context, hard constraints, approval boundaries, and success criteria. It also
recommends lean prompts that state each instruction once, concise relevant tool
descriptions, explicit autonomy and approval boundaries, and response guidance
that preserves required facts, decisions, caveats, next steps, and evidence
before trimming repetition. Its examples distinguish direct model judgment from
bounded programmatic tool workflows and call for representative evaluation of
quality, completeness, latency, tokens, and cost.

These findings support Weave's portable role, boundary, verification, output,
and anti-duplication rules. They do not justify embedding GPT-5.6 model names,
Responses API parameters, reasoning or verbosity controls, prompt-cache
settings, programmatic-tool-calling routes, or provider-specific tool names in a
builtin prompt. Those choices belong to adapters, runtime configuration, tool
definitions, or evaluation.

**Source:** [OpenAI — Using GPT-5.6](https://developers.openai.com/api/docs/guides/latest-model)

**Research input:** This section was checked against a local extract of the
linked article. The extract is evidence for these provider-specific findings,
not a durable file dependency.

## Anti-patterns

The following are forbidden in shipped builtin prompts:

- **Hidden reasoning:** requests to reveal chain of thought, hidden-chain-of-
  thought, private scratch work, hidden deliberation, or internal reasoning
  tokens. Ask for concise conclusions and evidence instead.
- **Duplicated tool instructions:** restating tool names, schemas, permission
  rules, retry behavior, or invocation choreography already owned by tools,
  skills, engine policy, or adapters.
- **Adapter commands:** concrete harness commands, slash commands, plugin names,
  UI actions, or tool names that are not part of the portable prompt contract.
- **Provider settings:** model names, provider names, API parameters,
  reasoning/effort controls, verbosity settings, or cache settings.
- **Fixed concurrency:** hard-coded worker counts, parallelism values, queue
  sizes, wait durations, or scheduling promises. Runtime limits are portable
  policy and remain outside the prompt.
- **Repeated success criteria:** the same completion checklist copied into role,
  workflow, handoff, and verification sections.
- **Private choreography:** status sidebars, compulsory retries, sleep/wait
  loops, progress rituals, or instructions that simulate runtime state.
- **Hand-maintained delegation:** copied target lists or stale delegation
  placeholders instead of the generated `delegation.targets` contract.
- **Repository leakage:** Weave-repository instructions, private paths, or
  contributor tooling in product-level defaults.

## Regression expectations

Tests should check semantic contracts and composition, not exact prose. Every
builtin must compose through the real config and engine path, contain no
unresolved template tags, and preserve its role boundary, autonomy, output,
and verification behavior.

Source-size checks use UTF-8 **bytes** and whitespace-delimited **words**. These
are deterministic, provider-neutral proxies for prompt growth. They are hard
regression gates because a provider tokenizer can change, is not shared by all
adapters, and is not part of Weave's prompt contract. Provider token counts may
be recorded as evaluation observations, but they are not normative thresholds.

The normative per-source ceilings and aggregate ceiling are defined in [Spec
10](specs/10-spec-builtin-prompt-defaults/10-spec-builtin-prompt-defaults.md).
A change may use different wording, but it must stay within those ceilings and
must preserve the semantic checks above. No tokenizer dependency is required.
