# Human-readable reports

Triad+ keeps JSON/YAML control records, verification evidence, review reports,
candidate fingerprints, and delivery records as the source of truth. From those
records the Orchestrator can materialize two portable Markdown views:

- one `card-reports/<card-id>.md` for every terminal Card;
- one final delivery handoff with a human-first summary and links to the Card
  reports.

The report renderer is deterministic and does not make an additional LLM call.
It attributes changed paths to the complete Card baseline, so a rework attempt
does not hide files changed by an earlier attempt. Reports contain relative
evidence references and redact unrelated absolute paths.

An available renderer is not proof that a report file exists: the Orchestrator
must invoke the CLI with derived context. Until then, `card-reports/<card-id>.md`
and `handoff.md` are **not materialized**; if an expected output is absent, do
not describe it as generated. The Cockpit and these reports are views of the
canonical records, not new approval evidence.

## Materialize a Card report

The Orchestrator first writes a small derived JSON context from the canonical
Card, attempt, verifier, Reviewer, and delivery records. The source Card and
those records remain read-only. Then run:

```bash
node .triad-runtime/triad-human-report.mjs \
  --mode card \
  --project /absolute/path/to/control-workspace \
  --input .loop/runtime/report-context/CARD-001.json \
  --output card-reports/CARD-001.md \
  --worktree /absolute/path/to/product-worktree \
  --base-commit <card-baseline-commit>
```

For an approved Card the renderer requires a final commit, the candidate
fingerprint recorded by passing verifier evidence, independent Reviewer
approval, and the complete changed-path manifest. Current verifier evidence
also carries a `candidate_manifest` with the verified paths and content hashes.
The renderer binds that manifest to the final commit delta (allowing the
expected `git_head` change caused by the commit) and records the resulting
committed fingerprint separately. A blocked or not-delivered terminal Card must
include a truthful reason and never claims delivery. Writes are atomic and
re-running the command with the same context is idempotent.

### Card context checklist

The derived card context should carry only canonical control-plane fields:

- `card.id` (and its title, goal/outcome, repository, and card path);
- terminal `status`, `attempts`, and verification runs;
- at least one passing verification run with its evidence path and candidate
  fingerprint;
- independent `review.decision: approved` and its evidence/fingerprint;
- `final.branch`, `final.commit`, `final.repository`, `final.base_commit`, and
  `final.candidate_fingerprint`;
- assignment/packet/verification provenance and bounded evidence references.

For an approved card, `final.candidate_fingerprint` is the pre-commit
fingerprint recorded by the passing verifier. The renderer computes and records
`final.committed_candidate_fingerprint` from the committed delta; do not replace
the verified fingerprint with a newly calculated value in the input context.
The source card and canonical evidence remain read-only.

### Attempt-local Reviewer references

When a Card report input already includes an attempt-local Reviewer file in
that Attempt's `evidence_refs`, the report places a safe relative link in that
Attempt's row. It does not invent a reference, read the Markdown to derive a
verdict, or promote the document to a validated approval. The singular
`review` object remains a **Card-level** Reviewer section and must not be read
as a decision for every Attempt. References are linked only when they resolve
to an existing regular file inside the declared project or worktree root and
the generated URL remains within that root; otherwise the report retains a
plain, redacted path.

## Materialize the final handoff

```bash
node .triad-runtime/triad-human-report.mjs \
  --mode handoff \
  --project /absolute/path/to/control-workspace \
  --input .loop/runtime/report-context/delivery.json \
  --output handoff.md
```

The handoff opens with the executive summary and Card results, then preserves
links to the technical evidence, branch/commit map, quality-contract closure,
Evaluator+ result, delivery gates, demo details, risks, and practical test.
It is a view for people, not an alternative delivery state machine.

When the output exists, its Card-report links are relative to `handoff.md`, and
explicit local evidence references are linked relative to that output. A report
or evidence file that was not supplied, does not exist, is external, or fails
path-safety checks remains unlinked; generating the handoff does not create
the underlying canonical evidence.

### Handoff context checklist

The derived handoff context must include a non-empty `cards` list and a
`decision` plus `executive_summary`. Each card entry carries `id`, `title`,
`status`, `summary`, `report_path`, and, when available, `commit`,
`candidate_fingerprint`, `verification`, `review`, `evaluator_report`, and
`evidence_refs`. The remaining canonical handoff fields are:

`code_areas`, `residual`, `verification`, `review`, `branch_commits`,
`practical_test`, `evaluator`, `delivery`, `quality_contract`,
`delivery_criteria`, `demo`, `evidence_refs`, `exceptions`, `prd_baseline`,
`approved_cards`, `push_evidence`, `gate_metrics`,
`local_worktree_integration`, `delivery_closure_record`, `final_message`,
`risks`, and `generated_from`.

Populate fields from canonical run, card, verifier, Reviewer, Evaluator+, and
delivery records. Do not pass Developer reasoning, queue-control narrative, or
unbounded source documents merely to satisfy the renderer.
