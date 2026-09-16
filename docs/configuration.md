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

The runtime adapter is selected once per installed control workspace (`--host`).
All roles in that run use that adapter; Triad+ does not orchestrate roles across
different hosts. The team file records role-level models and effort, but an
adapter writes those into host-native profiles only where the selected host
supports that facility. A blank model means the host default. Never put tokens,
API keys, or private deployment data in this file.

## Installation ownership and version

The package version and the installed workspace version are separate facts:

```bash
npx triad-plus --version
npx triad-plus version --control /path/to/project-control
```

After successful materialization, `.triad-plus/installation.json` records the
adapter, project/global scopes, exact managed files, SHA-256 hashes, timestamps,
and a deterministic fingerprint. Project paths are control-workspace-relative;
global paths identify the user-level managed asset. The manifest is generated
from the same adapter registry and install plan used by `init` and `upgrade`.

The manifest deliberately does not own `.triad-plus/team.json`, `.loop/`,
`project.yaml`, feature cards, artifacts, evidence, or product source. A failed
install never writes a success manifest. Legacy workspaces are migrated by
`upgrade --apply` using the currently executing package version; the previous
version is not guessed.

`doctor` reports CLI version, installed version, manifest state, adapter, and
project/global scope. It reports version skew explicitly and never queries npm
for `latest`.

## Configure models through the agent

The installed `triad-model-configuration` skill lets an owner ask the selected
agent to show or change role models without editing host-specific files. The
agent reads `.triad-runtime/adapter.json`, validates `.triad-plus/team.json`,
changes only the explicitly requested `model` or `reasoning_effort` fields, and
uses the existing managed binding path to materialize supported values. It
reports whether each request was applied host-natively, recorded only in the
team file, left at the host default, or unsupported. It never invents model IDs
and never puts credentials in the configuration.

The skill follows the adapter metadata: `global-profiles` writes native
user-level profiles, `project-frontmatter` writes only the declared native
fields (OpenCode supports model plus its native `variant`, Copilot supports
model plus `reasoningEffort`, and Claude Code currently supports model only),
and `team-record` records intent without fabricating a host binding. A null or
blank value deliberately means host default. Reasoning levels are host-specific
and are never translated between providers.

For project-frontmatter adapters, `.triad-plus/team.json` remains the canonical
source of truth. Managed installation and `upgrade --apply` re-materialize each
configured role's supported fields after refreshing agent assets. OpenCode maps
`model` to `model` and `reasoning_effort` to its native `variant` field; Copilot
maps the same canonical fields to `model` and `reasoningEffort`; Claude Code
currently maps `model` only. Null or blank values are omitted so the host uses
its session default. Other adapters may expose different controls; Triad+ only
materializes fields supported by the selected host. A host/session default is
distinct from a role-agent binding.

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
