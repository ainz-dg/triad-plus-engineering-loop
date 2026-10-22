# Triad+

<p align="center">
  <img src="assets/triad-plus-engineering-loop-icon.svg" alt="Triad+ logo" width="220">
</p>

## Stop letting the same AI write the code and approve its own work.

Triad+ gives coding agents a lightweight engineering loop with separate
implementation, review, and orchestration.

> **Developer proposes. Reviewer challenges. Orchestrator governs.**

## Why Triad+?

| | What changes |
| --- | --- |
| **Independent review** | A Reviewer examines the candidate and verifier evidence instead of asking the Developer to grade its own work. |
| **Different models per role** | Choose models, personas, and supported effort per role within one selected runtime. |
| **Evidence-backed verification** | A claim that tests passed is not proof: `triad-verify` records environment-derived gate evidence. |
| **Works across coding agents** | Use Codex, Claude Code, OpenCode, Antigravity, Hermes Agent, or GitHub Copilot through peer adapters. |

Triad+ is for the moment after a coding agent says “done”: it gives that claim a
separate reviewer, deterministic checks, and an orchestrator that decides what
happens next.

## When to use Triad+

Triad+ is not meant to be the default for every coding task.

A single coding agent is a reasonable candidate when all of the following are
true:

- the change is localized, mechanical, or repetitive;
- the diff and scope are small and explicit;
- deterministic tests or oracles strongly cover the required behavior;
- there is no shared-state, concurrency/order, public API or backward-
  compatibility, parsing/security-sensitive, or material architecture risk;
- the blast radius is low and the change is easy to reverse; and
- repository-policy, skill, and integration ambiguity is absent.

If any of those conditions are not clearly satisfied, Triad+ remains the
conservative path: it adds deterministic evidence, an independent Reviewer,
and Orchestrator-governed rework.

This choice happens **before** entering Triad+. Once a task enters the loop, the
normal `Developer → verification → Reviewer` path remains mandatory; this
guidance selects between that full path and the single-agent candidate path, not
a partial Triad mode.

This guidance is based on a small, stratified benchmark and is intentionally
conservative. The benchmark supports low-risk single-agent use as a candidate
optimization; it does not prove that every higher-risk task benefits from
Triad+ or that independent review has no value.

## How it works

```text
                   Orchestrator
                   /           \
            Developer  ←→  Reviewer
                   ↓
             triad-verify evidence

Reviewer approved
       ↓
Evaluator+ (only when configured; fresh and post-run)
```

The normal path is `Developer → verification → Reviewer → approved | rework |
blocked`. The Orchestrator governs the loop. When configured, Evaluator+ runs
automatically after approval with a fresh packet; a `FAIL` is information for a
future user-initiated run, never an automatic repair.

## Get started

OpenCode is the canonical tutorial because it is open source and makes the
separate Triad roles easy to inspect. Setup and run time depend on your host and
project; this guide does not promise that a full loop finishes in five minutes.

### One quickstart: root Control Workspace and root PRD

Start outside the product repository. The wizard asks you to choose a dedicated
Control Workspace, map local product repositories/worktrees explicitly, select
adapters, optionally select a Codex or Hermes user-level entry, and review every
target before the exact `install` confirmation. The optional entries are not
written unless selected and approved. Setup does not clone repositories or push
changes.
For the step-by-step path, see [Getting started](docs/getting-started.md).
For the complete OpenCode walkthrough—from setup and readiness through a first
loop, its evidence, human-readable reports, and the read-only Cockpit—see the
[OpenCode first-loop tutorial](docs/tutorials/opencode-first-loop.md).

```bash
npx triad-plus
```

After setup, create root `PRD.md` and `.loop/quality-gates.yaml`, commit the
mapped repositories, and create their declared worktrees; the wizard does not
create these inputs. Its preview checks only their structural presence (plus
an initial commit and configured worktree path for each mapping). It does not
judge PRD or gate quality, nor run the gates. `doctor` is a separate host and
installation diagnostic: it does not establish project readiness or execute
the gates. Review both outputs for their distinct purposes, then start OpenCode:

```bash
npx triad-plus doctor --host opencode --control .
opencode
```

In OpenCode, run `/triad ./PRD.md` (or `/triad` to use the root default).
`init` remains the scriptable alternative to the first-run wizard:

```bash
npx triad-plus init --host opencode --control .
npx triad-plus doctor --host opencode --control .
```

