# BMAD integration

The primary BMAD handoff is the native planning artifact
`_bmad-output/planning-artifacts/epics.md`. Use the deterministic parser in
`epics-parser.mjs` to detect Epic/Story boundaries, ingest canonical Stories,
resolve Triad execution readiness, and materialize normal Cards with strong
source provenance.

The parser is read-only and does not invoke BMAD workflows or mutate
`epics.md`. It reuses the Card builder from `story-importer.mjs`; no
intermediate BMAD Story files are required.

`story-importer.mjs` remains the low-level compatibility API for a standalone
Story that already has `status: ready-for-dev`. It is retained for debugging,
tests, automation, and existing callers, but it is not the primary BMAD user
workflow.

See [the native BMAD integration guide](../../docs/bmad-integration.md) for the
handoff contract, repository resolution, execution readiness, provenance, and
fail-closed behavior.
