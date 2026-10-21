# Triad+ Codex adapter

The optional global `$triad` entry is a Codex-native skill at
`$CODEX_HOME/skills/triad/SKILL.md` (default
`$HOME/.codex/skills/triad/SKILL.md`). It places the current conversation in
the Orchestrator role; it does not create a hidden coordinator session.

Use the interactive installer from the intended Control Workspace:

```bash
npx triad-plus
```

Select Codex as a project adapter. To expose `$triad`, also select Codex under
**Optional global entry bridge**. The final preview shows the exact absolute
skill, preflight, and workspace-specific binding files. The binding pins the
canonical Control Workspace path, its installation manifest, and the expected
project/global runtime hashes; the installer writes it only after the exact
`install` confirmation. A separate binding is created for each approved
Control Workspace, so shared global skill files can be reused without changing
another workspace's trust binding. Shared Triad skills and role profiles
remain project-local or separately user-configured.

The old `$CODEX_HOME/prompts/triad.md` custom prompt is not migrated,
overwritten, or deleted. If present, it is reported as a legacy-name collision
and the optional native Codex skill install is blocked until the owner backs
up that prompt under another name or deselects the Codex global entry. The
wizard never claims that the old prompt was migrated.

For non-interactive project-only installation, use `init --host codex
--control <path>` without `--global`. Direct `init/upgrade --global` and the
legacy script's `--global` option refuse this entry so the exact-path consent
preview cannot be bypassed.

Start Codex from the Control Workspace root and invoke:

```text
$triad <PRD path or project request>
```

The global skill first runs the installed built-ins-only
`$CODEX_HOME/triad-plus/host-entry-preflight.mjs` bridge. The exact binding is
under `$CODEX_HOME/triad-plus/bindings/` and is created only after the setup
preview is approved. The bridge checks that the current canonical directory
matches that owner-approved path, validates the binding against the local
installation manifest, and checks every bound project/global runtime hash. It
then runs a temporary snapshot of the bound validator, not the mutable local
validator path, which validates project configuration, PRD, gates, and declared
repositories/worktrees. A self-authored local manifest cannot replace the
separate workspace binding. On failure it states that Triad did not start, does
not search other workspaces, and requires opening/restarting Codex from the
bound root or approving setup there. This remains post-LLM: Codex has already
selected and read the skill, so this is not pre-LLM host enforcement. If Codex
cannot rebind to the selected root, restart it there.

Before it starts work, configure the four named role profiles described in
[`docs/codex-replication.md`](../../docs/codex-replication.md). The adapter
does not edit profile or model configuration, because their availability and
model routing are host-owner decisions.

At bootstrap and resume, the Orchestrator runs the runtime capability detector
with the project's `control_plane.dispatch_mode`. Codex `auto` selects explicit
verification dispatch even when an async hook is available. The async
`SubagentStop` route remains an experimental opt-in (`async_hook`) and falls
back to explicit dispatch when unavailable. On Codex CLI 0.142, explicit
dispatch is the safe expected route.

The Codex conversation remains the Orchestrator parent while a delegated
Developer or Reviewer is active. A `wait_agent` timeout is only a polling
interval: the parent refreshes status and waits again in the same turn. A
progress update never returns control to the owner while delegated work
remains active; completion is collected automatically and proceeds to
verification, review, and the next dependency-satisfied card.

## Deterministic standalone role dispatch

The optional hybrid control driver can launch a configured role without keeping
an LLM Orchestrator parent alive for mechanical lifecycle sequencing:

```bash
node .triad-runtime/adapters/codex/run-role.mjs \
  --role developer \
  --control /absolute/path/to/control \
  --cwd /absolute/path/to/product \
  --prompt-file /absolute/path/to/prompt.txt \
  --profile-source /absolute/path/to/.codex/agents/triad_developer.toml \
  --model <host-model> \
  --local-provider ollama
```

The launcher copies the selected configured TOML profile into an isolated
temporary Codex home and invokes the native `codex exec --profile
triad_<role>` mechanism. It never edits the user's Codex home or the managed
profile. For a host-native authenticated route (when `--local-provider` is not
used), the existing user `config.toml` and `auth.json` are copied into that
temporary home and removed with it after the invocation; no credentials or
configuration are persisted or modified. Reviewer output is normalized only from Codex `agent_message` events;
tool/reasoning examples, missing markers, malformed payloads, and duplicates
fail closed. The shared control driver remains host-independent.
