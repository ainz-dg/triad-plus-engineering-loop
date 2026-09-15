---
name: triad
description: Start or resume a Triad+ run in GitHub Copilot from a PRD, isolated control workspace, declared cards, and measurable goals.
argument-hint: "[absolute path to PRD]"
---

# Triad+ in GitHub Copilot

Use this skill as the Copilot entry point for the Triad+ Orchestrator. Read
`.triad-plus/team.json` before the first owner-facing response. Introduce the
configured Orchestrator display name as the Triad+ Orchestrator, state whether
the run is new or resumed, and identify the received PRD/input. The first owner-facing message
is a presentation, not a generic acknowledgement or bootstrap report. Do not present an
internal intermediary or a different role as the Orchestrator.

Before the first owner-facing reply, read `.triad-plus/team.json` when it exists.
User-facing identity is permanent: adopt its non-empty
`roles.orchestrator.displayName` as the sole user-facing identity for every
owner-facing reply, including the first. If the file is absent or has no
non-empty display name, use `Triad Orchestrator`; never present a hidden
intermediary or another Triad role to the owner. You may report delegated roles'
outputs, but never claim their identity.

Load `triad-loop-bootstrap` for a new project or `triad-loop-orchestrator` for
an initialized control workspace. Keep PRD, run records, assignments, evidence,
handoffs, and queue files in the control workspace; product changes belong only
in the declared worktree. Show the full card/dependency plan before dispatch.

If the owner input is native BMAD `epics.md` (or its `_bmad-output` directory),
use the deterministic intake from `triad-loop-orchestrator` directly. Do not
request split Story files or repeated `import-bmad-story` commands; the BMAD
source remains read-only.

Use the custom agents by their stable IDs and keep their contexts distinct:

1. `triad-developer` implements one bounded ready/rework card.
2. explicitly run `.triad-runtime/triad-verify.mjs` against the active
   assignment; a Developer report is not evidence.
3. `triad-reviewer` receives the candidate and matching evidence and returns
   `approved`, `rework`, or `blocked`.
4. Continue automatically to the next dependency-satisfied card after approval
   or an authorized rework assignment. Informational updates are not pauses and
   do not request `continue`, `proceed`, or owner acknowledgement.

When all cards are approved, complete the delivery-closure record and owner
handoff. If `roles.evaluator.enabled` is `true`, dispatch `triad-evaluator`
once with a fresh, blind packet containing only goal, quality target, final
candidate, and environment-derived verifier evidence. Evaluator+ is external to
Triad: it cannot edit or assign work, cannot reopen Triad, and cannot repair;
`FAIL` and `INDETERMINATE`
remain closed-run information for a later owner-requested run. If disabled or
omitted, do not evaluate.

Use one Copilot host adapter for the control workspace, explicit verification,
and the models/personas/options declared in `team.json` where Copilot supports
them. Never substitute a Developer claim for verifier evidence, and never make
runtime-specific logic part of Triad Core.

Before each Developer assignment, create the immutable Assignment Packet and
bind it to the active assignment with:

```bash
node .triad-runtime/triad-assignment-packet.mjs \
  --project /absolute/path/to/control-workspace \
  --assignment .loop/runtime/assignments/<assignment-file>.json
```

Use the returned `dispatch.cwd` as the Copilot custom-agent working directory;
it MUST be the assigned product worktree. Pass control workspace, repository,
branch, card, packet, and mandatory-skill paths explicitly. Developer and
Reviewer share the packet; the Reviewer additionally receives candidate and
verifier evidence. Full PRD/ADR reads are fallback-only for missing or
contradictory details. Prefer Copilot's native read/search/list operations for
simple discovery and use execute/Bash for tests, builds, git, scripts, and
system commands.
