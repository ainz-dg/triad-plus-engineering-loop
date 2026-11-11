# Runtime adapters

Every adapter installs the same role skills and verifier runtime, while retaining
host-specific entry points and configuration behavior.

The table describes adapter-provided entry and verifier paths. Project asset,
contract, and fixture coverage is not evidence of a native session on every
host. In the v1.22.4 release scope, only OpenCode 1.19.3 has a live package E2E,
using the shared host default; per-role model/effort routing is not verified.

| Runtime | Prerequisite | Entry point | Verification | Hook limitation |
| --- | --- | --- | --- | --- |
| Codex | Codex CLI | `$triad` (optional user-level native skill) | Explicit dispatch by default; experimental async hook opt-in | Hook is optional, requires trusted configuration, and is not selected by `auto`. |
| Claude Code | Claude Code CLI | `/triad` | Explicit dispatch; hook when validated | Hook is optional and requires trusted configuration. |
| OpenCode | OpenCode | `/triad` | Explicit dispatch | No Triad lifecycle hook. |
| Antigravity | Antigravity | `/triad` | Explicit dispatch | No Triad lifecycle hook. |
| Hermes Agent | Hermes Agent | `/triad` | Explicit dispatch | No Triad lifecycle hook. |
| GitHub Copilot | GitHub Copilot CLI and desktop app | `/triad` when the project skill is exposed, otherwise `/agent` → `triad-orchestrator` | Explicit dispatch | No adapter hook; live desktop/CLI lifecycle is not attested in this release scope. |

Run `npx triad-plus` for the first-install wizard. It can optionally install
the Codex `$triad` skill or Hermes `/triad` wrapper after displaying each
exact absolute target and requiring the final `install` confirmation. Direct
global `init`/`upgrade` and legacy global scripts refuse these two entries.
`doctor` reports the runtime binary, adapter assets, verifier, team file, and
optional Evaluator+ state.

When selected, the Hermes bridge installs only its `/triad` wrapper files into
the active Hermes profile; shared role skills remain project-local. Its role
invocations must bind terminal operations to the declared worktree; this is
handled by its adapter instructions. It is supported, not experimental.

The Codex and Hermes wrappers run a deterministic project-local check before
Triad work: current Control Workspace, installation manifest and managed-file
hashes, adapter metadata, PRD, quality gates, and explicitly declared Git
repositories/worktrees. A failure stops without searching other workspaces or
changing files and offers an explicit workspace path, setup wizard, or cancel.
Because the wrapper itself is invoked by the host model, this is not a pre-LLM
security boundary. Full native-host invocation still needs host-specific smoke
testing.

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

The project skill was recognized by Copilot CLI during isolated capability
inspection. A native Copilot model session is not attested here. Its adapter
uses explicit verification and has no lifecycle hook; CLI and asset contracts
are distinct from a live desktop/CLI workflow.

## OpenCode

Use the interactive OpenCode TUI for complete multi-step Triad runs. OpenCode
1.19.3 was used for the live package E2E in this release scope. The acceptance
covered Orchestrator → Developer → verifier → Reviewer; all three roles used
the shared host default. It did not validate per-role model routing or the
configured Evaluator+ lifecycle. `opencode run` is useful for one-shot work but
does not retain that multi-step parent/subagent lifecycle.
