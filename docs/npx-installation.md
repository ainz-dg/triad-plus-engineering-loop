# Install Triad+

Triad+ installs a project-control workspace, not application code. Keep it
outside product repositories whenever possible.

For the recommended first-run journey from wizard through PRD, evidence,
Markdown reports, and Cockpit, see [Getting started](getting-started.md).

```bash
npx triad-plus
```

The terminal wizard is the normal setup and management path. If the current
directory contains a valid Control Workspace manifest, it defaults to managing
that workspace. Otherwise it defaults to creating a new workspace; selecting
management then requires an explicit existing path. It never searches sibling
directories.

### New-workspace onboarding

For a new workspace, the wizard asks for a Control Workspace root. The default
is the current directory when it is outside a Git repository; if the current
directory is inside a Git root, the wizard requires a separate path and does
not generate a sibling path or migrate the product repository. A valid
installation already present at the chosen root is not overwritten: the
wizard asks whether to manage it or choose another root.

Repository configuration is explicit. The keyboard checklist suggests only
immediate-child Git roots, with their current branches; use Up/Down to focus,
Space to select, and Enter to confirm up to 20 repositories. Nothing is added
without an explicit selection. **Add repository by path** accepts an explicitly
provided existing local Git root without widening discovery. **Create
greenfield repository** initializes selected empty paths only after approval;
that path collection remains text-based in this prototype. **Defer repository
configuration** leaves mappings empty and readiness **NOT READY** until the
owner adds them later.

For an existing selected Git root, the directory name suggests a stable ID,
project branch, and worktree mapping; the selected path and detected base
branch are shown. Each value remains editable and goes through the same
deterministic path, branch, symlink, overlap, and preflight validation. No
repository is inferred from the numeric keyboard or prompt position. The
wizard does not clone URLs, create worktrees, or change a product repository.
It writes only the repository mapping portion of `project.yaml`, preserving
unrelated content.

The next keyboard checklist shows all six registered adapters. Use Space to
toggle and Enter to confirm one or more. The first adapter selected is visibly
marked primary and continues to determine singleton runtime metadata and the
existing team/model setup behavior; the manifest's adapter membership is
normalized independently. Installing several adapters does **not** enable
per-Attempt cross-harness dispatch. Escape cancels repository selection and
backs out from adapter selection; Ctrl+C exits without applying the plan.
The registered adapters are OpenCode, Codex, Claude Code, GitHub Copilot,
Antigravity, and Hermes Agent.

After project adapters are selected, the wizard can optionally install the
Codex-native `$triad` skill and/or Hermes `/triad` wrapper at user level. It
resolves and displays every absolute file target (Codex: the native skill plus
`CODEX_HOME/triad-plus/host-entry-preflight.mjs`; Hermes: the active profile's
`skills/triad/` wrapper plus `~/.hermes/triad-plus/host-entry-preflight.mjs`).
It also displays an exact workspace-specific binding path for each selected
entry. That binding pins the canonical Control Workspace, its local manifest,
and expected project/global runtime bytes, and is written only after the owner
approves the exact final preview. Byte-identical shared bridge files are
labeled for reuse; workspace bindings are separate, so another approved
workspace does not replace an existing binding. A different existing file is
a preflight conflict and is never overwritten. The legacy
Codex `$CODEX_HOME/prompts/triad.md` file is never migrated, overwritten, or
deleted; if present, the wizard reports the name collision and blocks the
optional native skill install until the owner backs it up under another name
or deselects the Codex global entry. Skipping this step writes no user-level
files. An optional team-identity/model configuration
may also be requested. The final preview covers the Control Workspace, mapping
changes, selected project and global assets, primary runtime adapter, and
initial readiness. Type `install` to apply that exact plan; any other answer
cancels. Global bridge files are written only after that final consent; no
credentials or account settings are changed. Direct global `init`/`upgrade`
and the legacy Codex/Hermes `install.sh --global` paths refuse the bridge so
they cannot bypass this preview.

Preflight refuses a Control Workspace inside a product Git root, unsafe paths,
and asset conflicts. Before applying, setup rechecks relevant root, role
configuration, and mapping state; the adapter commands also retain their
ownership and collision checks. A change detected after preview is not
silently overwritten.
Successful steps are not automatically rolled back if a later adapter install
fails; the wizard reports the partial result and directs the owner to inspect
it before re-entry. Installation itself does not imply project readiness:
the wizard's initial readiness summary is a structural check for the root
`PRD.md`, `.loop/quality-gates.yaml`, an initial Git commit per repository,
and each mapped worktree path. It does not create those inputs implicitly,
assess their quality, or execute the gates.

