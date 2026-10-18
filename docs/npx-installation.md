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

Repository configuration is explicit. Choose one of these modes:

1. Map selected existing local Git repositories. Immediate-child Git roots may
   be shown as read-only suggestions, but none are added automatically.
2. Initialize selected empty paths as local greenfield Git repositories after
   approval. This does not create a remote or push anything.
3. Defer repository mapping; setup can complete, but readiness remains
   **NOT READY** until mappings and required project inputs are present.

For modes 1 and 2, enter the number of repositories (1–20), then confirm each
repository ID, path, base branch, project branch, and worktree mapping. The
wizard does not clone from URLs or search for repositories. It writes only the
repository mapping portion of `project.yaml`, preserving unrelated content.

Select one or more of the six listed adapters in the same setup session. An
optional team-identity/model configuration may also be requested. Before
writing, the wizard shows a complete preview of the Control Workspace, mapping
changes, selected project-local adapter assets, and initial readiness. Type
`install` to apply that exact plan; any other answer cancels. The first-run
flow does not write global/user-level host files, credentials, or account
settings.

Preflight refuses a Control Workspace inside a product Git root, unsafe paths,
and asset conflicts. Before applying, setup rechecks relevant root, role
configuration, and mapping state; the adapter commands also retain their
ownership and collision checks. A change detected after preview is not
silently overwritten.
Successful steps are not automatically rolled back if a later adapter install
fails; the wizard reports the partial result and directs the owner to inspect
it before re-entry. Installation itself does not imply project readiness:
the status separately checks for the root `PRD.md`,
`.loop/quality-gates.yaml`, an initial Git commit per repository, and each
mapped worktree. It does not create those inputs implicitly.

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
npx triad-plus init --host codex --control /path/to/project-control --global
npx triad-plus doctor --host codex --control /path/to/project-control
```

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
approved and implemented. Codex and Hermes project-local native entry points
are marked limited/unproven rather than treated as validated.

## Upgrade, repair, or restore an existing control workspace

`init` is the first-install command and refuses to overwrite an existing
workspace. `upgrade --apply` is the managed update, repair, and restore path
for a workspace that is already registered by an installation manifest,
including a workspace whose project scope is `uninstalled` or `partial` after a
safe uninstall. It re-materializes project assets, reuses the preserved
`team.json`, and refreshes the manifest without changing user state, `.loop/`,
PRD files, evidence, or product repositories. The default is a dry run:

```bash
npx triad-plus upgrade --host codex --control /path/to/project-control --global
npx triad-plus upgrade --host codex --control /path/to/project-control --global --apply
```

Before replacing a managed asset, the applied upgrade saves its prior copy under
`.triad-plus/backups/`. Triad+ also maintains a clearly marked role-run block in
the control workspace `AGENTS.md`; existing instructions are preserved. Review
`doctor` output when host-level instructions impose a fixed identity, because a
higher-priority host policy can prevent the configured Orchestrator identity.

Supported hosts: `codex`, `opencode`, `claude-code`, `antigravity`, `hermes`, and
the `copilot` adapter.
Use `--global` to install a host-level entry point where desired. The installer
refuses overwrites. If the control path is recognizably a product Git repository,
it stops unless `--allow-product-repo` is explicitly supplied after review.

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
