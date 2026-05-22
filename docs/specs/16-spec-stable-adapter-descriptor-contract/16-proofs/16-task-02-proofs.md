# 16-task-02-proofs.md

## Task Summary

Task 2.0 stabilizes non-category descriptor fields. The descriptor contract remains limited to normalized adapter-facing fields: composed prompt, ordered model intent, abstract tool policy, delegation targets, requested skill names, and identity/presentation metadata.

## What This Task Proves

- Custom non-category agents expose `composedPrompt`, ordered `models`, abstract raw/effective tool policy, delegation targets, and requested skill names.
- Raw prompt source fields (`prompt`, `prompt_file`, `prompt_append`) are not present on returned descriptors.
- Descriptor skill data is requested skill names only, without resolved payloads, paths, contents, or adapter-private metadata.
- Boundary documentation assigns model availability, selected-model lookup, concrete model formatting, concrete tool mapping, and harness resource generation to adapters.

## Evidence Summary

The targeted compose test suite includes custom-agent descriptor assertions and raw prompt-source omission assertions. Documentation in `docs/adapter-boundary.md#stable-adapter-descriptor-contract` now explicitly keeps concrete model/tool/resource responsibilities adapter-owned.

## Artifact: Targeted Compose Test

Interpretation: `compose.test.ts` passed with the new stable non-category descriptor coverage.

```text
$ bun test packages/engine/src/__tests__/compose.test.ts
bun test v1.3.13 (bf2e2cec)
 37 pass
 0 fail
 88 expect() calls
Ran 37 tests across 1 file. [58.00ms]
```

## Artifact: Descriptor Field Review

Interpretation: `packages/engine/src/compose.ts` exposes normalized descriptor fields only. No concrete harness ids, selected-model state, model availability records, concrete tool names, raw prompt source fields, or adapter-private skill metadata are added to `AgentDescriptor`.

## Artifact: Documentation Evidence

Interpretation: `docs/adapter-boundary.md` states that adapters own concrete model availability checks, selected-model lookup, concrete model-field formatting, concrete tool-name mapping, permissions enforcement, harness resource generation, and feature-gap emulation.

## Reviewer Conclusion

Task 2.0 is complete. The non-category descriptor contract is covered by tests and documentation while preserving the engine/adapter boundary.
