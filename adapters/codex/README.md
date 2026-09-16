# Triad+ Codex adapter

Codex custom prompts live in the user prompt directory, so its native command
is `/prompts:triad` rather than the un-namespaced `/triad` used by OpenCode and
Claude Code. The prompt places the current conversation in the Orchestrator
role; it does not create a hidden coordinator session.

Install a project-control repository first:

```bash
./adapters/codex/install.sh --project /path/to/project-control-repository
```

Then install the global entry point and the skills once for the Codex user:

```bash
./adapters/codex/install.sh --global
```

The installer refuses any overwrite. It installs the project runtime under
`.triad-runtime` and the six shared skills under `.agents/skills`; the global
installation also makes the skills available to Codex and writes
`$CODEX_HOME/prompts/triad.md` (`$HOME/.codex` by default).

Start Codex from the control repository and invoke:

```text
/prompts:triad <PRD path or project request>
```

Before it starts work, configure the four named role profiles described in
[`docs/codex-replication.md`](../../docs/codex-replication.md). The adapter
does not edit profile or model configuration, because their availability and
model routing are host-owner decisions.

At bootstrap and resume, the Orchestrator runs the runtime capability detector
with the project's `control_plane.dispatch_mode`. Codex `auto` selects explicit
verification dispatch even when an async hook is available. The async
`SubagentStop` route remains an experimental opt-in (`async_hook`) and falls
back to explicit dispatch when unavailable. On Codex CLI 0.142, explicit
dispatch is the safe expected route.

The Codex conversation remains the Orchestrator parent while a delegated
Developer or Reviewer is active. A `wait_agent` timeout is only a polling
interval: the parent refreshes status and waits again in the same turn. A
progress update never returns control to the owner while delegated work
remains active; completion is collected automatically and proceeds to
verification, review, and the next dependency-satisfied card.
