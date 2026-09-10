# BMAD Story importer

This optional integration converts one BMAD Markdown Story with
`status: ready-for-dev` into a normal Triad feature Card. It is intentionally
small and deterministic: the source is read-only, caller options are explicit,
and BMAD workflows are never invoked.

See [the public BMAD integration guide](../../docs/bmad-integration.md) for the
mapping contract, CLI/API examples, provenance sidecar, and fail-closed rules.

The implementation is in `story-importer.mjs`. It does not add BMAD-specific
branches to the Triad Core or infer gates/dependencies from planning order.
