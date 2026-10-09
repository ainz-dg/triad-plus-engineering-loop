import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, lstat, symlink, writeFile } from "node:fs/promises";
import http from "node:http";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildInstallationManifest } from "../runtime/lib/installation-manifest.mjs";
import { qualityBaselineFingerprint } from "../runtime/lib/quality-baseline.mjs";

const repositoryRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

// Record any child process the Cockpit might start. Builtin ESM named exports
// are re-synchronized so modules imported afterwards see the recorder.
const spawned = [];
for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) {
  const original = childProcess[name];
  childProcess[name] = (...args) => {
    spawned.push(name);
    return original(...args);
  };
}
syncBuiltinESMExports();
const { startCockpitServer } = await import("../cockpit/server/server.mjs");
const { APP_CSP, loadStaticAssets } = await import("../cockpit/server/static.mjs");

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

async function put(file, content) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content, "utf8");
  return content;
}

const putJson = (file, value) => put(file, `${JSON.stringify(value, null, 2)}\n`);

// ---------------------------------------------------------------------------
// Fixture: a declared, synthetic control workspace mirroring v1.15 artifacts.

const root = await mkdtemp(path.join(tmpdir(), "triad-cockpit-"));
const control = path.join(root, "control");
const outside = path.join(root, "outside");
const secret = "TOP-SECRET-OUTSIDE-CONTROL";
await put(path.join(outside, "secret.txt"), `${secret}\n`);
await put(path.join(control, ".env"), `API_KEY=${secret}\n`);
await put(path.join(control, "AGENTS.md"), `# Instructions ${secret}\n`);
await put(path.join(control, ".git", "config"), `[core] ${secret}\n`);

await putJson(path.join(control, ".triad-plus", "installation.json"), buildInstallationManifest({
  triadVersion: "1.15.0",
  adapter: "opencode",
  installedAt: "2026-10-01T10:00:00.000Z",
}));
await putJson(path.join(control, ".triad-plus", "team.json"), {
  schema_version: 1,
  interaction: { language: "English", owner_name: "Owner", communication_style: "concise" },
  roles: {
    orchestrator: { displayName: "Sebas", persona: "calm", model: null, reasoning_effort: null, enabled: true },
    developer: { displayName: "Solution", persona: "precise", model: "model-a", reasoning_effort: "max", enabled: true },
    reviewer: { displayName: "Yuri", persona: "strict", model: null, reasoning_effort: null, enabled: true },
    evaluator: { displayName: "Lupusregina", persona: "blind", model: null, reasoning_effort: null, enabled: false },
  },
});

await put(path.join(control, ".loop", "work-queue.yaml"), `version: 2
policy:
  require_reviewer_approval: true

items:
  - id: 1.1
    title: "Greeting utility"   # quoted title
    card: features/1.1.md
    depends_on: []
    state: approved
    required_gates: [npm-test, diff-check]
    attempts: 1
  - id: 1.2
    title: Farewell utility
    card: features/1.2.md
    depends_on:
      - 1.1
    state: in_review
    attempts: 2
  - id: 1.3
    title: Not started
    state: draft
    owner:
      name: nested-mapping-not-supported
  - id: 11.1
    title: Sibling ID that contains "1.1" as a substring
    state: draft
`);
await put(path.join(control, ".loop", "run-state.yaml"), "version: 1\nproject_decision: running\n");
const prd = await put(path.join(control, "artifacts", "prd.md"), "# PRD\n");
const gates = await put(path.join(control, ".loop", "quality-gates.yaml"), "gates:\n  - id: npm-test\n    command: npm test\n");
const card11 = await put(path.join(control, "features", "1.1.md"), "# 1.1\n");
const card12Original = "# 1.2 original\n";
await put(path.join(control, "features", "1.2.md"), "# 1.2 edited after verification\n");

function assignment(feature, attempt, extra = {}) {
  return {
    schema_version: 1,
    assignment_id: `${feature}-a${attempt}`,
    status: "active",
    agent_id: "triad-developer",
    agent_type: "triad_developer",
    feature_id: feature,
    attempt,
    expected_branch: "feature",
    prd_path: "artifacts/prd.md",
    card_path: `features/${feature}.md`,
    gates_path: ".loop/quality-gates.yaml",
    required_gate_ids: ["npm-test"],
    ...extra,
  };
}

