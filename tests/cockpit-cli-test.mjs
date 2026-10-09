import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDemoWorkspace } from "./fixtures/cockpit-demo-workspace.mjs";

// `triad-plus cockpit`: argument validation, a real start/stop cycle, and no
// change to the existing commands.

const repositoryRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const cli = path.join(repositoryRoot, "bin", "triad-plus.js");
const run = (args, options = {}) => spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", ...options });

const root = await mkdtemp(path.join(tmpdir(), "triad-cockpit-cli-"));
const control = await createDemoWorkspace(root);
const notControl = path.join(root, "plain-directory");
await mkdir(notControl);

// Usage lists the command; the default command is still the setup wizard.
const help = run(["--help"]);
assert.equal(help.status, 0);
assert.match(help.stdout, /npx triad-plus cockpit --control <path> \[--port <n>\]/);
const wizard = run([], { input: "" });
assert.equal(wizard.status, 2);
assert.match(wizard.stderr, /interactive wizard needs a terminal/, "no-argument behaviour is unchanged");

// Validation failures exit 2 with a clear message and start nothing.
for (const [args, message] of [
  [["cockpit"], /Provide --control/],
  [["cockpit", "--control", path.join(root, "missing")], /Control workspace does not exist/],
  [["cockpit", "--control", notControl], /Not a Triad\+ control workspace/],
  [["cockpit", "--control", control, "--port", "http"], /--port must be an integer/],
  [["cockpit", "--control", control, "--port", "70000"], /--port must be an integer/],
  [["cockpit", "--control", control, "--port"], /--port requires a value/],
  [["version", "--control", control, "--port", "4000"], /Unknown argument: --port/],
]) {
  const result = run(args);
  assert.equal(result.status, 2, `${args.join(" ")} must fail`);
  assert.match(result.stderr, message);
}

// Existing commands behave as before on the same workspace.
const version = run(["version", "--control", control]);
assert.equal(version.status, 0);
assert.match(version.stdout, /Installed Triad\s+1\.15\.0/);

// A real start: loopback URL with a one-time code, the shell, the API, and a
// clean stop on SIGINT.
async function snapshot(directory) {
  const lines = [];
  for (const entry of (await readdir(directory, { withFileTypes: true, recursive: true })).sort((a, b) => path.join(a.parentPath, a.name).localeCompare(path.join(b.parentPath, b.name)))) {
    const full = path.join(entry.parentPath, entry.name);
    lines.push(entry.isFile() ? `${full} ${createHash("sha256").update(await readFile(full)).digest("hex")}` : full);
  }
  return lines.join("\n");
}
const before = await snapshot(control);
const child = spawn(process.execPath, [cli, "cockpit", "--control", control, "--port", "0"], { stdio: ["ignore", "pipe", "pipe"] });
let stdout = "";
let stderr = "";
child.stdout.on("data", (chunk) => { stdout += chunk; });
child.stderr.on("data", (chunk) => { stderr += chunk; });
const exited = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
const deadline = Date.now() + 10_000;
while (!/session\?code=[0-9a-f]{64}/.test(stdout) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
const launch = /http:\/\/127\.0\.0\.1:(\d+)\/api\/session\?code=([0-9a-f]{64})/.exec(stdout);
assert.ok(launch, `the CLI prints a loopback session URL:\n${stdout}\n${stderr}`);
assert.match(stdout, /Triad Cockpit \(read-only\)/);
assert.match(stdout, /loopback only/);
const [, port, code] = launch;
const base = `http://127.0.0.1:${port}`;

const login = await fetch(`${base}/api/session?code=${code}`, { redirect: "manual" });
assert.equal(login.status, 303);
assert.equal(login.headers.get("location"), "/");
const cookie = login.headers.get("set-cookie").split(";")[0];
const shell = await fetch(`${base}/`);
assert.equal(shell.status, 200);
assert.match(shell.headers.get("content-type"), /text\/html/);
assert.match(await shell.text(), /<div id="root">/);
const workspace = await fetch(`${base}/api/workspace`, { headers: { cookie } });
assert.equal(workspace.status, 200);
assert.deepEqual((await workspace.json()).projects.map((project) => project.id), ["root", "mobile-shell"]);
assert.equal((await fetch(`${base}/api/workspace`)).status, 401);

child.kill("SIGINT");
const { code: exitCode } = await exited;
assert.equal(exitCode, 0, `Ctrl+C stops the server cleanly\n${stderr}`);
assert.ok(!stderr.includes(code), "the login code is not logged");
assert.ok(!/\?/.test(stderr), "request logs carry no query strings");
const after = await snapshot(control);
assert.equal(after, before, "running the Cockpit does not modify the control workspace");

// Installer commands never load the Cockpit server.
const binSource = await readFile(cli, "utf8");
assert.ok(!/^import .*cockpit/m.test(binSource), "the Cockpit is imported lazily, only by the cockpit command");

process.stdout.write("cockpit CLI tests passed\n");
