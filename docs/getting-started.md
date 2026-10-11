# Getting started

Triad+ keeps project-control records outside product repositories. Choose an empty
directory for that workspace and a runtime available on your machine.

```bash
npx triad-plus
```

The terminal wizard guides first-time setup and management. It detects a valid
Control Workspace manifest in the current directory and defaults to managing
that workspace. Otherwise, it defaults to new setup; choose **Manage existing**
and enter a path explicitly to manage another workspace. Triad+ does not search
sibling directories. In the management menu, list and doctor/status are
read-only; add, upgrade, and remove first show the existing CLI preflight and
proceed only when you type the exact word `apply`. Cancellation makes no
changes. Multi-adapter actions remain project-local and do not select a host
for the next Attempt.

For non-interactive setup, pass a reviewed team file:

```bash
npx triad-plus init --host opencode --control "$PWD/triad-control" --team-config ./team.json
```

Open `triad-control` in the selected host and invoke its native Triad entry
point with an absolute PRD path. The Orchestrator snapshots the PRD, asks only
for missing measurable facts, and shows feature cards before implementation.

For the first run, use a small PRD with one observable acceptance criterion and
one deterministic command such as a focused unit test. The expected path is:

```text
Orchestrator → Developer → verifier evidence → Reviewer → approved | rework | blocked
```

The host agent governs the conversation. Triad+ does not start product services
or demonstrations unless you explicitly request them.
