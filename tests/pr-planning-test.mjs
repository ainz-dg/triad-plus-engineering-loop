import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  approvePrPlan,
  buildPrPlan,
  createStructuralApproval,
  prepareDraftPullRequests,
  prGroupId,
  prPlanSha256,
  validatePlanApproval,
  validatePrPlan,
  validateStructuralApproval,
  validateSnapshotSources,
} from "../runtime/lib/pr-planning.mjs";
import { parseWorkQueueItems } from "../cockpit/server/work-queue.mjs";
import { calculateCandidateFingerprintAtCommit } from "../runtime/lib/fingerprint.mjs";

const QUEUE_SHA = "1".repeat(64);
const PROJECT_SHA = "2".repeat(64);
const BASE_SHA = "3".repeat(40);
const CANDIDATE = "4".repeat(64);
const EVIDENCE_SHA = "5".repeat(64);
const GITHUB_URL = "git@github.com:ainz-dg/triad-plus-engineering-loop.git";

function repository(id = "repo-a") {
  return {
    id,
    path: "/tmp/product-repository",
    worktree: "/tmp/default-worktree",
    base_branch: "main",
    base_commit: BASE_SHA,
    project_branch: "feature/project",
    remote: "origin",
    remote_url: GITHUB_URL,
  };
}

// Pre-run structural authorization remains valid as terminal evidence and
// final commits arrive, but requires a fresh owner decision for structural drift.
{
  const source = snapshot([
    card("CARD-1", { review_group: "left" }),
    card("CARD-2", { review_group: "right" }),
  ]);
  for (const entry of source.cards) {
    entry.source_path = "features/" + entry.id + ".md";
    entry.source_sha256 = createHash("sha256").update("canonical " + entry.id).digest("hex");
    source.source.files.push({ path: entry.source_path, sha256: entry.source_sha256 });
  }
  const preRunPlan = boundPlan(source, "review-friendly");
  const intent = createStructuralApproval(preRunPlan, source, { owner: "Ainz Ooal Gown", approvedAt: "2026-10-23T00:00:00.000Z" });
  assert.equal(validateStructuralApproval(intent, preRunPlan, source).valid, true);

  const completed = structuredClone(source);
  completed.cards[0].status = "approved";
  completed.cards[1].status = "approved";
  completed.cards[0].test_summary = "tests pass";
  completed.cards[0].final = { repository: "repo-a", branch: "feature/pr-repo-a-" + "x", commit: "6".repeat(40), base_commit: BASE_SHA, worktree: "worktrees/one", candidate_fingerprint: CANDIDATE };
  const bindings = Object.fromEntries(preRunPlan.groups.map((group) => [group.id, group]));
  const deliveryPlan = buildPrPlan(completed, { mode: "review-friendly", bindings });
  assert.equal(validateStructuralApproval(intent, deliveryPlan, completed).valid, true, "dynamic evidence and final commit details are outside the approval fingerprint");
  deliveryPlan.structural_approval = { ...intent.approval };
  deliveryPlan.plan_sha256 = prPlanSha256(deliveryPlan);
  assert.equal(validatePrPlan(deliveryPlan, completed).valid, true);

  const dependencyDrift = structuredClone(completed);
  dependencyDrift.cards[0].depends_on = ["CARD-2"];
  const driftedPlan = buildPrPlan(dependencyDrift, { mode: "review-friendly", bindings });
  assert.equal(validateStructuralApproval(intent, driftedPlan, dependencyDrift).errors.some((item) => item.code === "pr_structural_drift"), true);

  const branchDrift = Object.fromEntries(preRunPlan.groups.map((group) => [group.id, { ...group, branch: group.branch + "-changed" }]));
  const changedBindingsPlan = buildPrPlan(completed, { mode: "review-friendly", bindings: branchDrift });
  assert.equal(validateStructuralApproval(intent, changedBindingsPlan, completed).errors.some((item) => item.code === "pr_structural_drift"), true);

  const missingCardSource = structuredClone(source);
  delete missingCardSource.cards[0].source_path;
  assert.throws(() => createStructuralApproval(buildPrPlan(missingCardSource, { mode: "review-friendly", bindings }), missingCardSource, { owner: "Ainz" }), { code: "pr_structural_card_source_missing" });
}

function card(id, overrides = {}) {
  return {
    id,
    title: "Card " + id,
    selected: true,
    status: "ready",
    target_repository: "repo-a",
    depends_on: [],
    expected_paths: [id.toLowerCase() + ".txt"],
    changed_paths: [],
    ...overrides,
  };
}

function snapshot(cards, repositories = [repository()]) {
  return {
    schema_version: 1,
    project_id: "triad-pr-planning-test",
    source: {
      queue_path: ".loop/work-queue.yaml",
      queue_sha256: QUEUE_SHA,
      project_path: "project.yaml",
      project_sha256: PROJECT_SHA,
      files: [
        { path: ".loop/work-queue.yaml", sha256: QUEUE_SHA },
        { path: "project.yaml", sha256: PROJECT_SHA },
      ],
    },
    canonical_card_ids: cards.map((entry) => entry.id).sort(),
    repositories,
    cards,
  };
}

function boundPlan(source, mode) {
  const preview = buildPrPlan(source, { mode });
  const bindings = Object.fromEntries(preview.groups.map((group) => [group.id, {
    branch: "feature/" + group.id,
    worktree: "worktrees/" + group.id,
    base_branch: "main",
    base_commit: BASE_SHA,
    remote: "origin",
    remote_url: GITHUB_URL,
  }]));
  return buildPrPlan(source, { mode, bindings });
}

function git(args, cwd, expected = true) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (expected && result.status !== 0) throw new Error("git " + args.join(" ") + " failed: " + result.stderr);
  return result;
}

function gitOut(args, cwd) { return git(args, cwd).stdout.trim(); }