// Packet for 1.1 attempt 1, in the exact shape the Core validator parses.
const packetPath = ".loop/runtime/assignments/1.1-attempt-001.md";
const packet = [
  "<!-- triad-plus-assignment-packet:start -->",
  "# Triad+ Assignment Packet",
  "",
  "```json",
  JSON.stringify({ assignment_id: "1.1-a1", feature_id: "1.1", attempt: 1, branch: "feature", packet_path: packetPath, required_gate_ids: ["npm-test"], mandatory_skills: [] }, null, 2),
  "```",
  "<!-- triad-plus-assignment-packet:end -->",
  "",
].join("\n");
await put(path.join(control, packetPath), packet);
const a11 = await putJson(path.join(control, ".loop/runtime/assignments/1.1-attempt-1.json"), assignment("1.1", 1, {
  assignment_packet_path: packetPath,
  assignment_packet_sha256: sha256(packet),
}));
const a121 = await putJson(path.join(control, ".loop/runtime/assignments/1.2-attempt-1.json"), assignment("1.2", 1, {
  assignment_packet_path: ".loop/runtime/assignments/1.2-attempt-001.md",
  assignment_packet_sha256: "0".repeat(64),
}));
const a122 = await putJson(path.join(control, ".loop/runtime/assignments/1.2-attempt-2.json"), assignment("1.2", 2));
await put(path.join(control, ".loop/runtime/assignments/broken.json"), "{ not json");

function verification(feature, attempt, assignmentText, status, createdAt, cardText, fingerprint, extraBaseline = {}) {
  return {
    schema_version: 1,
    run_id: `run-${feature}-${attempt}`,
    feature_id: feature,
    attempt,
    assignment_id: `${feature}-a${attempt}`,
    assignment_sha256: sha256(assignmentText),
    assignment_ref: `.loop/runtime/assignments/${feature}-attempt-${attempt}.json`,
    trigger: { event: "SubagentStop", agent_id: "triad-developer", agent_type: "triad_developer" },
    baseline: { prd_sha256: sha256(prd), card_sha256: sha256(cardText), gates_sha256: sha256(gates), git_head: "abc", candidate_fingerprint: fingerprint, branch: "feature", ...extraBaseline },
    scope: { status: "not_configured" },
    gates: [{ id: "npm-test", required: true, status: status === "pass" ? "pass" : "fail", exit_code: status === "pass" ? 0 : 1, duration_ms: 12, stdout_ref: "logs/npm-test.stdout.log", stderr_ref: "logs/npm-test.stderr.log", output_truncated: false }],
    required_gates_passed: status === "pass",
    status,
    failure: null,
    created_at: createdAt,
  };
}

const evidence11 = path.join(control, ".loop/evidence/1.1/attempt-001");
await putJson(path.join(evidence11, "verification.json"), verification("1.1", 1, a11, "pass", "2026-10-02T10:00:00.000Z", card11, "fp-11"));
const log11 = await put(path.join(evidence11, "logs/npm-test.stdout.log"), "ok 1 - greeting\n");
await put(path.join(evidence11, "logs/npm-test.stderr.log"), "");
await symlink(path.join(outside, "secret.txt"), path.join(evidence11, "logs/leak.log"));
await symlink(outside, path.join(control, "features", "escape"));

await putJson(path.join(control, ".loop/evidence/1.2/attempt-001/verification.json"), verification("1.2", 1, a121, "fail", "2026-10-03T10:00:00.000Z", card12Original, "fp-121"));
await putJson(path.join(control, ".loop/evidence/1.2/attempt-002/verification.json"), verification("1.2", 2, a122, "pass", "2026-10-04T10:00:00.000Z", card12Original, "fp-122"));
await put(path.join(control, ".loop/evidence/1.2/attempt-002/review-report.md"), "# Review\n");
await put(path.join(control, ".loop/evidence/1.4/attempt-001/verification.json"), "{ truncated");
await put(path.join(control, ".loop/reviews/1.2-review.md"), "# Reviewer notes\n");

// F2 regression: evidence that does not satisfy the shipped contract.
await putJson(path.join(control, ".loop/evidence/1.5/attempt-001/verification.json"), { feature_id: "1.5", status: "pass" });
await putJson(path.join(control, ".loop/evidence/1.6/attempt-001/verification.json"), {
  ...verification("1.6", 1, "{}", "pass", "2026-10-02T10:00:00.000Z", card11, "fp-16"),
  required_gates_passed: false,
});

// F3: review documents for 1.1 and its substring sibling 11.1.
for (const name of ["1.1-review.md", "11.1-review.md", "1.10-notes.md", "1.1.2-draft.md", "1.1-vs-11.1.md"]) {
  await put(path.join(control, ".loop/reviews", name), `# ${name}\n`);
}
await put(path.join(control, "card-reports/1.1.md"), "# Card report 1.1\n");

