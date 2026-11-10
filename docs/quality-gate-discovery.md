# Inactive quality-gate discovery

Setup reads the explicitly mapped repositories and prepares
`.triad-plus/quality-gates.draft.json`. This is an **inactive proposal**, not
readiness, execution evidence or an approved catalog. It never replaces
`.loop/quality-gates.yaml`, installs dependencies, probes executables or runs
discovered commands. The behavior is shared by all six adapters.

```bash
# Fresh read-only preview; no files changed and no commands executed.
npx triad-plus quality-gates --control .

# Explicitly refresh only the inactive draft; active catalogs stay unchanged.
npx triad-plus quality-gates --control . --refresh --apply

# Lint an owner-configured catalog without executing it or probing versions.
npx triad-plus quality-gates --control . --lint
npx triad-plus quality-gates --control . --lint --source .loop/gates/backend.json
```

The commands do not prompt. Invalid arguments, unsafe/unreadable catalog paths
and lint failures exit nonzero. An empty proposal is a discovery result, not
READY. Existing drafts are preserved byte-for-byte during installation;
replacement requires `--refresh --apply`. Unchanged refreshes are idempotent.
The wizard's detailed preview names the draft file before installation.

## Sources, categories and limits

The supported automatic source is `package.json` npm scripts. Explicit script
names classify candidates as test, lint, typecheck or build; Triad+ does not
invent a command from a language or directory name. Script bodies must use a
supported single runner invocation. Shell composites/substitutions, inline
Node code, missing or unsafe Node script files, pre/post lifecycle hooks,
watch/server modes, publish/deploy/install, Docker, VRT, snapshot update and
mutating fix/write/clean commands are excluded conservatively. Other package
managers and unsupported forms need manual configuration. Common non-Node
manifests are noted for manual review; their contents are not interpreted.

Each candidate records its exact script name, manifest and script SHA-256,
category and prerequisites. Its proposed command is
`npm --ignore-scripts run <script-name>` with a 600-second timeout. npm still
runs that explicitly named script, while omitting its pre/post hooks
([npm configuration reference](https://docs.npmjs.com/cli/v11/using-npm/config/#ignore-scripts)).
Discovery additionally excludes scripts that declare such hooks; the flag is
defense in depth, not a certification that the script is safe.

Manifest bodies, arbitrary script text, OS error bodies, credentials and
environment values are not copied into the draft or console output. Paths and
script names remain data, never agent instructions. Regular-file reads are
bounded to 1 MiB, mappings to 64 repositories and script maps to 128 entries;
symlink and special-file sources are rejected. Dependency availability and
executable identity are not attested by discovery.

## Repository and worktree binding

Each mapping has its own proposal. If its declared worktree exists, discovery
reads that worktree's manifest. If it does not exist, the repository manifest
is labeled **repository-preview**, with an instruction to re-discover in the
worktree before confirmation. An unsafe existing worktree never falls back to
the repository. Reading either directory does not verify its Git identity or
branch: `context_verified` stays false until a separate readiness check.

Do not merge commands from different repositories into one catalog running in
one worktree. The verifier already executes an assignment's catalog in that
assignment's worktree and binds its hash through `assignment.gates_path`.
`command_source` is discovery metadata, not the verifier's native executable
`toolchain`/`provenance` binding. A proposal is rejected by the verifier even
with a matching hash; do not use it as `gates_path` or copy it over an active
catalog.

## Review, execution and subsequent onboarding

An owner must review the manifest and prerequisites and select, edit or reject
candidates before constructing an active per-repository catalog. There is no
automatic activation command in this increment. The shared first-entry guided
confirmation/repair flow and persisted readiness receipts are still pending;
this draft is their input, not a replacement for those acceptance criteria.
Existing manual active-catalog configuration remains available.

Lint accepts the existing JSON / list-of-maps YAML contract, rejects missing,
duplicate or placeholder commands, malformed fields, unsupported YAML blocks
and invalid toolchain bindings, and bounds timeout values to 1..3600 seconds
(600 by default). It validates structure only: it does not prove command
safety, tool availability, worktree readiness or a gate pass. The deterministic
verifier still resolves provenance and executes approved gates independently
of Reviewer conclusions.

Regression evidence is in [gate-discovery-test.mjs](../tests/gate-discovery-test.mjs)
and the real PTY setup integration. Fixtures cover six adapters, separate
repository/worktree manifests, missing/malformed/malicious sources, no execution
or secret disclosure, active-file preservation, explicit refresh and inactive
proposal rejection. No native host session or complete `/triad` E2E is claimed
by these tests.
