# Triad Cockpit

A local, **read-only** web view of a Triad+ control workspace. It shows what
Triad+ actually persisted and keeps three kinds of information apart: what an
agent declared, what Triad+ code wrote or validated, and what the Cockpit
cannot know.

```bash
npx triad-plus cockpit --control <project-control-path> [--port <n>]
```

The command validates the workspace and starts a server on `127.0.0.1` (port
`0` picks a free port). It prints a launch URL carrying a **one-time login
code**. Opening it sets an `HttpOnly`, `SameSite=Strict` session cookie and
redirects (`303`) to the UI, so the code leaves the address bar and cannot be
replayed. Ctrl+C stops the server.

`npx triad-plus` with no arguments is still the setup wizard.

What it is not:
- It does not orchestrate, approve, start or stop agents, or record
  transitions.
- It adds no database, cache, daemon, or new persistence.
- It has no CopilotKit, AG-UI, or chat.

How it is built:
- **Backend** (`server/`): `node:http`, zero runtime dependencies, stateless.
  Every request re-reads the artifacts. Only `GET` and `HEAD` are served; no
  file is written and no process is started.
- **Reuse of Core contracts** instead of re-implementing them:
  - the validators `validateInstallationManifest`, `validateTeamConfiguration`,
    `validateAssignmentPacket`, `validateReviewerResult`, and
    `validateEvaluatorResult`;
  - the loader `loadQualityBaseline`;
  - the shipped verification-evidence schema.
- **UI** (`web/` sources, `dist/` compiled): React and TypeScript built with
  Vite. It renders what the backend returns and never re-validates artifacts.

## UI

The UI follows Workspace → Project → Card → Attempt → Evidence. Navigation
uses URL hashes (`#/p/<project>/c/<card>?file=<path>`), so refresh, deep links,
and the Back button work and the server needs no fallback routes.

**Data identity.** Each request is keyed by what it is for: the workspace, a
project's cards, one card, or one file.
- When the key changes, nothing loaded for the previous key is ever shown,
  even if the new project has a card with the same ID.
- A refresh of the same key keeps the last good data on screen.
- Responses for a superseded request are discarded, even if they arrive late.

- **Shell:**
  - workspace facts (Triad+ version, adapter, team roles as declared in
    `team.json`);
  - project navigation;
  - an always-visible **Read-only** badge;
  - a manual **Refresh** whose status only states what is true: "Refreshing…"
    while requests are in flight, "Update failed" if one failed, otherwise
    "Updated" with the time the oldest data on screen actually arrived;
  - a System / Light / Dark theme switch.
- **Project:**
  - cards with their *declared* state, observed attempt count, and latest
    recorded verifier result;
  - search and a declared-state filter;
  - workspace notices: work-queue warnings, ignored evidence, unmatched
    Evaluator+ results.
- **Card:**
  - three separate signals: Verifier, Reviewer, and Evaluator+, each with its
    meaning and provenance;
  - "Worth a look": observations derived from the artifacts, never a verdict;
  - attempts, with assignments, packet status, verifications, a gate table,
    the three freshness axes, and documents;
  - review documents, Evaluator+ results, and the deterministic driver run;
  - "What this view cannot know".
- **Artifact viewer:**
  - Markdown, JSON, and text or logs;
  - copy, wrap, size, sha256, and a truncation notice.
  - Everything is rendered as text nodes. HTML in an artifact is shown, never
    executed; links and images are shown as inert text and are never fetched
    or followed.
- **Reading guide** ("How to read this view"): explains provenance, the
  difference between verifier, reviewer, and Evaluator+, freshness, and
  declared states.

### UX decisions

- **Workflow-first, not KPI-first.** The card detail is the product. No charts
  or counters that would invite a "health score" Triad+ cannot back.
- **No combined green.**
  - Verifier, Reviewer, and Evaluator+ answer different questions and are
    shown side by side, never merged.
  - Declared states are neutral, **dashed** chips: "approved" in YAML is a
    declaration, not a fact.
  - "In progress" carries an explicit note that it is not liveness.
- **Freshness as three independent axes:** Bindings, Recency, and Candidate.
  The candidate is always shown as "Not re-checked", so an unchanged control
  file can never read as a re-verified candidate.
- **Provenance everywhere it matters.** Every claim carries a badge with an
  icon, a short label, and an explanation: Triad+ code, Validated, Declared,
  or Derived.
- **No invented timeline.** Attempts are ordered by number. The only trace
  shown is the one the optional deterministic driver actually recorded.
- **Meaning never depends on colour alone.** Every state has text plus a
  distinct icon or border style. Contrast is WCAG AA (≥ 4.5:1) for text and
  chips in both themes.
- **Responsive by level, not by shrinking:**
  - ≥ 1180 px: three panes (workspace, cards, detail);
  - 820–1179 px: two panes, with the workspace in a drawer;
  - < 820 px: one level at a time with a back button, and gate tables turned
    into labelled rows.
- **Accessibility:**
  - landmarks, a skip link, and visible focus;
  - modal dialogs that trap Tab, close on Escape, and restore focus;
  - `prefers-reduced-motion` and `forced-colors` support.

## Build and packaging

The npm package ships `cockpit/server/` and the **compiled** `cockpit/dist/`.
It does not ship `cockpit/web/` (sources, `node_modules`, toolchain). Users
need neither React, Vite, nor TypeScript, and `triad-plus` keeps **zero
runtime dependencies**. React is compiled into the bundle.