Keep this structural preview separate from `doctor`. `doctor` diagnoses
adapter installation, managed project assets, the host executable, and
available host/verifier configuration; it is not a project-readiness check.
Declared quality gates run later through `triad-verify` for a recorded Attempt.

### Existing-workspace management

Launching the wizard in a registered workspace defaults to its management
menu. To manage a workspace elsewhere, choose **Manage existing** and provide
its path explicitly. The menu offers list, add, doctor/status, upgrade,
remove, and exit. These are distinct from first-run onboarding:
`init` refuses to overwrite an existing installation, while
`upgrade --apply` is the managed update/repair path for an already
registered workspace.

List and doctor are read-only. Upgrade and remove are limited to adapters
recorded in that Control Workspace; add offers the registered adapters not
already recorded. Each mutation first runs the existing CLI dry-run/preflight,
then proceeds only when the exact word `apply` is entered. Cancellation or a
preflight conflict makes no changes. The plan reports project-local create,
reuse/shared, replacement/backup, removal, and preserved shared paths. Global
assets are not written or changed by these multi-adapter operations. Installing
an adapter still does not select it for the next Attempt; Attempt-bound host
dispatch remains unsupported.

Colors are used only for an interactive terminal and are disabled by
`NO_COLOR` or when output is not a TTY.

From an initialized Control Workspace, launch the wizard there to return to its
management menu and add another adapter without memorizing command names. The
menu displays installed membership and explicitly reports that this does not
select the host for the next Attempt.

For repeatable setup:

```bash
npx triad-plus
npx triad-plus doctor --host codex --control /path/to/project-control
```

Run the wizard from the intended Control Workspace (or supply its path in the
wizard) to review and optionally install the global bridge. The direct
`init --host codex --global` and `init --host hermes --global` commands do not
perform that installation.

## Version visibility

`--version` reports the package that is actually executing:

```bash
npx triad-plus --version
```

The workspace command reports the materialized installation recorded by the
control workspace manifest:

```bash
npx triad-plus version --control /path/to/project-control
```

An older workspace without `.triad-plus/installation.json` is reported as a
legacy installation. Triad+ does not infer a historical version from scattered
agent files.

## Installation manifest and safe uninstall

After a successful `init`, Triad+ writes
`.triad-plus/installation.json`. It records the selected adapter, CLI version,
project/global scopes, normalized managed-file paths, SHA-256 hashes, and a
manifest fingerprint. `upgrade --apply` refreshes this record after managed
assets are materialized; a legacy workspace receives a new manifest without
inventing its previous version.

Uninstall is dry-run by default:

```bash
npx triad-plus uninstall --host opencode --control /path/to/project-control
npx triad-plus uninstall --host opencode --control /path/to/project-control --apply
npx triad-plus uninstall --host opencode --control /path/to/project-control --global --apply
```

Only files listed in the manifest, still unchanged from their recorded hash,
are removed. Missing files are reported as `ABSENT`; modified assets are
preserved. Host directories are never pruned because directory ownership is
not claimed. The team configuration, `.loop/`, project manifest, feature
cards, artifacts, evidence, and other user state are preserved. A managed
`AGENTS.md` role-run block is tracked separately and removed only when its
markers and hash are exact; surrounding user content remains. A manifest
remains as an `uninstalled` or `partial` tombstone so a second uninstall is
idempotent and the ownership history is auditable.

`--global --apply` is deliberately preserve-by-default: global assets may be
shared by several control workspaces, so the command reports them as shared
and does not delete them without a cross-workspace ownership model.

Read-only commands require an existing control workspace; a typo path is
never created by `version` or `uninstall`.

### Local multi-adapter inventory

Schema-v1 workspaces remain readable as one adapter. `adapter list` and
`adapter doctor` do not write or migrate that record. A successful explicit
`adapter add <id> --control <path> --apply` migrates it to schema v2 and records
per-adapter managed assets plus exact shared-path owners. New multi-adapter
assets are project-local; no `--global` option is supported for these commands.
Additional adapter metadata is stored at
`.triad-runtime/adapters/<id>/adapter.json`; the existing
`.triad-runtime/adapter.json` is not rewritten when another host is added.
The terminal management menu is the recommended path. For scripts and advanced
use, this is the equivalent pinned CLI procedure from the initialized Control
Workspace; the first add is a dry run, and `--apply` performs the reviewed
project-local change:

