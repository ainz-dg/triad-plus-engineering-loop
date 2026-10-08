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
- Reuses existing Core contracts instead of re-implementing them:
  - the validators `validateInstallationManifest`, `validateTeamConfiguration`,
    `validateAssignmentPacket`, `validateReviewerResult`, and
    `validateEvaluatorResult`;
  - the loader `loadQualityBaseline`;
  - the shipped verification-evidence schema.

## Run the prototype

```bash
node cockpit/server/cli.mjs --control <project-control-path> [--port <n>]
```

The server binds to `127.0.0.1` (port `0` = ephemeral) and prints a launch
URL carrying a **one-time login code**. Opening it sets an `HttpOnly`,
`SameSite=Strict` session cookie and redirects (`303`) to `/`, so the code
leaves the address bar and cannot be replayed. Stop the server with Ctrl+C.

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

## Verifier evidence contract

A `verification.json` is attributed to a card only if it satisfies the
contract Triad+ ships, `schemas/verification-evidence.schema.json`. The schema
is loaded from the package as-is and checked by
`server/evidence-contract.mjs`.

- The checker implements exactly the keywords that schema uses. An unknown
  keyword makes the contract unavailable, so a future schema change cannot
  silently widen what is accepted.
- On top of the schema it enforces the two invariants `triad-verify.mjs`
  establishes when it writes `status`:
  - `status: "pass"` requires `required_gates_passed: true`;
  - `required_gates_passed: true` requires every required gate to be `pass`.
- It is not a second verifier: nothing is re-executed or re-hashed.
- Rejected files appear only in project `diagnostics` (field names, never
  values) and never create or populate a card. A file holding only
  `{ "feature_id": "1.5", "status": "pass" }` is rejected.

## Evaluator+ validation

Results are validated with the Core `validateEvaluatorResult`, under the
contract the card actually binds. The binding follows the Core rule
(`resolveQualityContract`): an assignment declares `quality_baseline_path`
and `expected_quality_baseline_fingerprint` together.

| Situation | `status` | `validation` |
|---|---|---|
| No assignment, evidence, or result mentions a quality baseline | `valid` or `invalid` | `contract: "legacy"` |
| Contract bound and loadable | `valid` or `invalid` | `contract: "quality_contract"`, with the baseline fingerprint and the expected candidate fingerprint passed to the Core validator |
| Contract expected but not confirmable | `not_validated` | `reason` is one of the values below; **no legacy fallback** |

The possible `reason` values for `not_validated`:
- `quality_contract_binding_missing`: evidence or the result names a baseline,
  but no assignment binds one;
- `quality_contract_binding_incomplete`: the assignment has only one of path
  and fingerprint;
- `quality_baseline_missing`, `quality_baseline_unreadable`,
  `quality_baseline_outside_allowlist`, `quality_baseline_source_outside_allowlist`;
- the Core loader's own code, for example `quality_baseline_drift` when the
  manifest no longer matches the bound fingerprint, or `quality_baseline_invalid`;
- `no_passing_verification`: a contract is bound but there is no candidate
  fingerprint to bind it to.

The expected candidate fingerprint is the `candidate_fingerprint` recorded by
the latest passing `verification.json` for the card (code-written), and its
source is returned. The baseline manifest and every source it names are
confined to the allowlist before the Core loader, `loadQualityBaseline`, reads
them.

## Document attribution

Review documents (`.loop/reviews/*`, `card-reports/*`) carry no card ID
field, so they are matched by file name.
- A document belongs to a card only if exactly one known card ID appears in
  the name as a whole token.
- Token boundaries account for IDs containing `.` and `-`. Thus `1.1` matches
  `1.1-review.md` and `1.1.md`, but not `11.1-review.md`, `1.10-notes.md`, or
  `1.1.2-draft.md`.
- A name that matches several known cards is assigned to none of them. It is
  listed under `reviewer.ambiguous_documents` of each card involved.

## Freshness of verifier evidence

Code-written evidence is not assumed valid now. Each verification gets a
`freshness` object with three **independent** axes and deliberately no
combined verdict, so nothing reads as "the candidate was re-verified".

| Axis | Values | What was actually checked |
|---|---|---|
| `control_bindings` | `unchanged`, `changed`, `unverifiable` | SHA-256 of the control-workspace files the verifier bound (assignment, card, PRD, gates) against the hashes it recorded. Each comparison is listed in `checks`. |
| `recency` | `latest_for_card`, `superseded` | Whether a later `verification.json` exists for the same card. |
| `candidate` | always `not_checked` | Nothing. The product worktree is never inspected, because that would require running `git`. `recorded_fingerprint` is what the verifier recorded, not a fresh measurement. |

So `control_bindings: unchanged` plus `recency: latest_for_card` means "the
latest recorded evidence still binds to today's control files". It does not
mean the candidate still matches.

`changed` does not mean the historical result was wrong; it means it no longer
describes the current files. Evaluator+ `candidate_binding` likewise compares
recorded fingerprints only (`same_as_latest_pass_record` or
`differs_from_latest_pass_record`).

## Reading `work-queue.yaml`

`work-queue.yaml` is agent-written, and its card states are declarations. The
reader in `server/work-queue.mjs` is **fail-closed**: it returns a value
exactly as the author wrote it, or it does not return it and says so. It never
returns a truncated, unescaped, type-coerced, or defaulted value.

