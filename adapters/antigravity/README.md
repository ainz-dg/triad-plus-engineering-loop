# Triad+ for Antigravity

The Antigravity adapter uses native workspace paths: `.agents/skills/` for the
six shared Triad+ skills and `/triad` workflow, plus `.agents/agents/` for the
four technical agents. Start Antigravity from the project-control workspace and
invoke:

```text
/triad <PRD path or project request>
```

Install with the Triad+ CLI:

```bash
npx triad-plus init --host antigravity --control /path/to/project-control
```

Add `--global` to install the same assets under `~/.gemini/config/`. The
installer stores the selected role/model contract in `.triad-plus/team.json`.
Antigravity model selection remains a host setting; select a model through its
native controls. `/triad` compares the contract with any host-exposed model
identity and asks for owner confirmation when the host cannot expose one.

The initial adapter uses explicit verification dispatch. Background subagents
are useful for role separation, but they are not treated as proof of a verified
lifecycle hook until a versioned Antigravity control-plane adapter exists.
