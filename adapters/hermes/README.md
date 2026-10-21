# Triad+ for Hermes Agent

Hermes exposes skills as slash commands. Install the project-local adapter and,
if wanted, select Hermes under **Optional global entry bridge** in the
interactive setup wizard:

```bash
npx triad-plus
```

The final preview lists the exact active-profile path
(`HERMES_HOME` when explicitly set, otherwise the validated Hermes
`active_profile`, falling back to `~/.hermes/skills/triad/` only when there is
no active-profile marker). Only the Triad wrapper files are installed there;
shared role skills and runtime assets remain project-local. Global `init`,
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

The wrapper runs the project-local validator before Triad work. This is a
model-level check, not a pre-LLM security boundary. The validator does not
search for another workspace; if the active directory is wrong, reopen Hermes
from the exact Control Workspace or run the setup wizard there.

Evaluator+ is opt-in and post-run only. Set `roles.evaluator.enabled` to `true`
in `team.json` and the Orchestrator dispatches it automatically after Triad
approval. It receives the approved goal, acceptance target, final artifact, and
verifier evidence, then writes an independent report without reopening Triad.
