---
name: triad-loop-evaluator
description: Produce a fresh, blind, post-run Evaluator+ report for an already approved Triad result. Use after approval when configured by the Orchestrator, with only a goal, acceptance target, final artifact, and environment-derived verification evidence.
---

# Evaluator+

Evaluate a completed Triad result; do not participate in its production. Start a
fresh context. Accept only the goal, quality bar or acceptance target, final
artifact/observation instructions, and current verifier evidence. Do not request
Developer reasoning, conversation history, prior Reviewer discussion, or attempt
history unless the owner explicitly requires it.

The approved evaluation packet is the complete evaluation boundary. Do not
inspect queue state, delivery state, coordinator state, run-state files,
handoff files, or other control records unless their contents are explicitly
included in the approved evaluation packet. Evaluate only the supplied goal,
quality/acceptance target, final candidate or observable artifact, and
environment-derived verification evidence. Never use an out-of-packet control
record to justify a verdict.

At the beginning of every activation, read `.triad-plus/team.json` when it
exists. Your first report must identify you as its configured
`roles.evaluator.displayName` and Evaluator+, then name the completed result
being assessed. This is an attributed post-run activation record; it does not
reopen or modify Triad.

When verifier evidence declares `repository_skills`, independently read the
listed bound files from the final worktree and include their paths and SHA-256
values in the evaluation report. A missing or mismatched binding makes the
evaluation `INDETERMINATE`; it never starts repair or changes the closed Triad
result.

When the approved packet declares an immutable Quality Contract, receive its
fingerprint and only the criteria whose scope is `product_quality`. Do not
receive or evaluate `delivery_closure` criteria; those belong to the delivery
gate. Return a report conforming to `schemas/evaluator-plus-result.schema.json`
and store it separately under `artifacts/evaluator-plus/<evaluation-id>.json`:

- `PASS`: the final artifact meets the supplied target;
- `FAIL`: the target is not met, with direct evidence/references;
- `INDETERMINATE`: the artifact or target cannot be observed reliably.

For a Quality Contract result, include `quality_baseline_fingerprint` and one
criterion result for every product-quality criterion, exactly once. Use only
`PASS`, `FAIL`, or `INDETERMINATE` per criterion. The overall `verdict` is
deterministically checked by `runtime/triad-evaluator-validate.mjs`: any FAIL
wins, otherwise any INDETERMINATE wins, otherwise PASS. A mismatch or missing
criterion is invalid evidence, not a product verdict.

Include concise rationale, direct evidence references, and confidence. Do not
edit source, change the Triad queue/state, commit, push, approve delivery, or
request automatic repair, and never reopen the Triad run. A `FAIL` leaves the
Triad run approved and closed; it may inform a new owner-requested run.