// F1: Evaluator+ under a Quality Contract.
const qualityManifest = {
  schema_version: 1,
  id: "QB-1",
  revision: 1,
  sources: [{ id: "prd", role: "intent", path: "artifacts/prd.md", sha256: sha256(prd) }],
  criteria: [
    { id: "PQ-1", scope: "product_quality", requirement: "greets correctly" },
    { id: "DC-1", scope: "delivery_closure", requirement: "demo recorded" },
  ],
};
qualityManifest.fingerprint = qualityBaselineFingerprint(qualityManifest);
await putJson(path.join(control, ".loop/quality-baseline.json"), qualityManifest);
await put(path.join(control, ".loop/quality-baseline-broken.json"), "{ not json");
const qbf = qualityManifest.fingerprint;
const contractBinding = (manifestPath, expected = qbf) => ({ quality_baseline_path: manifestPath, expected_quality_baseline_fingerprint: expected });
const legacyEvaluation = (feature, fingerprint) => ({ schema_version: 1, feature_id: feature, candidate_fingerprint: fingerprint, verdict: "PASS", summary: "checked", evidence_refs: [], created_at: "2026-10-06T10:00:00.000Z" });
const contractEvaluation = (feature, fingerprint) => ({
  schema_version: 1,
  feature_id: feature,
  candidate_fingerprint: fingerprint,
  quality_baseline_fingerprint: qbf,
  verdict: "PASS",
  summary: "product quality met",
  evidence_refs: [],
  criteria: [{ id: "PQ-1", scope: "product_quality", verdict: "PASS", summary: "ok", evidence_refs: [] }],
  created_at: "2026-10-06T10:00:00.000Z",
});
for (const card of ["2.1", "2.2", "2.3", "2.4", "2.5"]) await put(path.join(control, "features", `${card}.md`), `# ${card}\n`);
const a21 = await putJson(path.join(control, ".loop/runtime/assignments/2.1-attempt-1.json"), assignment("2.1", 1, contractBinding(".loop/quality-baseline.json")));
await putJson(path.join(control, ".loop/evidence/2.1/attempt-001/verification.json"), verification("2.1", 1, a21, "pass", "2026-10-06T09:00:00.000Z", "# 2.1\n", "fp-21", { quality_baseline_fingerprint: qbf }));
await putJson(path.join(control, "artifacts/evaluator-plus/2.1-good.json"), contractEvaluation("2.1", "fp-21"));
await putJson(path.join(control, "artifacts/evaluator-plus/2.1-wrong-candidate.json"), contractEvaluation("2.1", "fp-other"));
await putJson(path.join(control, ".loop/runtime/assignments/2.2-attempt-1.json"), assignment("2.2", 1, contractBinding(".loop/quality-baseline-absent.json")));
await putJson(path.join(control, "artifacts/evaluator-plus/2.2.json"), legacyEvaluation("2.2", "fp-22"));
await putJson(path.join(control, ".loop/runtime/assignments/2.3-attempt-1.json"), assignment("2.3", 1, contractBinding(".loop/quality-baseline-broken.json")));
await putJson(path.join(control, "artifacts/evaluator-plus/2.3.json"), legacyEvaluation("2.3", "fp-23"));
const a24 = await putJson(path.join(control, ".loop/runtime/assignments/2.4-attempt-1.json"), assignment("2.4", 1));
await putJson(path.join(control, ".loop/evidence/2.4/attempt-001/verification.json"), verification("2.4", 1, a24, "pass", "2026-10-06T09:00:00.000Z", "# 2.4\n", "fp-24", { quality_baseline_fingerprint: qbf }));
await putJson(path.join(control, "artifacts/evaluator-plus/2.4.json"), legacyEvaluation("2.4", "fp-24"));
await putJson(path.join(control, ".loop/runtime/assignments/2.5-attempt-1.json"), assignment("2.5", 1, contractBinding(".loop/quality-baseline.json", "f".repeat(64))));
await putJson(path.join(control, "artifacts/evaluator-plus/2.5.json"), contractEvaluation("2.5", "fp-25"));

const evaluation = (feature, fingerprint, verdict = "PASS") => ({ schema_version: 1, feature_id: feature, candidate_fingerprint: fingerprint, verdict, summary: "checked", evidence_refs: [], created_at: "2026-10-05T10:00:00.000Z" });
await putJson(path.join(control, "artifacts/evaluator-plus/1.1.json"), evaluation("1.1", "fp-11"));
await putJson(path.join(control, "artifacts/evaluator-plus/1.2-bad.json"), evaluation("1.2", "fp-122", "MAYBE"));
await putJson(path.join(control, "artifacts/evaluator-plus/combined.json"), evaluation("1.1+1.2", "fp-x"));

await putJson(path.join(control, ".loop/runtime/deterministic-control-run.json"), {
  status: "done",
  trace: [{ at: Date.parse("2026-10-02T09:00:00.000Z"), phase: "ready", action: "dispatch_developer", reason: "ready card" }],
  packet: { path: packetPath, metadata: { feature_id: "1.1", mandatory_skills: [] } },
  reviewer: { decision: "approved", summary: "looks good" },
  timings: { started: 1, ended: 2 },
});

