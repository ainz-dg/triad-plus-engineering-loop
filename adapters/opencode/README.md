# Triad+ Engineering Loop for OpenCode

This adapter makes the repository's existing six standard Agent Skills
operational in OpenCode. It installs four specialized agents and the `/triad`
command; it does not duplicate the method or alter `opencode.json`.

## Install into one project-control repository

From the root of this cloned repository, run:

```bash
./adapters/opencode/install.sh --project /path/to/project-control-repository
```

The installer copies the following into the selected repository's `.opencode/`
directory:

```text
agents/triad-orchestrator.md
agents/triad-developer.md
agents/triad-evaluator.md
agents/triad-reviewer.md
commands/triad.md
skills/triad-loop-bootstrap/
skills/triad-loop-orchestrator/
skills/triad-loop-developer/
skills/triad-loop-evaluator/
skills/triad-loop-reviewer/
skills/triad-model-configuration/
.triad-runtime/
  triad-verify.mjs
  triad-runtime-capabilities.mjs
  schemas/
```

It checks every destination before copying and stops if any would be
overwritten. A project installation also copies the Node control-plane runtime
to `.triad-runtime/`; no global settings, credentials, product source, or
worktrees are copied.

## Optional global installation

To make Triad available in all OpenCode projects for the current user:

```bash
./adapters/opencode/install.sh --global
```

This writes only the Triad agents, command, and skills below
`~/.config/opencode/`. A project-local installation is preferable when teams
need the configuration versioned with the project-control repository. Global
installation intentionally does not copy a control-plane runtime because it must
remain in a declared project workspace.

## Configure models deliberately

`.triad-plus/team.json` is the source of truth for role-level model
configuration. When a team file supplies values, Triad+ materializes the
OpenCode-native `model` and `reasoningEffort` frontmatter fields in each
project agent definition during `init` and `upgrade --apply`:

```text
team.json model             → OpenCode model
team.json reasoning_effort → OpenCode reasoningEffort
```

Do not treat generated `.opencode/agents/*.md` files as an independent
configuration source; a later managed upgrade regenerates them from
`.triad-plus/team.json`. A `null` or blank value leaves the corresponding field
absent so OpenCode uses its host/session default.

The adapter only writes fields supported by this OpenCode materialization. Host
and provider capabilities may still limit which model or reasoning levels are
available. Inspect identifiers with `opencode models` and keep role-specific
routing explicit in the team file:

| Agent | Recommended profile |
| --- | --- |
| `triad-orchestrator` | Reliable planning and orchestration model, medium reasoning. |
| `triad-developer` | Highest-capability implementation model. |
| `triad-evaluator` | Fresh, independent quality-comparison model. |
| `triad-reviewer` | Independent, reliable review model, medium reasoning. |

Use `opencode models` to inspect the provider/model identifiers available in
the local installation. Keep the developer, evaluator, and reviewer separately
configured when independent model routing is required.

## Start the loop

Launch OpenCode from the project-control repository, then enter:

```text
/triad <PRD location or concise project request>
```

For a new project, the orchestrator asks only for missing essentials that
prevent safe setup or measurable cards, creates the control artifacts outside
product repositories, declares the card plan, and begins. For an existing
project, give its project ID or control-workspace path after `/triad` and it
resumes from the recorded state.

The developer, evaluator, and reviewer are hidden implementation subagents. The
orchestrator can invoke only those three through the Task tool; the evaluator and
reviewer have read-only file permissions but can run verification commands. The agents allow
access to declared external worktrees so a multi-repository project can operate
from its control repository. Their prompts still restrict work to paths,
branches, and worktrees declared in the project manifest.

OpenCode uses the capability-selected `explicit_dispatch` verification route:
the orchestrator invokes `.triad-runtime/triad-verify.mjs` after the Developer
stops and then validates its evidence. It records this decision by running
`.triad-runtime/triad-runtime-capabilities.mjs --host opencode`; no undocumented
OpenCode lifecycle hook is assumed.

## Verify installation

From the selected control repository, confirm that OpenCode discovered the
agents:

```bash
opencode agent list
```

Then open the TUI and type `/triad`. The command description should appear.
Before using the adapter for real delivery, follow the forward test in the
[Codex replication guide](../../docs/codex-replication.md#forward-test-before-adopting): the
same observable checks validate this OpenCode adapter.
