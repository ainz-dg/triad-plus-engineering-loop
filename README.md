# Triad+

<p align="center">
  <img src="assets/triad-plus-engineering-loop-icon.svg" alt="Triad+ logo" width="220">
</p>

## Stop letting the same AI write the code and approve its own work.

Triad+ gives coding agents a lightweight engineering loop with separate
implementation, review, and orchestration.

> **Developer proposes. Reviewer challenges. Orchestrator governs.**

## Why Triad+?

| | What changes |
| --- | --- |
| **Independent review** | A Reviewer examines the candidate and verifier evidence instead of asking the Developer to grade its own work. |
| **Different models per role** | Choose models, personas, and supported effort per role within one selected runtime. |
| **Evidence-backed verification** | A claim that tests passed is not proof: `triad-verify` records environment-derived gate evidence. |
| **Works across coding agents** | Use Codex, Claude Code, OpenCode, Antigravity, Hermes Agent, or GitHub Copilot through peer adapters. |

Triad+ is for the moment after a coding agent says “done”: it gives that claim a
separate reviewer, deterministic checks, and an orchestrator that decides what
happens next.

## How it works

```text
                   Orchestrator
                   /           \
            Developer  ←→  Reviewer
                   ↓
             triad-verify evidence

Reviewer approved
       ↓
Evaluator+ (only when configured; fresh and post-run)
```

The normal path is `Developer → verification → Reviewer → approved | rework |
blocked`. The Orchestrator governs the loop. When configured, Evaluator+ runs
automatically after approval with a fresh packet; a `FAIL` is information for a
future user-initiated run, never an automatic repair.

## Try Triad+ in 5 minutes with OpenCode

OpenCode is the canonical tutorial because it is open source and makes the
separate Triad roles easy to inspect.

