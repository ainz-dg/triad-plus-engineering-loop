# Runtime adapters

Every adapter installs the same role skills and verifier runtime, while retaining
host-specific entry points and configuration behavior.

| Runtime | Prerequisite | Entry point | Verification | Hook limitation |
| --- | --- | --- | --- | --- |
| Codex | Codex CLI | `/prompts:triad` | Explicit dispatch by default; experimental async hook opt-in | Hook is optional, requires trusted configuration, and is not selected by `auto`. |
| Claude Code | Claude Code CLI | `/triad` | Explicit dispatch; hook when validated | Hook is optional and requires trusted configuration. |
| OpenCode | OpenCode | `/triad` | Explicit dispatch | No Triad lifecycle hook. |
| Antigravity | Antigravity | `/triad` | Explicit dispatch | No Triad lifecycle hook. |
| Hermes Agent | Hermes Agent | `/triad` | Explicit dispatch | No Triad lifecycle hook. |
| GitHub Copilot | GitHub Copilot CLI and desktop app | `/triad` when the project skill is exposed, otherwise `/agent` → `triad-orchestrator` | Explicit dispatch | No adapter hook; desktop app supports the complete validated lifecycle. |

Install with `npx triad-plus init --host <runtime> --control <path>`; use
`--global` when you want host-level command assets. `doctor` reports the runtime
binary, adapter assets, verifier, team file, and optional Evaluator+ state.

Hermes installs user skills into the active Hermes profile. Its role invocations
must bind terminal operations to the declared worktree; this is handled by its
adapter instructions. It is supported, not experimental.

See the concise host guides for [Codex](codex-replication.md),
[Claude Code](claude-code-replication.md), [OpenCode](opencode-replication.md),
and [Antigravity](antigravity-replication.md).

## GitHub Copilot

The Copilot adapter uses the documented custom-agent and agent-skill primitives.
Install it with:

```bash
npx triad-plus init --host copilot --control /absolute/path/to/triad-control --global
npx triad-plus doctor --host copilot --control /absolute/path/to/triad-control
```

Project agents are generated under `.github/agents/` and the Triad skill under
`.github/skills/triad/`; `--global` also installs the corresponding assets under
`~/.copilot/`. Open the control workspace in the Copilot desktop app. Use
`/triad <absolute-prd-path>` when the skill is available as a command; otherwise
select `triad-orchestrator` through `/agent` and provide the same request.
Verification is explicit by default and no Copilot lifecycle hook is required.

The desktop app has been validated with distinct Orchestrator, Developer, and
Reviewer contexts through a complete unattended Triad run. The adapter uses
explicit verification and has no lifecycle hook; the CLI and asset paths are
validated independently as well.

## OpenCode

Use the interactive OpenCode TUI for complete multi-step Triad runs. OpenCode
1.18.x validated the full Orchestrator → Developer → verifier → Reviewer →
configured Evaluator+ lifecycle in the TUI. `opencode run` is useful for
one-shot work but does not retain that multi-step parent/subagent lifecycle.
