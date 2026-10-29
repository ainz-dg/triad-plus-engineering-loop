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

Choose **New workspace** and confirm this separate Control Workspace root.
The product-repository screen lists read-only immediate-child Git roots with
their current branches. Use Up/Down to focus, Space to select, and Enter to
confirm one or more repositories; Enter with none selected explains the
required action. Use **Add repository by path** for an explicitly supplied
existing local Git root outside that list, or choose **Create greenfield
repository** / **Defer repository configuration**. Greenfield paths remain a
text-entry flow in this prototype. A selected repository's directory name
suggests its stable ID, project branch, and worktree mapping; these remain
editable and pass the existing safety validation. The selected path and
detected base branch are shown in the mapping step.

Select one or more harnesses on the next checkbox screen with the same keys:
OpenCode, Codex, Claude Code, GitHub Copilot, Antigravity, and Hermes Agent.
The first harness selected is visibly marked as primary because it supplies
the current singleton runtime metadata; multi-harness installation does not
provide per-Attempt cross-harness dispatch. Escape cancels from repository
selection and goes back from harness selection. Ctrl+C exits without applying
the plan. The concise confirmation can be expanded with `details`; when a
user-level entry is selected, reviewing its exact paths is required before
typing exactly `install` to apply the plan. The selected adapter's project assets can be installed
without its native host executable being present; setup does not probe host
availability. An additional optional screen can select the Codex `$triad` or
Hermes `/triad` user-level entry. The concise plan can be expanded with
`details`; when a user-level entry is selected, that exact-path review is
required before `install` is accepted. Skipping it leaves user-level files
unchanged. The wizard does not clone repositories or push changes. For full
setup behavior and limitations, see
[npx installation](npx-installation.md). Selecting an adapter does not prove
native host discovery or route an Attempt to that host. See the
[adapter compatibility matrix](compatibility.md).

## 2. Add the project inputs and check readiness

At the Control Workspace root, create `PRD.md` with a small goal, one
observable acceptance criterion, and a deterministic verification command.
Also add `.loop/quality-gates.yaml`, make an initial commit in each mapped
repository, and create the declared worktree. Setup does not create these
inputs implicitly. The wizard's first-run summary is an installation plan; it
does not inspect or attest to project readiness, probe host availability,
assess PRD or gate quality, or execute gates. Check the project inputs
separately. `doctor` diagnoses selected adapter installation, managed assets,
the host executable, and available host/verifier configuration; it is not a
readiness check and does not run quality gates.

Run `doctor` separately for host and installation diagnostics:

```bash
npx triad-plus doctor --host opencode --control .
```

Resolve structural gaps from the preview yourself, and address any host or
installation issue reported by `doctor`. Open OpenCode in the Control
Workspace and start the loop with `/triad ./PRD.md` (or `/triad` to use the
root PRD). Bootstrap snapshots the source to immutable
`artifacts/prd.md` and records its SHA-256; keep the source unchanged. Direct
`init` remains available for scripts and advanced setup, but is not the
first-run wizard path. A successful `init --host ... --control ...`
confirms installation of adapter assets, **not** creation of `project.yaml`,
root `PRD.md`, quality gates, or mapped Git worktrees. Do not infer loop
readiness from adapter installation alone. The declared deterministic gates
are run later by `triad-verify` for an Attempt's recorded candidate.

## 3. Follow the Card and evidence

The normal path is:

```text
Orchestrator → Developer → verifier evidence → Reviewer → approved | rework | blocked
```

The Reviewer considers the Card, diff, Developer report, and verifier evidence.
A declared `in_progress` state is not proof that an agent is currently active;
Triad+ does not record agent liveness. See the [operating guide](operating-guide.md)
and the [Italian operating guide](operating-guide.it.md).

### Optional: plan draft PR delivery

Before the first Developer assignment, the Orchestrator can show an opt-in PR
grouping plan and request **one explicit owner approval** of its structure.
After normal Card verification and independent review, the approved structure
can be reused with fresh, byte-bound evidence to prepare draft PRs; no further
structural approval is needed unless the scope changes. This requires separately
prepared snapshots and exact group branch/worktree bindings, and never
authorizes automatic merge or release. The default manual delivery path is
unchanged. See [PR planning and prerequisites](pr-planning.md).

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
