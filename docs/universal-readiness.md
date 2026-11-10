# Guided workspace readiness

The six native entries now require the same preflight before loop planning,
bootstrap or delegation. Terminal use is also available:

```bash
npx triad-plus preflight --host opencode --control /absolute/control-workspace
npx triad-plus preflight --host opencode --control /absolute/control-workspace --non-interactive --json
```

The runtime entry also defaults to this consent-aware flow. Its explicit
`--structural-only` diagnostic never prints READY and is not authorization to
start the loop.

Use the exact Control Workspace and select the host explicitly. Interactive
mode guides one correction at a time. Without a terminal, or with
`--non-interactive`/`--json`, it never prompts or grants consent: unresolved
actions return exit 2. READY returns 0. Unchanged confirmed inputs need no
repeated questions or writes. A prompt has a two-minute timeout, invalid
choices have three attempts, and the overall pass is finite. Earlier completed
confirmations survive cancellation; an incomplete step does not grant consent.

## What READY means

Preflight validates installation/adapter compatibility and managed bytes,
canonical workspace paths, a nonempty root PRD, repository mappings and Git
baselines, existing base branches, separate worktrees and exact project
branches. It distinguishes fatal installation/configuration problems,
fixable owner actions and advisories. It does not invent PRDs, change branches,
create worktrees, install dependencies, run discovered commands or modify
external repositories. Dependency directory/executable presence checks are not
proof that arbitrary project tools or code work.

READY means current workspace bindings and explicit confirmations are valid.
It does **not** attest native host availability, provider credentials, effective
model identity, per-role model selection, script safety or a passing gate.
The deterministic verifier still produces execution evidence independently of
Reviewer reports. A host requiring an exact unavailable/unobservable model
must remain blocked unless the owner explicitly accepts the stated defaults.

## Models and host capabilities

`team.json` retains requested intent. Model syntax is checked without guessing
a replacement or claiming catalog availability. Correct one field with a
current-state-bound operation, or explicitly choose host defaults. Correction
does not materialize native overrides. Host-default consent preserves the
requests while recording that they are unapplied and identity is unobservable.
Optional Evaluator+ remains disabled unless configured explicitly.

| Host | Entry/preflight surface | Verifiable model/capability limit |
| --- | --- | --- |
| OpenCode | `/triad` and the Orchestrator profile run the common preflight | Use the project `/models` picker; syntax-valid is not available, and per-role overrides remain unapplied |
| Claude Code | `/triad` runs the common preflight | Session and subagent model controls differ; no shared catalog or portable effort translation is assumed |
| Codex | `$triad` runs its owner-bound global wrapper and trusted runtime snapshot | Global profile writes need separate exact-path consent; this increment does not verify/apply requested role models |
| GitHub Copilot | Skill and explicit Orchestrator agent fallback | CLI/IDE/cloud tool and prompt capabilities differ; disclose missing capabilities and use the owner terminal route |
| Antigravity | Skill and Orchestrator profile | Effective per-role model identity is not observable through this adapter |
| Hermes | Active-profile skill and owner-bound global wrapper | Use the exact trusted active-profile wrapper; CLI presence is not a working session and an unknown profile path is a blocker |

These entries are **model-instructed and post-LLM**, not enforced pre-LLM host
hooks. Generated agents remain loadable because they omit unverified model
overrides. If the host cannot run shell tools or prompt the owner, it must
disclose that limit and request the explicit terminal route rather than invent
READY. The complete native harness E2E and requested per-role model routing
remain release acceptance criteria; this increment does not complete them.

## Gate consent for one repository

The saved discovery draft is never trusted as an approval. Preflight reads the
current worktree, verifies its repository/branch identity and re-hashes known
manifest/lock sources. It shows candidate commands, their hashes, timeouts,
prerequisites and limits. Scripts and referenced project code are arbitrary
code: inspect their bodies locally before consent. Manifest bodies are never
emitted as agent instructions. `npm --ignore-scripts` is not a safety certificate.

Choose explicit candidate IDs, edit/provide a workspace-relative manual catalog,
or reject the proposal. Rejected unchanged candidates do not prompt again;
readiness remains blocked until the owner explicitly reopens or replaces that
choice. Manual catalogs are reviewed locally and their exact bytes are staged
before consent. Catalog lint proves structure only, not safety or tool identity.

