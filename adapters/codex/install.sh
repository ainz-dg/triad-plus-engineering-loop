#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  ./adapters/codex/install.sh --project <control-repository-path>
  ./adapters/codex/install.sh --global

Install the Triad Codex adapter without overwriting existing skills, prompt, or
project runtime. --project installs the six skills under
<control-repository-path>/.agents/skills and installs .triad-runtime. It does
not install the user-level Codex prompt. --global installs the /prompts:triad
entry point and the six skills under $CODEX_HOME (default: $HOME/.codex).

For normal use run both commands once: --project for each control repository,
then --global for the Codex entry point. Existing paths are never overwritten.
EOF
}

codex_home="${CODEX_HOME:-$HOME/.codex}"
skill_names=(triad-loop-bootstrap triad-loop-orchestrator triad-loop-developer triad-loop-evaluator triad-loop-reviewer triad-model-configuration)

if [[ $# -eq 2 && "$1" == "--project" ]]; then
  project_root="$2"
  project_install=true
elif [[ $# -eq 1 && "$1" == "--global" ]]; then
  project_root=""
  project_install=false
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
  [[ -e "$codex_home/prompts/triad.md" ]] && collisions+=("$codex_home/prompts/triad.md")
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
  cp "$adapter_root/runtime.json" "$project_root/.triad-runtime/adapter.json"
  printf 'Triad skills installed in %s/.agents/skills\n' "$project_root"
  printf 'Control-plane runtime installed in %s/.triad-runtime\n' "$project_root"
  printf 'Then run the global install once to expose /prompts:triad in Codex.\n'
else
  mkdir -p "$codex_home/prompts" "$codex_home/skills"
  cp "$adapter_root/prompts/triad.md" "$codex_home/prompts/triad.md"
  for skill_name in "${skill_names[@]}"; do
    cp -R "$repository_root/skills/$skill_name" "$codex_home/skills/$skill_name"
  done
  printf 'Triad Codex prompt installed at %s/prompts/triad.md\n' "$codex_home"
  printf 'Start Codex in an initialized control repository and use /prompts:triad followed by a PRD source or project request.\n'
fi