async function gitFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "triad-pr-plan-"));
  const repo = path.join(root, "repo");
  const remote = path.join(root, "origin.git");
  const worktrees = [path.join(root, "group-one"), path.join(root, "group-two")];
  await mkdir(repo, { recursive: true });
  git(["init", "-q", "-b", "main"], repo);
  git(["config", "user.name", "Triad Test"], repo);
  git(["config", "user.email", "triad-test@example.invalid"], repo);
  await writeFile(path.join(repo, "README.md"), "baseline\n");
  git(["add", "README.md"], repo);
  git(["commit", "-qm", "baseline"], repo);
  const base = gitOut(["rev-parse", "HEAD"], repo);
  await mkdir(remote, { recursive: true });
  git(["init", "--bare", "-q"], remote);
  git(["remote", "add", "origin", remote], repo);
  git(["push", "-qu", "origin", "main"], repo);
  for (let index = 0; index < worktrees.length; index += 1) {
    const branch = "feature/triad-group-" + (index + 1);
    git(["worktree", "add", "-qb", branch, worktrees[index], "main"], repo);
    git(["config", "user.name", "Triad Test"], worktrees[index]);
    git(["config", "user.email", "triad-test@example.invalid"], worktrees[index]);
    const filename = "card-" + (index + 1) + ".txt";
    await writeFile(path.join(worktrees[index], filename), "approved candidate " + (index + 1) + "\n");
    git(["add", filename], worktrees[index]);
    git(["commit", "-qm", "approved Card " + (index + 1)], worktrees[index]);
    git(["push", "-qu", "origin", branch], worktrees[index]);
  }
  return { root, repo, remote, base, worktrees };
}

function readyCard(id, branch, worktree, commit, base, changedPath) {
  return {
    ...card(id, {
      status: "approved",
      review_group: id,
      expected_paths: [changedPath],
      changed_paths: [changedPath],
    }),
    final: {
      repository: "repo-a",
      branch,
      commit,
      base_commit: base,
      worktree,
      candidate_fingerprint: CANDIDATE,
    },
    verifier: {
      status: "pass",
      candidate_fingerprint: CANDIDATE,
      evidence_path: ".loop/evidence/" + id + "/verification.json",
      sha256: EVIDENCE_SHA,
    },
    reviewer: {
      decision: "approved",
      candidate_fingerprint: CANDIDATE,
      evidence_path: ".loop/reviews/" + id + ".json",
      sha256: EVIDENCE_SHA,
    },
    docs_impact: { status: "not_affected", reference: ".loop/docs-impact/" + id + ".json" },
    test_summary: "required gates passed",
  };
}

function makeGhRunner({ repoRoot, missingAuth = false, missingHead = null, movedBase = null, wrongBranch = null } = {}) {
  const calls = [];
  const prs = new Map();
  let creates = 0;
  const runner = (command, args, cwd) => {
    calls.push({ command, args: [...args], cwd });
    if (command === "gh") {
      if (args[0] === "auth" && args[1] === "status") return { status: missingAuth ? 1 : 0, stdout: "", stderr: missingAuth ? "not logged in" : "" };
      if (args[0] === "repo" && args[1] === "view") return { status: 0, stdout: JSON.stringify({ nameWithOwner: "ainz-dg/triad-plus-engineering-loop", url: "https://github.com/ainz-dg/triad-plus-engineering-loop" }) };
      if (args[0] === "pr" && args[1] === "list") {
        const branch = args[args.indexOf("--head") + 1];
        return { status: 0, stdout: JSON.stringify(prs.get(branch) ?? []) };
      }
      if (args[0] === "pr" && args[1] === "create") {
        creates += 1;
        const branch = args[args.indexOf("--head") + 1];
        const base = args[args.indexOf("--base") + 1];
        const title = args[args.indexOf("--title") + 1];
        const body = args[args.indexOf("--body") + 1];
        const url = "https://github.com/ainz-dg/triad-plus-engineering-loop/pull/" + creates;
        prs.set(branch, [{ number: creates, url, state: "OPEN", isDraft: args.includes("--draft"), title, body, baseRefName: base, headRefName: branch }]);
        return { status: 0, stdout: url + "\n" };
      }
      return { status: 1, stdout: "", stderr: "unexpected gh command: " + args.join(" ") };
    }
    if (command === "git" && args[0] === "remote" && args[1] === "get-url") {
      return { status: 0, stdout: GITHUB_URL + "\n", stderr: "" };
    }
    if (command === "git" && args[0] === "branch" && args[1] === "--show-current" && wrongBranch) {
      return { status: 0, stdout: wrongBranch + "\n", stderr: "" };
    }
    if (command === "git" && args[0] === "ls-remote") {
      const ref = args.at(-1);
      if (movedBase && ref === "refs/heads/main") return { status: 0, stdout: movedBase + "\t" + ref + "\n", stderr: "" };
      if (missingHead && ref === "refs/heads/" + missingHead) return { status: 0, stdout: "", stderr: "" };
    }
    return spawnSync(command, args, { cwd, encoding: "utf8" });
  };
  return { runner, calls, prs, get creates() { return creates; } };
}

async function integrationSnapshot(fixture) {
  const branches = fixture.worktrees.map((worktree) => gitOut(["branch", "--show-current"], worktree));
  const commits = fixture.worktrees.map((worktree) => gitOut(["rev-parse", "HEAD"], worktree));
  const cards = [
    readyCard("CARD-1", branches[0], fixture.worktrees[0], commits[0], fixture.base, "card-1.txt"),
    readyCard("CARD-2", branches[1], fixture.worktrees[1], commits[1], fixture.base, "card-2.txt"),
  ];
  const source = snapshot(cards, [{
    ...repository(),
    path: fixture.repo,
    worktree: fixture.worktrees[0],
    base_commit: fixture.base,
  }]);
  for (const card of cards) {
    source.source.files.push(
      { path: card.verifier.evidence_path, sha256: card.verifier.sha256 },
      { path: card.reviewer.evidence_path, sha256: card.reviewer.sha256 },
      { path: card.docs_impact.reference, sha256: EVIDENCE_SHA },
    );
  }
  const preview = buildPrPlan(source, { mode: "review-friendly" });
  const bindings = Object.fromEntries(preview.groups.map((group, index) => [group.id, {
    branch: branches[index],
    worktree: fixture.worktrees[index],
    base_branch: "main",
    base_commit: fixture.base,
    remote: "origin",
    remote_url: GITHUB_URL,
  }]));
  const plan = buildPrPlan(source, { mode: "review-friendly", bindings });
  assert.equal(validatePrPlan(plan, source).valid, true);
  return { source, plan: approvePrPlan(plan, { owner: "Ainz Ooal Gown", approvedAt: "2026-10-21T00:00:00.000Z" }) };
}

