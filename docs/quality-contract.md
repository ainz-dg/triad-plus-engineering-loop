# Immutable Quality Contract

Triad+ 1.8 optionally binds a run to an owner-approved, machine-readable
Quality Baseline. It is an additional target record, not a second control
plane and not a replacement for the PRD, card baseline, or candidate
fingerprint.

```text
Quality Baseline fingerprint  = what the run was meant to satisfy
Repository/card baseline     = where implementation started
Candidate fingerprint        = what implementation produced
```

## Manifest

The manifest is JSON and is normally stored at
`artifacts/quality-baseline.json`:

```json
{
  "schema_version": 1,
  "id": "my-project-quality-baseline",
  "revision": 1,
  "sources": [
    {
      "id": "prd",
      "role": "intent",
      "path": "artifacts/prd.md",
      "sha256": "<64-hex-digest>"
    }
  ],
  "criteria": [
    { "id": "QB-001", "scope": "product_quality", "requirement": "..." },
    { "id": "QB-010", "scope": "delivery_closure", "requirement": "..." }
  ],
  "fingerprint": "<sha256-of-canonical-manifest-without-fingerprint>"
}
```

The manifest requires a positive revision, at least one source, unique source
and criterion IDs, project-relative source paths, SHA-256 for every source, and
non-empty requirements. Version 1 has exactly two criterion scopes:
`product_quality` and `delivery_closure`.

The fingerprint is SHA-256 over canonical JSON with object keys sorted
recursively, array order preserved, and the `fingerprint` field excluded from
the payload. Whitespace and object formatting therefore do not change it.

## Binding and drift

When `project.quality_contract` is present, the Orchestrator binds both the
manifest path and its fingerprint in every active Developer assignment:

```json
{
  "quality_baseline_path": "artifacts/quality-baseline.json",
  "expected_quality_baseline_fingerprint": "<sha256>"
}
```

`triad-verify` validates the manifest and all source hashes before expensive
gates. A malformed manifest or fingerprint mismatch is
`quality_baseline_invalid`; a valid manifest whose declared sources or
assignment fingerprint no longer match is `quality_baseline_drift`. Both are
`invalid_context`: no Developer dispatch, expensive gates, or retry budget.

Projects without `quality_contract` retain the legacy PRD-only path. A
rebaseline is never an in-place edit: create a new revision/fingerprint and
record an explicit lineage event. Historical evidence is not silently
reinterpreted.

## Phase ownership

`product_quality` criteria are included in the fresh, blind Evaluator+ packet.
The packet carries the baseline fingerprint, final candidate fingerprint,
criteria, approved source material, and bounded verifier evidence. It never
includes delivery criteria, queue state, handoff state, or attempt history.

Evaluator+ returns one result per product criterion. The control plane validates
coverage, uniqueness, scope, candidate/baseline fingerprints, and the overall
verdict. Aggregation is deterministic:

```text
any FAIL               -> FAIL
else any INDETERMINATE -> INDETERMINATE
else                   -> PASS
```

`delivery_closure` criteria are evaluated separately during delivery closure
and recorded with criterion ID, verdict, and evidence references. A run is not
`delivered` when any configured delivery criterion is `FAIL` or
`INDETERMINATE`. Quality Bar evaluation is not a required-gate replacement,
and an Evaluator+ failure never repairs or reopens Triad automatically.
