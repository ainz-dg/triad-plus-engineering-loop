# Contributing to Triad+

Thank you for contributing. Triad+ is intentionally small: preserve the Core
roles and keep the host agent in charge of the loop.

## Local setup

Use Node.js 20 or later, then run:

```bash
npm test
npm run pack:check
```

The repository is organized as follows:

- `skills/` — role and bootstrap contracts.
- `runtime/` — verification and evidence utilities.
- `adapters/` — host-specific assets and metadata.
- `docs/` — public usage and architecture documentation.

## Pull requests

Keep each pull request focused. Include tests for changed behavior, update public
documentation when user-visible behavior changes, and avoid private paths,
tokens, deployment configuration, or generated smoke artifacts.

Every Triad+ mandate and pull request must include a **Documentation impact**
analysis in its review evidence and PR body. Identify the user-facing behavior
in scope, the documentation reviewed, the files changed (or state that no
documentation change is needed and why), and any remaining documentation gap.

Triad+ is feature-frozen around its public Core: Orchestrator, Developer, and
Reviewer, with optional post-run Evaluator+. Do not add workflow engines,
schedulers, automatic repair, additional Core roles, or runtime-specific Core
branches without prior design agreement.

## Adapters

To add or modify an adapter, update its descriptor in `adapters/registry.mjs`,
its adapter assets, and tests. The descriptor should express only genuine host
differences: detection, asset locations, entry point, capabilities, and model
binding. Do not add `if <runtime>` behavior to Core installer or verifier code.

## Review expectations

Explain the user-facing outcome, provide test output, call out runtime
limitations, and include the **Documentation impact** analysis in both the PR
body and the review/delivery report. Maintainers may ask for a clean package
smoke when install assets change.

## Operational artifacts

Keep working reports, smoke transcripts, handoffs, and release checklists in
`.triad-internal/` (which Git ignores) or outside the repository. The tracked
tree is reserved for product code and user/contributor documentation.
