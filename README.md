# Review assets: Triad Cockpit, Mandate 003

**This branch is not code.**
- It holds only the synthetic screenshots used for the visual review of the
  Draft PR from `feat/cockpit-readonly-backend` to `main`.
- It shares no history with `main` (orphan commit) and must never be merged.
- None of these files are part of the `triad-plus` npm package.

`cockpit-mandato003-f3cf861/` contents:
- seven screenshots of commit `f3cf8614c403a41a1df78902bbf62d26fe660adb`,
  rendered from the synthetic fixture `tests/fixtures/cockpit-demo-workspace.mjs`
  (no real workspace data);
- `MANIFEST.md` with the viewport, color scheme, overflow check, refresh status,
  and sha256 of each file;
- `capture-cdp-shots.mjs`, the dependency-free capture script used to produce
  them.

The branch can be deleted once the review is closed.
