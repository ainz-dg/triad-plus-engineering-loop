# GitHub Copilot adapter

This adapter targets the GitHub Copilot CLI and the GitHub Copilot desktop app
using their documented custom-agent and agent-skill primitives.

Project assets are installed under `.github/agents/` and `.github/skills/triad/`;
`--global` additionally installs role profiles and the Triad skill under
`~/.copilot/agents/` and `~/.copilot/skills/`. The project/control workspace is
the source of run configuration; one workspace selects one host adapter.

Use `/triad <absolute-path-to-prd>` when the project skill is available. If the
surface does not expose the skill as a slash command, select
`triad-orchestrator` with `/agent` and provide the same PRD request. The
adapter always uses explicit verification dispatch and has no lifecycle hook.

`.triad-plus/team.json` preserves requested role model/effort intent. Current
generated custom-agent assets omit unverified `model` and `reasoningEffort`
overrides; no per-role routing is applied or verified. Use the host's explicit
session/default controls when available. The CLI/IDE/desktop surfaces have
different capabilities; skill discovery and adapter fixtures do not attest a
native Copilot model session in the v1.22.4 release scope.
