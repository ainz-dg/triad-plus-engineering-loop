# Universal onboarding: entry audit

Audit for Nazarick delivery #26, 2026-11-10. Baseline:
`9f5cdd3404adc3437904356bdc8d8b6256f1dd5a` (after PR #46).
This records the installed paths and limits before the shared onboarding work;
it is not a claim that all hosts already have a guided readiness flow.

| Host | Installed entry event | Deterministic preflight before agent activation | Prompt / repair surface | Verifiable limits |
| --- | --- | --- | --- | --- |
| OpenCode | `/triad`, `.opencode/commands/triad.md`, selected `triad-orchestrator` | None; the host reads agent frontmatter before Triad instructions | Native conversation; a terminal preflight can precede host launch | Unknown native model overrides can prevent entry; model availability is project/provider specific |
| Claude Code | `/triad`, `.claude/commands/triad.md` | None; the supplied lifecycle hook is `SubagentStop`, not an entry gate | Native conversation; command preprocessing exists but is not a portable enforcement boundary | Model/effort capabilities differ from other hosts; current session is separate from subagent profiles |
| Codex | `$triad`, consent-installed user skill and workspace binding | Trusted wrapper checks the exact binding before local validator code, but the skill is model-instructed, **after** LLM activation | Conversation and explicit blocked-path remediation | Existing global entry requires opt-in; native profiles are user-level; no universal verified catalog |
| GitHub Copilot | `/triad` skill where supported; explicit `/agent` fallback | Instructions only; no supplied universal entry hook | Host conversation; CLI/IDE/cloud capabilities differ | Native model and custom-agent support depend on the surface; no inferred cross-surface API |
| Antigravity | `/triad` skill in `.agents/skills/triad` | Instructions only | Host conversation / skill | Team intent is already record-only; native effective model may be unobservable |
| Hermes | `/triad`, consent-installed active-profile skill and binding | Same trusted, post-LLM wrapper model as Codex | Conversation and explicit blocked-path remediation | Active profile determines global path; local CLI availability is not a proven native session |

Source evidence: [adapter registry](../adapters/registry.mjs), each adapter's
`runtime.json` and entry assets, [host validator](../runtime/triad-host-entry.mjs),
[trusted wrapper](../runtime/triad-host-entry-preflight.mjs),
[Codex hook](../integrations/codex/hooks.json),
[Claude hook](../integrations/claude-code/hooks.json), and
[model writers](../bin/triad-plus.js). Hooks currently trigger deterministic
verification after Developer completion, not universal entry readiness.

The existing host validator supports Codex and Hermes only. It checks the
installation's recorded bytes, root PRD, gate definitions, mapped repositories
and worktrees. Other entry assets currently instruct the agent to begin the
loop directly. Adding a check inside the Orchestrator cannot fix an agent file
that the host rejects before loading those instructions.

## First increment: loadable model assets

`team.json` remains canonical **requested intent**. Managed model/effort
overrides are omitted from generated native files for all hosts; the legacy
Codex profile writer also omits them. Managed frontmatter upgrade removes stale
overrides and preserves intent. The current consented Codex entry installs a
skill/wrapper, not role profiles: existing user-level TOML files outside that
managed scope remain untouched and require separately previewed remediation. Setup summaries say requested
versus host default; an ID is never claimed selected merely because it is saved.
Lexical wizard checks reject spaces/control characters, require OpenCode's
`provider/model` shape, and stop after three invalid attempts without applying
the installation. These checks do not verify a model catalog.

Native model selection remains the host's responsibility and must be confirmed
or explicitly reported unobservable. The shared readiness/confirmation flow,
inactive gate proposals, receipts and automation failures are a subsequent,
strictly sequential increment; this first increment does not claim them.

## Gate boundary to preserve

The deterministic verifier runs gates in the assigned repository's worktree
and binds their source hash. Existing `assignment.gates_path` supports a
repository-specific catalog. Discovery must be read-only and proposals inactive;
it must not collect commands from several repositories into a catalog that runs
them all in one worktree. Manifest text is data, never agent instructions.
No discovered command, package lifecycle hook, install, publish, deploy,
Docker or VRT command may run merely to establish readiness.

## Local host observations

Read-only version probes: OpenCode 1.19.3, Claude Code 2.1.308, Codex 0.163.0,
and `agy` 1.4.5 returned successfully. Copilot's version probe timed out after
eight seconds; Hermes returned exit 1. Neither counts as an available native
end-to-end session. These observations are machine-specific, not requirements.

The opt-in [native loader smoke](../tests/opencode-model-load-smoke.mjs) installs
Triad+ in a temporary workspace, adds a legacy malformed override, runs the real
OpenCode `--pure debug agent triad-orchestrator`, applies the managed upgrade,
then loads the agent again. HOME, XDG and OpenCode configuration are isolated;
no credentials, plugins, provider requests or LLM execution are used. It confirms
that `model: "gpt 6 luna medium"` becomes a provider override with an empty model
ID; after upgrade there is no model override and canonical intent is identical.
Both debug reads exit zero: this is loader evidence, **not** a reproduced runtime
failure or a complete loop test. Run explicitly on a machine with OpenCode:

```bash
TRIAD_OPENCODE_SMOKE_BIN="$(command -v opencode)" node tests/opencode-model-load-smoke.mjs
```

The normal suite covers wizard correction/finite failure with real PTYs,
legacy intent preservation across install/upgrade on all six adapters, native
frontmatter omission and stale-field cleanup. The native smoke is not silently
substituted with a fake CLI when unavailable in CI.
The end-to-end invalid-model → remediation → valid entry acceptance criterion
remains open for the shared-preflight increment.

Host references checked during the audit:
[OpenCode models](https://opencode.ai/docs/models/),
[OpenCode agents](https://opencode.ai/docs/agents/),
[OpenCode commands](https://opencode.ai/docs/commands/),
[Copilot custom agent fields](https://docs.github.com/en/copilot/reference/custom-agents-configuration).
The installed assets and explicit capability limits take precedence over
assuming all harnesses expose an identical prompt, catalog, or pre-LLM hook.
