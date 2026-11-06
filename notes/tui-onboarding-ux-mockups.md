# Triad+ first-run UX — pre-implementation mockups

These mockups are the design checkpoint for the TUI UX mandate. They describe the real first-install path with **OpenCode primary, Claude Code secondary, one existing `ketchup2` repository, no global entry, and optional team left off**. The separate global-write example uses Codex, which is a supported global-entry adapter. They are not claims about implemented output.

## Color and typography contract

| Role | Treatment | Meaning |
|---|---|---|
| Brand | Violet `#7C8CFF` + turquoise `#35C3B1`; amber `#F5B95E` for `+` | Identity, shown large once on entry and compact on later screens |
| Focus / current stage / primary action | Cyan; bold title | Where the user is and what is actionable |
| Selected / success | Green, also marked `[x]` or `✓` | Selection and completed setup |
| Context / helper / navigation | Dim gray, with plain-language labels | Secondary information, never the only way to understand the screen |
| Meaningful caution | Amber, with explanatory text | A consequential but recoverable choice |
| Blocking error | Red, with a cause and recovery step | Setup cannot safely continue |

Use ANSI 16-color roles for ordinary ANSI terminals and 24-bit logo colors only when the terminal advertises truecolor support. `NO_COLOR`, `TERM=dumb`, and piped/non-TTY output render plain text. Text glyphs, labels, and status wording preserve meaning without color. No rainbow treatment or TUI framework.

## 80×24 supported PTY — primary path

On entry, show the large mark once; following checklist screens use a compact brand. Colors are indicated in the side notes rather than encoded into copy.

```text
  ████████╗  ██████╗   ██╗  █████╗  ██████╗   +
  ╚══██╔══╝  ██╔══██╗  ██║ ██╔══██╗ ██╔══██╗
     ██║     ██████╔╝  ██║ ███████║ ██║  ██║
     ██║     ██╔══██╗  ██║ ██╔══██║ ██║  ██║
     ██║     ██║  ██║  ██║ ██║  ██║ ██████╔╝
     ╚═╝     ╚═╝  ╚═╝  ╚═╝ ╚═╝  ╚═╝ ╚═════╝

TRIAD+ · Setup · Start
No setup is installed in this folder.
Set up a new workspace or manage one already installed here? [N]ew / [M]anage [N]:

TRIAD+ · Setup · Control Workspace
Where should Triad+ keep this project's setup?
The Control Workspace holds configuration, not product source.
Setup folder [<current directory>] (absolute or relative; blank uses this path):
```

Brand colors: `TRI`/`R` violet, `AD` turquoise, `+` amber. The active stage and title are cyan; the prompt remains readable if color is unavailable. Do not print the old routine “No sibling directories will be searched” note here; the explicit-path / no-search invariant remains enforced and documented where repository selection is explained.

### Repository selection and defaults

```text
TRIAD+ · Setup · Product repositories
Which product repositories belong in this setup?
We suggest Git repositories directly inside this folder.
Nothing is cloned or created; adding another path is explicit.

› [x] ./ketchup2 — current branch main
  [ ] Add repository by path
  [ ] Skip repository setup for now

1 selected · Enter to continue · Esc to cancel
```

After selecting `ketchup2`, show the complete defaults once and offer one deliberate edit action. Enter accepts defaults; `edit` opens the existing per-field validated prompts. No default is silently applied: the exact values appear again in the final plan.

```text
Suggested repository setup (shown again in the final review):
ketchup2 · ./ketchup2
Base branch     main
Project branch triad/ketchup2-feature
Worktree folder worktrees/ketchup2-feature

Press Enter to use these values, or type edit to change them:
```

The same block repeats for each selected repository before the one `edit` decision. The final preview labels branch and worktree values as **planned mappings only**; no branch or worktree is created. Advanced prompts remain editable, validate all four values, and preserve existing branch semantics.

### Harnesses, optional stages, and review