| Input | Outcome |
|---|---|
| The template shape: plain or quoted single-line scalars, single-line flow lists of plain scalars, block lists of scalars, null forms, comments | Read. |
| Valid YAML outside that shape: anchors, aliases, tags, block or multi-line scalars, escapes, nested mappings or lists, duplicate keys | The **key** is not returned. It is listed in `unsupported_keys` and warned about. |
| Item structure that cannot be read safely: merge keys, quoted or complex keys, missing or non-scalar `id`, duplicate `id` | The **item** is not returned. It is warned about. |
| Text that is not valid YAML (unclosed quotes or brackets, `a: b` in a value, reserved indicators), tabs, multiple documents, a non-block `items` | **Nothing** is returned and the queue is `unreadable`. A real parser rejects these documents, and a line-local reading could attribute later lines to the wrong key. |

Downstream, the model keeps uncertainty visible:
- an unread or absent list is `null`, never `[]`;
- a card missing from a queue that was only partly read is `not_determinable`,
  not `not_declared`;
- the queue `status` is `ok`, `partial`, `unreadable`, or `missing`.

### Why not a YAML library

- **Faithfulness.** A YAML 1.1/1.2 core-schema parser resolves `id: 1.10` to
  the float `1.1`, `on`/`yes` to booleans, and so on. Triad card IDs such as
  BMAD-style `1.10` would be corrupted. This reader keeps the author's text.
- **No runtime dependency.** `triad-plus` has zero dependencies. The Core
  already uses purpose-built readers for the same reason (`parseQualityGates`
  in `runtime/lib/gates.mjs`, and the `project.yaml` repository reader).
- **Narrow scope.** Only `items[]` is needed. `run-state.yaml` is not
  interpreted at all; it can only be fetched raw.
- **Drift needs failing closed anyway.** A full parser would accept every
  construct an agent invents, and the Cockpit would still have to decide what
  it means. Refusing unknown shapes is the safer contract for declarations.

### Evidence

`tests/cockpit-work-queue-test.mjs` covers each row of the table above,
asserting both that the value is absent and that a warning is emitted.

A differential check against Ruby Psych 3.1 compared this reader with that
parser's node values. The script is not part of the repository because Ruby is
not a project dependency. The corpus was every test snippet plus the 36
`work-queue.yaml` files found in local control workspaces, worktrees, and
templates: 87 documents in total.

| Measure | Result |
|---|---|
| Returned values compared | 1,053, across 128 items |
| Mismatches | 0 |
| Documents Psych rejects but this reader returned data from | 0 |
| Valid documents refused conservatively | 5 (multi-document markers, inline, anchored, or duplicate `items`, `items` as a mapping) |

## Endpoints

All responses are `application/json`. All endpoints except `/api/session`
require the session.

| Endpoint | Returns |
|---|---|
| `GET /api/session?code=…` | Exchanges the one-time login code for the session cookie. Returns `303 Location: /` with no body; a second use returns `401`. |
| `GET /` | A small JSON landing object (requires the session). |
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
    "provenance": "cockpit-derived",
    "control_bindings": {
      "status": "changed",
      "checks": [
        { "check": "assignment_sha256", "result": "match" },
        { "check": "card_sha256", "result": "mismatch" },
        { "check": "prd_sha256", "result": "match" },
        { "check": "gates_sha256", "result": "match" }
      ]
    },
    "recency": { "status": "latest_for_card" },
    "candidate": {
      "status": "not_checked",
      "recorded_fingerprint": "fp-122",
      "reason": "the product worktree is not inspected; whether the current candidate still matches this evidence is unknown"
    }
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
- **Session:** two independent 256-bit random secrets per process, compared in
  constant time.
  - The **login code** is the only secret that appears in a URL. It is printed
    once to the launching terminal and is valid for a single exchange.
  - The exchange answers `303 Location: /` (a fixed, query-free path) with no
    body, so the code leaves the address bar. A replay from history,
    scrollback, or a screenshot gets `401`.
  - The **session secret** travels only in the `HttpOnly`, `SameSite=Strict`
    cookie, or in an `Authorization: Bearer` header for in-process callers.
    It is never put in a URL.
  - Referer leakage is blocked twice. Every response, including the redirect
    and errors, carries `Referrer-Policy: no-referrer`. JSON responses and
    `default-src 'none'` mean no page loads a third-party resource.
  - Neither secret is logged: the request log has no query strings.
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
- Under a Quality Contract, the expected candidate is the latest passing
  verification's recorded fingerprint. That is the code-written proxy for the
  Reviewer-approved candidate, which Triad+ does not persist in code.
- Review documents with no card ID in their name are not attributed to any
  card.
- `work-queue.yaml` is read by a fail-closed reader of the template shape (see
  above). Constructs outside it are not read. `run-state.yaml` is not
  interpreted; it can only be fetched raw.
- The candidate is never re-checked (`freshness.candidate` is always
  `not_checked`).
- The login code is printed to the launching terminal. Anyone who can read
  that terminal before first use can open the session; after first use the
  printed URL is dead.
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
node tests/cockpit-work-queue-test.mjs
```

The server suite builds a synthetic workspace in a temporary directory and
verifies:
- correct reads, including missing, invalid, changed-binding, and superseded
  artifacts;
- refusal of traversal, symlink escape, non-allowlisted files, bad or replayed
  sessions, foreign Host headers, and every mutation method;
- the session flow: one-time code, `303` to `/`, `no-referrer` everywhere,
  secret never in a URL;
- rejection of contract-violating evidence, including `{feature_id, status:
  "pass"}` and a `pass` without `required_gates_passed`;
- Evaluator+ under a Quality Contract:
  - a correct result is `valid`;
  - a wrong candidate is `invalid`;
  - a missing, unreadable, unbound, or drifted baseline is `not_validated`,
    never legacy;
- document attribution between `1.1` and `11.1`, including an ambiguous name;
- an unchanged filesystem, by byte-level snapshot;
- no child process, by runtime interception plus a static check;
- logs free of secrets and paths.

The work-queue suite covers every row of the fail-closed table.
