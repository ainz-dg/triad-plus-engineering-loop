# Install Triad+

Triad+ installs a project-control workspace, not application code. Keep it
outside product repositories whenever possible.

```bash
npx triad-plus
```

The interactive setup selects a host, optional user-level command, language,
owner address, role display names/personas, models, and whether the optional
Evaluator+ is enabled. It changes files only after `install` is typed.
Before confirmation it prints a compact summary of the host, control workspace,
interaction settings, Evaluator+, and each role's model/binding. Colors are
used only for an interactive terminal and are disabled by `NO_COLOR` or when
output is not a TTY.

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
preserved. Empty directories created by Triad may be pruned after their files
are removed. The team configuration, `.loop/`, project manifest, feature
cards, artifacts, evidence, and other user state are preserved. A manifest
remains as an `uninstalled` or `partial` tombstone so a second uninstall is
idempotent and the ownership history is auditable.

## Upgrade an existing control workspace

`upgrade` refreshes only Triad-managed runtime, skill, adapter, and optional
host-entry assets. It never changes `team.json`, `.loop/`, PRD files, evidence,
or product repositories. The default is a dry run:

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