For automation or a native conversational prompt, inspect first and use the
current report's `state_sha256` for **one** explicit owner-approved action:

```bash
# Read only. Replace the placeholders below from this current report.
npx triad-plus preflight --host opencode --control . --non-interactive --json
npx triad-plus preflight --host opencode --control . --approve models --expected-state <current-sha256>

# Inspect again after each step. Approve the first current gate action only.
npx triad-plus preflight --host opencode --control . --approve gates:backend --select test,lint --timeout 600 --expected-state <current-sha256>

# Stage/review a manual catalog before approving it; use its resulting state.
npx triad-plus preflight --host opencode --control . --catalog .loop/gates/backend.json --non-interactive --json
npx triad-plus preflight --host opencode --control . --catalog .loop/gates/backend.json --approve gates:backend --expected-state <current-sha256>

# Reopen a rejected or previously approved choice only at the owner's request.
npx triad-plus preflight --host opencode --control . --review gates:backend --non-interactive --json

# Correct intent without applying a native model. Blank after = clears it.
npx triad-plus preflight --host opencode --control . --set-model developer=provider/model --expected-state <current-sha256>
```

Until all steps are complete an approval can succeed while readiness still
returns exit 2; inspect the next action. Do not blindly retry or auto-approve.
Changed state/source/catalog bytes invalidate an old approval request before
writes. A selected proposal becomes a content-addressed catalog under
`.loop/gates/`; existing files are never overwritten. A manual catalog remains
at its explicitly approved path. `.loop/quality-gates.yaml` is preserved.

## Receipt, dispatch and verification

`.triad-plus/readiness.json` records confirmations for host defaults,
prerequisites and each repository's catalog. It binds current manifest source
hashes, canonical repository/worktree identity, branch and exact catalog bytes.
It records explicit CLI approval, not a cryptographic proof of human identity;
the Control Workspace remains owner-controlled configuration. Agents must not
forge receipts or infer consent.

Use the READY report's per-repository `gates_path` and
`expected_gates_sha256` when creating each immutable assignment. The shared
assignment resolver, used before dispatch and by the verifier, independently
checks current consent, source, branch/worktree and catalog bytes. A caller hash
or Reviewer verdict cannot substitute for that binding. Missing/deleted consent
blocks newly installed workspaces. Legacy standalone verifier fixtures without
an installed onboarding runtime retain their existing manual-catalog contract.

The independent guard also requires current global prerequisite consent: a safe,
non-empty root PRD with the confirmed hash and the current fingerprints of all
mapped repositories. Removing that confirmation, changing the PRD or changing
another mapped repository blocks new dispatch even if this assignment's catalog
consent is unchanged. Inspect readiness and explicitly reconfirm prerequisites
after review; this does not rewrite existing per-repository catalog approvals.
This global check does not attest per-host model/default consent or effective
model routing; those remain the native entry preflight's disclosed boundary.

Do not combine repositories into a catalog executed in one worktree. Do not
overwrite approved catalogs during bootstrap or mutate an existing assignment
to adopt a new approval. Gate/source/branch changes require fresh consent and
the normal new-attempt boundary. No run record, frozen PRD or old evidence is
rewritten by preflight.

## Existing global entries and remaining release limits

Codex/Hermes wrappers still verify owner-bound paths and bytes before running
local code; scoped approvals use that same temporary trusted snapshot. After
a project/runtime upgrade an older global binding can stop for byte drift.
Do not patch hashes or bypass it with changed local code. The current installer
refuses direct global upgrades and preserves shared global files on removal;
a supported, explicitly consented global refresh/migration still needs separate
implementation/review before the final release. The trusted package terminal
route is available for workspace configuration, not proof that a stale native
global entry was repaired.

Evidence here is six-adapter contract coverage, actual terminal error → model
correction → READY, current-source/catalog/branch adversarial cases, and trusted
wrapper fixtures. These are not fabricated native model sessions. Native model
routing, real harness E2E, consented global compatibility/migration and final
release gates remain open under delivery #26. No intermediate release is implied.