```text
TRIAD+ · Setup · Coding tools
Which coding tools will use this setup?
Choose one or more tools. The first is primary; adding others does not switch tools automatically during a run.

› [x] OpenCode — /triad command
  [x] Claude Code — /triad command
  [ ] Codex — project-local skills
  [ ] GitHub Copilot — project-local agent

2 selected · primary OpenCode · Enter to continue
```

For OpenCode + Claude Code, the global-entry stage is unavailable and is **omitted**; the next screen is `Optional team`, with no skipped stage counter. Stage names, not fixed fractions, remain truthful through optional branches and Back navigation. If an eligible tool such as Codex is selected, show a distinct optional stage:

```text
TRIAD+ · Setup · Optional user-level entries
Add an optional user-level shortcut?
Available for some coding tools. The final review lists each exact file; this shortcut does not block model access.
› [ ] Codex ($triad) — requires a separate exact-path review
0 selected · Enter to continue · Esc to go back
```

Then `TRIAD+ · Setup · Optional team` asks one short yes/no question; “No” is a normal, neutral choice. The plan stays explicit about adapters and primary selection.

```text
Setup summary
Control Workspace <absolute path>
Repositories       ketchup2 (existing checkout)
  Stable ID        ketchup2
  Base branch      main
  Planned branch   triad/ketchup2-feature (mapping only)
  Worktree folder  worktrees/ketchup2-feature (mapping only)
Coding tools       OpenCode (primary), Claude Code
Changes planned    local tool entries and project settings mapping
Team setup         not configured (optional)
Files              setup-folder only; no user-level files

Type install to apply this exact plan, details to inspect it,
or anything else to cancel:
```

When global files were selected, `details` is required before consent and prints every exact absolute path and planned content. Cancellation or failed preflight writes nothing. The final approval remains the explicit typed `install` phrase.

```text
✓ Triad+ installed
Control Workspace: <absolute path>
Coding tools configured: OpenCode, Claude Code
Next: Open this Control Workspace in your IDE: <absolute path>
Next: In OpenCode, run `/triad <PRD location or concise project request>` to start.
```

Success is green; the command follows the documented OpenCode entry. Do not claim a branch, worktree, or run is already created or ready.

## 60×20 compact / `TERM=dumb` / `NO_COLOR` fallback

The fallback uses plain text and omits the large logo. This example shows the optional-stage branch without supported global entries.

```text
TRIAD+ · Setup · Coding tools
Choose project-local coding tools.
The first selected tool is primary.

› [x] OpenCode — /triad
  [x] Claude Code — /triad
  [ ] Codex

2 selected · primary OpenCode
Enter continue · Esc back

TRIAD+ · Setup · Optional team
Team setup is optional.
Configure team identities/models now? [y/N]:
```

At 60×20, clip only secondary descriptions, preserve the full choice label when possible, wrap recovery text cleanly, and never depend on cursor-addressing or color. At `TERM=dumb`, print the stage as a plain line; piped output retains the same words and selected/default values.

## Blocking error

```text
TRIAD+ · Setup · Blocked
Cannot use this folder for a new Control Workspace.
Why: it is inside product repository <path>.
Nothing was written.
Next: choose a separate Control Workspace path, or cancel.
```

Cause is red only on a color-capable terminal; the `Blocked`, `Why`, and `Next` labels make the condition and recovery clear in plain mode. Optional/unconfigured values are never red.

## Verification points for implementation

- Capture real PTY frames at 80×24, 80×20, and 60×20; assert stage labels and stable layout, not transcript substrings alone.
- For OpenCode + Claude Code, assert no global-entry screen and no misleading fraction jump; for Codex global selection, assert exact-path details must be reviewed before `install` consent.
- Assert semantic ANSI roles and plain output under `NO_COLOR`, `TERM=dumb`, and piped input. Assert truecolor is emitted only when advertised and downgrades otherwise.
- Cover default acceptance, advanced edit + validation, Back/Escape, cancellation, no writes before consent, blocking error recovery, short success text, cursor restoration, and no redraw flood.
