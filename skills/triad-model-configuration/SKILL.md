---
name: triad-model-configuration
description: Inspect and safely configure Triad+ role models through the canonical team configuration and the selected host adapter.
---

# Triad+ model configuration

Use this skill when the owner asks to inspect, explain, or change the models
used by Triad+ roles in a control workspace. Keep the operation small,
deterministic, and reversible.

## Source of truth

1. Identify the requested project-control workspace. Do not guess a workspace
   from the current directory when more than one is visible.
2. Read `.triad-runtime/adapter.json` and `.triad-plus/team.json` from that
   workspace. The team file is the canonical source of role configuration.
3. Validate the schema version, role IDs, and model/reasoning value types before
   proposing or applying a change. A malformed team file is a blocker; do not
   repair it by inference.
4. Show the current values and the adapter binding mode before changing them.

Never edit generated host files as the first step. Preserve every field in
`team.json` that the owner did not request, including display names, personas,
interaction settings, Evaluator+ enablement, and policy fields. Do not put
tokens, API keys, credentials, or private deployment data in the team file.

## Requested changes

Interpret only an explicit owner request. A request may set a role `model`, a
role `reasoning_effort`, clear either value to `null` (host default), or ask for
an inspection without changing anything. Do not invent model IDs from a
marketing name or from memory. If the host exposes a reliable native model
list, present only IDs from that list; otherwise ask for an explicit ID or keep
the host default.

Reject unknown fields, malformed values, ambiguous role names, and requests for
a host-native field that the selected adapter cannot materialize. Explain the
limitation instead of silently substituting another model or pretending that a
field was applied.

When a change is authorized, update only the requested keys in
`.triad-plus/team.json`, preserving its JSON structure and all other values.
Use the existing managed binding path to materialize the result (normally an
`upgrade --apply` for the selected host). Do not duplicate frontmatter/TOML
parsing in a shell command or in this skill. Preview the change first when the
host workflow offers a dry run, then apply it only after the requested values
are clear.

After applying, reread `team.json`, verify that only requested fields changed,
and inspect the generated host assets. A failed materialization is a failed
operation; do not claim success from the team file alone.

## Adapter binding modes

Read the adapter metadata rather than branching on a host name:

- `global-profiles`: the adapter writes supported role values to its native
  user-level profiles (for example Codex). Verify the resulting profile files.
- `project-frontmatter`: the adapter writes only the fields listed by its
  metadata to managed project agent definitions. OpenCode supports `model` and
  its native `variant` field (the canonical `team.json.reasoning_effort` value
  is materialized as that variant); Copilot supports `model` and
  `reasoningEffort`; Claude Code currently materializes `model` only for its
  supported roles. A field not listed by the adapter remains host/session
  managed and must be reported as such.
- `team-record`: the adapter records the owner's intent in `team.json` but has
  no native model file to update. Report “recorded in team.json; host-native
  materialization unavailable” and do not fabricate an agent binding.

For every requested role/field, classify the result as **host-native applied**,
**recorded only**, **host/session default**, or **unsupported**. Null or blank
values mean host default and should not create artificial frontmatter/profile
values. Reasoning levels are not portable across hosts; never translate a
level or model ID from another provider. For OpenCode, inspect the host's
available model variants (for example with `opencode models`) before requesting
one; a role profile's `variant` is separate from the primary OpenCode session
default.

OpenCode's managed binding is the only writer for `.opencode/agents/*.md`.
Never patch `reasoningEffort` into those profiles by analogy with Copilot. The
same binding is reapplied after `upgrade --apply`, while null values remove
stale managed fields and restore the host default.

## Safe completion report

Report:

- control workspace and selected adapter;
- fields inspected and fields changed (or “no changes”);
- binding mode and host-native fields supported;
- generated assets checked and their result;
- any unsupported/recorded-only limitation;
- confirmation that unrelated `team.json` fields and secrets were preserved.

This skill configures role models only. It does not change Triad authority,
retry policy, verification, Evaluator+ behavior, host routing, or workflow
state, and it does not perform releases or publish packages.
