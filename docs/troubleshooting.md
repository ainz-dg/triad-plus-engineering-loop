# Troubleshooting

When the new-workspace wizard lists an existing Git repository, use Up/Down
and Space to select it, then Enter to confirm. **Add repository by path** is
for an explicitly supplied local Git root not in the immediate-child list; it
does not broaden discovery. Repository IDs are suggested from directory names
and are distinct from keyboard selection. A mistyped path can be corrected in
place. If branch/mapping validation fails, retry the repository mapping from
the same Control Workspace; no repository or installation files are changed
before approval.

Successful `npx triad-plus init --host opencode --control .` installs the
adapter assets only. It does **not** configure product-repository mappings,
quality gates, PRD, or worktrees. Check the project plan and readiness before
running `/triad`. When `doctor --control .` is run without `--host`, it
inspects all six adapters; `incomplete` for unused adapters is not evidence
that your chosen adapter is broken. Use `--host opencode` to inspect OpenCode
alone. Command errors are concise; run `npx triad-plus --help` for full syntax.

Run doctor first:

```bash
npx triad-plus doctor --host <runtime> --control /path/to/triad-control
```

Compare the executing CLI with the materialized workspace installation:

```bash
npx triad-plus --version
npx triad-plus version --control /path/to/triad-control
```

`legacy / manifest missing` means the workspace predates the installation
manifest. Run `upgrade --apply` to materialize a current manifest; Triad+ does
not infer the old version. The same `upgrade --apply` command is the managed
restore path after a safe uninstall leaves an `uninstalled` or `partial`
manifest: it re-materializes managed assets and reuses the preserved team
configuration and user state. `init` is reserved for first installation and
refuses existing paths. `manifest invalid` means the ownership record or its
fingerprint is malformed and should be reviewed before any uninstall.

Doctor also reports `CLI newer / upgrade available` and `CLI older than
installed version` instead of silently claiming compatibility. It never checks
the npm `latest` tag.

`not installed` means the selected adapter assets are absent from that control
workspace. `not installed or version unavailable` for a host means its binary is
not on PATH or otherwise cannot answer `--version`. Re-run the appropriate host
installer or fix the host environment; Triad+ does not require every runtime to
be present.

If a hook is unavailable, use explicit verification dispatch. Hooks are never a
requirement for a normal Triad run.

If a verifier result is `invalid_context`, compare the assignment, PRD/card/gate
baselines, worktree, branch, and candidate. Do not treat it as a passing test.

If Evaluator+ is unavailable, check `roles.evaluator.enabled` in the team file.
An Evaluator+ failure is post-run information, not an automatic repair request.

## Codex and Hermes entry bridge

The optional `$triad` Codex prompt and Hermes `/triad` wrapper check only the
current directory. A `BLOCKED` result means Triad has not started; the wrapper
does not search other workspaces and makes no workspace, host-setting, or
delegation changes. Open/restart the host from the intended Control Workspace,
run the setup wizard from that exact workspace, or cancel. A supplied
`--workspace` path must match the host's current directory; if the host cannot
rebind, restart it there. The wrapper is model-level and cannot enforce a
pre-LLM boundary.

The guard also stops on an invalid installation manifest or asset hash,
missing/unsafe local adapter files, empty PRD, invalid quality gates, or missing
declared repository/worktree Git roots. Correct those inputs deliberately and
rerun; it does not infer or initialize them.

## Safe uninstall

Uninstall is a dry run unless `--apply` is supplied:

```bash
npx triad-plus uninstall --host <runtime> --control /path/to/triad-control
npx triad-plus uninstall --host <runtime> --control /path/to/triad-control --apply
```

Only unchanged files listed in `.triad-plus/installation.json` are removed.
`ABSENT` files are harmless. A `PRESERVE` line means the file was modified, no
longer matches the trusted managed plan, or is not a regular file; no force
option exists for this operation. Add `--global` only when user-level Triad
assets should also be considered. Global assets are nevertheless preserved by
default because another workspace may share them. Team config, loop state,
cards, artifacts, evidence, generic host directories, and other user files are
preserved. A managed `AGENTS.md` block is removed only when its exact markers
and hash still match; a modified or ambiguous block leaves the uninstall
partial. `version` and `uninstall` reject nonexistent control paths without
creating them.