async function attachCanonicalDeliveryEvidence(fixture, source) {
  const digest = (value) => createHash("sha256").update(value).digest("hex");
  const boundFiles = new Map((source.source.files ?? []).map((entry) => [entry.path, entry.sha256]));
  const writeBound = async (relativePath, value) => {
    const target = path.join(fixture.root, relativePath);
    await mkdir(path.dirname(target), { recursive: true });
    const bytes = typeof value === "string" ? value : JSON.stringify(value, null, 2) + "\n";
    await writeFile(target, bytes);
    const sha256 = digest(bytes);
    boundFiles.set(relativePath, sha256);
    return { path: relativePath, sha256 };
  };
  source.source.canonical_evidence = true;
  for (const card of source.cards) {
    const cardBytes = await readFile(path.join(fixture.root, card.source_path));
    if (digest(cardBytes) !== card.source_sha256) throw new Error("test Card baseline does not match its recorded source hash");
    boundFiles.set(card.source_path, card.source_sha256);
    const final = card.final;
    const assignmentId = "assignment-" + card.id;
    const runId = "run-" + card.id;
    const assignmentPath = ".loop/runtime/assignments/" + card.id + ".json";
    const verifierPath = card.verifier.evidence_path;
    const reviewerResultPath = ".loop/runtime/reviewer-results/" + card.id + ".json";
    const reviewerRunPath = ".loop/runtime/run-results/" + card.id + ".json";
    const docsPath = card.docs_impact.reference;
    const candidate = await calculateCandidateFingerprintAtCommit(final.worktree, { baseCommit: final.base_commit, commit: final.commit });
    const assignment = {
      schema_version: 1,
      assignment_id: assignmentId,
      feature_id: card.id,
      attempt: 1,
      project_root: fixture.root,
      repository_id: final.repository,
      worktree: final.worktree,
      expected_branch: final.branch,
      verification_run_id: runId,
    };
    const assignmentRef = await writeBound(assignmentPath, assignment);
    const verifierEvidence = {
      schema_version: 1,
      run_id: runId,
      feature_id: card.id,
      attempt: 1,
      assignment_id: assignmentId,
      assignment_sha256: assignmentRef.sha256,
      trigger: { event: "manual_explicit_dispatch", agent_id: "developer-" + card.id, agent_type: "triad_developer" },
      baseline: { prd_sha256: PROJECT_SHA, card_sha256: card.source_sha256, git_head: candidate.manifest.git_head, candidate_fingerprint: final.candidate_fingerprint, branch: final.branch },
      candidate_manifest: candidate.manifest,
      gates: [],
      required_gates_passed: true,
      status: "pass",
      created_at: "2026-10-23T00:00:00.000Z",
    };
    const verifierRef = await writeBound(verifierPath, verifierEvidence);
    const reviewerResultRef = await writeBound(reviewerResultPath, { decision: "approved", summary: "Independent Reviewer approved the verified candidate." });
    const binding = {
      schema_version: 2,
      assignment_ref: assignmentPath,
      assignment_sha256: assignmentRef.sha256,
      assignment_id: assignmentId,
      feature_id: card.id,
      attempt: 1,
      assignment_packet: null,
      verifier_evidence: {
        path: verifierPath,
        sha256: verifierRef.sha256,
        run_id: runId,
        feature_id: card.id,
        attempt: 1,
        assignment_id: assignmentId,
        assignment_sha256: assignmentRef.sha256,
        assignment_packet: null,
        candidate_fingerprint: final.candidate_fingerprint,
      },
      candidate_fingerprint: final.candidate_fingerprint,
      reviewer_result_ref: reviewerResultRef,
    };
    const reviewerRun = { status: "done", reviewer: { decision: "approved" }, reviewer_binding: binding };
    const reviewerRunRef = await writeBound(reviewerRunPath, reviewerRun);
    const docsRef = await writeBound(docsPath, { schema_version: 1, card_id: card.id, status: "not_affected" });
    card.verifier = { status: "pass", candidate_fingerprint: final.candidate_fingerprint, evidence_path: verifierPath, sha256: verifierRef.sha256, run_id: runId };
    card.reviewer = { decision: "approved", candidate_fingerprint: final.candidate_fingerprint, evidence_path: reviewerRunRef.path, sha256: reviewerRunRef.sha256, binding_path: reviewerRunRef.path };
    card.docs_impact = { status: "not_affected", reference: docsRef.path };
  }
  source.source.files = [...boundFiles.entries()].map(([filePath, sha256]) => ({ path: filePath, sha256 })).sort((a, b) => a.path.localeCompare(b.path));
}

// All four modes make distinct choices when the canonical Card hints differ.
{
  const cards = [
    card("C1", { shared_dependencies: ["auth"], compatibility_key: "a", review_group: "left" }),
    card("C2", { shared_dependencies: ["auth"], compatibility_key: "b", review_group: "right" }),
    card("C3", { shared_dependencies: ["ui"], compatibility_key: "ui", review_group: "left" }),
    card("C4", { shared_dependencies: ["ui"], compatibility_key: "ui", review_group: "right" }),
  ];
  const source = snapshot(cards);
  const modes = Object.fromEntries(["auto", "single", "compact", "review-friendly"].map((mode) => [mode, buildPrPlan(source, { mode }).groups.map((group) => group.card_ids.join("+")).sort()]));
  assert.equal(modes.single.length, 1);
  assert.equal(modes.compact.length, 3);
  assert.deepEqual(modes.auto, ["C1+C2", "C3+C4"]);
  assert.deepEqual(modes["review-friendly"], ["C1+C3", "C2+C4"]);
  assert.equal(new Set(Object.values(modes).map((value) => JSON.stringify(value))).size, 4);
  const altered = buildPrPlan(source, { mode: "auto" });
  altered.mode = "single";
  assert.equal(validatePrPlan(altered, source).errors.some((item) => item.code === "pr_grouping_not_deterministic"), true);
  const staleHash = buildPrPlan(source, { mode: "auto" });
  staleHash.groups[0].rationale += " tampered";
  assert.equal(validatePrPlan(staleHash, source).errors.some((item) => item.code === "pr_plan_hash_invalid"), true);
}

