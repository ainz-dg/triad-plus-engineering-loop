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
The saved values are requested intent, not host selection. Generated native
assets deliberately inherit host model and effort defaults: an unknown native
model ID can prevent the host from loading Triad before preflight can run.
Do not materialize requested model or effort overrides, manually patch managed
profiles, or claim that `upgrade --apply` selected a requested model. The normal
managed upgrade removes old overrides while preserving canonical intent.

After applying, reread `team.json`, verify that only requested fields changed,
and report **recorded only; host default**. If the host supplies a reliable
native picker/catalog, guide the owner through that host's selection and
confirm what is observable. Otherwise report that effective selection is
unknown. Never turn a guessed ID, another provider's effort, or a user assertion
into verification evidence. Syntax-valid does not mean host-available.

The adapter metadata describes potential native field names (`model`, OpenCode
`variant`, Copilot `reasoningEffort`, Codex `model_reasoning_effort`) and
unsupported roles. It does not authorize writing unverified overrides.
`team-record` adapters have no native file to update. Null means no requested
model/effort, with the host/session default still in effect.

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
