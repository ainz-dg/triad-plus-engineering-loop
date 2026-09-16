#!/usr/bin/env bash
set -euo pipefail

usage() {
  printf '%s\n' 'Usage: ./adapters/hermes/install.sh --project <control-workspace> | --global'
}

if [[ $# -eq 2 && "$1" == "--project" ]]; then
  project_root="$2"
  global_install=false
elif [[ $# -eq 1 && "$1" == "--global" ]]; then
  project_root=""
  global_install=true
else
  usage >&2
  exit 2
fi

adapter_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repository_root="$(cd -- "$adapter_root/../.." && pwd)"
skill_names=(triad-loop-bootstrap triad-loop-orchestrator triad-loop-developer triad-loop-evaluator triad-loop-reviewer triad-model-configuration)

if [[ "$global_install" == true ]]; then
  hermes_root="${HERMES_HOME:-$HOME/.hermes}"
  if [[ -z "${HERMES_HOME:-}" && -f "$hermes_root/active_profile" ]]; then
    active_profile="$(tr -d '[:space:]' < "$hermes_root/active_profile")"
    [[ -n "$active_profile" ]] && hermes_root="$hermes_root/profiles/$active_profile"
  fi
  target_root="$hermes_root/skills"
  [[ ! -e "$target_root/triad" ]] || { printf 'Refusing to overwrite %s/triad\n' "$target_root" >&2; exit 1; }
  for skill in "${skill_names[@]}"; do
    [[ ! -e "$target_root/$skill" ]] || { printf 'Refusing to overwrite %s/%s\n' "$target_root" "$skill" >&2; exit 1; }
  done
  mkdir -p "$target_root"
  cp -R "$adapter_root/skills/triad" "$target_root/triad"
  for skill in "${skill_names[@]}"; do cp -R "$repository_root/skills/$skill" "$target_root/$skill"; done
  printf 'Hermes Triad skills installed in %s\n' "$target_root"
else
  [[ -d "$project_root" ]] || { printf 'Control workspace does not exist: %s\n' "$project_root" >&2; exit 2; }
  [[ ! -e "$project_root/.triad-runtime" ]] || { printf 'Refusing to overwrite %s/.triad-runtime\n' "$project_root" >&2; exit 1; }
  cp -R "$repository_root/runtime" "$project_root/.triad-runtime"
  cp -R "$repository_root/schemas" "$project_root/.triad-runtime/schemas"
  cp "$adapter_root/runtime.json" "$project_root/.triad-runtime/adapter.json"
  printf 'Triad verifier runtime installed in %s/.triad-runtime\n' "$project_root"
fi
