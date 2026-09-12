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

## Optional immutable quality target

An initialized project may bind an immutable JSON Quality Baseline through
`project.quality_contract`. Triad fingerprints the canonical manifest, verifies
all declared sources before running costly gates, and fails closed on malformed
contracts or source drift. `product_quality` criteria are evaluated one by one
by a fresh Evaluator+; `delivery_closure` criteria remain in the delivery gate.
Projects without this opt-in continue to use the legacy PRD baseline path.

## Optional BMAD Story import

When BMAD planning has already produced a Story with `status: ready-for-dev`,
you can convert one Story at a time into the normal Triad Card contract:

```bash
npx triad-plus import-bmad-story \
  --source /absolute/path/to/story.md \
  --output /absolute/path/to/control/features/STORY-001.md
```

The importer is read-only and fail-closed. It preserves the Story's executable
intent, acceptance criteria, technical context, and references, while any
required gates or dependencies remain explicit caller options. It does not run
BMAD workflows or add BMAD semantics to the Core. See the [BMAD integration
guide](docs/bmad-integration.md).

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