```bash
npm run cockpit:build   # npm ci + tsc --noEmit + vite build -> cockpit/dist
npm run cockpit:test    # UI tests (vitest + jsdom against the real backend)
```

- **Committed assets.** `cockpit/dist` is versioned, so publishing can never
  ship a package without the UI. CI rebuilds it and fails if the result
  differs from the committed files (`git diff --exit-code -- cockpit/dist`).
  This catches stale assets.
- **Reproducible build.** The toolchain is pinned to exact versions with a
  lockfile in `cockpit/web/`. A rebuild on Linux with Node 20 produced files
  identical to the committed ones.
- **Toolchain requirements.** The build tooling needs Node ≥ 20.19 (Vite 8).
  The runtime needs Node ≥ 20.
- **Guard.** `prepublishOnly` runs `tests/cockpit-package-test.mjs`, which
  checks the tarball contents and starts the Cockpit from a clean install.

Distribution cost, measured with `npm pack` on the branch:

| Tarball | Before | With Cockpit | Delta |
|---|---|---|---|
| Packed | 171,938 B | ≈ 295 KB | ≈ +123 KB (+71%) |
| Unpacked | 668,747 B | ≈ 1.08 MB | ≈ +410 KB |
| Files | 138 | 151 | +13 |

The packed size varies by a few hundred bytes between environments (gzip
metadata). The compiled UI is about 300 KB: JS about 274 KB (83 KB gzip,
mostly React), CSS about 25 KB. A test enforces a 400 KB budget for `cockpit/dist`.

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

API responses are `application/json`. Every `/api/*` endpoint except
`/api/session` requires the session. Non-API paths serve only the compiled UI
(see Security model).

| Endpoint | Returns |
|---|---|
| `GET /api/session?code=…` | Exchanges the one-time login code for the session cookie. Returns `303 Location: /` with no body; a second use returns `401`. |
| `GET /`, `/index.html`, `/assets/*`, `/theme-init.js`, `/favicon.svg` | The compiled UI shell (no workspace data), or `503 ui_not_built` for `/` when `dist/` is absent. |
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
  - API: `Cache-Control: no-store`, `Content-Security-Policy: default-src 'none'`,
    `nosniff`, and `X-Frame-Options: DENY`;
  - file content is always wrapped in JSON, never served as HTML;
  - filesystem error messages are reduced to codes, so absolute paths do not leak.
- **Static UI** (`server/static.mjs`):
  - **Fixed table.** The compiled files are read once at startup into an
    in-memory table keyed by URL path. Requests are looked up in it and never
    joined into a filesystem path, so traversal, encoded `..`, and symlinks
    have nothing to reach. Unknown paths return `404`. Hidden files, source
    maps, unknown types, and symlinked files are never loaded.
  - **Public shell.** The shell is public by design: it is the same bytes as
    the npm package and holds no workspace data. Host check and read-only
    methods still apply. All data stays behind the session.
  - **Strict CSP for the HTML:**

    `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; manifest-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`

    No inline script or style, no `unsafe-eval`, and no external origin. The
    build keeps the HTML free of inline code (the theme pre-paint script is an
    external file), and a test checks it.
  - **Caching.** Hashed bundles are cached as immutable; everything else is
    revalidated.
- **Logs:** only `method route-template status`, with `static` for UI files;
  no query strings, paths, or content.

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
npm test                 # all Triad+ tests, including the four Cockpit suites below
npm run cockpit:test     # UI tests (requires npm run cockpit:build or npm ci in cockpit/web)
```

| Suite | Covers |
|---|---|
| `tests/cockpit-server-test.mjs` | API, security, static assets, CSP, no mutation, no processes |
| `tests/cockpit-work-queue-test.mjs` | Fail-closed YAML reader |
| `tests/cockpit-cli-test.mjs` | `triad-plus cockpit` validation, start, session, and Ctrl+C; existing commands unchanged; workspace unmodified |
| `tests/cockpit-package-test.mjs` | Tarball contents, zero dependencies, size budget, and starting the Cockpit from a clean `npm install` of the packed tarball |
| `cockpit/web/src/test/*.test.ts(x)` | The UI against the real backend on the synthetic workspace in `tests/fixtures/cockpit-demo-workspace.mjs`: navigation, signals, provenance, freshness, viewer safety, errors, empty states, theme, keyboard. `isolation.test.tsx` uses two projects that share a card ID, rapid navigation, and delayed, out-of-order responses, and checks every DOM commit for data shown under the wrong project. It also checks the refresh status. |

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
- logs free of secrets and paths;
- static UI serving: fixed-table lookup, a `404` for every traversal or
  out-of-build path, the exact CSP, caching, `HEAD`, Host check, and `405` for
  mutations;
- a missing build returns `503` while the API keeps working;
- the real build has no inline code and references only shipped files.

The work-queue suite covers every row of the fail-closed table.

Responsive layout and contrast are verified visually and numerically rather
than in jsdom, which has no layout engine.

## OpenDots

The UI takes visual and interaction cues from
[OpenDots](https://github.com/CopilotKit/OpenDots): panel organisation,
density, and a System / Light / Dark switch with no flash on load. **No OpenDots
code is included**, so no third-party attribution applies.
