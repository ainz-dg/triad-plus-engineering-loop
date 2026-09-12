# Architecture

Triad+ has three small layers:

```text
Triad Core roles       Orchestrator / Developer / Reviewer
        │
Runtime adapter        host detection, assets, entry point, capabilities, model binding
        │
Verification layer     declared gates and environment-derived evidence
```

The host agent is the Orchestrator. It owns operational context, delegation, and
the next decision. The runtime does not schedule work or implement a general
state machine.

Adapters are registered descriptors in `adapters/registry.mjs`. They describe
only real host differences: binary discovery, installation destinations, native
entry point, optional hook lifecycle, and supported model binding. Runtime-
specific behavior belongs in the adapter. Adding a runtime must not add
runtime-specific branches to Core installer or verification logic.

Evaluator+ is outside the Core: it runs after a Reviewer-approved result, receives
a deliberately limited fresh packet, and cannot reopen the completed run.

An optional immutable Quality Contract extends this existing control-plane
baseline without creating a second control plane. Its JSON manifest binds
approved intent sources and phase-scoped criteria to one canonical fingerprint.
`product_quality` criteria travel in the fresh Evaluator+ packet;
`delivery_closure` criteria are checked only during delivery closure. Projects
without the contract keep the legacy PRD baseline behavior.
