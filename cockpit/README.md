# Triad Cockpit — read-only backend (prototype)

Status: **prototype, not packaged**. This directory is not listed in
`package.json#files` and is not reachable from `bin/triad-plus.js`. The final
command name, packaging, and UI are open decisions.

The backend lets a future web UI consult what Triad+ has actually persisted in
one control workspace. It does not orchestrate, does not record transitions,
and does not change how Triad+ runs:

- `node:http` only; no runtime dependencies, no CopilotKit or AG-UI.
- Stateless: every request re-reads the artifacts. No database, cache, daemon,
  or new persistence.
- Read-only: only `GET`/`HEAD`; no file is written; no process is started.
- Reuses existing Core validators instead of re-implementing contracts:
  `validateInstallationManifest`, `validateTeamConfiguration`,
  `validateAssignmentPacket`, `validateReviewerResult`, and
  `validateEvaluatorResult`.

## Run the prototype

```bash
node cockpit/server/cli.mjs --control <project-control-path> [--port <n>]
```

The server binds to `127.0.0.1` (port `0` = ephemeral) and prints a one-time
session URL. Opening it sets an `HttpOnly`, `SameSite=Strict` cookie; scripts
may send `Authorization: Bearer <token>` instead. Stop it with Ctrl+C.

## Data model

Project → Card → Attempt → Evidence. There is no universal "Run" object:
host-governed runs do not persist one.

- **Project:** the control root when it has `.loop/`, plus every `projects/<id>/`
  directory with a `.loop/`. Real workspaces use both layouts.
- **Card:** an ID found in `.loop/work-queue.yaml`, an assignment, or readable
  verifier evidence. Evaluator+ results never create a card; unmatched ones are
  listed separately.
- **Attempt:** grouped by the integer `attempt` recorded in assignments and in
  `verification.json`, never by directory name.
- **Evidence:** `verification.json` and gate logs, assignment packets,
  Evaluator+ results, the optional deterministic-driver output, and review or
  handoff documents.

## Provenance

Every object carries `provenance`, so a client can tell fact from declaration.

| Value | Meaning | Examples |
|---|---|---|
| `code-written` | Written by Triad+ runtime code. | `verification.json`, gate logs, assignment packets, installation manifest, `deterministic-control-run.json` |
| `code-validated` | Written by an agent and accepted by a Core validator. | `team.json`, valid Evaluator+ results, the Reviewer contract inside the deterministic-driver output |
| `agent-declared` | Written by an agent with no Core validation. | `work-queue.yaml` states, assignment JSON, review Markdown, invalid Evaluator+ results |
| `cockpit-derived` | Computed here from the artifacts above. | freshness, counts, attempt grouping |

## Two workflows, kept apart

- **Host-governed runs (normal path).** The host agent is the Orchestrator.
  Reviewer outcomes live in agent-written files: run-state, `.loop/reviews/*.md`,
  or review reports next to the evidence. These files are returned as
  `agent-declared` documents.
- **Optional deterministic driver.** `runtime/triad-control-run.mjs` writes
  `.loop/runtime/deterministic-control-run.json`, but only when the run ends in
  `done` or one of the `stopped_*` states. Its Reviewer contract was parsed and
  validated by the driver, and the Cockpit re-validates it with
  `validateReviewerResult`. Only the default output path is discovered.

## Freshness of verifier evidence

Code-written evidence is not assumed current. For each `verification.json` the
backend hashes the control-workspace files the verifier bound and reports:

| Status | Meaning |
|---|---|
| `current` | The assignment, card, PRD, and gates hashes all match, and this is the newest verification for the card. |
| `stale` | At least one bound file changed after verification. The historical result is not wrong; it no longer describes the current files. |
| `superseded` | The bindings match, but a newer verification exists for the card. |
| `unknown` | A binding was not recorded, is missing, or lies outside the allowlist. |

The product worktree is never inspected (that would require running `git`), so
a candidate that changed after verification is not detectable here.

## Endpoints

All responses are `application/json`. All endpoints except `/api/session`
require the session.

| Endpoint | Returns |
|---|---|
| `GET /api/session?token=…` | Sets the session cookie. |
| `GET /api/workspace` | Installation manifest status, team roles, discovered projects. |
| `GET /api/projects/:project/cards` | Card list: declared queue data next to observed evidence, plus `unmatched_evaluations` and `diagnostics`. |
| `GET /api/projects/:project/cards/:card` | Attempts (assignments, packets, verifications with gates, freshness, and documents), Evaluator+ results, Reviewer documents, deterministic-driver output. |
| `GET /api/projects/:project/control-run` | The deterministic-driver output, or `404` when absent. |
| `GET /api/projects/:project/files?path=…` | One allowlisted file in a JSON envelope (`content`, `sha256`, `size`, `truncated`). Bounded to 1 MiB. |

Errors use `{ "error": { "code", "message" } }` with these status codes:
- `400` malformed request;
- `401` no or invalid session;
- `403` Host or path refused;
- `404` unknown resource;
- `405` mutation attempt.

