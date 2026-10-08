import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, lstat, symlink, writeFile } from "node:fs/promises";
import http from "node:http";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildInstallationManifest } from "../runtime/lib/installation-manifest.mjs";

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
const { parseWorkQueueItems } = await import("../cockpit/server/work-queue.mjs");

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

function verification(feature, attempt, assignmentText, status, createdAt, cardText, fingerprint) {
  return {
    schema_version: 1,
    run_id: `run-${feature}-${attempt}`,
    feature_id: feature,
    attempt,
    assignment_id: `${feature}-a${attempt}`,
    assignment_sha256: sha256(assignmentText),
    assignment_ref: `.loop/runtime/assignments/${feature}-attempt-${attempt}.json`,
    baseline: { prd_sha256: sha256(prd), card_sha256: sha256(cardText), gates_sha256: sha256(gates), git_head: "abc", candidate_fingerprint: fingerprint, branch: "feature" },
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

const logs = [];
await assert.rejects(startCockpitServer({ controlRoot: control, host: "0.0.0.0" }), /binds only to 127\.0\.0\.1/);
const cockpit = await startCockpitServer({ controlRoot: control, log: (entry) => logs.push(entry) });
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
  assert.deepEqual(cards.body.cards.map((card) => card.id), ["1.1", "1.2", "1.3"]);
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
  assert.ok(cards.body.work_queue.warnings.some((warning) => /nested/.test(warning)), "nested YAML is reported, not guessed");
  assert.deepEqual(cards.body.unmatched_evaluations.map((entry) => entry.feature_id), ["1.1+1.2"]);
  const diagnosticSources = cards.body.diagnostics.map((entry) => entry.source);
  assert.ok(diagnosticSources.includes(".loop/runtime/assignments/broken.json"), "invalid assignment is reported");
  assert.ok(diagnosticSources.includes(".loop/evidence/1.4/attempt-001/verification.json"), "invalid evidence is reported");

  // Card 1.1: valid packet, current evidence, validated evaluator and reviewer.
  const card11View = (await request("/api/projects/root/cards/1.1")).body;
  const attempt11 = card11View.attempts[0];
  assert.equal(attempt11.assignments[0].packet.status, "valid");
  assert.equal(attempt11.assignments[0].declared_status, "active");
  const verification11 = attempt11.verifications[0];
  assert.equal(verification11.status, "pass");
  assert.equal(verification11.provenance, "code-written");
  assert.equal(verification11.freshness.status, "current");
  assert.equal(verification11.gates[0].stdout_log, ".loop/evidence/1.1/attempt-001/logs/npm-test.stdout.log");
  assert.equal(card11View.evaluations[0].status, "valid");
  assert.equal(card11View.evaluations[0].candidate_binding.result, "matches_latest_pass");
  assert.equal(card11View.control_run.status, "done");
  assert.equal(card11View.control_run.reviewer.status, "valid");
  assert.equal(card11View.control_run.reviewer.decision, "approved");
  assert.equal(card11View.control_run.trace[0].at, "2026-10-02T09:00:00.000Z");

  // Card 1.2: superseded failure, stale pass (card edited), invalid packet and evaluator.
  const card12View = (await request("/api/projects/root/cards/1.2")).body;
  const [attempt121, attempt122] = card12View.attempts;
  assert.equal(attempt121.verifications[0].status, "fail");
  assert.equal(attempt121.verifications[0].freshness.status, "stale");
  assert.ok(attempt121.verifications[0].freshness.checks.some((check) => check.check === "newer_verification_for_card"));
  assert.equal(attempt121.assignments[0].packet.status, "missing");
  assert.equal(attempt122.verifications[0].freshness.status, "stale");
  assert.deepEqual(attempt122.verifications[0].freshness.checks.find((check) => check.check === "card_sha256"), { check: "card_sha256", result: "mismatch" });
  assert.deepEqual(attempt122.documents.map((document) => document.source), [".loop/evidence/1.2/attempt-002/review-report.md"]);
  assert.equal(card12View.evaluations[0].status, "invalid");
  assert.equal(card12View.evaluations[0].provenance, "agent-declared");
  assert.deepEqual(card12View.reviewer.documents.map((document) => document.source), [".loop/reviews/1.2-review.md"]);
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
  assert.equal((await request("/api/session?token=wrong", { auth: false })).status, 401);
  const session = await request(`/api/session?token=${cockpit.token}`, { auth: false });
  assert.equal(session.status, 200);
  const cookie = session.headers["set-cookie"][0];
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.equal((await request("/api/workspace", { auth: false, headers: { cookie: cookie.split(";")[0] } })).status, 200);

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
} finally {
  await cockpit.close();
}

// No secret reached any response, no sensitive data reached the server log.
assert.ok(bodies.every((body) => !body.includes(secret)), "outside or excluded content must never be served");
const logText = JSON.stringify(logs);
assert.ok(!logText.includes(cockpit.token), "token must not be logged");
assert.ok(!logText.includes("secret") && !logText.includes("?"), "paths and queries must not be logged");
assert.ok(logs.every((entry) => Object.keys(entry).sort().join() === "method,route,status"));

// The control workspace (and its surroundings) is byte-for-byte unchanged.
assert.equal(await snapshot(root), before, "the Cockpit must not modify the filesystem");

// No child process was started by the Cockpit.
assert.deepEqual(spawned, [], "the Cockpit must not start processes");
for (const name of await readdir(path.join(repositoryRoot, "cockpit", "server"))) {
  const source = await readFile(path.join(repositoryRoot, "cockpit", "server", name), "utf8");
  // Method calls such as RegExp#exec are fine; bare process primitives are not.
  assert.ok(!/child_process|(?<![.\w])(spawn|spawnSync|exec|execSync|execFile|execFileSync|fork)\s*\(/.test(source), `${name} must not reference process execution`);
}

// The work-queue reader keeps IDs as strings and stops at the next top-level key.
const parsed = parseWorkQueueItems("items:\n  - id: 1.10\n    attempts: 3\n    state: 'ready' # comment\nother:\n  - id: X\n");
assert.deepEqual(parsed.items.map((item) => [item.id, item.state, item.attempts]), [["1.10", "ready", "3"]]);
assert.deepEqual(parseWorkQueueItems("version: 2\n"), { items: [], warnings: ["no top-level items: list"] });

process.stdout.write("cockpit server tests passed\n");
