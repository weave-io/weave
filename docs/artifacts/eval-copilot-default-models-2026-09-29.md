# Eval record: GitHub Copilot default models (29 Sep 2026)

> Non-normative artifact. The builtin defaults it supports are in
> [`packages/config/src/builtins.ts`](../../packages/config/src/builtins.ts), and
> how adapters use them is in [Model Resolution](../model-resolution.md#builtin-default-models).
> It follows the [25 Sep default-models record](eval-default-models-2026-09-25.md),
> which measured the earlier picks.

The defaults moved to the models GitHub Copilot offers (see [Model Resolution](../model-resolution.md#builtin-default-models)). Two of the new picks had not been measured, so each ran against the default it would replace, on the same commit (`3a51b7c`, a work-in-progress commit of this change that was later squashed; run ids `3a51b7c-2026-09-29-001`), with the same judge and the text track. The runs cost **$0.43** plus about $0.30 for the extra Spindle repeats, and no attempt errored.

| Agent | Suite | Candidate | Score | Previous default | Score |
| --- | --- | --- | --- | --- | --- |
| Shuttle | shuttle-execution (3 repeats) | Sonnet 5.5 | **9/9** | Sonnet 5 | 8/9 |
| Spindle | spindle-tools (8 repeats) | GPT 6 Sol | 11/16 | GPT 6 Luna | **15/16** |

Sol passed `spindle-tools-source-boundary-network-claims` in 4 of 8 attempts, against 8 of 8 for Luna. Its rationale scored 0.96–0.97 every time, but its execution completeness fell to 0.37–0.49: it left out the report's required `Source facts`, `Interpretation`, `Confidence:` and `Sources:` sections. The other case was 7/8 for both.

**Outcome.** Shuttle defaults to Sonnet 5.5. Spindle stays on GPT 6 Luna, which follows its report format more reliably and costs less; its Claude fallback is Haiku 4.5. Weft and Warp now try GPT 6 Sol first, on the strength of the five-repeat reviewer run in the [25 Sep record](eval-default-models-2026-09-25.md#weft-and-warp-on-strong-models-25-sep-2026) (Sol 18/20 and 20/20, Opus 5.5 19/20 and 20/20). Loom, Tapestry, Pattern and Thread keep the same models.

**Live check on Copilot.** On OpenCode `2.0.16` signed in to GitHub Copilot, with the local adapter build, the host registered Loom, Tapestry and Pattern on `github-copilot/claude-opus-5.5`, Shuttle on `github-copilot/claude-sonnet-5.5`, Thread on `github-copilot/claude-haiku-4.5`, Spindle on `github-copilot/gpt-6-luna` and Weft and Warp on `github-copilot/gpt-6-sol`. Loom sessions that delegated to Thread, Weft and Spindle recorded the child sessions on `claude-haiku-4.5`, `gpt-6-sol` and `gpt-6-luna`. The same host with the published `0.2.0-next.5` put Loom, Tapestry and Pattern on `gpt-6-sol`, Thread on `gpt-6-luna` and Shuttle on `claude-sonnet-5`, because Copilot spells Claude versions with a dot. OpenCode 2's `run --agent` starts a top-level session on the host's selected model rather than the agent's, for Weave's agents and native ones alike; delegated children use their registered model.

## Bundles

The bundles are local and are not in the repository. They were written to `eval-bundles/slots/copilot-defaults/<unit>/` in the branch's worktree, one directory per unit (`sh-s55`, `sh-s5`, `sp-sol`, `sp-luna`, and `sp-sol-2`, `sp-luna-2` for the extra Spindle repeats), each with its `run.log`.
