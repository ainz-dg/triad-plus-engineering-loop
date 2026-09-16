# OpenCode adapter

Install with `npx triad-plus init --host opencode --control <path>`. Open the
control workspace and run `/triad <absolute-prd-path>`. Project-local agent and
command assets carry the configured role models where OpenCode supports them.

Verification uses explicit Orchestrator dispatch. A configured Evaluator+ is
automatically invoked only after a Reviewer-approved result; it cannot reopen
that run.

`.triad-plus/team.json` is the desired source of truth for OpenCode role
configuration. Triad+ materializes each supported role's `model` and native
`variant` (from `reasoning_effort`) in `.opencode/agents/*.md` during init and
after `upgrade --apply`. A null value leaves that field absent so OpenCode uses
its host/session default. The OpenCode session default is independent of these
per-agent bindings; use `opencode models` to inspect available IDs and
variants.
