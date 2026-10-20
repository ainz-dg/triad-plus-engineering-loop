# Changelog

## 1.21.0 — 2026-10-20

Onboarding TUI usability update, following `v1.20.1`, with PR #25.

- Add real keyboard-driven repository selection, displaying local Git roots
  found only as immediate children of the explicitly selected Control Workspace.
  Navigate with Up/Down; Space toggles; Enter confirms; Escape cancels.
- Suggest stable repository IDs from selected directory names, preserve editable
  base/project branches and worktree mappings, and keep existing deterministic
  validation, no-clobber, and exact `install` approval.
- Add genuine multi-harness checkboxes for the six registered coding-agent
  adapters; the first selected host remains visibly primary. Multi-adapter
  *installation* does not provide automatic per-Attempt host dispatch.
- Preserve the no-write-before-confirmation and no-global-settings boundaries,
  support explicit add-by-path, greenfield and defer, and maintain readable
  monochrome/narrow-terminal behavior. Add real-key PTY regression coverage.
- The P0 rollout does not yet redesign the text-based optional team, persona
  and model configuration. Those improvements remain scoped to later P1 work.
- No Core, verifier, Reviewer or Evaluator+ runtime changes.
- Release notes: [Triad+ 1.21.0](docs/releases/1.21.0.md).

## 1.20.1 — 2026-10-20

Maintenance release following `v1.20.0`, covering PR #22 and PR #23.

- Start the local read-only Cockpit with `npx triad-plus cockpit` from the
  Control Workspace, without requiring `--control .`. Keep `--control`
  as an explicit override and add `--no-open` to suppress safe interactive
  browser opening.
- Keep the Cockpit bound to 127.0.0.1 with one-time session login, foreground
  execution, and no agent-control or liveness claims. OpenCode `/cockpit`
  is **not** provided: the existing custom-command contract does not manage
  persistent background processes safely.
- Fix onboarding of existing product repositories: show numbered Git-root
  suggestions and require an explicit selection, allow correction of invalid
  paths and retry of repository preflight without restarting the wizard.
- Clarify adapter installation versus project readiness, the scope of doctor
  checks, and concise CLI errors. No changes to the Triad+ Core, verifier,
  Reviewer independence, or Evaluator+ lifecycle.
- Release notes: [Triad+ 1.20.1](docs/releases/1.20.1.md).

## 1.20.0

The 1.20.0 change set follows `v1.19.0` and covers the documentation
alignment in PR #17, human-first Cockpit Card report and Delivery handoff
entries in PR #18, mobile Markdown containment in PR #19, and the OpenCode
first-loop walkthrough plus synthetic screenshots in PR #20. The walkthrough
documents a host interaction; it does not claim that Cockpit runs agents or
verifies liveness.

- Add a procedural OpenCode tutorial covering a separate Control Workspace,
  prerequisites the wizard does not create, a first `/triad` loop, evidence,
  explicitly materialized reports, and reading the Cockpit safely.
- Document the Project-level **Delivery handoff** and Card-level **Card
  report** as shortcuts to existing derived Markdown, distinct from approval
  and verification records.
- Keep Markdown prose readable on narrow viewports while wide tables and code
  blocks remain independently scrollable.
- No new Triad+ Core/runtime capability is introduced in this tranche;
  Cockpit remains a read-only surface.
- Release notes: [Triad+ 1.20.0](docs/releases/1.20.0.md).

## 1.19.0 — 2026-10-17

