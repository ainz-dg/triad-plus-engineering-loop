#!/usr/bin/env bash
set -euo pipefail

usage() {
  printf '%s\n' 'Usage: ./adapters/hermes/install.sh --project <control-workspace>'
}

if [[ $# -eq 2 && "$1" == "--project" ]]; then
  project_root="$2"
  global_install=false
elif [[ $# -eq 1 && "$1" == "--global" ]]; then
  printf '%s\n' 'Global Hermes entry installation requires the consent-gated npx triad-plus wizard; no files were changed.' >&2
  exit 2
else
  usage >&2
  exit 2
fi

adapter_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repository_root="$(cd -- "$adapter_root/../.." && pwd)"
skill_names=(triad-loop-bootstrap triad-loop-orchestrator triad-loop-developer triad-loop-evaluator triad-loop-reviewer triad-model-configuration)

[[ -d "$project_root" ]] || { printf 'Control workspace does not exist: %s\n' "$project_root" >&2; exit 2; }
[[ ! -e "$project_root/.triad-runtime" ]] || { printf 'Refusing to overwrite %s/.triad-runtime\n' "$project_root" >&2; exit 1; }
cp -R "$repository_root/runtime" "$project_root/.triad-runtime"
cp -R "$repository_root/schemas" "$project_root/.triad-runtime/schemas"
cp "$adapter_root/runtime.json" "$project_root/.triad-runtime/adapter.json"
printf 'Triad verifier runtime installed in %s/.triad-runtime\n' "$project_root"