// CLI paths cannot escape the Control Workspace, even for inputs not yet read.
{
  const root = await mkdtemp(path.join(os.tmpdir(), "triad-pr-cli-paths-"));
  try {
    const cli = fileURLToPath(new URL("../runtime/triad-pr-plan.mjs", import.meta.url));
    const help = spawnSync(process.execPath, [cli, "--help"], { cwd: root, encoding: "utf8" });
    assert.equal(help.status, 0, help.stderr);
    const escaped = spawnSync(process.execPath, [cli, "preview", "--project", root, "--snapshot", "../outside.json"], { cwd: root, encoding: "utf8" });
    assert.equal(escaped.status, 1);
    assert.match(escaped.stderr, /escapes the Control Workspace/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

// The normal CLI records owner-approved pre-run structure and reuses it with
// refreshed queue state without another owner prompt.
{
  const root = await mkdtemp(path.join(os.tmpdir(), "triad-pr-intent-cli-"));
  try {
    const cli = fileURLToPath(new URL("../runtime/triad-pr-plan.mjs", import.meta.url));
    const product = path.join(root, "product");
    await mkdir(path.join(root, ".loop"), { recursive: true });
    await mkdir(path.join(root, "features"), { recursive: true });
    await mkdir(product, { recursive: true });
    const digest = (value) => createHash("sha256").update(value).digest("hex");
    const queuePath = ".loop/work-queue.yaml";
    const projectPath = "project.yaml";
    const cardDocs = [
      "# CARD-1 — Card 1\n\n- Target repository: repo-a\n- Dependencies: none\n",
      "# CARD-2 — Card 2\n\n- Target repository: repo-a\n- Dependencies: none\n",
    ];
    const cardRecords = [card("CARD-1", { title: "Card 1", review_group: "left", expected_paths: ["one.txt"], source_path: "features/CARD-1.md", source_sha256: digest(cardDocs[0]) }),
      card("CARD-2", { title: "Card 2", review_group: "right", expected_paths: ["two.txt"], source_path: "features/CARD-2.md", source_sha256: digest(cardDocs[1]) })];
    const projectYaml = `repositories:\n  - id: repo-a\n    path: ${product}\n    worktree: worktrees/default\n    base_branch: main\n    project_branch: feature/project\n`;
    const makeQueue = (state) => `version: 2\nitems:\n  - id: CARD-1\n    title: Card 1\n    state: ${state}\n    target_repository: repo-a\n    depends_on: []\n  - id: CARD-2\n    title: Card 2\n    state: ${state}\n    target_repository: repo-a\n    depends_on: []\n`;
    const queue = makeQueue("ready");
    await writeFile(path.join(root, queuePath), queue);
    await writeFile(path.join(root, projectPath), projectYaml);
    for (let index = 0; index < cardDocs.length; index += 1) await writeFile(path.join(root, cardRecords[index].source_path), cardDocs[index]);
    const sourceFiles = [
      { path: queuePath, sha256: digest(queue) },
      { path: projectPath, sha256: digest(projectYaml) },
      ...cardRecords.map((item) => ({ path: item.source_path, sha256: item.source_sha256 })),
    ];
    const source = {
      project_id: "cli-structural-intent",
      canonical_card_ids: cardRecords.map((item) => item.id).sort(),
      source: { queue_path: queuePath, queue_sha256: digest(queue), project_path: projectPath, project_sha256: digest(projectYaml), files: sourceFiles },
      repositories: [{ id: "repo-a", path: product, worktree: "worktrees/default", base_branch: "main", project_branch: "feature/project", base_commit: BASE_SHA, remote: "origin", remote_url: GITHUB_URL }],
      cards: cardRecords,
    };
    const unbound = buildPrPlan(source, { mode: "review-friendly" });
    source.group_bindings = Object.fromEntries(unbound.groups.map((group, index) => [group.id, {
      branch: "draft/" + (index + 1), worktree: "worktrees/draft-" + (index + 1), base_branch: "main",
      base_commit: BASE_SHA, remote: "origin", remote_url: GITHUB_URL,
    }]));
    await writeFile(path.join(root, ".loop/runtime-pr-pre.json"), JSON.stringify(source, null, 2));
    const bound = buildPrPlan(source, { mode: "review-friendly", bindings: source.group_bindings });
    const approval = createStructuralApproval(bound, source, { owner: "Ainz Ooal Gown" });
    const intentPath = ".loop/runtime/pr-structure-approval.json";
    const wrongPhrase = spawnSync(process.execPath, [cli, "intent", "--project", root, "--snapshot", ".loop/runtime-pr-pre.json", "--mode", "review-friendly", "--owner", "Ainz Ooal Gown"], {
      cwd: root, input: "not the approval phrase\n", encoding: "utf8",
    });
    assert.equal(wrongPhrase.status, 1);
    assert.match(wrongPhrase.stderr, /Approval phrase did not match/);
    assert.equal(await readFile(path.join(root, intentPath), "utf8").then(() => true, () => false), false);

    const recorded = spawnSync(process.execPath, [cli, "intent", "--project", root, "--snapshot", ".loop/runtime-pr-pre.json", "--mode", "review-friendly", "--owner", "Ainz Ooal Gown"], {
      cwd: root, input: `approve ${approval.approval.structural_sha256.slice(0, 12)}\n`, encoding: "utf8",
    });
    assert.equal(recorded.status, 0, recorded.stderr);
    assert.match(recorded.stdout, /worktrees\/draft-1/);
    assert.match(recorded.stdout, /Structural owner approval recorded/);

    const postQueue = makeQueue("approved");
    await writeFile(path.join(root, queuePath), postQueue);
    const postRun = structuredClone(source);
    postRun.source.queue_sha256 = digest(postQueue);
    postRun.source.files = postRun.source.files.map((entry) => entry.path === queuePath ? { ...entry, sha256: digest(postQueue) } : entry);
    postRun.cards.forEach((entry) => { entry.status = "approved"; entry.test_summary = "verified"; });
    await writeFile(path.join(root, ".loop/runtime-pr-post.json"), JSON.stringify(postRun, null, 2));
    const preview = spawnSync(process.execPath, [cli, "preview", "--project", root, "--snapshot", ".loop/runtime-pr-post.json", "--intent", intentPath], { cwd: root, encoding: "utf8" });
    assert.equal(preview.status, 0, preview.stderr + preview.stdout);
    const plan = JSON.parse(await readFile(path.join(root, ".loop/runtime/pr_plan.json"), "utf8"));
    assert.equal(plan.groups.length, 2);
    assert.equal(plan.structural_approval.structural_sha256, approval.approval.structural_sha256);
    assert.equal(validatePrPlan(plan, postRun).valid, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

// Single mode is one PR per target repository, not one PR across repositories.
{
  const repos = [repository("repo-a"), repository("repo-b")];
  const source = snapshot([card("A", { target_repository: "repo-a" }), card("B", { target_repository: "repo-b" })], repos);
  const plan = buildPrPlan(source, { mode: "single" });
  assert.equal(plan.groups.length, 2);
  assert.deepEqual(plan.groups.map((group) => group.target_repository).sort(), ["repo-a", "repo-b"]);
}

// Dependency ambiguity and cycles fail closed; cross-PR dependencies get the exact unsupported diagnostic.
{
  const missing = snapshot([card("A", { depends_on: ["UNKNOWN"] })]);
  assert.throws(() => buildPrPlan(missing), { code: "pr_dependency_ambiguous" });
  const cycle = snapshot([card("A", { depends_on: ["B"] }), card("B", { depends_on: ["A"] })]);
  assert.throws(() => buildPrPlan(cycle), { code: "pr_dependency_cycle" });
  const stackedSource = snapshot([
    card("A", { review_group: "one" }),
    card("B", { review_group: "two", depends_on: ["A"] }),
  ]);
  const plan = boundPlan(stackedSource, "review-friendly");
  assert.equal(plan.diagnostics[0].code, "stacked_required/unsupported");
  assert.equal(validatePrPlan(plan, stackedSource).stacked_unsupported, true);
  const approved = approvePrPlan(plan, { owner: "Ainz" });
  await assert.rejects(prepareDraftPullRequests(approved, stackedSource), { code: "stacked_required/unsupported" });
}

// Approval binds exact group scope, repository, branch, base, and draft-only effect.
{
  const source = snapshot([card("A"), card("B")]);
  const plan = boundPlan(source, "review-friendly");
  const approved = approvePrPlan(plan, { owner: "Ainz", approvedAt: "2026-10-21T00:00:00.000Z" });
  assert.equal(validatePlanApproval(approved).valid, true);
  const driftedSnapshot = structuredClone(source);
  driftedSnapshot.cards[0].test_summary = "changed after preview";
  assert.equal(validatePrPlan(plan, driftedSnapshot).errors.some((item) => item.code === "pr_snapshot_drift"), true);
  const changed = structuredClone(approved);
  changed.groups[0].base_commit = "6".repeat(40);
  assert.equal(validatePlanApproval(changed).errors.some((item) => item.code === "approval_drift"), true);
  const duplicate = structuredClone(plan);
  duplicate.groups[0].card_ids.push(duplicate.groups[0].card_ids[0]);
  assert.equal(validatePrPlan(duplicate, source).errors.some((item) => item.code === "pr_card_double_assignment"), true);
  const wrongBase = structuredClone(plan);
  wrongBase.groups[0].base_branch = "release";
  assert.equal(validatePrPlan(wrongBase, source).errors.some((item) => item.code === "pr_base_not_declared"), true);
}

// Work queue and project source hashes are verified against the current local control workspace.
{
  const root = await mkdtemp(path.join(os.tmpdir(), "triad-pr-sources-"));
  try {
    await mkdir(path.join(root, ".loop"), { recursive: true });
    const queuePath = path.join(root, ".loop", "work-queue.yaml");
    const projectPath = path.join(root, "project.yaml");
    const cardPath = path.join(root, "features", "A.md");
    const queue = "version: 2\nitems:\n  - id: A\n    state: ready\n    target_repository: repo-a\n    depends_on: []\n";
    const project = "repositories:\n  - id: repo-a\n    path: /tmp/product-repository\n    base_branch: main\n    project_branch: feature/project\n    worktree: worktrees/product\n";
    const cardSource = "# A — Card A\n\n- Target repository: repo-a\n- Dependencies: none\n";
    await writeFile(queuePath, queue);
    await writeFile(projectPath, project);
    await mkdir(path.dirname(cardPath), { recursive: true });
    await writeFile(cardPath, cardSource);
    const digest = (value) => createHash("sha256").update(value).digest("hex");
    const source = snapshot([card("A")], [{
      id: "repo-a", path: "/tmp/product-repository", worktree: "worktrees/product",
      base_branch: "main", project_branch: "feature/project", base_commit: BASE_SHA, remote: "origin", remote_url: GITHUB_URL,
    }]);
    source.source.queue_sha256 = digest(queue);
    source.source.project_sha256 = digest(project);
    source.source.files = [
      { path: ".loop/work-queue.yaml", sha256: digest(queue) },
      { path: "project.yaml", sha256: digest(project) },
      { path: "features/A.md", sha256: digest(cardSource) },
    ];
    source.cards[0].source_path = "features/A.md";
    source.cards[0].source_sha256 = digest(cardSource);
    const valid = await validateSnapshotSources(source, root, { queueParser: parseWorkQueueItems });
    assert.equal(valid.valid, true, JSON.stringify(valid.errors));
    await writeFile(cardPath, cardSource.replace("# A — Card A", "# B — Wrong identity"));
    const wrongCard = await validateSnapshotSources(source, root, { queueParser: parseWorkQueueItems });
    assert.equal(wrongCard.valid, false);
    assert.equal(wrongCard.errors.some((item) => item.code === "pr_source_drift" || item.code === "pr_card_identity_mismatch"), true);
    await writeFile(cardPath, cardSource);
    await writeFile(queuePath, queue.replace("state: ready", "state: blocked"));
    const drifted = await validateSnapshotSources(source, root, { queueParser: parseWorkQueueItems });
    assert.equal(drifted.valid, false);
    assert.equal(drifted.errors.some((item) => item.code === "pr_source_drift"), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

// Two independent draft groups use distinct approved worktrees/branches and
// have independent verifier + Reviewer evidence. Dry-run is read-only.
{
  const fixture = await gitFixture();
  try {
    const { source, plan } = await integrationSnapshot(fixture);
    const fake = makeGhRunner({ repoRoot: fixture.repo });
    const dryRun = await prepareDraftPullRequests(plan, source, { runner: fake.runner, projectRoot: fixture.root });
    assert.equal(dryRun.status, "dry_run");
    assert.equal(dryRun.draft_count, 2);
    assert.equal(dryRun.writes_performed, false);
    assert.equal(fake.creates, 0);
    assert.equal(fake.calls.some((call) => call.command === "gh"), false);

    const created = await prepareDraftPullRequests(plan, source, { execute: true, runner: fake.runner, projectRoot: fixture.root });
    assert.equal(created.status, "created");
    assert.equal(created.drafts.length, 2);
    assert.equal(created.writes_performed, true);
    assert.equal(fake.creates, 2);
    assert.equal(new Set(created.drafts.map((item) => item.branch)).size, 2);
    for (const call of fake.calls.filter((item) => item.command === "gh" && item.args[0] === "pr" && item.args[1] === "create")) {
      assert.equal(call.args.includes("--draft"), true);
      assert.equal(call.args.includes("--force"), false);
      assert.equal(call.args.some((value) => value === "merge" || value === "push" || value === "--merge"), false);
      assert.match(call.args[call.args.indexOf("--body") + 1], /verifier|Verifier/);
      assert.match(call.args[call.args.indexOf("--body") + 1], /Reviewer/);
    }
    const retry = await prepareDraftPullRequests(plan, source, { execute: true, runner: fake.runner, projectRoot: fixture.root });
    assert.equal(retry.drafts.every((item) => item.status === "already_created"), true);
    assert.equal(fake.creates, 2);

    const structuralSource = structuredClone(source);
    for (const entry of structuralSource.cards) {
      entry.source_path = "features/" + entry.id + ".md";
      const cardText = "# " + entry.id + " — " + entry.title + "\n\n- Target repository: repo-a\n- Dependencies: none\n";
      entry.source_sha256 = createHash("sha256").update(cardText).digest("hex");
      await mkdir(path.dirname(path.join(fixture.root, entry.source_path)), { recursive: true });
      await writeFile(path.join(fixture.root, entry.source_path), cardText);
      structuralSource.source.files.push({ path: entry.source_path, sha256: entry.source_sha256 });
    }
    const bindings = Object.fromEntries(plan.groups.map((group) => [group.id, group]));
    const preRun = structuredClone(structuralSource);
    for (const entry of preRun.cards) {
      entry.status = "ready";
      delete entry.verifier;
      delete entry.reviewer;
      delete entry.docs_impact;
      delete entry.final;
      delete entry.test_summary;
    }
    const preRunPlan = buildPrPlan(preRun, { mode: "review-friendly", bindings });
    const structuralIntent = createStructuralApproval(preRunPlan, preRun, { owner: "Ainz Ooal Gown" });
    await attachCanonicalDeliveryEvidence(fixture, structuralSource);
    const structuralPlan = buildPrPlan(structuralSource, { mode: "review-friendly", bindings });
    structuralPlan.structural_approval = { ...structuralIntent.approval };
    structuralPlan.plan_sha256 = prPlanSha256(structuralPlan);
    assert.equal(validatePrPlan(structuralPlan, structuralSource).valid, true);
    const noCanonicalFlag = structuredClone(structuralSource);
    noCanonicalFlag.source.canonical_evidence = false;
    const noCanonicalPlan = buildPrPlan(noCanonicalFlag, { mode: "review-friendly", bindings });
    noCanonicalPlan.structural_approval = { ...structuralIntent.approval };
    noCanonicalPlan.plan_sha256 = prPlanSha256(noCanonicalPlan);
    await assert.rejects(prepareDraftPullRequests(noCanonicalPlan, noCanonicalFlag, { projectRoot: fixture.root }), { code: "pr_canonical_evidence_required" });

    const verifierFile = path.join(fixture.root, structuralSource.cards[0].verifier.evidence_path);
    const verifierBytes = await readFile(verifierFile);
    await writeFile(verifierFile, verifierBytes.toString("utf8").replace('"status": "pass"', '"status": "fail"'));
    const staleVerifierFake = makeGhRunner();
    await assert.rejects(prepareDraftPullRequests(structuralPlan, structuralSource, { execute: true, runner: staleVerifierFake.runner, projectRoot: fixture.root }), { code: "pr_canonical_evidence_invalid" });
    assert.equal(staleVerifierFake.creates, 0);
    await writeFile(verifierFile, verifierBytes);

    const structuralFake = makeGhRunner({ repoRoot: fixture.repo });
    const structuralDryRun = await prepareDraftPullRequests(structuralPlan, structuralSource, { runner: structuralFake.runner, projectRoot: fixture.root });
    assert.equal(structuralDryRun.draft_count, 2);
    const structuralCreated = await prepareDraftPullRequests(structuralPlan, structuralSource, { execute: true, runner: structuralFake.runner, projectRoot: fixture.root });
    assert.equal(structuralCreated.drafts.length, 2);
    assert.equal(structuralFake.creates, 2);
    const structuralRetry = await prepareDraftPullRequests(structuralPlan, structuralSource, { execute: true, runner: structuralFake.runner, projectRoot: fixture.root });
    assert.equal(structuralRetry.drafts.every((item) => item.status === "already_created"), true);
    assert.equal(structuralFake.creates, 2);

    const rework = structuredClone(structuralSource);
    rework.cards[0].reviewer.decision = "rework";
    const reworkPlan = buildPrPlan(rework, { mode: "review-friendly", bindings });
    reworkPlan.structural_approval = { ...structuralIntent.approval };
    reworkPlan.plan_sha256 = prPlanSha256(reworkPlan);
    const reworkFake = makeGhRunner();
    await assert.rejects(prepareDraftPullRequests(reworkPlan, rework, { execute: true, runner: reworkFake.runner, projectRoot: fixture.root }), { code: "pr_group_evidence_incomplete" });
    assert.equal(reworkFake.creates, 0);

    const missingApproval = structuredClone(structuralPlan);
    delete missingApproval.structural_approval;
    missingApproval.plan_sha256 = prPlanSha256(missingApproval);
    await assert.rejects(prepareDraftPullRequests(missingApproval, structuralSource, { execute: true, runner: makeGhRunner().runner, projectRoot: fixture.root }), { code: "pr_plan_approval_invalid" });

    const withBaseDependency = structuredClone(source);
    withBaseDependency.cards[0].depends_on = ["BASE-CARD"];
    withBaseDependency.cards.push({
      ...card("BASE-CARD", { selected: false, status: "approved" }),
      final: { ...withBaseDependency.cards[0].final, commit: fixture.base },
    });
    withBaseDependency.canonical_card_ids.push("BASE-CARD");
    const approvedBaseDependency = approvePrPlan(buildPrPlan(withBaseDependency, {
      mode: "review-friendly",
      bindings: Object.fromEntries(plan.groups.map((group) => [group.id, group])),
    }), { owner: "Ainz" });
    const withBaseDependencyResult = await prepareDraftPullRequests(approvedBaseDependency, withBaseDependency, { runner: makeGhRunner().runner, projectRoot: fixture.root });
    assert.equal(withBaseDependencyResult.status, "dry_run");

    const unmergedDependency = structuredClone(withBaseDependency);
    unmergedDependency.cards.at(-1).final.commit = source.cards[0].final.commit;
    const unmergedPlan = approvePrPlan(buildPrPlan(unmergedDependency, {
      mode: "review-friendly",
      bindings: Object.fromEntries(plan.groups.map((group) => [group.id, group])),
    }), { owner: "Ainz" });
    await assert.rejects(prepareDraftPullRequests(unmergedPlan, unmergedDependency, { runner: makeGhRunner().runner, projectRoot: fixture.root }), { code: "pr_dependency_unverified" });
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
}

// Sequential Cards in one approved group retain the PR's group base while
// each canonical verifier candidate is bound to its own approved baseline.
{
  const fixture = await gitFixture();
  try {
    const worktree = fixture.worktrees[0];
    const branch = gitOut(["branch", "--show-current"], worktree);
    const firstCommit = gitOut(["rev-parse", "HEAD"], worktree);
    await writeFile(path.join(worktree, "card-2.txt"), "approved second Card candidate\n");
    git(["add", "card-2.txt"], worktree);
    git(["commit", "-qm", "approved Card 2"], worktree);
    const secondCommit = gitOut(["rev-parse", "HEAD"], worktree);
    git(["push", "-qu", "origin", branch], worktree);

    const cards = [
      readyCard("CARD-1", branch, worktree, firstCommit, fixture.base, "card-1.txt"),
      readyCard("CARD-2", branch, worktree, secondCommit, firstCommit, "card-2.txt"),
    ];
    for (const entry of cards) entry.review_group = "sequential";
    cards[1].depends_on = ["CARD-1"];
    cards[0].final.candidate_fingerprint = (await calculateCandidateFingerprintAtCommit(worktree, { baseCommit: fixture.base, commit: firstCommit })).value;
    cards[1].final.candidate_fingerprint = (await calculateCandidateFingerprintAtCommit(worktree, { baseCommit: firstCommit, commit: secondCommit })).value;

    const source = snapshot(cards, [{
      ...repository(), path: fixture.repo, worktree, base_commit: fixture.base,
    }]);
    const digest = (value) => createHash("sha256").update(value).digest("hex");
    for (const entry of cards) {
      entry.source_path = "features/" + entry.id + ".md";
      const dependency = entry.id === "CARD-2" ? "CARD-1" : "none";
      const cardText = "# " + entry.id + " — " + entry.title + "\n\n- Target repository: repo-a\n- Dependencies: " + dependency + "\n";
      entry.source_sha256 = digest(cardText);
      await mkdir(path.dirname(path.join(fixture.root, entry.source_path)), { recursive: true });
      await writeFile(path.join(fixture.root, entry.source_path), cardText);
      source.source.files.push({ path: entry.source_path, sha256: entry.source_sha256 });
    }

    const preview = buildPrPlan(source, { mode: "review-friendly" });
    assert.equal(preview.groups.length, 1);
    const bindings = { [preview.groups[0].id]: {
      branch, worktree, base_branch: "main", base_commit: fixture.base, remote: "origin", remote_url: GITHUB_URL,
    } };
    const preRun = structuredClone(source);
    for (const entry of preRun.cards) {
      entry.status = "ready";
      delete entry.final;
      delete entry.verifier;
      delete entry.reviewer;
      delete entry.docs_impact;
      delete entry.test_summary;
    }
    const intentPlan = buildPrPlan(preRun, { mode: "review-friendly", bindings });
    const structuralApproval = createStructuralApproval(intentPlan, preRun, { owner: "Ainz Ooal Gown" });
    await attachCanonicalDeliveryEvidence(fixture, source);

    const makePlan = (candidate) => {
      const plan = buildPrPlan(candidate, { mode: "review-friendly", bindings });
      plan.structural_approval = { ...structuralApproval.approval };
      plan.plan_sha256 = prPlanSha256(plan);
      return plan;
    };
    const plan = makePlan(source);
    assert.equal(validatePrPlan(plan, source).valid, true);
    assert.equal(plan.groups[0].base_commit, fixture.base, "the PR base remains the approved group base");

    const fake = makeGhRunner();
    const dryRun = await prepareDraftPullRequests(plan, source, { runner: fake.runner, projectRoot: fixture.root });
    assert.equal(dryRun.status, "dry_run");
    assert.equal(dryRun.draft_count, 1);
    assert.equal(dryRun.groups[0].head, secondCommit);
    assert.equal(fake.creates, 0);
    const created = await prepareDraftPullRequests(plan, source, { execute: true, runner: fake.runner, projectRoot: fixture.root });
    assert.equal(created.status, "created");
    assert.equal(created.drafts.length, 1);
    assert.equal(created.drafts[0].base_branch, "main");
    assert.equal(fake.creates, 1);
    const createCall = fake.calls.find((call) => call.command === "gh" && call.args[0] === "pr" && call.args[1] === "create");
    assert.ok(createCall);
    assert.equal(createCall.args.includes("--draft"), true);
    assert.equal(createCall.args[createCall.args.indexOf("--base") + 1], "main");

    const tamperedBaseline = structuredClone(source);
    tamperedBaseline.cards.find((entry) => entry.id === "CARD-2").final.base_commit = fixture.base;
    const tamperedBaselineFake = makeGhRunner();
    await assert.rejects(
      prepareDraftPullRequests(makePlan(tamperedBaseline), tamperedBaseline, { execute: true, runner: tamperedBaselineFake.runner, projectRoot: fixture.root }),
      { code: "pr_card_commit_candidate_mismatch" },
    );
    assert.equal(tamperedBaselineFake.creates, 0);
    assert.equal(tamperedBaselineFake.calls.some((call) => call.command === "gh" && call.args[0] === "pr" && call.args[1] === "create"), false);

    const staleBaseline = structuredClone(source);
    staleBaseline.cards.find((entry) => entry.id === "CARD-2").final.base_commit = "f".repeat(40);
    const staleBaselineFake = makeGhRunner();
    await assert.rejects(
      prepareDraftPullRequests(makePlan(staleBaseline), staleBaseline, { execute: true, runner: staleBaselineFake.runner, projectRoot: fixture.root }),
      { code: "pr_card_baseline_invalid" },
    );
    assert.equal(staleBaselineFake.creates, 0);
    assert.equal(staleBaselineFake.calls.some((call) => call.command === "gh" && call.args[0] === "pr" && call.args[1] === "create"), false);

    const unrelatedBaseline = structuredClone(source);
    unrelatedBaseline.cards.find((entry) => entry.id === "CARD-2").final.base_commit = gitOut(["rev-parse", "HEAD"], fixture.worktrees[1]);
    const unrelatedBaselineFake = makeGhRunner();
    await assert.rejects(
      prepareDraftPullRequests(makePlan(unrelatedBaseline), unrelatedBaseline, { execute: true, runner: unrelatedBaselineFake.runner, projectRoot: fixture.root }),
      { code: "pr_card_baseline_invalid" },
    );
    assert.equal(unrelatedBaselineFake.creates, 0);
    assert.equal(unrelatedBaselineFake.calls.some((call) => call.command === "gh" && call.args[0] === "pr" && call.args[1] === "create"), false);

    await writeFile(path.join(worktree, "card-2.txt"), "unreviewed extra change to an approved path\n");
    git(["add", "card-2.txt"], worktree);
    git(["commit", "-qm", "unreviewed rogue commit"], worktree);
    git(["push", "-qu", "origin", branch], worktree);
    const rogueFake = makeGhRunner();
    await assert.rejects(
      prepareDraftPullRequests(plan, source, { execute: true, runner: rogueFake.runner, projectRoot: fixture.root }),
      { code: "pr_group_commit_set_mismatch" },
    );
    assert.equal(rogueFake.creates, 0);
    assert.equal(rogueFake.calls.some((call) => call.command === "gh" && call.args[0] === "pr" && call.args[1] === "create"), false);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
}

// Blocked/rework Cards, branch drift, missing upstream, moved base, and missing host auth never create PRs.
{
  const fixture = await gitFixture();
  try {
    const { source, plan } = await integrationSnapshot(fixture);
    const blockedSource = structuredClone(source);
    blockedSource.cards[0].status = "blocked";
    const blockedPlan = approvePrPlan(buildPrPlan(blockedSource, {
      mode: "review-friendly",
      bindings: Object.fromEntries(plan.groups.map((group) => [group.id, group])),
    }), { owner: "Ainz" });
    const blockedFake = makeGhRunner();
    await assert.rejects(prepareDraftPullRequests(blockedPlan, blockedSource, { execute: true, runner: blockedFake.runner, projectRoot: fixture.root }), { code: "pr_group_evidence_incomplete" });
    assert.equal(blockedFake.creates, 0);

    const wrongBranch = makeGhRunner({ wrongBranch: "unexpected" });
    await assert.rejects(prepareDraftPullRequests(plan, source, { execute: true, runner: wrongBranch.runner, projectRoot: fixture.root }), { code: "pr_branch_mismatch" });
    assert.equal(wrongBranch.creates, 0);

    const firstBranch = plan.groups[0].branch;
    const missingHead = makeGhRunner({ missingHead: firstBranch });
    await assert.rejects(prepareDraftPullRequests(plan, source, { execute: true, runner: missingHead.runner, projectRoot: fixture.root }), { code: "pr_upstream_unavailable" });
    assert.equal(missingHead.creates, 0);

    const movedBase = makeGhRunner({ movedBase: "9".repeat(40) });
    await assert.rejects(prepareDraftPullRequests(plan, source, { execute: true, runner: movedBase.runner, projectRoot: fixture.root }), { code: "pr_base_drift" });
    assert.equal(movedBase.creates, 0);

    const noAuth = makeGhRunner({ missingAuth: true });
    await assert.rejects(prepareDraftPullRequests(plan, source, { execute: true, runner: noAuth.runner, projectRoot: fixture.root }), { code: "pr_host_auth_unavailable" });
    assert.equal(noAuth.creates, 0);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
}

// A later unreviewed commit touching an already-approved path advances the
// branch and remote, but cannot be smuggled into a draft PR by path equality.
{
  const fixture = await gitFixture();
  try {
    const { source, plan } = await integrationSnapshot(fixture);
    const group = plan.groups.find((entry) => entry.card_ids.includes("CARD-1"));
    const worktree = fixture.worktrees.find((candidate) => gitOut(["branch", "--show-current"], candidate) === group.branch);
    await writeFile(path.join(worktree, "card-1.txt"), "unreviewed follow-up touching an approved path\n");
    git(["add", "card-1.txt"], worktree);
    git(["commit", "-qm", "unreviewed follow-up"], worktree);
    const rogueHead = gitOut(["rev-parse", "HEAD"], worktree);
    git(["push", "-qu", "origin", group.branch], worktree);
    assert.equal(gitOut(["ls-remote", "origin", "refs/heads/" + group.branch], worktree).split(/\s+/)[0], rogueHead);

    const fake = makeGhRunner({ repoRoot: fixture.repo });
    await assert.rejects(
      prepareDraftPullRequests(plan, source, { execute: true, runner: fake.runner, projectRoot: fixture.root }),
      { code: "pr_group_commit_set_mismatch" },
    );
    assert.equal(fake.creates, 0);
    assert.equal(fake.calls.some((call) => call.command === "gh" && call.args[0] === "pr" && call.args[1] === "create"), false);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
}

// Tampered or incomplete verification and Reviewer records are never publishable.
{
  const fixture = await gitFixture();
  try {
    const { source, plan } = await integrationSnapshot(fixture);
    const noReviewer = structuredClone(source);
    noReviewer.cards[0].reviewer.decision = "rework";
    const fake = makeGhRunner();
    await assert.rejects(prepareDraftPullRequests(plan, noReviewer, { execute: true, runner: fake.runner, projectRoot: fixture.root }), { code: "pr_plan_invalid" });
    assert.equal(fake.creates, 0);

    const tamperedEvidence = structuredClone(source);
    tamperedEvidence.cards[0].verifier.sha256 = "6".repeat(64);
    const bindings = Object.fromEntries(plan.groups.map((group) => [group.id, group]));
    const tamperedPlan = approvePrPlan(buildPrPlan(tamperedEvidence, { mode: "review-friendly", bindings }), { owner: "Ainz" });
    await assert.rejects(prepareDraftPullRequests(tamperedPlan, tamperedEvidence, { execute: true, runner: fake.runner, projectRoot: fixture.root }), { code: "pr_group_evidence_incomplete" });
    assert.equal(fake.creates, 0);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
}

process.stdout.write("PR planning tests passed\n");
