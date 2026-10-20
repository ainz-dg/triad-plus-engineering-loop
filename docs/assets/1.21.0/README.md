# Triad+ 1.21.0 Cockpit screenshot provenance

These images are direct captures of the actual Triad+ 1.21.0 Cockpit running
in Chrome. They use the repository's synthetic demo-workspace fixture, not a
private project or a real agent run. They are illustrative UI evidence only.

## Reproduction and environment

- Source checkout: `e6d9ca02181f45796eaa43758eb472b425c8fc54` (v1.21.0).
- Fixture: `tests/fixtures/cockpit-demo-workspace.mjs`, upgraded using the
  checked-out CLI so the Cockpit sidebar reports 1.21.0.
- Browser: Google Chrome 155.0.8059.85.
- Displayed viewport: 1200 × 846 pixels.
- Runtime used for the local CLI and demo: Node.js 26.12.0.
- The Cockpit was started against the fixture and inspected in its real
  loopback browser tab. Captures were taken directly from that tab; no UI was
  redrawn or composited.

| Capture | View | Dimensions | Size |
| --- | --- | ---: | ---: |
| `cockpit-workspace-overview.png` | Workspace and card list | 1200 × 846 | 76,826 B |
| `cockpit-card-signals.png` | Verifier, Reviewer, and Evaluator+ cards | 1200 × 846 | 126,112 B |
| `cockpit-card-evidence.png` | Attempt verification, gate results, and candidate freshness | 1200 × 846 | 121,503 B |
| `cockpit-how-to-read.png` | Built-in provenance and freshness guide | 1200 × 846 | 115,946 B |

The first-run wizard was also exercised in a real 118 × 36 PTY, including the
Control Workspace and product-repository prompts. The Mac's locked desktop
prevented a native terminal screenshot, so none is represented as a visual
capture here. No terminal image was fabricated.