The Orchestrator first shows the feature cards, then delegates the bounded work.
If a tutorial step is unclear, see the [OpenCode guide](docs/runtimes.md#opencode)
and [troubleshooting](docs/troubleshooting.md).

For deterministic, owner-approved draft PR grouping and creation from verified
Triad snapshots, see [PR planning](docs/pr-planning.md). This is an opt-in
post-run delivery primitive: the Orchestrator does not yet generate snapshots
or schedule draft creation automatically. Draft creation is opt-in; merge,
release, push, and force-push actions are outside that tool.

## Installation version and safe uninstall

For interactive setup or day-to-day management, run `npx triad-plus` in a
terminal. A valid Control Workspace manifest in the current directory defaults
to the management menu; without one, the wizard defaults to new setup. To
manage a workspace elsewhere, choose **Manage existing** and provide its path
explicitly. The wizard does not search sibling directories. Its menu lists
adapters and offers add, doctor/status, upgrade, remove, and exit. Every
mutation runs the existing CLI preflight first and requires the exact `apply`
confirmation; canceled or conflicting plans make no changes. Management is
project-local and does not select a host for the next Attempt.

The CLI version and the version materialized in a control workspace are
reported independently:

```bash
npx triad-plus --version
npx triad-plus version --control /absolute/path/to/triad-control
```

Successful `init` and `upgrade --apply` operations record exact Triad-owned
files in `.triad-plus/installation.json`. This manifest does not own
`.triad-plus/team.json`, `.loop/`, product files, or evidence.
`init` is the first-install path; `upgrade --apply` is also the managed
update/repair/restore path for a registered workspace, including one left
`uninstalled` or `partial` by safe uninstall.

Uninstall is conservative and dry-run by default:

```bash
npx triad-plus uninstall --host opencode --control /absolute/path/to/triad-control
npx triad-plus uninstall --host opencode --control /absolute/path/to/triad-control --apply
```

Only unchanged files recorded by the manifest are removed. Modified or
unknown files are preserved and reported; user state remains available for a
future installation or review. Generic host directories are never pruned. A
managed `AGENTS.md` role-run block is removed only when its markers and hash
are exact; surrounding user content is preserved. Global assets are shown but
preserved by default with `--global` because another control workspace may
share them.

Schema-v2 workspaces can inventory multiple project-local adapters without
overwriting one another. `adapter list` and `adapter doctor` are read-only;
`adapter add`, `adapter upgrade`, and `adapter remove` use explicit local
ownership records and conservative hash checks. This is an installation
foundation, not multi-host dispatch: an Attempt does not yet select an adapter,
and the CLI reports dispatch as unsupported rather than choosing the last-added
host. The first-run wizard can also install the optional Codex `$triad` and
Hermes `/triad` user-level entry files. It previews every absolute profile path
and exact file, and writes only after `install` is typed; existing or
conflicting profile files are never overwritten. Codex and Hermes entries are
model-level wrappers: they validate the project-local workspace before Triad
work but cannot enforce a pre-LLM host boundary. Native host discovery and full
application invocation still require smoke tests.
The terminal menu is the normal path; direct `adapter` commands remain useful
for scripts and advanced use. See [multi-adapter details](docs/npx-installation.md#local-multi-adapter-inventory).

## Optional immutable quality target

An initialized project may bind an immutable JSON Quality Baseline through
`project.quality_contract`. Triad fingerprints the canonical manifest, verifies
all declared sources before running costly gates, and fails closed on malformed
contracts or source drift. `product_quality` criteria are evaluated one by one
by a fresh Evaluator+; `delivery_closure` criteria remain in the delivery gate.
Projects without this opt-in continue to use the legacy PRD baseline path.

## Native BMAD handoff

BMAD planning hands `epics.md` to Triad+ directly. Start the normal host entry
point with the planning artifact (or its `_bmad-output` directory):

```text
/triad /absolute/path/to/_bmad-output/planning-artifacts/epics.md
```

Triad deterministically detects Epic and Story sections, ingests multiple
Stories without creating intermediate Story files, resolves repository and
quality-gate readiness from the project-control workspace, and materializes
normal Cards with source SHA/provenance. `epics.md` remains read-only. BMAD owns
planning; Triad owns execution, verification, review, and delivery.

`import-bmad-story` remains a low-level compatibility/API path for standalone
ready-for-dev Stories, debugging, and automation. It is no longer the primary
BMAD workflow. See the [BMAD integration guide](docs/bmad-integration.md).

## Human-readable delivery reports

Triad+ can materialize deterministic Markdown views from canonical control-plane
records: one report for each terminal Card and a human-first final handoff. The
Orchestrator must explicitly invoke the renderer with derived context; the
renderer being available does not mean a report has been generated. The views
include baseline-attributed changed paths, attempts, verifier gates,
independent review, provenance, residual risks, and practical-test links. They
never replace JSON/YAML evidence or add an LLM reporting call. See the
[human-readable reports guide](docs/human-readable-reports.md).

## Triad Cockpit (read-only web view)

```bash
npx triad-plus cockpit
```

Run this from the Control Workspace after project/Card/attempt records exist;
the current directory is validated automatically. Use `--control <path>` to
select a different workspace or `--no-open` to disable automatic browser
opening. On a local interactive desktop, the command starts a local web view
on `127.0.0.1`, opens the one-time link when safe, and always prints that link
as a fallback. It shows persisted cards,
attempts, verifier evidence, review documents, Evaluator+ results, and
artifacts. Every item says who wrote it: Triad+ code, a Triad+ validator, or
an agent's declaration. A declared `in_progress` state does not show that an
agent is currently active; Triad+ does not record agent liveness.

It is read-only. It never starts agents, approves work, or writes to the
workspace. The compiled UI ships in this package, so there is nothing more to
install. See the [Cockpit guide](cockpit/README.md).

## Quick start for every runtime

Requirements: Node.js 20+ and one supported coding-agent host.

Run `npx triad-plus` and use the setup wizard. Select Codex and/or Hermes under
**Optional global entry bridge** if you want user-level commands. The final
preview lists the exact profile files and writes them only after the `install`
confirmation. Without that selection, no user-level files are changed.

Open the control workspace in the selected host and start Triad with an absolute
PRD path:

| Host | Entry point |
| --- | --- |
| Codex | `$triad /absolute/path/to/prd.md` |
| Claude Code | `/triad /absolute/path/to/prd.md` |
| OpenCode | `/triad /absolute/path/to/prd.md` |
| Antigravity | `/triad /absolute/path/to/prd.md` |
| Hermes Agent | `/triad /absolute/path/to/prd.md` (active Hermes profile) |
| GitHub Copilot | `/triad /absolute/path/to/prd.md` or select `triad-orchestrator` with `/agent` |

## Evaluator+

Evaluator+ is not a fourth member of Triad and is never a repair controller.
Configure it once in `team.json` (`roles.evaluator.enabled: true`) or in the
installer. The Orchestrator automatically dispatches it after Triad approval.
It sees only the goal, quality target, final candidate, and verifier evidence.

## Supported coding agents

| Runtime | Orchestrator | Developer | Reviewer | Evaluator+ | Verification dispatch |
| --- | --- | --- | --- | --- | --- |
| Codex | Yes | Yes | Yes | Yes | Explicit dispatch by default; experimental async hook opt-in |
| Claude Code | Yes | Yes | Yes | Yes | Explicit fallback; validated hook when available |
| OpenCode | Yes | Yes | Yes | Yes | Explicit dispatch |
| Antigravity | Yes | Yes | Yes | Yes | Explicit dispatch |
| Hermes Agent | Yes | Yes | Yes | Yes | Explicit dispatch |
| GitHub Copilot | Yes | Yes | Yes | Yes | Explicit dispatch; no lifecycle hook |

## Configuration and verification

The installer writes `.triad-plus/team.json`, which separates stable role IDs
from user-facing names, personas, models, and supported effort/options. A
schema-v1 control workspace still uses one selected adapter for its run. Schema
v2 can record several local adapters, but runtime dispatch remains single-host
and is not Attempt-bound yet; installing another adapter does not change the
existing `.triad-runtime/adapter.json` selector. Different hosts are never
blended within an Attempt. Read [configuration](docs/configuration.md) and
[runtime details](docs/runtimes.md).

The installed `triad-model-configuration` Agent Skill lets the host agent
inspect or change requested role models while preserving `team.json` as the
source of truth and reporting host-specific binding limits.

On OpenCode, `team.json`'s `reasoning_effort` is materialized as the native
per-agent `variant`; the OpenCode session default is a separate host setting.

`triad-verify` validates assignment/candidate binding, runs declared
control-plane gates, detects mutation, and writes evidence. It supports the
loop; it never replaces the Orchestrator. See [verification](docs/verification.md).

## Scope and limitations

Triad+ is deliberately not a workflow engine, daemon, scheduler, dashboard-
driven control plane, shared-memory system, automatic model router,
multi-reviewer system, or evaluator-driven repair loop. The optional Triad
Cockpit is a read-only viewer started on demand: it cannot start agents,
approve work, or change state. See [architecture](docs/architecture.md).

## Contributing

Start with [CONTRIBUTING.md](CONTRIBUTING.md). Keep runtime-specific behavior in
an adapter and preserve the small Core.

## License

[Apache-2.0](LICENSE). Triad+ is permissively licensed for personal and
commercial use.
