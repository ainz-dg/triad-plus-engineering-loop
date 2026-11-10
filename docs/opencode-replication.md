# OpenCode adapter

Install with `npx triad-plus init --host opencode --control <path>`. Open the
control workspace and run `/triad <absolute-prd-path>`. Project-local agent and
command assets inherit the OpenCode host model and variant defaults.

Verification uses explicit Orchestrator dispatch. A configured Evaluator+ is
automatically invoked only after a Reviewer-approved result; it cannot reopen
that run.

`.triad-plus/team.json` records requested role models and effort as intent.
Triad+ omits unverified `model`/`variant` overrides from managed agents, so an
invalid requested ID cannot prevent `/triad` from loading. Upgrade existing
assets through `upgrade --apply` after reviewing its preview. Use OpenCode's
model picker to select an available host model; a saved request does not prove
that model was selected. Syntax checks require `provider/model` (optionally
`#variant`) and reject values such as `gpt 6 luna medium` without guessing a
replacement.
