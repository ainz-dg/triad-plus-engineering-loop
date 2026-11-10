# Codex adapter

Run `npx triad-plus` and select Codex as a project adapter. To add the optional
user-level `$triad` entry, select Codex on the **Optional global entry bridge**
screen, review the exact absolute `CODEX_HOME/skills/triad/SKILL.md` target, then
type `install` at the final preview. No global file is written when that
optional entry is skipped. Direct global `init`/`upgrade` and the legacy
`install.sh --global` path refuse to bypass this consent.

Open the Control Workspace and run `$triad <absolute-prd-path>`. The prompt
checks that exact workspace before doing Triad work, but runs after the host
model has been invoked; it is not a pre-LLM security boundary.

Codex can use native role profiles, but current generated assets do not apply
or verify requested per-role model overrides. The shared preflight requires
explicit host-default consent and per-repository gate approvals; see
[guided readiness](universal-readiness.md) and its global migration limits. Verification uses explicit dispatch by default, even when a complete,
version-compatible async `SubagentStop` hook is installed. This keeps the normal
unattended path on the directly auditable verifier route.

The async hook remains available as an experimental opt-in by setting
`requested_mode=async_hook` in capability detection. Hook output is evidence
only; it never changes Triad state by itself. If the requested experimental hook
is unavailable, capability detection fails safe to explicit dispatch.

During delegated work the Codex Orchestrator parent turn stays alive. A
`wait_agent` timeout is a non-terminal polling interval: refresh status and
wait again in the same turn while the Developer or Reviewer remains active.
Progress messages are informational, not owner-wait points; completion flows
directly to verification, review, and card continuation.