1. Install OpenCode and configure a provider/model, following the
   [OpenCode documentation](https://opencode.ai/docs).
2. Create a small product folder and deterministic test command:

   ```bash
   mkdir triad-celsius && cd triad-celsius
   npm init -y
   npm pkg set type=module
   npm pkg set scripts.test='node --test'
   ```
3. Create a separate control workspace and install the OpenCode adapter:

   ```bash
   npx triad-plus init --host opencode --control "$PWD/triad-control"
   npx triad-plus doctor --host opencode --control "$PWD/triad-control"
   ```

   The setup asks for the Orchestrator, Developer, Reviewer, and optional
   Evaluator+ names, personas, and models. Choose `yes` for Evaluator+ if you
   want it automatically after approval.
4. Save this tiny PRD as `celsius-prd.md` beside the product project:

   ```md
   # Goal
   Create a `celsiusToFahrenheit` utility.

   ## Acceptance criteria
   - Export `celsiusToFahrenheit(value)`.
   - `celsiusToFahrenheit(0)` returns `32`.
   - `celsiusToFahrenheit(100)` returns `212`.
   - Add automated tests.

   ## Verification
   npm test
   ```
5. Open `triad-control` **interactively** in the OpenCode TUI and run:

   ```text
   /triad /absolute/path/to/celsius-prd.md
   ```

Expected experience:

```text
Orchestrator
      ↓
Developer implements
      ↓
triad-verify produces evidence
      ↓
Reviewer inspects
      ├─ approved → optional automatic Evaluator+
      └─ rework → Developer
```

The Orchestrator first shows the feature cards, then delegates the bounded work.
If a tutorial step is unclear, see the [OpenCode guide](docs/runtimes.md#opencode)
and [troubleshooting](docs/troubleshooting.md).

## Installation version and safe uninstall

The CLI version and the version materialized in a control workspace are
reported independently:

```bash
npx triad-plus --version
npx triad-plus version --control /absolute/path/to/triad-control
```

Successful `init` and `upgrade --apply` operations record exact Triad-owned
files in `.triad-plus/installation.json`. This manifest does not own
`.triad-plus/team.json`, `.loop/`, product files, or evidence.
`init` is the first-install path; `upgrade --apply` is also the managed
update/repair/restore path for a registered workspace, including one left
`uninstalled` or `partial` by safe uninstall.

Uninstall is conservative and dry-run by default:

```bash
npx triad-plus uninstall --host opencode --control /absolute/path/to/triad-control
npx triad-plus uninstall --host opencode --control /absolute/path/to/triad-control --apply
```

Only unchanged files recorded by the manifest are removed. Modified or
unknown files are preserved and reported; user state remains available for a
future installation or review. Generic host directories are never pruned. A
managed `AGENTS.md` role-run block is removed only when its markers and hash
are exact; surrounding user content is preserved. Global assets are shown but
preserved by default with `--global` because another control workspace may
share them.

## Optional immutable quality target

An initialized project may bind an immutable JSON Quality Baseline through
`project.quality_contract`. Triad fingerprints the canonical manifest, verifies
all declared sources before running costly gates, and fails closed on malformed
contracts or source drift. `product_quality` criteria are evaluated one by one
by a fresh Evaluator+; `delivery_closure` criteria remain in the delivery gate.
Projects without this opt-in continue to use the legacy PRD baseline path.

## Native BMAD handoff

BMAD planning hands `epics.md` to Triad+ directly. Start the normal host entry
point with the planning artifact (or its `_bmad-output` directory):

```text
/triad /absolute/path/to/_bmad-output/planning-artifacts/epics.md
```

Triad deterministically detects Epic and Story sections, ingests multiple
Stories without creating intermediate Story files, resolves repository and
quality-gate readiness from the project-control workspace, and materializes
normal Cards with source SHA/provenance. `epics.md` remains read-only. BMAD owns
planning; Triad owns execution, verification, review, and delivery.

`import-bmad-story` remains a low-level compatibility/API path for standalone
ready-for-dev Stories, debugging, and automation. It is no longer the primary
BMAD workflow. See the [BMAD integration guide](docs/bmad-integration.md).

## Human-readable delivery reports

Triad+ can materialize deterministic Markdown views from canonical control-plane
records: one report for each terminal Card and a human-first final handoff. The
views include baseline-attributed changed paths, attempts, verifier gates,
independent review, provenance, residual risks, and practical-test links. They
never replace the JSON/YAML evidence or add an LLM reporting call. See the
[human-readable reports guide](docs/human-readable-reports.md).

## Quick start for every runtime

Requirements: Node.js 20+ and one supported coding-agent host.

```bash
npx triad-plus init --host codex --control /absolute/path/to/triad-control --global
npx triad-plus doctor --host codex --control /absolute/path/to/triad-control
```

Open the control workspace in the selected host and start Triad with an absolute
PRD path:

| Host | Entry point |
| --- | --- |
| Codex | `/prompts:triad /absolute/path/to/prd.md` |
| Claude Code | `/triad /absolute/path/to/prd.md` |
| OpenCode | `/triad /absolute/path/to/prd.md` |
| Antigravity | `/triad /absolute/path/to/prd.md` |
| Hermes Agent | `/triad /absolute/path/to/prd.md` |
| GitHub Copilot | `/triad /absolute/path/to/prd.md` or select `triad-orchestrator` with `/agent` |

## Evaluator+

Evaluator+ is not a fourth member of Triad and is never a repair controller.
Configure it once in `team.json` (`roles.evaluator.enabled: true`) or in the
installer. The Orchestrator automatically dispatches it after Triad approval.
It sees only the goal, quality target, final candidate, and verifier evidence.

## Supported coding agents

| Runtime | Orchestrator | Developer | Reviewer | Evaluator+ | Verification dispatch |
| --- | --- | --- | --- | --- | --- |
| Codex | Yes | Yes | Yes | Yes | Explicit dispatch by default; experimental async hook opt-in |
| Claude Code | Yes | Yes | Yes | Yes | Explicit fallback; validated hook when available |
| OpenCode | Yes | Yes | Yes | Yes | Explicit dispatch |
| Antigravity | Yes | Yes | Yes | Yes | Explicit dispatch |
| Hermes Agent | Yes | Yes | Yes | Yes | Explicit dispatch |
| GitHub Copilot | Yes | Yes | Yes | Yes | Explicit dispatch; no lifecycle hook |

## Configuration and verification

The installer writes `.triad-plus/team.json`, which separates stable role IDs
from user-facing names, personas, models, and supported effort/options. A control
workspace selects one host adapter for the whole run; its roles can use different
models where that host supports them. To use another host, create another control
workspace with that adapter. Triad+ does not dispatch different roles across
different hosts in one run. Read [configuration](docs/configuration.md) and
[runtime details](docs/runtimes.md).

The installed `triad-model-configuration` Agent Skill lets the host agent
inspect or change requested role models while preserving `team.json` as the
source of truth and reporting host-specific binding limits.

On OpenCode, `team.json`'s `reasoning_effort` is materialized as the native
per-agent `variant`; the OpenCode session default is a separate host setting.

`triad-verify` validates assignment/candidate binding, runs declared
control-plane gates, detects mutation, and writes evidence. It supports the
loop; it never replaces the Orchestrator. See [verification](docs/verification.md).

## Scope and limitations

Triad+ is deliberately not a workflow engine, daemon, scheduler, dashboard,
shared-memory system, automatic model router, multi-reviewer system, or
evaluator-driven repair loop. See [architecture](docs/architecture.md).

## Contributing

Start with [CONTRIBUTING.md](CONTRIBUTING.md). Keep runtime-specific behavior in
an adapter and preserve the small Core.

## License

[Apache-2.0](LICENSE). Triad+ is permissively licensed for personal and
commercial use.
