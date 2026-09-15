# BMAD native intake

Triad+ treats BMAD as the planning authority and takes over at the natural
planning handoff: the read-only `_bmad-output/planning-artifacts/epics.md`
artifact.

```text
BMAD planning
  -> epics.md
  -> deterministic Triad intake
  -> normal Cards
  -> Developer -> verifier -> Reviewer -> delivery
```

The owner does not need to split `epics.md` into Triad-shaped Story files or
run one import command per Story. A normal host entry point such as
`/triad /path/to/_bmad-output/planning-artifacts/epics.md` lets the Orchestrator
detect the native artifact, ingest it, and continue with the initialized
project-control workspace. Passing the BMAD output directory is also supported
when it contains the conventional `planning-artifacts/epics.md` path.

## Responsibilities

BMAD owns planning:

- Epic and Story boundaries;
- intent and user outcome;
- acceptance criteria;
- planning context, constraints, and references.

Triad owns execution:

- project and repository resolution;
- worktree and branch selection;
- trusted quality gates and required-gate selection;
- Card creation, assignment, Developer, verifier, Reviewer, retry, and delivery
  semantics.

Triad never invokes `bmad-loop`, Build, Build Auto, or another BMAD workflow.
It does not modify `epics.md` or add execution metadata to the BMAD source.

## Deterministic parser and API

The integration is implemented in
`integrations/bmad/epics-parser.mjs`. It recognizes native headings such as:

```md
### Epic 1: JsonForm integration

### Story 1.1: Route the provider document

**Intent / outcome:** ...

**Acceptance Criteria:**
**Given** ...
**When** ...
**Then** ...
```

Story detection, Epic association, ID/title extraction, acceptance extraction,
splitting, and provenance are deterministic code. No LLM is used for intake.
The source is read twice and must remain byte-stable during the operation.

Read-only ingestion returns canonical Stories without assigning a repository:

```js
import { ingestBmadEpics } from 'triad-plus/integrations/bmad/epics-parser.mjs';

const result = await ingestBmadEpics({
  sourcePath: '/project/_bmad-output/planning-artifacts/epics.md'
});

// result.stories: canonical BMAD Stories
// result.cards: [] — no execution assumptions were made
```

The integration-side runtime primitive can materialize normal Cards when an
initialized Triad project context is supplied:

```bash
node .triad-runtime/triad-bmad-intake.mjs \
  --source /project/_bmad-output/planning-artifacts/epics.md \
  --project /project/triad-control \
  --output /project/triad-control/features \
  --repository webup \
  --required-gate 1.4=cypress-jfr
```

`--source` may also be the BMAD output directory; the conventional
`_bmad-output/planning-artifacts/epics.md` file is selected deterministically.

This is an automation/API primitive for the Orchestrator, not the primary user
workflow. The primary workflow remains the host's `/triad` entry point with the
BMAD artifact path.

## Ingestion readiness versus execution readiness

An `epics.md` Story is ingestible when it has:

- a unique Story ID;
- a title;
- an intent, outcome, or user story;
- acceptance criteria;
- an unambiguous Epic parent.

`status: ready-for-dev` is not required for ingestion because native
`epics.md` commonly does not contain that field. Ingestion does not dispatch a
Developer and does not claim that a Card is executable.

Before Card materialization, Triad resolves execution readiness:

- project configuration is present;
- the target repository is explicit, configured as the project default, or is
  the only configured repository;
- multiple repositories without a deterministic mapping fail closed;
- the selected repository has a usable path/worktree;
- the trusted gate catalog exists and contains no placeholders;
- explicit per-Story required gates and dependencies validate as caller input.

An explicit non-ready BMAD status such as `draft`, `in-progress`, `done`, or
`blocked` remains ingestible but is rejected at execution readiness. Triad never
silently promotes it to `ready-for-dev` in the source.

## Repository and gate binding

`target_repository` is optional in native BMAD. Resolution is deterministic:

```text
per-Story caller override / Story repository declaration
  -> explicit caller default repository
  -> project default repository
  -> single configured repository
  -> otherwise fail closed as ambiguous
```

Conflicting explicit mappings fail closed rather than being silently chosen;
unknown repositories fail closed. Quality gates are not inferred from
acceptance prose or Story ordering. If a caller selects an additional gate, it
is supplied explicitly and uses the existing additive `required_gates`
semantics. Dependencies are preserved only when explicitly supplied; position
in `epics.md` never becomes `depends_on` automatically.

## Card and provenance output

The parser reuses the existing Card builder. It does not create intermediate
BMAD Story files. When Cards are materialized, each normal Card is accompanied
by an integration-side provenance record containing at least:

```json
{
  "source_kind": "bmad-epics",
  "source_path": "_bmad-output/planning-artifacts/epics.md",
  "source_sha256": "...",
  "epic_id": "1",
  "story_id": "1.1",
  "source_heading": "Story 1.1: ...",
  "source_range": { "start_line": 10, "end_line": 38 },
  "card_sha256": "..."
}
```

The source SHA, Story identity, source heading/range, and generated Card SHA
form the audit binding. Line ranges are supporting evidence, not the sole
identity. The BMAD source remains read-only.

## Fail-closed conditions

The native intake rejects malformed or unsafe input rather than inventing a
planning decision. Examples include:

- missing or malformed Epic/Story headings;
- duplicate Epic or Story IDs;
- a Story outside an Epic;
- missing title, intent/outcome, or acceptance criteria;
- source mutation during the read;
- ambiguous or unknown repository resolution;
- missing project/worktree/gate readiness;
- an explicit non-ready Story status at execution time.

No partial Card set is written when parsing or execution readiness fails.

## Low-level single-Story compatibility path

`import-bmad-story` remains available as a low-level API, debugging tool, test
utility, and compatibility path for a standalone Story that already carries
`status: ready-for-dev` and a repository (or an explicit caller override):

```bash
npx triad-plus import-bmad-story \
  --source /absolute/path/to/story.md \
  --output /absolute/path/to/control/features/STORY-001.md
```

It is no longer the primary BMAD workflow. It remains read-only and fail-closed,
preserves explicit gates/dependencies, and uses the same Card contract.

## Non-goals

This integration does not add:

- BMAD execution, Build Auto, or `bmad-loop`;
- an Epic scheduler or batch execution engine;
- dependency inference from `stories.yaml` or document order;
- an LLM Story interpreter;
- NotebookLM, SMEUP-specific policy, or Quality Baseline Core changes;
- parallel writers, worktree orchestration, or a new plugin framework.