Published to [npm](https://www.npmjs.com/package/triad-plus/v/1.19.0) and as a
[GitHub Release](https://github.com/ainz-dg/triad-plus-engineering-loop/releases/tag/v1.19.0).
The release tag and `main` point to
`f3833e071fe03c5396babc3117529987368522e3`.

- Add an explicit first-run terminal setup flow for choosing a separate
  Control Workspace and mapping one or more product repositories. The
  Control Workspace may remain non-Git while each mapped product repository
  has its own Git root and declared worktree.
- Offer explicit repository modes: map selected existing local Git
  repositories, initialize selected empty greenfield paths as local Git
  repositories only after confirmation, or defer mapping. The wizard does not
  clone repositories or search sibling directories for a workspace.
- Allow one or more of the six registered adapters to be selected in a single
  first-run setup, with a complete local-only preview and exact confirmation.
  The integrated smoke verifies the six-adapter project-local installation
  and schema-v2 ownership manifest.
- Extend read-only Cockpit views to show assigned attempt evidence only when
  its declared path and assignment/evidence bindings validate; this does not
  authorize general evidence browsing. Refresh the OpenCode quickstart around
  a separate Control Workspace and explicitly mapped product repositories.
- Setup reports readiness separately from installation and does not create a
  PRD, quality-gate catalog, initial repository commit, mapped worktree, or
  successful verification implicitly. Adapter inventory still does not select
  a host for an Attempt; native host discovery and multi-harness dispatch are
  not claimed.

## 1.18.0

- Make attempt-local Reviewer documents easier to find in the Cockpit while
  keeping them explicitly agent-declared and their verdicts unattested; Card-
  level and ambiguous reviews remain separate.
- Improve human-readable report references for project/worktree artifacts,
  including absolute paths, and link only uniquely resolved, existing regular
  files that remain within a declared root.
- Keep missing, external, ambiguous, unsafe, or symlink-escaping references
  unlinked. The accepted local-filesystem path-resolution TOCTOU limitation
  remains unresolved.
- No automatic report materialization, host-governed attempt verdict,
  multi-host dispatch, or Control Room integration is claimed.

## 1.17.0

- Retain schema-v1 installation compatibility while adding the explicit,
  project-local schema-v2 multi-adapter inventory and lifecycle commands.
- Keep adapter membership separate from Attempt dispatch: no automatic
  cross-attempt host handoff is provided.
- Preserve user/project state and use ownership/hash checks for managed adapter
  changes; removing the final adapter leaves an auditable v2 tombstone.
- Make the default terminal wizard the normal path for managing existing
  Control Workspaces: list, add, doctor, upgrade, and remove now reuse the
  same project-local lifecycle commands with read-only preflight and explicit
  `apply` confirmation. Attempt-bound host dispatch remains unsupported.
- No breaking changes are intended. Schema-v2 migration remains opt-in through
  an explicit adapter add; schema-v1 readers remain compatible.
- Host-native discovery and delegated execution are not claimed for every host.
  Codex and Hermes project-local entry points remain limited/unproven, and the
  known local-filesystem path-resolution TOCTOU limitation remains unresolved.

## 1.16.0 — 2026-10-11

- Add Triad Cockpit, a read-only local web view started with
  `npx triad-plus cockpit --control <path>`. It is a React UI served by a
  zero-dependency `node:http` backend on 127.0.0.1.
  - Sessions use a one-time login link.
  - Provenance is explicit, and verifier, Reviewer, and Evaluator+ results are
    shown separately.
  - Freshness is shown as three axes, and the candidate is never claimed
    re-checked.
- Ship the compiled UI in the package. The package keeps zero runtime
  dependencies, and the default `npx triad-plus` wizard is unchanged.
- Document the owner-accepted, unfixed path-resolution TOCTOU limitation for
  single-user, locally trusted workspaces; a concurrent replacement of an
  intermediate symlink or directory can still cause an out-of-root read.

## 1.15.0 — 2026-10-07

- Add a minimal, generic evidence manifest and integrity seam with
  evidence-root, candidate, run, and assignment binding plus fail-closed
  validation.
- Preserve backward-compatible no-manifest behavior and compact evidence
  metadata without automatic binary prompt injection.
- Keep Triad process metadata separate from product-owned naming; control-plane
  IDs are not imposed on product names solely for traceability.

## 1.14.0 — 2026-10-02

- Require an independent Reviewer to report bounded semantic compliance for
  every repository skill bound to an assignment; approval cannot omit bound-
  skill coverage or approve a material violated rule.
- Preserve deterministic separation: the verifier proves skill
  identity/integrity while semantic interpretation remains Reviewer-owned.
- Add explicit host authority guidance: “The workspace is delegated. The host
  is not.”
- Add command/toolchain provenance for Triad-controlled canonical commands,
  including resolved executable identity when available and explicit unresolved
  provenance for composite shell commands.
- Add optional trusted gate toolchain binding with fail-closed behavior on
  bound executable identity mismatch, without silent fallback or automatic
  host repair.
- Preserve backward compatibility for assignments without bound repository
  skills and legacy gates without toolchain bindings.

## 1.13.1 — 2026-09-30

- Fix standalone OpenCode role launch so the native `--dir` and OS process cwd
  point at the assigned product worktree.
- Preserve control-workspace OpenCode configuration through child-only
  `OPENCODE_CONFIG_DIR` without copying control assets into the product.
- Strengthen launcher regression coverage for distinct control/product roots
  and spawn-failure profile restoration.

## 1.13.0 — 2026-09-28

- Add the Hybrid Orchestrator control path: semantic Orchestrator governance
  and judgment with a deterministic control plane for mechanically determined
  lifecycle transitions.
- Add deterministic native Developer and independent Reviewer dispatch for
  OpenCode and Codex while preserving existing verifier authority and
  separate role contexts.
- Preserve immutable Assignment Packet reuse, retry/scope semantics,
  fail-closed Reviewer-result normalization, and optional post-run Evaluator+
  semantics.
- Harden OpenCode profile restoration and Codex isolated temporary-home,
  config, and auth cleanup for the new role-dispatch seams.

## 1.12.2 — 2026-09-26

- Fix compatibility for historical assignments with `scope_contract: null` and
  omit unconfigured scope contracts from new bootstrap templates while keeping
  valid scope enforcement fail-closed.
- Clarify the exact explicit verifier identity/run-id invocation contract and
  the omission rule for unconfigured repository-skill bindings.
- Clarify the bounded Card and delivery handoff report-context contract without
  changing Reviewer independence or deterministic verification semantics.

## 1.12.1 — 2026-09-26

- Bind approved human-readable Card reports to the independently verified
  candidate manifest, preserving the pre-commit verifier fingerprint while
  recording the committed fingerprint separately.
- Preserve raw candidate bytes for commit-derived hashes, fail closed on
  post-verification path/content changes, and retain legacy no-manifest
  behavior without silently widening the verified candidate.

## 1.12.0 — 2026-09-23

- Add deterministic human-readable Markdown views for terminal Cards and the
  final delivery handoff, derived from canonical evidence with baseline-based
  changed-path attribution and truthful blocked/not-delivered reporting.

## 1.11.0 — 2026-09-17

- Add an installation manifest that records Triad-owned assets, materialized
  version, adapter scopes, hashes, and deterministic ownership fingerprint.
- Add CLI/workspace version visibility, legacy manifest migration through
  `upgrade --apply`, and conservative dry-run/apply uninstall for all adapters.
- Preserve modified or unknown assets and all project-control state during
  uninstall; report version skew and manifest integrity through `doctor`.
- Preserve shared global assets by default, remove only exact managed
  `AGENTS.md` blocks, and leave generic host directories untouched.

## 1.10.0 — 2026-09-16

- Improve TUI and doctor output with terminal-native summaries, sober color
  handling, `NO_COLOR`, and non-TTY support.
- Add the agent-first model-configuration skill with `.triad-plus/team.json`
  as the role/model source of truth and explicit host-native bindings,
  including OpenCode `variant` materialization.
- Add shared-skill diagnostics and repair during managed upgrades, plus
  deterministic repository/runtime context verification and nested-repository
  hardening.
- Fail closed on incorrect working directories, mixed Git roots, symlink
  escapes, missing or mutated skills, and implicit fallback to unrelated skill
  copies.

## 1.9.0 — 2026-09-16

- Add native BMAD `epics.md` intake while preserving the boundary that BMAD
  plans and Triad executes.
- Add shared immutable Assignment Context/Packet binding for Developer and
  Reviewer work, including repository/worktree authorization and required
  repository-skill path/hash verification.
- Harden repository-mapping parsing and align runtime adapters and
  documentation with the assignment contract.
- Update Copilot custom-agent metadata to the current invocation model with
  named Developer, Reviewer, and Evaluator contexts. Copilot CLI runtime
  qualification passes; the VS Code desktop bridge remains host-dependent on
  the tested host.

## 1.8.1 — 2026-09-15

- Preserve supported role model bindings from `.triad-plus/team.json` when
  project-frontmatter adapters refresh managed agents during `upgrade --apply`.
- Materialize OpenCode `reasoning_effort` as `reasoningEffort` and keep null or
  blank values on the host default; Claude Code continues to manage reasoning
  through its host configuration.

## 1.8.0 — 2026-09-12

- Add an optional Immutable Quality Contract with a deterministic Quality
  Baseline fingerprint and fail-closed source-drift detection.
- Add phase-scoped `product_quality` and `delivery_closure` criteria,
  criterion-level Evaluator+ validation, and a deterministic aggregate
  verdict.
- Add deterministic Evaluator+/Delivery control-plane validation while
  preserving legacy Triad+ 1.7 compatibility.

## 1.7.0 — 2026-09-10

- Add an optional deterministic importer for one BMAD `ready-for-dev` Story at
  a time, preserving the normal Triad Card contract and source provenance.

## 1.6.0 — 2026-09-05

- Add card-declared repository `required_gates` with additive per-card gate
  selection; globally required gates are always preserved.
- Promote selected optional repository gates to mandatory for the card, with
  trusted assignment binding, fail-closed unavailable-gate handling, and
  generic gate-selection evidence.
- Preserve the existing legacy behavior when a card has no selected gates.

## 1.5.0 — 2026-09-05

- Add cause-coded retry/recovery accounting with independent finite runtime and
  candidate-remediation budgets, plus fail-closed retry-policy validation while
  retaining backward-compatible legacy retry behavior.
- Add opt-in deterministic candidate scope contracts with card-level baselines,
  changed-path evidence, and scope verification before expensive gates.
- Keep independent Reviewer approval mandatory after deterministic verification.

## 1.4.2 — 2026-09-01

- Align package repository, homepage, and issue links with the renamed GitHub
  account (`ainz-dg`).

## 1.4.1 — 2026-08-28

- Fix Codex Orchestrator liveness across `wait_agent` polling timeouts. While a
  delegated Developer or Reviewer assignment remains active, a timeout is
  non-terminal: the Orchestrator refreshes status and waits again in the same
  parent turn instead of returning control to the owner. Validated with real
  Codex Developer and Reviewer wait timeouts, explicit verification,
  independent review, dependent-card continuation, and zero owner follow-ups.

## 1.3.0 — 2026-08-26

- Keep the declared card chain unattended from Developer completion through
  verification, review, and the next dependency-satisfied card.
- Bind repository skill files and hashes to attempts as verifier evidence, and
  make role activations observable to the owner.
- Require a formal owner delivery closure: final push evidence, optional
  Evaluator+ report, handoff, run-record update, and practical-test guidance.
- Make local versus remote demo access explicit; `localhost` is never reported
  as a remote endpoint.
- Use explicit verification dispatch by default on Codex; retain the async
  `SubagentStop` hook as an experimental opt-in path.

## 1.4.0 — 2026-08-28

- Promote the GitHub Copilot adapter to supported status with official Copilot
  CLI/Desktop integration and distinct Orchestrator, Developer, Reviewer, and
  Evaluator+ custom-agent contexts.
- Validate explicit verification dispatch and unattended dependent-card
  continuation in Copilot Desktop.
- Harden the Evaluator+ packet boundary so verdicts use only the approved
  packet and not out-of-packet control or delivery records.

## 1.2.0 — 2026-08-25

- Add safe dry-run/apply upgrades for existing project-control workspaces.
- Maintain a narrowly scoped Triad+ role-run instruction overlay and report
  potential host identity-policy conflicts in `doctor`.
- Require the configured Orchestrator to introduce itself at the beginning of
  every Triad+ run.

## 1.1.1 — 2026-08-25

- Ensure every supported host adopts the configured Orchestrator display name
  for owner-facing communication.
- Keep the public install-test fixture neutral.

## 1.1.0 — 2026-08-24

- Automatically dispatch configured Evaluator+ after Triad approval, without
  allowing it to reopen or repair the closed run.
- Add a five-minute OpenCode tutorial and refresh README onboarding.
- Remove operational service artifacts from the public tree.
- Change future releases to Apache-2.0.

## 1.0.0 — 2026-08-24

- Public Triad+ engineering loop with Orchestrator, Developer, and Reviewer.
- Optional fresh post-run Evaluator+.
- Codex, Claude Code, OpenCode, Antigravity, and Hermes Agent adapters.
- Hash-bound control-plane verification evidence and package installer.
- Public setup, runtime, architecture, verification, and contribution guides.