### Example responses

These come from the synthetic fixture in `tests/cockpit-server-test.mjs` and
are abbreviated.

`GET /api/projects/root/cards` (one card):

```json
{
  "id": "1.2",
  "declared": {
    "status": "declared",
    "provenance": "agent-declared",
    "source": ".loop/work-queue.yaml#L13",
    "title": "Farewell utility",
    "state": "in_review",
    "attempts": 2,
    "depends_on": ["1.1"]
  },
  "observed": {
    "provenance": "cockpit-derived",
    "assignment_count": 2,
    "attempt_numbers": [1, 2],
    "verification_count": 2,
    "latest_verification": {
      "status": "pass",
      "created_at": "2026-10-04T10:00:00.000Z",
      "source": ".loop/evidence/1.2/attempt-002/verification.json",
      "provenance": "code-written"
    }
  }
}
```

`GET /api/projects/root/cards/1.2` (one verification in attempt 2):

```json
{
  "source": ".loop/evidence/1.2/attempt-002/verification.json",
  "provenance": "code-written",
  "status": "pass",
  "attempt": 2,
  "required_gates_passed": true,
  "candidate_fingerprint": "fp-122",
  "gates": [
    { "id": "npm-test", "required": true, "status": "pass", "exit_code": 0, "duration_ms": 12,
      "stdout_log": ".loop/evidence/1.2/attempt-002/logs/npm-test.stdout.log" }
  ],
  "freshness": {
    "status": "stale",
    "provenance": "cockpit-derived",
    "checks": [
      { "check": "assignment_sha256", "result": "match" },
      { "check": "card_sha256", "result": "mismatch" },
      { "check": "prd_sha256", "result": "match" },
      { "check": "gates_sha256", "result": "match" }
    ],
    "limit": "product worktree and candidate fingerprint are not re-inspected"
  }
}
```

Refusals:

```json
GET  /api/projects/root/files?path=..%2Foutside%2Fsecret.txt
403  { "error": { "code": "access_denied", "message": "path must not contain parent segments" } }

POST /api/workspace
405  { "error": { "code": "method_not_allowed", "message": "the Cockpit API is read-only" } }
```

## Security model

- **Network:**
  - binds to `127.0.0.1` only; any other host is refused at start;
  - the `Host` header must be `127.0.0.1:<port>` or `localhost:<port>`, which
    blocks DNS rebinding;
  - no CORS headers are sent.
- **Session:** a 256-bit random token per process, compared in constant time.
  It is printed once to the launching terminal and never logged.
- **Path policy** (paths are relative to the project base):
  - allowlist: `.loop/**`, `artifacts/**`, `features/**`, `card-reports/**`,
    `handoff.md`, `feature-plan.md`, `project.yaml`;
  - control-root files: `.triad-plus/installation.json`,
    `.triad-plus/team.json`, `.triad-runtime/adapter.json`;
  - refused before any filesystem access: absolute paths, `..`, backslashes,
    NUL, hidden segments, and `.env*`;
  - every target is resolved with `realpath` and must stay inside both the
    workspace and the allowlist, so symlink escapes are refused; files are
    opened with `O_NOFOLLOW`.
- **Identifiers:** project and card IDs are matched against discovered values
  and are never joined into paths.
- **Responses:**
  - `Cache-Control: no-store`, `Content-Security-Policy: default-src 'none'`,
    `nosniff`, and `X-Frame-Options: DENY`;
  - file content is always wrapped in JSON, never served as HTML;
  - filesystem error messages are reduced to codes, so absolute paths do not leak.
- **Logs:** only `method route-template status`; no query strings, paths, or
  content.

## Known limits

- Run liveness is not recorded by Triad+, so nothing here can say that a role
  is running or was interrupted.
- `work-queue.yaml` is read by a tolerant subset reader. Nested mappings and
  YAML features outside the template are reported as warnings, not guessed.
  `run-state.yaml` is not interpreted; it can only be fetched raw.
- Assignment `status` is never updated by runtime code, so `declared_status:
  "active"` does not mean the attempt is in progress.
- Re-verifying the same attempt directory overwrites its `verification.json`.
- The time-of-check/time-of-use window between `realpath` and `open` is
  narrowed by `O_NOFOLLOW` but not eliminated. This is accepted for a
  loopback-only, read-only tool.
- Allowlisted artifacts can contain prompts, paths, and gate output.
  Verifier logs are redacted heuristically by the verifier, not by the Cockpit.

## Tests

```bash
node tests/cockpit-server-test.mjs
```

The suite builds a synthetic workspace in a temporary directory and verifies:
- correct reads, including missing, invalid, stale, and superseded artifacts;
- refusal of traversal, symlink escape, non-allowlisted files, bad sessions,
  foreign Host headers, and every mutation method;
- an unchanged filesystem, by byte-level snapshot;
- no child process, by runtime interception plus a static check;
- logs free of tokens and paths.
