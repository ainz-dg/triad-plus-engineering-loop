# Evaluator+

Evaluator+ is optional and outside the Triad production loop. Configure
`roles.evaluator.enabled: true` and the Orchestrator automatically invokes it
only after the Reviewer has approved a feature or delivery.

It receives the goal, acceptance target, final artifact, and verifier evidence.
It should not receive developer reasoning, prior reviewer conversation, or
attempt history unless the owner explicitly requires it. It reports `PASS`,
`FAIL`, or `INDETERMINATE`, with concise evidence references, under
`artifacts/evaluator-plus/`.

An Evaluator+ `FAIL` does not reopen Triad, change the approved state, or start
repair. An owner or a later Orchestrator may use it as input to a new run.

When a project declares an immutable Quality Contract, the packet also carries
the approved Quality Baseline fingerprint and exactly one result for each
`product_quality` criterion. `delivery_closure` criteria are deliberately
excluded and are evaluated by delivery closure. The control plane validates
fingerprint, candidate binding, criterion coverage, and the deterministic
aggregate (`FAIL` over `INDETERMINATE` over `PASS`) before recording the report.
Formatting a manifest or changing a bound source invalidates the contract; it
never starts a product retry.
