# PR planning and draft delivery

`triad-pr-plan` records a pre-run structural delivery intent and later turns an
Orchestrator snapshot into deterministic PR review groups. It supports `auto`,
`single`, `compact`, and `review-friendly` grouping (Auto is the default).
Structural approval binds project identity, byte-bound Card baselines,
canonical Card membership and grouping inputs, repository scope, dependencies,
and every group's exact branch/worktree/base/remote mapping. Its effect is
limited to draft-PR creation.

## Approve structure before implementation

This does not substitute for the normal Developer → Verifier → independent
Reviewer path or approve any Card. Before the first Developer assignment, the
Orchestrator can produce a structural snapshot and ask the owner to approve its
displayed plan once:

```sh
triad-pr-plan intent --project ./control --snapshot .loop/runtime/pr-structure.json \
  --mode auto --owner "Ainz Ooal Gown"
```

The snapshot must include byte-bound source entries for every Card and
`source_path`/`source_sha256` on each Card. The CLI prints the exact grouping
and bindings and records approval only after the owner types the displayed
structural digest phrase. Changing Card selection/membership, grouping inputs,
dependencies, repository declarations, project baseline, or any exact group
branch/worktree/base/remote binding requires a new approval. Queue execution
state, verifier/Reviewer evidence, test summaries, and final Card commits are
deliberately excluded, so ordinary run progress does not invalidate the
approved structure. Queue IDs/repository/dependencies, project repository
mappings, Card identities, and listed source bytes are rechecked against the
local Control Workspace.

## Refresh evidence and prepare drafts

After all Cards are approved and committed, refresh the snapshot from current
canonical evidence and reuse the saved intent:

```sh
triad-pr-plan preview --project ./control --snapshot .loop/runtime/pr-delivery-snapshot.json \
  --intent .loop/runtime/pr-structure-approval.json
triad-pr-plan draft --project ./control --snapshot .loop/runtime/pr-delivery-snapshot.json \
  --plan .loop/runtime/pr_plan.json --execute
```

The refreshed snapshot still binds every verifier and independent Reviewer
record by path and SHA-256. Existing execution preflight rechecks the actual
worktree, exact base-to-head commits, final Card commits, branch, remote and
remote base before creating any draft. A rework, missing/stale verifier,
unreviewed extra commit, wrong branch/base, structural drift, stacked
dependency, missing approval, or resume conflict fails closed. No Card
lifecycle transition or Reviewer semantics change.

For the approved-intent path, set `source.canonical_evidence: true` only in a
refreshed snapshot that includes the actual Assignment, verifier JSON,
completed Orchestrator Reviewer run record, bounded Reviewer result JSON, and
documentation-impact source in `source.files`. Draft preflight reads and
re-hashes those files, checks Assignment/run/Card identity bindings, requires
the actual Reviewer decision to be approved, and compares the verifier's
candidate file manifest to the actual final commit tree. A snapshot summary
alone is not sufficient evidence.

The current vertical slice deliberately does not create or populate grouped
delivery worktrees, cherry-pick commits, or push branches. If the approved
group branches/worktrees do not already contain exactly the approved Card
commits, the CLI stops at a concrete preflight blocker; it does not improvise a
branch lifecycle. The Orchestrator turns that blocker into the exact manual
handoff. This preserves the existing manual post-run workflow.

The JSON snapshot contains `project_id`, `canonical_card_ids`, `repositories`,
`cards`, and `source`. `source` names the current `work-queue.yaml` and
`project.yaml` paths and SHA-256 values, plus a `files` manifest containing
every byte-bound source/evidence file. Each repository entry includes its
declared `id`, `path`, `worktree`, `base_branch`, `project_branch`,
`base_commit`, `remote`, and exact `remote_url`. Each Card includes its
selected state, dependencies, expected/changed paths, and source binding;
completed Cards additionally carry final commit metadata, passing verifier
evidence, independent Reviewer approval, test summary, and documentation-impact
review. For each draft group, preflight requires the complete
`base_commit..HEAD` commit set to equal exactly one distinct `final.commit`
from every approved Card in that group. Extra commits fail closed even when
they only touch paths already present in the approved Card delta.

When a mode produces more than one group for a repository, `group_bindings`
maps each deterministic group id to its own `branch`, `worktree`, `base_branch`,
`base_commit`, `remote`, and `remote_url`. Generate group ids with
`prGroupId(repositoryId, cardIds)` from `runtime/lib/pr-planning.mjs`.
`single` means one group per target repository, not one PR across unrelated
repositories.

The legacy post-run approval workflow remains available:

```sh
triad-pr-plan preview --project ./control --snapshot .loop/runtime/pr-snapshot.json --mode auto
triad-pr-plan approve --project ./control --snapshot .loop/runtime/pr-snapshot.json --plan .loop/runtime/pr_plan.json --owner "Ainz Ooal Gown"
triad-pr-plan draft --project ./control --snapshot .loop/runtime/pr-snapshot.json --plan .loop/runtime/pr_plan.json
triad-pr-plan draft --project ./control --snapshot .loop/runtime/pr-snapshot.json --plan .loop/runtime/pr_plan.json --execute
```

With `preview --intent`, the approved grouping and bindings are reused without
a second owner prompt, while the refreshed evidence snapshot is still fully
validated. Without `--intent`, the legacy flow behaves unchanged. Legacy
`approve` prints the exact repository/group scope and requires the owner to
type `approve <first-12-plan-hash-characters>`; that approval is invalidated if
the snapshot or plan drifts. `draft` without `--execute` performs read-only Git
preflight (including remote-ref checks) and makes no GitHub CLI calls.
`draft --execute` requires a valid structural intent or legacy plan approval,
an already-pushed clean group branch, an unchanged remote base, a matching
repository remote, complete byte-bound evidence, and available GitHub CLI
authentication. It creates GitHub draft PRs only and records each result
locally. A plan/group marker makes retries idempotent; unmatched existing PRs
or cross-PR dependencies fail closed for manual recovery. It never pushes
branches, merges, publishes releases, or installs or changes authentication.

All input and output plan paths must remain inside the selected Control
Workspace. Non-GitHub remotes are returned as manual handoffs rather than
automatically published.
