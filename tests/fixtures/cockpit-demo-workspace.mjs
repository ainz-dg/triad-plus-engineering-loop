import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildInstallationManifest } from "../../runtime/lib/installation-manifest.mjs";

// A synthetic, realistic control workspace for the Cockpit UI: used by the
// frontend integration tests, local previews, and documentation screenshots.
// Every name, path, and log line below is invented; nothing comes from a real
// workspace. Artifacts follow the shapes Triad+ v1.15 writes.

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

async function put(file, content) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content, "utf8");
  return content;
}
const putJson = (file, value) => put(file, `${JSON.stringify(value, null, 2)}\n`);

const PACKET_START = "<!-- triad-plus-assignment-packet:start -->";
const PACKET_END = "<!-- triad-plus-assignment-packet:end -->";

/** Create the demo workspace under `root`; returns the control directory. */
export async function createDemoWorkspace(root) {
  const control = path.join(root, "lumen-control");

  await putJson(path.join(control, ".triad-plus/installation.json"), buildInstallationManifest({
    triadVersion: "1.15.0",
    adapter: "opencode",
    installedAt: "2026-10-01T08:30:00.000Z",
  }));
  await putJson(path.join(control, ".triad-plus/team.json"), {
    schema_version: 1,
    interaction: { language: "English", owner_name: "Owner", communication_style: "concise" },
    roles: {
      orchestrator: { displayName: "Orchestrator", persona: "calm", model: null, reasoning_effort: null, enabled: true },
      developer: { displayName: "Developer", persona: "precise", model: "example-model-large", reasoning_effort: "high", enabled: true },
      reviewer: { displayName: "Reviewer", persona: "skeptical", model: "example-model-review", reasoning_effort: null, enabled: true },
      evaluator: { displayName: "Evaluator+", persona: "blind", model: null, reasoning_effort: null, enabled: true },
    },
  });

  const prd = await put(path.join(control, "artifacts/prd.md"), `# Lumen Notes — offline drafts

Lumen Notes is a local-first note app. This increment makes drafting resilient:
drafts survive reloads, search is keyboard-driven, and notes export cleanly.

## Goals
- Never lose a draft on reload or crash.
- Reach any note in two keystrokes.
- Export notes as portable Markdown.
`);
  const gates = await put(path.join(control, ".loop/quality-gates.yaml"), `gates:
  - id: unit
    command: npm test
    required: true
  - id: lint
    command: npm run lint
    required: true
  - id: e2e-smoke
    command: npm run test:e2e -- --grep @smoke
    required: false
`);
  await put(path.join(control, ".loop/run-state.yaml"), `version: 1
updated_at: 2026-10-07T16:12:00Z
project_decision: in_progress
delivery:
  status: not_delivered
attempts: []
escalations:
  - card: NOTE-104
    reason: sync service contract unclear
`);
  await put(path.join(control, ".loop/work-queue.yaml"), `version: 2
policy:
  require_reviewer_approval: true

items:
  - id: NOTE-101
    title: Persist note drafts locally
    card: features/NOTE-101.md
    depends_on: []
    state: approved
    required_gates: [unit, lint]
    attempts: 2
  - id: NOTE-102
    title: Keyboard shortcuts for note search
    card: features/NOTE-102.md
    depends_on: [NOTE-101]
    state: in_review
    required_gates: [unit, lint]
    attempts: 1
  - id: NOTE-103
    title: Export notes as Markdown
    card: features/NOTE-103.md
    depends_on: []
    state: in_progress
    required_gates: [unit]
    attempts: 1
  - id: NOTE-104
    title: Sync conflict banner
    card: features/NOTE-104.md
    depends_on: [NOTE-101]
    state: blocked
    attempts: 1
    owner:
      escalated_to: product
  - id: NOTE-105
    title: Pin notes to the sidebar
    card: features/NOTE-105.md
    depends_on: []
    state: draft
    attempts: 0
`);

  const cards = {};
  const cardText = {
    "NOTE-101": "# NOTE-101 — Persist note drafts locally\n\n## Acceptance criteria\n- Drafts are saved every 2 s and on blur.\n- A reload restores the last draft.\n",
    "NOTE-102": "# NOTE-102 — Keyboard shortcuts for note search\n\n## Acceptance criteria\n- `/` focuses search; `Esc` clears it.\n",
    "NOTE-103": "# NOTE-103 — Export notes as Markdown\n\n## Acceptance criteria\n- Export preserves headings and lists.\n",
    "NOTE-104": "# NOTE-104 — Sync conflict banner\n\n## Acceptance criteria\n- Conflicts show a non-blocking banner.\n",
    "NOTE-105": "# NOTE-105 — Pin notes to the sidebar\n",
  };
  for (const [id, text] of Object.entries(cardText)) cards[id] = await put(path.join(control, "features", `${id}.md`), text);

  const assignment = (feature, attempt, extra = {}) => ({
    schema_version: 1,
    assignment_id: `asg-${feature.toLowerCase()}-${attempt}`,
    status: "active",
    agent_id: "triad-developer",
    agent_type: "triad_developer",
    feature_id: feature,
    attempt,
    expected_branch: `triad/${feature.toLowerCase()}`,
    prd_path: "artifacts/prd.md",
    card_path: `features/${feature}.md`,
    gates_path: ".loop/quality-gates.yaml",
    required_gate_ids: ["unit", "lint"],
    verification_run_id: `run-${feature.toLowerCase()}-${attempt}`,
    ...extra,
  });

  async function writeAssignment(feature, attempt, { packet = true, extra = {} } = {}) {
    const base = assignment(feature, attempt, extra);
    if (packet) {
      const packetPath = `.loop/runtime/assignments/${feature}-attempt-${String(attempt).padStart(3, "0")}.md`;
      const body = [
        PACKET_START,
        "# Triad+ Assignment Packet",
        "",
        "```json",
        JSON.stringify({ schema_version: 1, packet_type: "triad-assignment", assignment_id: base.assignment_id, feature_id: feature, attempt, branch: base.expected_branch, packet_path: packetPath, required_gate_ids: base.required_gate_ids, mandatory_skills: [] }, null, 2),
        "```",
        "",
        "## Card outcome and scope",
        "",
        cardText[feature].split("\n")[0].replace(/^# /, ""),
        "",
        "## Dispatch contract",
        "",
        "The host MUST launch this role with cwd equal to the assigned product worktree.",
        PACKET_END,
        "",
      ].join("\n");
      await put(path.join(control, packetPath), body);
      base.assignment_packet_path = packetPath;
      base.assignment_packet_sha256 = sha256(body);
    }
    return putJson(path.join(control, `.loop/runtime/assignments/${feature}-attempt-${attempt}.json`), base);
  }

  async function writeVerification(feature, attempt, assignmentText, { status, createdAt, card, fingerprint, gates: gateResults, logs, failure = null }) {
    const directory = path.join(control, `.loop/evidence/${feature}/attempt-${String(attempt).padStart(3, "0")}`);
    for (const [name, text] of Object.entries(logs)) await put(path.join(directory, "logs", name), text);
    const requiredPassed = status === "pass";
    return putJson(path.join(directory, "verification.json"), {
      schema_version: 1,
      run_id: `run-${feature.toLowerCase()}-${attempt}`,
      feature_id: feature,
      attempt,
      assignment_id: `asg-${feature.toLowerCase()}-${attempt}`,
      assignment_sha256: sha256(assignmentText),
      trigger: { event: "SubagentStop", agent_id: "triad-developer", agent_type: "triad_developer" },
      assignment_ref: `.loop/runtime/assignments/${feature}-attempt-${attempt}.json`,
      baseline: { prd_sha256: sha256(prd), card_sha256: sha256(card), gates_sha256: sha256(gates), git_head: "4be1f0c9a2d3e5f60718293a4b5c6d7e8f901234", candidate_fingerprint: fingerprint, branch: `triad/${feature.toLowerCase()}` },
      scope: { status: "not_configured" },
      gates: gateResults.map(([id, required, gateStatus, exit, duration]) => ({
        id,
        required,
        executor: "shell",
        status: gateStatus,
        exit_code: exit,
        duration_ms: duration,
        stdout_ref: `logs/${id}.stdout.log`,
        stderr_ref: `logs/${id}.stderr.log`,
        output_truncated: false,
      })),
      required_gates_passed: requiredPassed,
      status,
      failure,
      created_at: createdAt,
    });
  }

  // NOTE-101: failed first attempt, passing second, review + Evaluator+ + driver output.
  const a1011 = await writeAssignment("NOTE-101", 1);
  await writeVerification("NOTE-101", 1, a1011, {
    status: "fail",
    createdAt: "2026-10-03T09:41:12.000Z",
    card: cards["NOTE-101"],
    fingerprint: "c0ffee01a9b8c7d6e5f4a3b2c1d0e9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c3d2",
    gates: [["unit", true, "fail", 1, 4210], ["lint", true, "pass", 0, 1873], ["e2e-smoke", false, "pass", 0, 15320]],
    logs: {
      "unit.stdout.log": "TAP version 13\n# drafts store\nok 1 - saves a draft on blur\nnot ok 2 - restores the last draft after reload\n  ---\n  expected: 'Groceries: eggs, rice'\n  actual:   ''\n  at: test/drafts.test.js:42:5\n  ...\nok 3 - debounces saves to 2 s\n1..3\n# tests 3\n# pass  2\n# fail  1\n",
      "unit.stderr.log": "",
      "lint.stdout.log": "> lumen-notes@0.9.0 lint\n> eslint src test\n\n✔ No problems found.\n",
      "lint.stderr.log": "",
      "e2e-smoke.stdout.log": "Running 4 tests using 2 workers\n  ✓ smoke › open app (1.2s)\n  ✓ smoke › create note (2.1s)\n  ✓ smoke › search note (1.9s)\n  ✓ smoke › reload keeps draft (3.0s)\n\n  4 passed (8.2s)\n",
      "e2e-smoke.stderr.log": "",
    },
  });
  const a1012 = await writeAssignment("NOTE-101", 2);
  await writeVerification("NOTE-101", 2, a1012, {
    status: "pass",
    createdAt: "2026-10-03T14:05:47.000Z",
    card: cards["NOTE-101"],
    fingerprint: "5eed1e55a9b8c7d6e5f4a3b2c1d0e9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c3d2",
    gates: [["unit", true, "pass", 0, 3984], ["lint", true, "pass", 0, 1790], ["e2e-smoke", false, "fail", 1, 16004]],
    logs: {
      "unit.stdout.log": "TAP version 13\n# drafts store\nok 1 - saves a draft on blur\nok 2 - restores the last draft after reload\nok 3 - debounces saves to 2 s\n1..3\n# tests 3\n# pass  3\n# fail  0\n",
      "unit.stderr.log": "",
      "lint.stdout.log": "> lumen-notes@0.9.0 lint\n> eslint src test\n\n✔ No problems found.\n",
      "lint.stderr.log": "",
      "e2e-smoke.stdout.log": "Running 4 tests using 2 workers\n  ✓ smoke › open app (1.1s)\n  ✓ smoke › create note (2.0s)\n  ✘ smoke › search note (5.0s)\n  ✓ smoke › reload keeps draft (2.8s)\n\n  1 failed, 3 passed (10.9s)\n",
      "e2e-smoke.stderr.log": "Error: Timed out 5000ms waiting for locator('[data-test=search-result]')\n  <script>alert('artifact text is never executed')</script>\n",
    },
  });
  await put(path.join(control, ".loop/evidence/NOTE-101/attempt-002/review-report.md"), `# Review — NOTE-101, attempt 2

**Recommendation:** approve

## Findings
1. Draft restore now reads from \`localStorage\` before first paint — fixes the
   attempt 1 failure (\`restores the last draft after reload\`).
2. The optional \`e2e-smoke\` gate failed on a search timeout unrelated to
   drafts; tracked separately.

## Evidence
- \`.loop/evidence/NOTE-101/attempt-002/verification.json\`
- Diff reviewed in \`triad/note-101\`

> Reviewer note: see [the design doc](https://example.invalid/design) for the
> storage key format.
`);
  await putJson(path.join(control, "artifacts/evaluator-plus/NOTE-101.json"), {
    schema_version: 1,
    feature_id: "NOTE-101",
    candidate_fingerprint: "5eed1e55a9b8c7d6e5f4a3b2c1d0e9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c3d2",
    verdict: "PASS",
    summary: "Drafts survive reload and tab crash in a fresh profile.",
    evidence_refs: [".loop/evidence/NOTE-101/attempt-002/verification.json"],
    created_at: "2026-10-03T15:20:00.000Z",
  });
  await putJson(path.join(control, ".loop/runtime/deterministic-control-run.json"), {
    status: "done",
    trace: [
      { at: Date.parse("2026-10-03T13:58:00.000Z"), phase: "ready", action: "dispatch_developer", reason: "card is ready and dependencies are satisfied" },
      { at: Date.parse("2026-10-03T14:05:30.000Z"), phase: "developer_complete", action: "run_verifier", reason: "developer reported completion" },
      { at: Date.parse("2026-10-03T14:05:48.000Z"), phase: "verifier_result", action: "dispatch_reviewer", reason: "verifier passed" },
      { at: Date.parse("2026-10-03T14:31:02.000Z"), phase: "reviewer_result", action: "commit_approved_card", reason: "reviewer approved" },
    ],
    packet: { path: ".loop/runtime/assignments/NOTE-101-attempt-002.md", metadata: { feature_id: "NOTE-101", mandatory_skills: [] } },
    reviewer: { decision: "approved", summary: "Restore path fixed; optional smoke failure is unrelated.", findings: ["e2e-smoke search timeout is pre-existing"] },
    timings: { started: Date.parse("2026-10-03T13:58:00.000Z"), ended: Date.parse("2026-10-03T14:31:05.000Z") },
  });

  // NOTE-102: passing verification, but the card changed afterwards.
  const a1021 = await writeAssignment("NOTE-102", 1);
  await writeVerification("NOTE-102", 1, a1021, {
    status: "pass",
    createdAt: "2026-10-05T11:12:09.000Z",
    card: "# NOTE-102 — Keyboard shortcuts for note search\n\n## Acceptance criteria\n- `/` focuses search.\n",
    fingerprint: "a11ce0ffa9b8c7d6e5f4a3b2c1d0e9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c3d2",
    gates: [["unit", true, "pass", 0, 2011], ["lint", true, "pass", 0, 1650]],
    logs: {
      "unit.stdout.log": "ok 1 - slash focuses search\nok 2 - escape clears search\n1..2\n",
      "unit.stderr.log": "",
      "lint.stdout.log": "✔ No problems found.\n",
      "lint.stderr.log": "",
    },
  });
  await put(path.join(control, ".loop/reviews/NOTE-102-review.md"), "# Review — NOTE-102\n\nIn progress. Waiting for the updated acceptance criteria (`Esc` behaviour).\n");

  // NOTE-103: assignment issued, no verifier evidence yet.
  await writeAssignment("NOTE-103", 1);

  // NOTE-104: verifier could not establish context.
  const a1041 = await writeAssignment("NOTE-104", 1, { packet: false });
  await writeVerification("NOTE-104", 1, a1041, {
    status: "invalid_context",
    createdAt: "2026-10-06T08:02:55.000Z",
    card: cards["NOTE-104"],
    fingerprint: null,
    gates: [],
    logs: {},
    failure: { code: "verification_context_invalid", reason: "assigned worktree is on an unexpected branch" },
  });
  await putJson(path.join(control, "artifacts/evaluator-plus/NOTE-104.json"), { feature_id: "NOTE-104", verdict: "PASS" });

  // Diagnostics: evidence that violates the contract, and an unmatched Evaluator+ file.
  await putJson(path.join(control, ".loop/evidence/NOTE-199/attempt-001/verification.json"), { feature_id: "NOTE-199", status: "pass" });
  await putJson(path.join(control, "artifacts/evaluator-plus/release-candidate.json"), {
    schema_version: 1, feature_id: "NOTE-101+NOTE-102", candidate_fingerprint: "rc", verdict: "INDETERMINATE", summary: "Combined check", evidence_refs: [], created_at: "2026-10-06T10:00:00.000Z",
  });

  // A second project in the projects/<id> layout.
  const mobile = path.join(control, "projects/mobile-shell");
  await put(path.join(mobile, ".loop/work-queue.yaml"), `items:
  - id: MOB-1
    title: Wrap the web app in a native shell
    state: ready
    attempts: 0
  - id: MOB-2
    title: Offline splash screen
    state: draft
`);

  return control;
}
