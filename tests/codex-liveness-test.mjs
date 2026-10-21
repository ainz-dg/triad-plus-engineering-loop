import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sharedContract = fs.readFileSync(
  path.join(root, "skills/triad-loop-orchestrator/SKILL.md"),
  "utf8",
);
const codexContract = fs.readFileSync(
  path.join(root, "adapters/codex/skills/triad/SKILL.md"),
  "utf8",
);

const normalized = (value) => value.replace(/\s+/g, " ").trim().toLowerCase();
const shared = normalized(sharedContract);
const codex = normalized(codexContract);

function requireContract(text, phrase, label) {
  assert.ok(
    text.includes(normalized(phrase)),
    `${label} must contain: ${phrase}`,
  );
}

for (const [label, contract] of [
  ["shared Orchestrator skill", shared],
  ["Codex Orchestrator skill", codex],
]) {
  requireContract(contract, "MUST NOT end its owner-facing turn while", label);
  requireContract(contract, "delegated Developer or Reviewer assignment", label);
  requireContract(contract, "`wait_agent` timeout", label);
  requireContract(contract, "polling interval", label);
  requireContract(contract, "refresh the assignment and delegated-agent status", label);
  requireContract(contract, "still active", label);
  requireContract(contract, "same Orchestrator turn", label);
  requireContract(contract, "progress update is informational and non-pausing", label);
  requireContract(contract, "without owner input", label);
  requireContract(contract, "dependency-satisfied cards", label);
}

requireContract(
  shared,
  "declared escalation, a `blocked` verdict, an unrecoverable runtime failure, or an explicit owner pause",
  "shared Orchestrator skill",
);
requireContract(
  codex,
  "immediately call `wait_agent` again in the same Orchestrator turn",
  "Codex Orchestrator skill",
);
requireContract(codex, "invoke explicit `triad-verify`", "Codex Orchestrator skill");

// A small executable model of the required host-wait semantics. This is not a
// replacement for the live Codex gate; it prevents the contract from drifting
// back to treating a polling timeout as terminal.
function collectAfterTimeout(waitResults, statusResults) {
  const events = [];
  let waitIndex = 0;
  let statusIndex = 0;

  while (true) {
    const result = waitResults[waitIndex++];
    assert.ok(result, "fixture must provide a wait result");

    if (result === "completed") {
      events.push("collect");
      return { events, ownerWait: false, nextAction: "collect" };
    }

    assert.equal(result, "timeout", "fixture only models timeout/completion");
    events.push("timeout", "refresh");
    const status = statusResults[statusIndex++];
    assert.ok(status, "fixture must provide a refreshed status");

    if (status === "active") {
      events.push("rewait");
      continue;
    }
    if (status === "completed") {
      events.push("collect");
      return { events, ownerWait: false, nextAction: "collect" };
    }
    assert.fail(`unexpected fixture status: ${status}`);
  }
}

for (const role of ["Developer", "Reviewer"]) {
  const result = collectAfterTimeout(["timeout", "completed"], ["active"]);
  assert.deepEqual(result.events, ["timeout", "refresh", "rewait", "collect"]);
  assert.equal(result.ownerWait, false);
  assert.equal(result.nextAction, "collect");
  // Keep the two role paths explicit in the test diagnostics.
  assert.ok(["Developer", "Reviewer"].includes(role));
}

console.log("Codex liveness contract and timeout fixture: PASS");
