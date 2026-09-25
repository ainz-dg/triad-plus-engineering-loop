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
