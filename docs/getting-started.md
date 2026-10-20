# Getting started

Triad+ keeps project-control records in a dedicated **Control Workspace**,
separate from product repositories. The terminal wizard is the normal
first-run path; it does not scan sibling folders or create a PRD, quality
gates, repository commits, or worktrees for you.

For a single procedural OpenCode journey from an empty Control Workspace to
reading the reports and Cockpit, follow the
[OpenCode first-loop tutorial](tutorials/opencode-first-loop.md).

## 1. Install and onboard

Start from a directory outside the product repository, then launch the wizard:

```bash
mkdir triad-control && cd triad-control
npx triad-plus
```

Choose **New workspace**, confirm this separate Control Workspace root, map
the existing local product repository and its branch/worktree details, and
select the OpenCode adapter. Review the complete preview and type exactly
`install` to apply it. The wizard does not clone repositories, push changes, or
write global host configuration. For the full setup behavior and limitations,
see [npx installation](npx-installation.md). Selecting an adapter installs its
project-local entry; it does not prove native host discovery or route an Attempt
to that host. See the [adapter compatibility matrix](compatibility.md).

## 2. Add the project inputs and check readiness

At the Control Workspace root, create `PRD.md` with a small goal, one
observable acceptance criterion, and a deterministic verification command.
Also add `.loop/quality-gates.yaml`, make an initial commit in each mapped
repository, and create the declared worktree. Setup does not create these
inputs implicitly. Then check readiness:

```bash
npx triad-plus doctor --host opencode --control .
```

Resolve any reported missing inputs before starting the host. Open OpenCode in
the Control Workspace and start the loop with `/triad ./PRD.md` (or `/triad`
to use the root PRD). Bootstrap snapshots the source to immutable
`artifacts/prd.md` and records its SHA-256; keep the source unchanged. Direct
`init` remains available for scripts and advanced setup, but is not the
first-run wizard path.

## 3. Follow the Card and evidence

The normal path is:

```text
Orchestrator → Developer → verifier evidence → Reviewer → approved | rework | blocked
```

The Reviewer considers the Card, diff, Developer report, and verifier evidence.
A declared `in_progress` state is not proof that an agent is currently active;
Triad+ does not record agent liveness. See the [operating guide](operating-guide.md)
and the [Italian operating guide](operating-guide.it.md).

## 4. Read the Markdown reports

When canonical Card, attempt, verifier, and Reviewer records are available, the
Orchestrator can explicitly invoke the deterministic report renderer to write
`card-reports/<card-id>.md` and `handoff.md`. The renderer being available does
not mean those files have been generated: absent outputs remain absent until
the renderer is invoked with derived context. They are portable, read-only
views, not new approval evidence. See the [human-readable reports guide](human-readable-reports.md)
for the required context and commands.

## 5. Open Cockpit after data exists

After the Control Workspace contains project/Card/attempt data, open the local
read-only Cockpit:

```bash
npx triad-plus cockpit
```

From the Control Workspace, Cockpit validates the current directory and opens
the one-time loopback URL in a local interactive browser when safe. The URL is
always printed; use `--no-open` to disable automatic opening or
`--control <path>` to select a workspace explicitly. Cockpit shows persisted
records and evidence; it does not start agents or provide liveness monitoring.
For its security and data interpretation details, see the [Cockpit guide](../cockpit/README.md).
