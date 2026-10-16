# Getting started

Triad+ keeps project-control records outside product repositories. Start in the
root of a dedicated Control Workspace, with a runtime already available on your
machine. Product repositories and worktrees are separate and must be mapped
explicitly in `project.yaml`; Triad+ does not discover them by scanning folders.

Create `PRD.md` at this root with a small goal, one observable acceptance
criterion, and a deterministic verification command such as a focused test.
Then initialize the project-local OpenCode assets and open the host here:

```bash
npx triad-plus init --host opencode --control .
npx triad-plus doctor --host opencode --control .
opencode
```

In the OpenCode TUI opened at this root, run `/triad ./PRD.md` (or `/triad` to
use the root `PRD.md` default). Bootstrap snapshots the selected source to
immutable `artifacts/prd.md` and records its SHA-256; keep the root source
unchanged. An external or absolute PRD path is also supported when preferred.
For host support and limitations, see
[`npx-installation.md`](npx-installation.md).

The expected execution path is:

```text
Orchestrator → Developer → verifier evidence → Reviewer → approved | rework | blocked
```

The host agent governs the conversation. Triad+ does not start product services
or demonstrations unless you explicitly request them.
