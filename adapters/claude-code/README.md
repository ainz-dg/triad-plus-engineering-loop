# Triad+ Engineering Loop for Claude Code

This adapter installs the shared six Triad skills, three isolated Claude Code
subagents, the `/triad` command, and—on a project installation—the Node control
plane. It does not modify global Claude settings or automatically activate a
hook.

## Install into a project-control repository

```bash
./adapters/claude-code/install.sh --project /path/to/project-control-repository
```

It creates:

```text
.claude/agents/triad-developer.md
.claude/agents/triad-evaluator.md
.claude/agents/triad-reviewer.md
.claude/commands/triad.md
.claude/skills/triad-loop-*/
.claude/triad-hooks.json
.triad-runtime/
```

The installer refuses all collisions before copying. `.claude/triad-hooks.json`
is an inert, reviewable fragment: merge it into the trusted Claude Code settings
only after replacing its paths and confirming it through `/hooks`.

## Start and verify

Launch Claude Code in the control repository, then use:

```text
/triad <PRD location or concise project request>
```

The command delegates Developer, Evaluator, and Reviewer to fresh subagents.
Confirm them with `/agents`; confirm skills with `/skills`. The project control
plane detects Claude Code and Node at bootstrap. It selects `hook_dispatch` only
when an actual `SubagentStop` hook is configured; otherwise it selects the
first-class `explicit_dispatch` route, where the orchestrator runs the verifier
after developer completion.

## Model choices

`.triad-plus/team.json` preserves requested project role model intent. Current
generated `.claude/agents/*.md` files omit unverified `model` overrides, so
these requests are not applied as native per-role routing. The host/session
default is used after explicit preflight consent; its effective identity is not
attested by READY. Generated agent files are managed outputs; do not use them
as a separate configuration source.

`team.json.reasoning_effort` is requested intent and is not applied or verified
by this adapter in the current release scope. Select any required model/effort
through the host's native controls and do not treat that selection as verified
unless the host supplies reliable session evidence.

## Global installation

```bash
./adapters/claude-code/install.sh --global
```

This installs agents, command, and skills below `~/.claude/`, but deliberately
does not install a project runtime or activate lifecycle hooks globally.