await put(path.join(control, "projects/alpha/.loop/work-queue.yaml"), "items:\n  - id: A-1\n    state: ready\n");

// ---------------------------------------------------------------------------
// Snapshot the whole fixture (control + outside) to prove nothing is written.

async function snapshot(directory) {
  const entries = [];
  async function walk(current) {
    for (const name of (await readdir(current)).sort()) {
      const target = path.join(current, name);
      const info = await lstat(target);
      if (info.isSymbolicLink()) entries.push(`${target} link ${info.mtimeMs}`);
      else if (info.isDirectory()) { entries.push(`${target} dir ${info.mtimeMs}`); await walk(target); }
      else entries.push(`${target} ${info.size} ${info.mtimeMs} ${sha256(await readFile(target))}`);
    }
  }
  await walk(directory);
  return entries.join("\n");
}
const before = await snapshot(root);

// ---------------------------------------------------------------------------
// Server

// A synthetic UI build, so static serving is tested independently of Vite.
const uiDist = await mkdtemp(path.join(tmpdir(), "triad-cockpit-dist-"));
const indexHtml = '<!doctype html><html><head><script src="/theme-init.js"></script></head><body><div id="root"></div><script type="module" src="/assets/index-AbCdEf12.js"></script></body></html>\n';
await put(path.join(uiDist, "index.html"), indexHtml);
const appJs = await put(path.join(uiDist, "assets/index-AbCdEf12.js"), "console.log('cockpit');\n");
await put(path.join(uiDist, "assets/style-AbCdEf12.css"), "body{}\n");
await put(path.join(uiDist, "theme-init.js"), "/* theme */\n");
await put(path.join(uiDist, "assets/index-AbCdEf12.js.map"), "{}\n");
await put(path.join(uiDist, ".hidden.js"), "hidden\n");
await symlink(path.join(outside, "secret.txt"), path.join(uiDist, "assets/linked-AbCdEf12.js"));
const staticAssets = loadStaticAssets(uiDist);

const logs = [];
await assert.rejects(startCockpitServer({ controlRoot: control, host: "0.0.0.0" }), /binds only to 127\.0\.0\.1/);
const cockpit = await startCockpitServer({ controlRoot: control, log: (entry) => logs.push(entry), staticAssets });
assert.equal(cockpit.address, "127.0.0.1");
const bodies = [];

function request(target, { method = "GET", headers = {}, auth = true } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1",
      port: cockpit.port,
      path: target,
      method,
      headers: { ...(auth ? { authorization: `Bearer ${cockpit.token}` } : {}), ...headers },
    }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { text += chunk; });
      res.on("end", () => {
        bodies.push(text);
        let body = null;
        try { body = text ? JSON.parse(text) : null; } catch {}
        resolve({ status: res.statusCode, headers: res.headers, body });
      });
    });
    req.on("error", reject);
    req.end();
  });
}