```bash
npx triad-plus@1.19.0 adapter list --control .
npx triad-plus@1.19.0 adapter add copilot --control .
npx triad-plus@1.19.0 adapter add copilot --control . --apply
npx triad-plus@1.19.0 adapter doctor copilot --control .
npx triad-plus@1.19.0 adapter upgrade copilot --control .
npx triad-plus@1.19.0 adapter upgrade copilot --control . --apply
npx triad-plus@1.19.0 adapter remove copilot --control .
npx triad-plus@1.19.0 adapter remove copilot --control . --apply
```

`list`, `doctor`, and `version` are read-only. Add is a dry run without
`--apply`; repeating a healthy add is a no-op. Upgrade backs up only unchanged
managed files that it refreshes. Remove checks ownership and byte hashes before
deleting exclusive adapter files, retains shared paths, and aborts without
side effects when an asset was edited. Removing the final adapter retains the
v2 tombstone and all project/user state. Global assets in a legacy installation
are not changed by these local operations. Host binary availability is reported
separately from adapter membership.

The schema-v2 inventory is an installation/lifecycle foundation only. It does
not provide per-Attempt host selection or active-run safety. Attempts are not
dispatched to whichever adapter was most recently installed; host dispatch is
reported as unsupported until an explicit Attempt-bound liveness contract is
approved and implemented. Their optional global entry wrappers validate the
current project-local workspace after the host invokes the model; this is not a
pre-LLM security boundary, and native host discovery/invocation still requires
host-specific smoke testing.

## Upgrade, repair, or restore an existing control workspace

`init` is the first-install command and refuses to overwrite an existing
workspace. `upgrade --apply` is the managed update, repair, and restore path
for a workspace that is already registered by an installation manifest,
including a workspace whose project scope is `uninstalled` or `partial` after a
safe uninstall. It re-materializes project assets, reuses the preserved
`team.json`, and refreshes the manifest without changing user state, `.loop/`,
PRD files, evidence, or product repositories. The default is a dry run:

```bash
npx triad-plus upgrade --host codex --control /path/to/project-control
npx triad-plus upgrade --host codex --control /path/to/project-control --apply
```

This managed upgrade refreshes project-local assets. Codex/Hermes global entry
files are deliberately excluded from direct upgrade; their installation is
available only through the exact-path, final-consent first-run wizard.

Before replacing a managed asset, the applied upgrade saves its prior copy under
`.triad-plus/backups/`. Triad+ also maintains a clearly marked role-run block in
the control workspace `AGENTS.md`; existing instructions are preserved. Review
`doctor` output when host-level instructions impose a fixed identity, because a
higher-priority host policy can prevent the configured Orchestrator identity.

Supported hosts: `codex`, `opencode`, `claude-code`, `antigravity`, `hermes`, and
the `copilot` adapter. Other adapters retain their documented `--global`
behavior. Codex/Hermes entry files are the exception: only the interactive
first-run wizard installs them after exact-path preview and final consent. If
the control path is recognizably a product Git repository, setup stops unless
`--allow-product-repo` is explicitly supplied after review.

The saved `.triad-plus/team.json` separates stable role IDs from display names,
personas, models, and supported effort/options. Existing schema-version-1 team
files remain valid. Core roles are always enabled; Evaluator+ is enabled only
when `roles.evaluator.enabled` is `true`.

The shared `triad-model-configuration` skill is installed with the selected
adapter. Ask the host agent to inspect or change a role model; it keeps
`.triad-plus/team.json` as the source of truth and re-materializes only fields
the adapter declares as host-native. Unsupported fields are reported rather
than silently substituted.

For OpenCode, the canonical `reasoning_effort` value is materialized as the
native per-agent `variant` field. Copilot uses its own native
`reasoningEffort` field; these host contracts are intentionally not inferred
from one another. The active host/session default remains separate from a
materialized role profile.

| Role | Responsibility |
| --- | --- |
| Orchestrator | Maintains goal/context and decides the next step. |
| Developer | Changes the artifact to meet the declared card. |
| Reviewer | Finds defects and returns approved, rework, or blocked. |
| Evaluator+ | Optionally and freshly judges an approved result after the run. |

Open the control workspace and invoke the host-native command with an absolute
PRD path. The Orchestrator presents feature cards before implementation, then
delegates normal development and review. When `roles.evaluator.enabled` is true,
the Orchestrator invokes Evaluator+ automatically after Triad is approved. Users never create
evaluation packets, report paths, or evidence directories manually.

During a run the Orchestrator creates any Assignment Packet internally and
passes its explicit product-worktree dispatch context to the delegated roles;
there is no user-facing packet path to configure.
