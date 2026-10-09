# Triad Cockpit — synthetic screenshots (Mandate 003, commit f3cf861)

- **Code:** `f3cf8614c403a41a1df78902bbf62d26fe660adb` on `feat/cockpit-readonly-backend`. The UI is served from that commit's `cockpit/dist` by the real CLI (`node bin/triad-plus.js cockpit --control <demo>`), after a one-time login.
- **Data:** only the **synthetic** workspace `tests/fixtures/cockpit-demo-workspace.mjs` (fictional "Lumen Notes" project). No real workspace, local path, or private data.
- **Capture:** `capture-cdp-shots.mjs` drives headless Chrome through the DevTools Protocol, with no dependencies. Each shot pins its own:
  - viewport and device type;
  - `prefers-color-scheme`, so the result does not depend on the host's theme;
  - scroll position, so nothing carries over from the previous shot.

  The app theme setting is "System" (no `data-theme` override).
- **Measured on the page at capture time:**
  - effective color scheme;
  - `scrollWidth` against the viewport width (equal means no horizontal overflow);
  - the refresh status text.

| File | Viewport | Scheme | scrollWidth / width | Refresh status | sha256 |
|---|---|---|---|---|---|
| `01-desktop-dark-card-detail.png` | 1440x900 | dark | 1440 / 1440 | Updated 22:44:59 | `bba6ee1950fdbca166bd929863cd2ba1994fc81d42652df7b9f757001ee6ab1a` |
| `02-desktop-light-card-attention.png` | 1440x900 | light | 1440 / 1440 | Updated 22:44:59 | `08dffdfdd4da6786ab9b9e7f1588b71db7ba5a12df0ad212d2b113d0131279c4` |
| `03-desktop-dark-artifact-viewer.png` | 1440x900 | dark | 1440 / 1440 | Updated 22:44:59 | `e9cc762eec1ad39b87809cf765ce4e06231dd42d551dc68ed16130cffe0db451` |
| `04-mobile-dark-card-list.png` | 375x812 mobile@2x | dark | 375 / 375 | Updated 22:44:59 | `d8297894b0c418ac2a5548eb88e66d0b5abdb8b51589a139d44fddf1b95e9060` |
| `05-mobile-dark-card-signals.png` | 375x812 mobile@2x | dark | 375 / 375 | Updated 22:44:59 | `1b7fb0a74c02ffa440edfd53569e865024cab92ba230f1e945425bd80737fc94` |
| `06-mobile-dark-freshness-gates.png` | 375x812 mobile@2x | dark | 375 / 375 | Updated 22:44:59 | `b830c648579211c7a9eecd994fb48fcc67a59e7cf558c94e1c5a1f79650b3e95` |
| `07-tablet-light-card.png` | 900x1100 | light | 900 / 900 | Updated 22:44:59 | `15f6180992fb890fadf4f001d212f68f883e3a21d45aae8f6af1b6b4f4e703b8` |
