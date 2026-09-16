#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  ./adapters/antigravity/install.sh --project <control-repository-path>
  ./adapters/antigravity/install.sh --global

Install the Triad+ Antigravity adapter without overwriting existing agents,
skills, workflow, or project runtime. --project installs into
<control-repository-path>/.agents and also installs .triad-runtime. --global
installs agents, skills, and /triad workflow under $HOME/.gemini/config.
EOF
}

if [[ $# -eq 2 && "$1" == "--project" ]]; then
  target_root="$2/.agents"
  project_root="$2"
  project_install=true
elif [[ $# -eq 1 && "$1" == "--global" ]]; then
  target_root="$HOME/.gemini/config"
  project_root=""
  project_install=false
else
  usage >&2
  exit 2
fi

adapter_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repository_root="$(cd -- "$adapter_root/../.." && pwd)"
agent_names=(triad-orchestrator triad-developer triad-evaluator triad-reviewer)
skill_names=(triad-loop-bootstrap triad-loop-orchestrator triad-loop-developer triad-loop-evaluator triad-loop-reviewer triad-model-configuration)
collisions=()

for agent_name in "${agent_names[@]}"; do
  [[ -e "$target_root/agents/$agent_name/agent.md" ]] && collisions+=("agents/$agent_name/agent.md")
done
for skill_name in "${skill_names[@]}"; do
  [[ -e "$target_root/skills/$skill_name" ]] && collisions+=("skills/$skill_name")
done
[[ -e "$target_root/skills/triad" ]] && collisions+=("skills/triad")
if [[ "$project_install" == true && -e "$project_root/.triad-runtime" ]]; then
  collisions+=(".triad-runtime")
fi

if [[ ${#collisions[@]} -gt 0 ]]; then
  printf 'Installation aborted; existing paths would be overwritten:\n' >&2
  printf '  %s\n' "${collisions[@]}" >&2
  printf 'Remove or rename those paths deliberately, then run the installer again.\n' >&2
  exit 1
fi

mkdir -p "$target_root/agents" "$target_root/skills"
for agent_name in "${agent_names[@]}"; do
  cp -R "$adapter_root/.agents/agents/$agent_name" "$target_root/agents/$agent_name"
done
for skill_name in "${skill_names[@]}"; do
  cp -R "$repository_root/skills/$skill_name" "$target_root/skills/$skill_name"
done
cp -R "$adapter_root/.agents/skills/triad" "$target_root/skills/triad"
if [[ "$project_install" == true ]]; then
  cp -R "$repository_root/runtime" "$project_root/.triad-runtime"
  cp -R "$repository_root/schemas" "$project_root/.triad-runtime/schemas"
  cp "$adapter_root/runtime.json" "$project_root/.triad-runtime/adapter.json"
fi

printf 'Triad+ Engineering Loop installed in %s\n' "$target_root"
if [[ "$project_install" == true ]]; then
  printf 'Control-plane runtime installed in %s/.triad-runtime\n' "$project_root"
fi
printf 'Start Antigravity in the target project and use /triad followed by a PRD source or project request.\n'
