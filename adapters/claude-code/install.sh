#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  ./adapters/claude-code/install.sh --project <control-repository-path>
  ./adapters/claude-code/install.sh --global

Install the Triad Claude Code adapter without overwriting existing agents,
commands, skills, hook fragments, or project runtime. --project installs into
<control-repository-path>/.claude and also installs .triad-runtime. --global
installs only agents, command, and skills under $HOME/.claude.
EOF
}

if [[ $# -eq 2 && "$1" == "--project" ]]; then
  target_root="$2/.claude"
  project_root="$2"
  project_install=true
elif [[ $# -eq 1 && "$1" == "--global" ]]; then
  target_root="$HOME/.claude"
  project_root=""
  project_install=false
else
  usage >&2
  exit 2
fi

adapter_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repository_root="$(cd -- "$adapter_root/../.." && pwd)"
agent_names=(triad-developer triad-evaluator triad-reviewer)
skill_names=(triad-loop-bootstrap triad-loop-orchestrator triad-loop-developer triad-loop-evaluator triad-loop-reviewer triad-model-configuration)
collisions=()

for agent_name in "${agent_names[@]}"; do
  [[ -e "$target_root/agents/$agent_name.md" ]] && collisions+=("agents/$agent_name.md")
done
for skill_name in "${skill_names[@]}"; do
  [[ -e "$target_root/skills/$skill_name" ]] && collisions+=("skills/$skill_name")
done
[[ -e "$target_root/commands/triad.md" ]] && collisions+=("commands/triad.md")
if [[ "$project_install" == true ]]; then
  [[ -e "$target_root/triad-hooks.json" ]] && collisions+=("triad-hooks.json")
  [[ -e "$project_root/.triad-runtime" ]] && collisions+=(".triad-runtime")
fi

if [[ ${#collisions[@]} -gt 0 ]]; then
  printf 'Installation aborted; existing paths would be overwritten:\n' >&2
  printf '  %s\n' "${collisions[@]}" >&2
  printf 'Remove or rename those paths deliberately, then run the installer again.\n' >&2
  exit 1
fi

mkdir -p "$target_root/agents" "$target_root/commands" "$target_root/skills"
for agent_name in "${agent_names[@]}"; do
  cp "$adapter_root/.claude/agents/$agent_name.md" "$target_root/agents/$agent_name.md"
done
cp "$adapter_root/.claude/commands/triad.md" "$target_root/commands/triad.md"
for skill_name in "${skill_names[@]}"; do
  cp -R "$repository_root/skills/$skill_name" "$target_root/skills/$skill_name"
done
if [[ "$project_install" == true ]]; then
  cp "$repository_root/integrations/claude-code/hooks.json" "$target_root/triad-hooks.json"
  cp -R "$repository_root/runtime" "$project_root/.triad-runtime"
  cp -R "$repository_root/schemas" "$project_root/.triad-runtime/schemas"
  cp "$adapter_root/runtime.json" "$project_root/.triad-runtime/adapter.json"
fi

printf 'Triad+ Engineering Loop installed in %s\n' "$target_root"
if [[ "$project_install" == true ]]; then
  printf 'Control-plane runtime installed in %s/.triad-runtime\n' "$project_root"
  printf 'Review .claude/triad-hooks.json and merge it into trusted Claude settings only if hook dispatch is desired.\n'
fi
printf 'Start Claude Code in the target project and use /triad followed by a PRD source or project request.\n'
