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
  prepareDraftPullRequests,
  prGroupId,
  validatePlanApproval,
  validatePrPlan,
  validateSnapshotSources,
} from "../runtime/lib/pr-planning.mjs";
import { parseWorkQueueItems } from "../cockpit/server/work-queue.mjs";

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
    const queue = "version: 2\nitems:\n  - id: A\n    state: ready\n    target_repository: repo-a\n    depends_on: []\n";
    const project = "repositories:\n  - id: repo-a\n    path: /tmp/product-repository\n    base_branch: main\n    project_branch: feature/project\n    worktree: worktrees/product\n";
    await writeFile(queuePath, queue);
    await writeFile(projectPath, project);
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
    ];
    const valid = await validateSnapshotSources(source, root, { queueParser: parseWorkQueueItems });
    assert.equal(valid.valid, true, JSON.stringify(valid.errors));
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
