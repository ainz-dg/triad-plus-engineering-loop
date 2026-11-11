# Compatibility matrix

The role and dispatch columns describe installed adapter contracts and
fixture coverage, not six live native sessions. The v1.22.4 package acceptance
includes one native OpenCode 1.19.3 host-default E2E; the other hosts have no
live session attested by this release preparation.

| Runtime | Install/contract | Orchestrator | Developer | Reviewer | Evaluator+ | Verification dispatch | Hook support | Live E2E in v1.22.4 scope |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Codex | Yes | Adapter | Adapter | Adapter | Adapter | Explicit dispatch by default; experimental async `SubagentStop` opt-in | Optional async `SubagentStop` | Not attested |
| Claude Code | Yes | Adapter | Adapter | Adapter | Adapter | Explicit fallback; hook when validated | Optional `SubagentStop` | Not attested |
| OpenCode | Yes | Adapter | Adapter | Adapter | Adapter | Explicit dispatch | No adapter hook | 1.19.3 host-default, task PASS |
| Antigravity | Yes | Adapter | Adapter | Adapter | Adapter | Explicit dispatch | No adapter hook | Not attested |
| Hermes Agent | Yes | Adapter | Adapter | Adapter | Adapter | Explicit dispatch | No adapter hook | Not attested |
| GitHub Copilot | Yes | Adapter | Adapter | Adapter | Adapter | Explicit dispatch | No adapter hook | Not attested |

All adapters consume the same role IDs and project-control records. Runtime
model/effort application is not active or verified per role in this release
scope. `.triad-plus/team.json` preserves requested intent; generated assets
omit unverified overrides. In the live OpenCode run, Orchestrator, Developer,
and Reviewer all used the selected `opencode/big-pickle` session default,
variant `default`. This does not establish distinct model routing.
