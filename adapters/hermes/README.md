# Triad+ for Hermes Agent

Hermes exposes skills as slash commands. Install the project-local adapter and,
if wanted, select Hermes under **Optional global entry bridge** in the
interactive setup wizard:

```bash
npx triad-plus
```

The final preview lists the exact active-profile wrapper, global preflight,
and workspace-specific binding paths
(`HERMES_HOME` when explicitly set, otherwise the validated Hermes
`active_profile`, falling back to `~/.hermes/skills/triad/` only when there is
no active-profile marker). The binding pins the canonical Control Workspace,
its local installation manifest, and expected runtime hashes; it is written
only after the exact setup preview is approved. Separate workspace bindings
allow the shared wrapper and preflight to be reused without replacing another
workspace's binding. Shared role skills and runtime assets remain project-local. Global `init`,
`upgrade`, and legacy `install.sh --global` paths are refused so they cannot
bypass the exact-path preview and confirmation.
Open Hermes from the project-control workspace and run:

```text
/triad /absolute/path/to/prd.md
```

Hermes supports one-shot use through `hermes chat -q` and `--skills`. The
adapter uses those host primitives for separately invoked Developer and Reviewer
roles when the configured model/provider is available. It uses explicit
verification dispatch; no Hermes lifecycle hook is assumed.

The wrapper first runs the installed built-ins-only global preflight. It checks
the exact owner-approved canonical Control Workspace path, binds the local
manifest to expected project/global asset hashes, then runs a temporary
snapshot of the validator so a changed local runtime script is not executed.
The local manifest alone is not treated as owner trust. The check is still
post-LLM: Hermes has already selected and read the skill, so no pre-LLM host
security boundary is claimed. The validator does not search for another
workspace; if the active directory is wrong, reopen/restart Hermes from the
exact Control Workspace used to approve setup.

Evaluator+ is opt-in and post-run only. Set `roles.evaluator.enabled` to `true`
in `team.json` and the Orchestrator dispatches it automatically after Triad
approval. It receives the approved goal, acceptance target, final artifact, and
verifier evidence, then writes an independent report without reopening Triad.
