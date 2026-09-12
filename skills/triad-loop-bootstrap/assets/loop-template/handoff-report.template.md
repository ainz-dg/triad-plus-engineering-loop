# Delivery handoff — <project ID>

## Decision

`delivered | delivery_blocked | delivered_without_demo`

## Evidence

- PRD baseline: `<source and SHA-256>`
- Approved cards: `<IDs and count>`
- Branches and commits: `<repository: branch @ SHA>`
- Push evidence: `<remote and branches>`
- Gates and metrics: `<summary>`
- Deferred items or waivers: `<none or owner decision>`
- Known risks: `<none or list>`

## Review and verification audit

| Feature | Verification runs | Final candidate fingerprint | Reviewer decision | Optional Evaluator+ report |
| --- | --- | --- | --- | --- |
| `<ID>` | `<count>` | `<SHA-256>` | `<approved|rework|blocked>` | `<none or report reference>` |

- Evidence/review chain: `<verification/review/evaluator references>`

## Quality Contract closure

- Quality Baseline: `<path, revision, fingerprint or legacy PRD-only mode>`
- Product-quality Evaluator+ verdict: `<PASS|FAIL|INDETERMINATE|not configured>`

| Criterion | Scope | Verdict | Evidence references |
| --- | --- | --- | --- |
| `<delivery criterion ID>` | `delivery_closure` | `<PASS|FAIL|INDETERMINATE>` | `<refs>` |

Delivery is `delivered` only when every configured `delivery_closure` criterion
is recorded as `PASS`. Product-quality criteria are evaluated by the fresh
Evaluator+ packet and are never silently evaluated during delivery closure.

## Local-worktree integration

| Card | Consumer worktree | Provider worktree | Branch/commit map | Setup command | Data/event/callback gate |
| --- | --- | --- | --- | --- |
| `<not applicable or ID>` | `<path>` | `<path>` | `<repo: branch @ SHA>` | `<command/result>` | `<command/result>` |

Package publication/release: `not performed by this loop`

## Orchestrator exception audit

- Exceptions: `<0 or count>` / `<total cards>`
- Normal roles restored: `<yes/no; evidence>`

| Exception ID | Trigger | Scope | Independent review | Return to normal delegation |
| --- | --- | --- | --- |
| `<none or ID>` | `<reason>` | `<bounded task>` | `<report/waiver>` | `<when/how>` |

## Owner-controlled demo

State: `not_applicable | ready_to_start | active | closed | start_failed`

| Service | Worktree | Command | Local check | Remote URL | Remote check | Process group |
| --- | --- | --- | --- | --- | --- |
| `<id>` | `<path>` | `<command>` | `<not started/pass/fail>` | `<declared URL>` | `<not started/pass/fail>` | `<none or reference>` |

- Start: `<only on owner request>`
- Stop: `<only on owner completion>`
- Closure evidence: `<timestamp, process result, port-release check>`
- Remote access contract: `<none | declared remote URL and access mode>`.
  `localhost` is local-only and must not be presented as a remote endpoint.

## Delivery closure record

- Run record updated: `<path and final decision>`
- Final branch/commit map recorded: `<yes/no; reference>`
- Final delivery message issued: `<yes/no; timestamp or reference>`

## Practical test and follow-up

| Feature | Environment | Steps | Expected result | Owner result |
| --- | --- | --- | --- | --- |
| `<ID>` | `<URL or none>` | `<steps>` | `<observable result>` | `to be tested` |

Feedback does not reopen this handoff. Follow-up: `none | feature card <ID> | successor project <ID> | owner decision required`.
