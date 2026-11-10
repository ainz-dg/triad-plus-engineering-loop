# Refresh an existing Codex or Hermes global entry

Use a trusted Triad+ package to refresh an already owned global entry after a
project upgrade. This does not install a new entry, select a model, migrate a
profile, run discovered commands or start the engineering loop.

```bash
# Read-only: use the same exact Control Workspace and host profile for both steps.
npx triad-plus entry refresh --host codex --control /absolute/control-workspace

# Inspect every absolute file path and before/after hash in the preview.
# Only after explicit owner consent, copy the current Expected state value:
npx triad-plus entry refresh --host codex --control /absolute/control-workspace \
  --apply --expected-state <sha256-from-this-preview>
```

For Hermes substitute `--host hermes`; select the actual active profile before
preview. `HERMES_HOME` selects where Hermes stores/loads the native skill. The
trusted preflight wrapper and binding use the canonical `$HOME/.hermes` path,
including with named profiles. Changing `HOME`, `CODEX_HOME`, `HERMES_HOME`, the
active Hermes profile, installation ownership or project/global bytes can
invalidate the request.
Do not search profiles or substitute a different workspace after approval.
No terminal prompt is required: without `--apply` this command is read-only;
automation with absent/stale `--expected-state` fails nonzero without writing.
The hash binds the explicit CLI operation, not cryptographic human identity.
Agents must not infer owner consent from a hash or auto-apply a preview.

The current workspace must already match the trusted package's project asset
membership, bytes and version. The command will not bless local code merely
because its hash appears in an edited manifest. A supported legacy single-adapter
project upgrade can be performed separately with `upgrade --host <host> --control
<path> --apply`, after reviewing its own dry run. That upgrade does not silently
refresh the global binding. Older multi-adapter installs requiring coordinated
shared project changes remain a separate limitation; this command does not
waive or bypass their upgrade refusal.

The preview lists the exact existing native skill/wrapper files and the binding
for this workspace, plus the local manifest to update. Only recorded files whose
current bytes still match prior ownership may be replaced. Missing, modified,
unowned, symlinked or foreign-workspace entries stop. A legacy prompt collision
is preserved. If shared wrapper/skill bytes would change and other workspace
bindings or adapter owners exist, stop for a separately reviewed coordinated
operation; this command does not refresh other workspaces implicitly. If those
shared bytes are already current, only this workspace's stale binding may change.

Application rechecks the plan before writes and project/profile/ownership before
committing the manifest. It retains original file permissions, uses atomic file
replacement and backs up old bytes under the selected Control Workspace's
`.triad-plus/backups/entry-refresh-*`. `plan.json` maps backup files to exact target
paths; `installation.json` is the prior manifest. Temporary files beside listed
global targets are removed. On failure, earlier replacements are restored only
when their bytes still match this operation; concurrent edits are preserved and
reported for local recovery. Backups remain available after success or failure.
This is not a crash-atomic transaction across multiple files: if interrupted,
the native guard must block inconsistent state. Inspect the backups and exact
files before an explicitly authorized recovery; do not patch hashes to bypass it.

Unchanged entries are idempotent: no new backups, manifest writes or repeated
readiness confirmations. A successful refresh says only that these entry files
and owner binding were refreshed. Run the usual preflight through the trusted
wrapper afterward. Workspace READY, runtime availability, effective model
identity and per-role routing remain distinct. Tests execute the installed
wrapper/preflight on controlled workspaces; they do not prove a provider session
or the still-required native harness E2E.