try {
  // Workspace overview from code-written and Core-validated artifacts.
  const workspace = await request("/api/workspace");
  assert.equal(workspace.status, 200);
  assert.equal(workspace.headers["content-type"], "application/json; charset=utf-8");
  assert.equal(workspace.headers["x-content-type-options"], "nosniff");
  assert.equal(workspace.headers["access-control-allow-origin"], undefined);
  assert.equal(workspace.body.installation.status, "valid");
  assert.equal(workspace.body.installation.adapter, "opencode");
  assert.equal(workspace.body.installation.provenance, "code-written");
  assert.equal(workspace.body.team.status, "valid");
  assert.equal(workspace.body.team.provenance, "code-validated");
  assert.deepEqual(workspace.body.team.roles.map((role) => role.display_name), ["Sebas", "Solution", "Yuri", "Lupusregina"]);
  assert.deepEqual(workspace.body.projects.map((project) => project.id), ["root", "alpha"]);

  // Card list: queue declarations plus code-written evidence, kept separate.
  const cards = await request("/api/projects/root/cards");
  assert.equal(cards.status, 200);
  assert.deepEqual(cards.body.cards.map((card) => card.id), ["1.1", "1.2", "1.3", "2.1", "2.2", "2.3", "2.4", "2.5", "11.1"]);
  const listed = Object.fromEntries(cards.body.cards.map((card) => [card.id, card]));
  assert.equal(listed["1.1"].declared.state, "approved");
  assert.equal(listed["1.1"].declared.provenance, "agent-declared");
  assert.equal(listed["1.1"].declared.title, "Greeting utility");
  assert.equal(listed["1.1"].declared.attempts, 1);
  assert.deepEqual(listed["1.2"].declared.depends_on, ["1.1"]);
  assert.equal(listed["1.2"].observed.latest_verification.status, "pass");
  assert.deepEqual(listed["1.2"].observed.attempt_numbers, [1, 2]);
  assert.equal(listed["1.3"].observed.verification_count, 0);
  assert.equal(listed["1.3"].observed.latest_verification, null);
  // The nested `owner` mapping is dropped and named, never reported as null.
  assert.equal(cards.body.work_queue.status, "partial");
  assert.deepEqual(listed["1.3"].declared.unsupported_keys, ["owner"]);
  assert.equal(Object.hasOwn(listed["1.3"].declared, "owner"), false);
  assert.equal(listed["1.3"].declared.depends_on, null, "an absent list is null, not an invented []");
  assert.ok(cards.body.work_queue.warnings.some((warning) => warning.includes("key owner not read")));
  assert.deepEqual(cards.body.unmatched_evaluations.map((entry) => entry.feature_id), ["1.1+1.2"]);
  const diagnosticSources = cards.body.diagnostics.map((entry) => entry.source);
  assert.ok(diagnosticSources.includes(".loop/runtime/assignments/broken.json"), "invalid assignment is reported");
  assert.ok(diagnosticSources.includes(".loop/evidence/1.4/attempt-001/verification.json"), "invalid evidence is reported");

  // F2: evidence violating the shipped contract never counts as evidence.
  for (const [card, why] of [["1.5", /evidence\.schema_version is required/], ["1.6", /status is pass but required_gates_passed is not true/]]) {
    assert.ok(!cards.body.cards.some((entry) => entry.id === card), `${card} must not become a card from invalid evidence`);
    const diagnostic = cards.body.diagnostics.find((entry) => entry.source === `.loop/evidence/${card}/attempt-001/verification.json`);
    assert.ok(diagnostic, `${card} evidence must be reported`);
    assert.match(diagnostic.problem, /violates the Triad\+ contract/);
    assert.match(diagnostic.problem, why);
  }
  assert.equal((await request("/api/projects/root/cards/1.5")).status, 404);

  // Card 1.1: valid packet, current evidence, validated evaluator and reviewer.
  const card11View = (await request("/api/projects/root/cards/1.1")).body;
  const attempt11 = card11View.attempts[0];
  assert.equal(attempt11.assignments[0].packet.status, "valid");
  assert.equal(attempt11.assignments[0].declared_status, "active");
  const verification11 = attempt11.verifications[0];
  assert.equal(verification11.status, "pass");
  assert.equal(verification11.provenance, "code-written");
  // Bindings, recency, and the candidate are separate; the candidate is never
  // claimed checked and no single "current" verdict exists.
  assert.equal(verification11.freshness.control_bindings.status, "unchanged");
  assert.ok(verification11.freshness.control_bindings.checks.every((check) => check.result === "match"));
  assert.equal(verification11.freshness.recency.status, "latest_for_card");
  assert.equal(verification11.freshness.candidate.status, "not_checked");
  assert.equal(verification11.freshness.candidate.recorded_fingerprint, "fp-11");
  assert.equal(Object.hasOwn(verification11.freshness, "status"), false);
  assert.ok(!JSON.stringify(card11View).includes('"current"'));
  assert.equal(verification11.gates[0].stdout_log, ".loop/evidence/1.1/attempt-001/logs/npm-test.stdout.log");
  assert.equal(card11View.evaluations[0].status, "valid");
  assert.equal(card11View.evaluations[0].candidate_binding.result, "same_as_latest_pass_record");
  assert.equal(card11View.control_run.status, "done");
  assert.equal(card11View.control_run.reviewer.status, "valid");
  assert.equal(card11View.control_run.reviewer.decision, "approved");
  assert.equal(card11View.control_run.trace[0].at, "2026-10-02T09:00:00.000Z");

  // Card 1.2: superseded failure, stale pass (card edited), invalid packet and evaluator.
  const card12View = (await request("/api/projects/root/cards/1.2")).body;
  const [attempt121, attempt122] = card12View.attempts;
  assert.equal(attempt121.verifications[0].status, "fail");
  assert.equal(attempt121.verifications[0].freshness.control_bindings.status, "changed");
  assert.equal(attempt121.verifications[0].freshness.recency.status, "superseded");
  assert.equal(attempt121.assignments[0].packet.status, "missing");
  assert.equal(attempt122.verifications[0].freshness.control_bindings.status, "changed");
  assert.equal(attempt122.verifications[0].freshness.recency.status, "latest_for_card");
  assert.deepEqual(attempt122.verifications[0].freshness.control_bindings.checks.find((check) => check.check === "card_sha256"), { check: "card_sha256", result: "mismatch" });
  assert.deepEqual(attempt122.documents.map((document) => document.source), [".loop/evidence/1.2/attempt-002/review-report.md"]);
  assert.equal(card12View.evaluations[0].status, "invalid");
  assert.equal(card12View.evaluations[0].provenance, "agent-declared");
  assert.deepEqual(card12View.reviewer.documents.map((document) => document.source), [".loop/reviews/1.2-review.md"]);

  // F3: documents are attributed by whole-token ID match to exactly one card.
  assert.deepEqual(card11View.reviewer.documents.map((document) => document.source), [".loop/reviews/1.1-review.md", "card-reports/1.1.md"]);
  const card111View = (await request("/api/projects/root/cards/11.1")).body;
  assert.deepEqual(card111View.reviewer.documents.map((document) => document.source), [".loop/reviews/11.1-review.md"]);
  for (const view of [card11View, card111View]) {
    assert.deepEqual(view.reviewer.ambiguous_documents.map((document) => [document.source, document.matches]), [[".loop/reviews/1.1-vs-11.1.md", ["1.1", "11.1"]]]);
  }
  const attributed = [card11View, card111View, card12View].flatMap((view) => view.reviewer.documents.map((document) => document.source));
  assert.ok(!attributed.some((source) => /1\.10-notes|1\.1\.2-draft/.test(source)), "1.10 and 1.1.2 documents belong to no known card");

  // F1: Evaluator+ under a Quality Contract.
  const card21View = (await request("/api/projects/root/cards/2.1")).body;
  const [good, wrong] = card21View.evaluations;
  assert.equal(good.source, "artifacts/evaluator-plus/2.1-good.json");
  assert.equal(good.status, "valid", "a correct contract result must validate once the candidate binding is supplied");
  assert.equal(good.provenance, "code-validated");
  assert.equal(good.validation.contract, "quality_contract");
  assert.equal(good.validation.quality_baseline.fingerprint, qbf);
  assert.deepEqual(good.validation.expected_candidate_fingerprint, { value: "fp-21", source: ".loop/evidence/2.1/attempt-001/verification.json", provenance: "code-written" });
  assert.equal(wrong.status, "invalid");
  assert.equal(wrong.error_code, "evaluator_candidate_fingerprint_mismatch");
  for (const [card, reason] of [
    ["2.2", "quality_baseline_missing"],
    ["2.3", "quality_baseline_unreadable"],
    ["2.4", "quality_contract_binding_missing"],
    ["2.5", "quality_baseline_drift"],
  ]) {
    const [view] = (await request(`/api/projects/root/cards/${card}`)).body.evaluations;
    assert.equal(view.status, "not_validated", `${card}: must not validate (and must not fall back to legacy)`);
    assert.equal(view.provenance, "agent-declared");
    assert.equal(view.validation.contract, "quality_contract");
    assert.equal(view.validation.reason, reason, card);
  }
  // Without any contract signal, the legacy contract still applies explicitly.
  assert.equal(card11View.evaluations[0].validation.contract, "legacy");
  assert.equal(card12View.control_run, null);

  // Missing resources.
  assert.equal((await request("/api/projects/root/cards/9.9")).status, 404);
  assert.equal((await request("/api/projects/nope/cards")).status, 404);
  assert.equal((await request("/api/projects/alpha/control-run")).status, 404);
  assert.equal((await request("/api/projects/root/control-run")).body.status, "done");
  assert.equal((await request("/api/projects/alpha/cards")).body.cards[0].id, "A-1");

  // Allowlisted file reads match the bytes on disk.
  const log = await request(`/api/projects/root/files?path=${encodeURIComponent(".loop/evidence/1.1/attempt-001/logs/npm-test.stdout.log")}`);
  assert.equal(log.status, 200);
  assert.equal(log.body.content, log11);
  assert.equal(log.body.sha256, sha256(log11));
  assert.equal(log.body.provenance, "code-written");
  assert.equal((await request(`/api/projects/root/files?path=.loop/run-state.yaml`)).body.content, "version: 1\nproject_decision: running\n");
  assert.equal((await request(`/api/projects/root/files?path=.loop/absent.json`)).status, 404);
  assert.equal((await request(`/api/projects/root/files`)).status, 400);

  // Traversal, symlink escape, and non-allowlisted files are refused.
  for (const target of [
    "../outside/secret.txt",
    ".loop/../../outside/secret.txt",
    "%2e%2e/outside/secret.txt",
    "/etc/passwd",
    path.join(outside, "secret.txt"),
    ".loop\\..\\..\\outside\\secret.txt",
    ".loop/evidence/1.1/attempt-001/logs/leak.log",
    "features/escape/secret.txt",
    ".env",
    "AGENTS.md",
    ".git/config",
    ".triad-runtime/triad-verify.mjs",
    "raw:.loop/x%00y",
  ]) {
    // `raw:` targets are already percent-encoded and sent unchanged.
    const query = target.startsWith("raw:") ? target.slice(4) : target.startsWith("%") ? target : encodeURIComponent(target);
    const response = await request(`/api/projects/root/files?path=${query}`);
    assert.equal(response.status, 403, `${target} must be refused`);
  }
  assert.equal((await request(`/api/projects/..%2F..%2Foutside/cards`)).status, 404);

  // Authentication and session.
  assert.equal((await request("/api/workspace", { auth: false })).status, 401);
  assert.equal((await request("/api/workspace", { auth: false, headers: { authorization: "Bearer wrong" } })).status, 401);
  // The launch URL carries only a one-time code, never the session secret.
  const launch = new URL(cockpit.sessionUrl);
  const loginCode = launch.searchParams.get("code");
  assert.equal(launch.pathname, "/api/session");
  assert.deepEqual([...launch.searchParams.keys()], ["code"]);
  assert.ok(loginCode.length >= 64 && loginCode !== cockpit.token);
  assert.ok(!cockpit.sessionUrl.includes(cockpit.token), "the session secret never appears in a URL");
  // The session secret is not accepted as a login code, and wrong codes fail.
  assert.equal((await request(`/api/session?token=${cockpit.token}`, { auth: false })).status, 401);
  assert.equal((await request(`/api/session?code=${cockpit.token}`, { auth: false })).status, 401);
  assert.equal((await request("/api/session?code=wrong", { auth: false })).status, 401);

  const session = await request(`/api/session?code=${loginCode}`, { auth: false });
  // 303 to a fixed, query-free location: the code leaves the address bar.
  assert.equal(session.status, 303);
  assert.equal(session.headers.location, "/");
  assert.equal(session.headers["referrer-policy"], "no-referrer");
  assert.equal(session.headers["cache-control"], "no-store");
  assert.equal(session.body, null, "the redirect has no body that could link elsewhere");
  const cookie = session.headers["set-cookie"][0];
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.ok(!cookie.includes(loginCode), "the cookie holds the session secret, not the code");
  const sessionCookie = cookie.split(";")[0];
  const landing = await request("/", { auth: false, headers: { cookie: sessionCookie } });
  assert.equal(landing.status, 200);
  assert.equal(landing.headers["referrer-policy"], "no-referrer");
  assert.equal((await request("/api/workspace", { auth: false, headers: { cookie: sessionCookie } })).status, 200);
  // Single use: a replayed launch URL (history, scrollback, screenshot) fails.
  assert.equal((await request(`/api/session?code=${loginCode}`, { auth: false })).status, 401);
  // The UI shell is public (it ships in the package and holds no workspace
  // data); every data route still requires the session.
  assert.equal((await request("/", { auth: false })).status, 200);
  for (const route of ["/api/workspace", "/api/projects/root/cards", "/api/projects/root/cards/1.1", "/api/projects/root/control-run", "/api/projects/root/files?path=.loop/run-state.yaml"]) {
    assert.equal((await request(route, { auth: false })).status, 401, `${route} must require the session`);
  }
  // Every response, including errors, forbids Referer leakage.
  assert.equal((await request("/api/projects/root/cards/9.9")).headers["referrer-policy"], "no-referrer");

  // DNS-rebinding style Host headers are refused even with a valid token.
  assert.equal((await request("/api/workspace", { headers: { host: "evil.example" } })).status, 403);
  assert.equal((await request("/api/workspace", { headers: { host: `localhost:${cockpit.port}` } })).status, 200);

  // Mutations are refused before routing or authentication.
  for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
    const response = await request("/api/workspace", { method });
    assert.equal(response.status, 405, `${method} must be refused`);
    assert.equal(response.headers.allow, "GET, HEAD");
  }
  assert.equal((await request("/api/projects/root/files?path=.loop/run-state.yaml", { method: "DELETE" })).status, 405);

  // Static UI: served from the in-memory table only, under the app CSP.
  const shell = await request("/", { auth: false });
  assert.equal(shell.headers["content-type"], "text/html; charset=utf-8");
  assert.equal(shell.headers["content-security-policy"], APP_CSP);
  assert.equal(shell.headers["cache-control"], "no-cache");
  assert.equal(shell.headers["x-frame-options"], "DENY");
  assert.equal(bodies.at(-1), indexHtml);
  for (const directive of ["default-src 'none'", "script-src 'self'", "style-src 'self'", "connect-src 'self'", "frame-ancestors 'none'", "base-uri 'none'", "form-action 'none'"]) {
    assert.ok(APP_CSP.split("; ").includes(directive), `CSP must include ${directive}`);
  }
  assert.ok(!/unsafe-inline|unsafe-eval|https?:|\*|data:|blob:/.test(APP_CSP), "CSP must not allow inline code, eval, or external origins");
  const script = await request("/assets/index-AbCdEf12.js", { auth: false });
  assert.equal(script.status, 200);
  assert.equal(script.headers["content-type"], "text/javascript; charset=utf-8");
  assert.equal(script.headers["cache-control"], "public, max-age=31536000, immutable");
  assert.equal(bodies.at(-1), appJs);
  assert.equal((await request("/assets/style-AbCdEf12.css", { auth: false })).headers["content-type"], "text/css; charset=utf-8");
  assert.equal((await request("/theme-init.js", { auth: false })).headers["cache-control"], "no-cache");
  assert.equal((await request("/index.html", { auth: false })).status, 200);
  assert.equal((await request("/", { auth: false, method: "HEAD" })).status, 200);
  assert.equal(bodies.at(-1), "", "HEAD has no body");
  // Unknown types, hidden files, symlinks, and anything outside the build are not served.
  for (const target of [
    "/assets/index-AbCdEf12.js.map",
    "/.hidden.js",
    "/assets/linked-AbCdEf12.js",
    "/assets/missing.js",
    "/package.json",
    "/%2e%2e/package.json",
    "/assets/..%2f..%2fpackage.json",
    "/../../../etc/passwd",
    "/assets/%2e%2e/%2e%2e/server/server.mjs",
    "/cockpit/server/server.mjs",
    "/control/.loop/run-state.yaml",
  ]) {
    const response = await request(target, { auth: false });
    assert.equal(response.status, 404, `${target} must not be served`);
    assert.equal(response.headers["content-type"], "application/json; charset=utf-8");
  }
  assert.equal((await request("/", { auth: false, method: "POST" })).status, 405, "static routes are read-only too");
  assert.equal((await request("/", { auth: false, headers: { host: "evil.example" } })).status, 403, "Host is checked for static routes too");

  // Non-root projects accept the control-relative `source` paths the API returns.
  assert.equal((await request(`/api/projects/alpha/files?path=${encodeURIComponent("projects/alpha/.loop/work-queue.yaml")}`)).status, 200);
  assert.equal((await request("/api/projects/alpha/files?path=.loop/work-queue.yaml")).status, 200);
  assert.equal((await request(`/api/projects/alpha/files?path=${encodeURIComponent("projects/alpha/../../control/.env")}`)).status, 403);
} finally {
  await cockpit.close();
}

