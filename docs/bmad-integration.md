# Optional BMAD Story integration

Triad+ can consume one already-produced BMAD Story and turn it into a normal
Triad feature Card. This is an integration boundary, not a BMAD execution
adapter: BMAD remains the planning authority and Triad remains responsible for
implementation, verification, review, and delivery.

## Contract

The source is a read-only Markdown Story. It must contain:

- a unique Story `id` and `title` (frontmatter, metadata labels, or a Story
  heading);
- `status: ready-for-dev` (frontmatter or a `Status` field);
- a target repository (or an explicit `--target-repository` importer option);
- an intent/outcome; and
- acceptance criteria.

The importer also carries through the Story's `Tasks & Acceptance`, Code Map,
Design Notes/constraints, verification expectations, and source references
when they are present. It does not interpret prose with an LLM, re-decompose a
Story, or invoke BMAD Build, Build Auto, or `bmad-loop`.

## CLI

```bash
npx triad-plus import-bmad-story \
  --source /absolute/path/to/story.md \
  --output /absolute/path/to/control/features/JFR-001.md \
  --target-repository webup \
  --required-gate cypress-jfr \
  --depends-on JFR-000
```

`--required-gate` and `--depends-on` may be repeated. They are explicit caller
options: gate IDs are additive to the repository's globally required gates,
and dependencies are never inferred from `stories.yaml` order. Omit both when
the Card should use the repository's normal/baseline behavior.

The command writes the Card and a sidecar provenance record (by default
`<card>.bmad-provenance.json`). The provenance records `source_kind:
bmad-story`, the resolved source path, source SHA-256, BMAD Story ID, target
repository, Card SHA-256, and the explicit options used for the import.

The same operation is available to Node consumers:

```js
import { importBmadStory, writeImportedCard } from
  'triad-plus/integrations/bmad/story-importer.mjs';

const result = await importBmadStory({
  sourcePath: '/absolute/path/to/story.md',
  targetRepository: 'webup',
  requiredGates: ['cypress-jfr']
});

await writeImportedCard({
  sourcePath: '/absolute/path/to/story.md',
  outputPath: '/absolute/path/to/control/features/JFR-001.md',
  targetRepository: 'webup',
  requiredGates: ['cypress-jfr']
});
```

## Example mapping

Input (abridged):

```md
---
id: JFR-001
title: Route the provider document
status: ready-for-dev
target_repository: webup
---

# Story JFR-001: Route the provider document

## Intent

Webup renders the provider-owned document at the existing boundary.

## Acceptance Criteria

- Given a valid document, when the route is requested, then it renders.

## Code Map

- `src/components/jfr/`
```

The generated Card keeps that intent, acceptance criterion, Code Map, and the
target repository, then adds the normal Triad sections and the integration
boundary note. The caller-supplied `cypress-jfr` (if any) is recorded as an
additive required gate; it is not inferred from the word "render" or from a
file extension.

## Fail-closed behavior

No executable Card is produced for a missing source, missing/non-`ready-for-dev`
status, malformed or ambiguous ID/title, missing indispensable Card fields,
conflicting target repository, invalid caller options, or a source that changes
while it is being read. The API exposes integration-level error codes such as
`bmad_story_not_ready`, `bmad_story_ambiguous`, `bmad_story_unmappable`, and
`bmad_story_source_mutated` so a planning gap can return upstream rather than
become a Developer decision.

After import, the generated Card goes through the existing assignment and
`triad-verify` path. No Core schema, lifecycle, Reviewer, retry, or gate
execution semantics are changed by this integration.
