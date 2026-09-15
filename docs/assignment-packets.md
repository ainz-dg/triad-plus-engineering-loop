# Assignment packets

Before a delegated role starts, the Orchestrator creates one immutable
Assignment Packet for that assignment:

```bash
node .triad-runtime/triad-assignment-packet.mjs \
  --project /absolute/path/to/control-workspace \
  --assignment .loop/runtime/assignments/<assignment-file>.json
```

The command binds `assignment_packet_path` and
`assignment_packet_sha256` in the active assignment and returns a JSON dispatch
context. The host launches the Developer with `dispatch.cwd` set to the
declared product worktree. The Reviewer receives the same packet and uses that
worktree when direct candidate inspection is needed. The control workspace
remains the source for policy, cards, state, and evidence.

Packets contain bounded assignment context: card outcome and acceptance
criteria, relevant PRD/ADR excerpts supplied by the Orchestrator, verification
mapping, expected paths, constraints, risks, mandatory skill paths/hashes, and
prior evidence references. They are not a second PRD and do not copy skill
contents. The Developer and Reviewer still read every real mandatory skill and
the verifier remains authoritative for skill hashes and gate evidence.

The packet and card are the normal startup contract. A full PRD or ADR is a
fallback only when a detail is missing, contradictory, or explicitly required.
Native `read`, `grep`, `glob`, and `list` operations should be preferred for
simple discovery; shell commands remain appropriate for builds, tests, git,
scripts, and system operations.

Projects and assignments without packet fields keep the legacy behavior. A
bound packet is validated before `triad-verify` runs skills, scope checks, or
quality gates; a missing, changed, or mismatched packet fails closed as
`assignment_packet_invalid` without consuming retry budget.
