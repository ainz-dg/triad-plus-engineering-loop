#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  ./adapters/codex/install.sh --project <control-repository-path>

This legacy helper installs project-local skills only. For a global $triad
entry, use `npx triad-plus` and select Codex under “Optional global entry
bridge”; the wizard previews `$CODEX_HOME/skills/triad/SKILL.md` and installs
it only after the exact `install` confirmation. An existing legacy
`$CODEX_HOME/prompts/triad.md` is never changed or deleted and blocks native
skill installation until the owner backs it up or deselects the Codex global
entry. Global entries are not written by this script.
EOF
}

codex_home="${CODEX_HOME:-$HOME/.codex}"
skill_names=(triad-loop-bootstrap triad-loop-orchestrator triad-loop-developer triad-loop-evaluator triad-loop-reviewer triad-model-configuration)

if [[ $# -eq 2 && "$1" == "--project" ]]; then
  project_root="$2"
  project_install=true
elif [[ $# -eq 1 && "$1" == "--global" ]]; then
  printf '%s\n' 'Global Codex entry installation requires the consent-gated npx triad-plus wizard; no files were changed.' >&2
  exit 2
else
  usage >&2
  exit 2
fi

adapter_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repository_root="$(cd -- "$adapter_root/../.." && pwd)"
collisions=()

if [[ "$project_install" == true ]]; then
  [[ -d "$project_root" ]] || { printf 'Project path does not exist: %s\n' "$project_root" >&2; exit 2; }
  for skill_name in "${skill_names[@]}"; do
    [[ -e "$project_root/.agents/skills/$skill_name" ]] && collisions+=(".agents/skills/$skill_name")
  done
  [[ -e "$project_root/.triad-runtime" ]] && collisions+=(".triad-runtime")
else
  [[ -e "$codex_home/skills/triad/SKILL.md" ]] && collisions+=("$codex_home/skills/triad/SKILL.md")
  for skill_name in "${skill_names[@]}"; do
    [[ -e "$codex_home/skills/$skill_name" ]] && collisions+=("$codex_home/skills/$skill_name")
  done
fi

if [[ ${#collisions[@]} -gt 0 ]]; then
  printf 'Installation aborted; existing paths would be overwritten:\n' >&2
  printf '  %s\n' "${collisions[@]}" >&2
  printf 'Remove or rename those paths deliberately, then run the installer again.\n' >&2
  exit 1
fi

if [[ "$project_install" == true ]]; then
  mkdir -p "$project_root/.agents/skills"
  for skill_name in "${skill_names[@]}"; do
    cp -R "$repository_root/skills/$skill_name" "$project_root/.agents/skills/$skill_name"
  done
  cp -R "$repository_root/runtime" "$project_root/.triad-runtime"
  cp -R "$repository_root/schemas" "$project_root/.triad-runtime/schemas"
  mkdir -p "$project_root/.triad-runtime/adapters/codex"
  cp "$adapter_root/run-role.mjs" "$project_root/.triad-runtime/adapters/codex/run-role.mjs"
  cp "$adapter_root/reviewer-result.mjs" "$project_root/.triad-runtime/adapters/codex/reviewer-result.mjs"
  cp "$adapter_root/runtime.json" "$project_root/.triad-runtime/adapter.json"
  printf 'Triad skills installed in %s/.agents/skills\n' "$project_root"
  printf 'Control-plane runtime installed in %s/.triad-runtime\n' "$project_root"
  printf 'To expose the optional global $triad entry, run npx triad-plus and approve the exact global path in its wizard.\n'
fi
