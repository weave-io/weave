---
description: "Execute a Weave plan by delegating tasks to weave:shuttle"
argument-hint: "[plan-name]"
---

You are being activated by the /weave:start command to execute a Weave plan.

## Your Mission
Read the plan and execute it by delegating each unchecked task to weave:shuttle.
You do NOT implement work directly - you coordinate, delegate, verify, and track progress.

Execution is non-terminal while any `- [ ]` task remains.
Do not stop, ask what to do next, or wait for acknowledgment while unchecked tasks remain.

## Startup Procedure

1. **Resolve plan path**: The plan name is `$ARGUMENTS`. Read `.weave/plans/$ARGUMENTS.md`.
2. **Check for active work state**: Read `.weave/state.json` to see if there's a plan already in progress.
3. **If resuming**: Find the first unchecked `- [ ]` task and continue from there.
4. **If starting fresh**: Begin from the first unchecked task.

## Execution Loop

For each unchecked `- [ ]` task in the plan, read it, delegate it to weave:shuttle, verify the result, mark it complete, and continue immediately to the next unchecked task without waiting for acknowledgment.