// Without a UI build the API keeps working and the shell reports it plainly.
{
  const bare = await startCockpitServer({ controlRoot: control, staticAssets: { available: false, assets: new Map() } });
  try {
    assert.equal(bare.uiAvailable, false);
    const shell = await fetch(`http://127.0.0.1:${bare.port}/`);
    assert.equal(shell.status, 503);
    assert.equal((await shell.json()).error.code, "ui_not_built");
    const api = await fetch(`http://127.0.0.1:${bare.port}/api/workspace`, { headers: { authorization: `Bearer ${bare.token}` } });
    assert.equal(api.status, 200);
  } finally {
    await bare.close();
  }
}

// The real build, when present, contains no inline script or style and only
// references files that exist in it.
{
  const real = loadStaticAssets();
  if (real.available) {
    const html = real.assets.get("/").body.toString("utf8");
    assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(html), "index.html must not contain inline scripts");
    assert.ok(!/<style|\sstyle=/i.test(html), "index.html must not contain inline styles");
    for (const [, reference] of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
      assert.ok(real.assets.has(reference), `index.html references a missing asset: ${reference}`);
    }
  }
}

// No secret reached any response, no sensitive data reached the server log.
assert.ok(bodies.every((body) => !body.includes(secret)), "outside or excluded content must never be served");
const logText = JSON.stringify(logs);
assert.ok(!logText.includes(cockpit.token), "session secret must not be logged");
assert.ok(!logText.includes(new URL(cockpit.sessionUrl).searchParams.get("code")), "login code must not be logged");
assert.ok(logs.some((entry) => entry.route === "/api/session" && entry.status === 303), "the exchange itself is logged by route only");
assert.ok(!logText.includes("secret") && !logText.includes("?"), "paths and queries must not be logged");
assert.ok(logs.every((entry) => Object.keys(entry).sort().join() === "method,route,status"));
assert.ok(logs.every((entry) => entry.route === "static" || entry.route === "unmatched" || entry.route.startsWith("/api/")), "static requests are logged without their path");

// The control workspace (and its surroundings) is byte-for-byte unchanged.
assert.equal(await snapshot(root), before, "the Cockpit must not modify the filesystem");

// No child process was started by the Cockpit.
assert.deepEqual(spawned, [], "the Cockpit must not start processes");
for (const name of await readdir(path.join(repositoryRoot, "cockpit", "server"))) {
  const source = await readFile(path.join(repositoryRoot, "cockpit", "server", name), "utf8");
  // Method calls such as RegExp#exec are fine; bare process primitives are not.
  assert.ok(!/child_process|(?<![.\w])(spawn|spawnSync|exec|execSync|execFile|execFileSync|fork)\s*\(/.test(source), `${name} must not reference process execution`);
}

process.stdout.write("cockpit server tests passed\n");
