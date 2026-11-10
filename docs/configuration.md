# Configuration

`.triad-plus/team.json` separates stable role IDs from user-facing names and
personas. A schema-version-1 configuration has four role records:

```json
{
  "schema_version": 1,
  "interaction": { "language": "English", "owner_name": "Owner", "communication_style": "concise" },
  "roles": {
    "orchestrator": { "displayName": "Coordinator", "persona": "calm and precise", "model": null, "reasoning_effort": null },
    "developer": { "displayName": "Builder", "persona": "methodical", "model": null, "reasoning_effort": null },
    "reviewer": { "displayName": "Critic", "persona": "independent", "model": null, "reasoning_effort": null },
    "evaluator": { "displayName": "Evaluator", "persona": "fresh and evidence-led", "model": null, "reasoning_effort": null, "enabled": false }
  }
}
```

`orchestrator`, `developer`, and `reviewer` are the Core roles. `evaluator` is
optional and enabled only when `roles.evaluator.enabled` is `true`. Omitting that
field is backward-compatible and means Evaluator+ is not configured.

When enabled, Evaluator+ is automatically dispatched by the Orchestrator after
Triad reaches Reviewer approval. It receives a fresh post-run packet and cannot
change the closed Triad result. Set `enabled` to `false` to disable this default.

For a schema-v1 installation, the runtime adapter is selected once per
installed control workspace (`--host`) and all roles use that adapter. A
schema-v2 installation can record multiple project-local adapters, but this
does not yet select a host per Attempt: no host is inferred from install order,
and dispatch is explicitly unsupported until Attempt-bound liveness and
selection are implemented. The team file records role-level models and effort,
while generated profiles inherit host defaults. A requested model is not an
attestation of host selection or availability. A blank model means no request. Never put
tokens, API keys, or private deployment data in this file.

## Installation ownership and version

The package version and the installed workspace version are separate facts:

```bash
npx triad-plus --version
npx triad-plus version --control /path/to/project-control
```

After successful materialization, `.triad-plus/installation.json` records the
adapter (schema v1) or adapter membership plus per-adapter exact assets and
shared-path owner sets (schema v2), scopes, SHA-256 hashes, timestamps, and a
deterministic fingerprint. Project paths are control-workspace-relative; global
paths identify the user-level managed asset. Read-only commands do not migrate
v1. An explicit successful `adapter add ... --apply` is the v1-to-v2 migration
boundary.

The manifest deliberately does not own `.triad-plus/team.json`, `.loop/`,
`project.yaml`, feature cards, artifacts, evidence, or product source. A failed
install never writes a success manifest. Legacy workspaces are migrated by
`upgrade --apply` using the currently executing package version; the previous
version is not guessed.

When a team configuration is materialized, the managed role-run block in
`AGENTS.md` is recorded as a bounded block asset. Uninstall removes that block
only when its markers and hash still match, never the surrounding user file.
Global assets are shared-capable and therefore preserved by default by
`uninstall --global`.

`doctor` reports CLI version, installed version, manifest state, adapter, and
project/global scope. `adapter list` and `adapter doctor` inspect v1/v2 state
without writes; host executable availability is separate from recorded adapter
membership. `adapter add`, `adapter upgrade`, and `adapter remove` operate on
project-local assets only. Remove and upgrade are dry runs unless `--apply` is
present, modified or conflicting bytes are preserved and block false success,
and no command creates global Triad assets by default. The host-native
`.triad-runtime/adapter.json` singleton remains unchanged when adding another
adapter; additional metadata is stored per adapter and is not a dispatch seam.
Codex/Hermes project-local native entries remain limited or unproven. The CLI
reports these limitations instead of claiming parity. Version skew is explicit
and npm `latest` is never queried.

## Configure models through the agent

The installed `triad-model-configuration` skill lets an owner ask the selected
agent to show or change role models without editing host-specific files. The
agent reads `.triad-runtime/adapter.json`, validates `.triad-plus/team.json`,
changes only the explicitly requested `model` or `reasoning_effort` fields, and
reports the request separately from the effective host configuration. It never
invents model IDs or puts credentials in configuration.

Generated agent assets use **host default** for model and effort on every
adapter. Triad+ cannot verify an arbitrary ID against every host's available
providers before that host loads its files. An unknown native override can
prevent the host from starting the command at all. Therefore setup and upgrade
omit managed `model`, `variant`, `reasoningEffort`, and Codex
`model_reasoning_effort` overrides; canonical requests remain unchanged in
`team.json`, including legacy invalid requests so they can be corrected.

The wizard rejects model IDs with spaces/control characters, and OpenCode
requests must use its `provider/model` form. These are syntax checks only;
passing them does not mean a provider or model is available. Use the host's
native model picker to inspect available IDs and select the session model.
Triad+ must report that selection as unobservable unless the host supplies
reliable evidence. Reasoning/variant names are host-specific and are never
translated between providers.

Existing installations need the normal managed upgrade (with its preview and
explicit apply) to remove old overrides. Do not manually patch generated
agent files or edit an installation manifest to hide drift. Existing user-level Codex TOML profiles are not rewritten by the current
skill/wrapper installation; any remediation of those files requires an explicit
path preview and consent. The model configuration skill records requests; it does not claim that
`upgrade --apply` applies the requested model.

## Inactive quality-gate proposals

Setup also prepares an inactive `.triad-plus/quality-gates.draft.json` from
mapped manifests. Inspect it with `npx triad-plus quality-gates --control .`;
it never activates commands or replaces `.loop/quality-gates.yaml`. Use
`--lint` for structure-only validation without execution. See
[quality-gate discovery](quality-gate-discovery.md) for sources, per-worktree
binding, exclusions and the remaining guided-confirmation limitations.

## Retry and scope policy

New control workspaces use separate finite budgets for environment recovery and
candidate remediation. Existing workspaces that only declare
`max_rework_attempts_per_item` retain that legacy policy. A card may optionally
bind a versioned JSON scope contract at its first assignment; without one, the
deterministic scope preflight is not configured and independent review remains
the semantic scope check. See [verification.md](verification.md) for the
contract and matching rules.

Cards may also declare `required_gates` as an additive list of trusted
repository gate IDs. Globally required gates are never suppressed; a selected
optional gate becomes required for that card, and an absent or empty list keeps
the legacy gate behavior. Selected IDs are validated before Developer dispatch
and are bound to the assignment; Triad does not attach visual or other
domain-specific meaning to a gate ID.

## Optional immutable Quality Contract

New or upgraded control workspaces may set:

```yaml
project:
  quality_contract:
    baseline: artifacts/quality-baseline.json
    fingerprint: <sha256 of the canonical manifest>
```

The JSON manifest must contain at least one hashed, project-relative source and
may contain criteria scoped only to `product_quality` or `delivery_closure`.
The fingerprint is deterministic and independent of JSON whitespace or object
key order. A configured contract is validated before expensive verification
gates; malformed manifests and source drift fail closed. Omitting the section
preserves the 1.7 legacy PRD baseline behavior. A rebaseline is a new manifest
revision and explicit owner event, never an in-place edit.
