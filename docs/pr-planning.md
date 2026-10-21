# PR planning and draft delivery

`triad-pr-plan` turns an already verified Orchestrator snapshot into a
deterministic set of review groups. It supports `auto`, `single`, `compact`,
and `review-friendly` grouping. The plan is bound to the snapshot bytes,
canonical queue and project hashes, repositories, Card membership, branches,
worktrees, remotes, base commits, and a draft-only effect.

This is a delivery step after the normal Developer → Verifier → Reviewer path;
it does not substitute for verification or Reviewer approval. The CLI expects
the Orchestrator to provide a JSON snapshot containing `project_id`,
`canonical_card_ids`, `repositories`, `cards`, and `source`. `source` must name
the current `work-queue.yaml` and `project.yaml` paths and SHA-256 values, plus
a `files` manifest containing every byte-bound source/evidence file. Each
repository entry includes its declared `id`, `path`, `worktree`, `base_branch`,
`project_branch`, `base_commit`, `remote`, and exact `remote_url`. Each Card
includes its selected state, dependencies and expected/changed paths; completed
Cards additionally carry final commit metadata, passing verifier evidence,
independent Reviewer approval, test summary, and documentation-impact review.

When a mode produces more than one group for a repository, `group_bindings`
may map each deterministic group id to its own `branch`, `worktree`,
`base_branch`, `base_commit`, `remote`, and `remote_url`. Generate group ids
with `prGroupId(repositoryId, cardIds)` from
`runtime/lib/pr-planning.mjs`; otherwise the validator rejects a plan whose
groups differ from the selected mode. `single` means one group per target
repository, not one PR across unrelated repositories.

```sh
triad-pr-plan preview --project ./control --snapshot .loop/runtime/pr-snapshot.json --mode auto
triad-pr-plan approve --project ./control --snapshot .loop/runtime/pr-snapshot.json --plan .loop/runtime/pr_plan.json --owner "Ainz Ooal Gown"
triad-pr-plan draft --project ./control --snapshot .loop/runtime/pr-snapshot.json --plan .loop/runtime/pr_plan.json
triad-pr-plan draft --project ./control --snapshot .loop/runtime/pr-snapshot.json --plan .loop/runtime/pr_plan.json --execute
```

`preview` is read-only apart from saving the local plan. `approve` prints the
exact repository/group scope and requires the owner to type
`approve <first-12-plan-hash-characters>`; the approval is invalidated if the
snapshot or plan drifts. `draft` without `--execute` performs read-only Git
preflight (including remote-ref checks) and makes no GitHub CLI calls. `draft --execute` requires the
previous owner approval, an already-pushed clean group branch, an unchanged
remote base, a matching repository remote, complete byte-bound evidence, and
available GitHub CLI authentication. It creates GitHub draft PRs only and
records each result locally. A plan/group marker makes retries idempotent;
unmatched existing PRs or cross-PR dependencies fail closed for manual
recovery. It never pushes branches, merges, publishes releases, or installs or
changes authentication.

All input and output plan paths must remain inside the selected Control
Workspace. Non-GitHub remotes are returned as manual handoffs rather than
automatically published.
