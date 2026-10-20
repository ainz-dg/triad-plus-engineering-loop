import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { createDemoWorkspace } from "./fixtures/cockpit-demo-workspace.mjs";
import { canAutoOpenBrowser, openSessionUrl } from "../cockpit/launcher/open-browser.mjs";
import { resolveCockpitOptions } from "../cockpit/server/launch.mjs";

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
assert.match(help.stdout, /npx triad-plus cockpit \[--control <path>\] \[--port <n>\] \[--no-open\]/);
const wizard = run([], { input: "" });
assert.equal(wizard.status, 2);
assert.match(wizard.stderr, /interactive wizard needs a terminal/, "no-argument behaviour is unchanged");

// Validation failures exit 2 with a clear message and start nothing.
for (const [args, message] of [
  [["cockpit"], /Not a Triad\+ control workspace/],
  [["cockpit", "--control", path.join(root, "missing")], /Control workspace does not exist/],
  [["cockpit", "--control", notControl], /Not a Triad\+ control workspace/],
  [["cockpit", "--control", control, "--port", "http"], /--port must be an integer/],
  [["cockpit", "--control", control, "--port", "70000"], /--port must be an integer/],
  [["cockpit", "--control", control, "--port"], /--port requires a value/],
  [["version", "--control", control, "--port", "4000"], /Unknown argument: --port/],
  [["version", "--control", control, "--no-open"], /Unknown argument: --no-open/],
]) {
  const result = run(args, args[0] === "cockpit" ? { cwd: notControl } : {});
  assert.equal(result.status, 2, `${args.join(" ")} must fail`);
  assert.match(result.stderr, message);
}
assert.equal(resolveCockpitOptions({ port: "0", cwd: control }).controlRoot, path.resolve(control), "an omitted --control uses exactly the current directory");
assert.equal(resolveCockpitOptions({ control, port: "0", cwd: notControl }).controlRoot, path.resolve(control), "an explicit --control still overrides cwd");

// Browser opening is suppressed outside a local interactive desktop and can
// be disabled explicitly. A supported opener receives one URL argument, never
// shell input; asynchronous failures do not echo the one-time code.
assert.equal(canAutoOpenBrowser({ platform: "darwin", env: {}, isInteractive: false }), false, "headless launches do not open a browser");
assert.equal(canAutoOpenBrowser({ platform: "darwin", env: { CI: "true" }, isInteractive: true }), false, "CI launches do not open a browser");
assert.equal(canAutoOpenBrowser({ platform: "darwin", env: { SSH_CONNECTION: "host" }, isInteractive: true }), false, "remote launches do not open a browser");
assert.equal(canAutoOpenBrowser({ platform: "linux", env: {}, isInteractive: true }), false, "Linux without a display does not open a browser");
assert.equal(canAutoOpenBrowser({ platform: "darwin", env: {}, isInteractive: true, noOpen: true }), false, "--no-open disables browser launch");
const launchUrl = "http://127.0.0.1:3000/api/session?code=secret-one-time-code";
let openerCall;
let openerErrorOutput = "";
const fakeOpener = new EventEmitter();
fakeOpener.unref = () => {};
assert.equal(openSessionUrl(launchUrl, {
  platform: "linux",
  env: { DISPLAY: ":0" },
  isInteractive: true,
  spawnImpl: (...args) => { openerCall = args; return fakeOpener; },
  err: { write: (value) => { openerErrorOutput += value; } },
}), true);
assert.equal(openerCall[0], "xdg-open");
assert.deepEqual(openerCall[1], [launchUrl]);
assert.notEqual(openerCall[2].shell, true, "the URL is never passed through a shell");
fakeOpener.emit("error", new Error(`opener failed with ${launchUrl}`));
fakeOpener.emit("close", 1);
assert.match(openerErrorOutput, /use the one-time URL printed above/);
assert.equal((openerErrorOutput.match(/Could not open a browser automatically/g) ?? []).length, 1, "opener failure is reported once");
assert.ok(!openerErrorOutput.includes("secret-one-time-code"), "opener failures never log the one-time code");
const macOpener = new EventEmitter();
macOpener.unref = () => {};
let macCommand;
assert.equal(openSessionUrl(launchUrl, {
  platform: "darwin", env: {}, isInteractive: true,
  spawnImpl: (command, args, options) => { macCommand = { command, args, options }; return macOpener; },
  err: { write() {} },
}), true);
assert.equal(macCommand.command, "open", "macOS uses its native URL opener");
assert.deepEqual(macCommand.args, [launchUrl]);
assert.notEqual(macCommand.options.shell, true);
let noOpenSpawned = false;
assert.equal(openSessionUrl(launchUrl, {
  noOpen: true, platform: "darwin", env: {}, isInteractive: true,
  spawnImpl: () => { noOpenSpawned = true; throw new Error("must not run"); },
  err: { write() {} },
}), false);
assert.equal(noOpenSpawned, false);

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
const child = spawn(process.execPath, [cli, "cockpit", "--control", control, "--port", "0", "--no-open"], { stdio: ["ignore", "pipe", "pipe"] });
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

// The public CLI path without --control validates cwd and also starts normally.
const cwdChild = spawn(process.execPath, [cli, "cockpit", "--port", "0", "--no-open"], { cwd: control, stdio: ["ignore", "pipe", "pipe"] });
let cwdStdout = "";
let cwdStderr = "";
cwdChild.stdout.on("data", (chunk) => { cwdStdout += chunk; });
cwdChild.stderr.on("data", (chunk) => { cwdStderr += chunk; });
const cwdExited = new Promise((resolve) => cwdChild.on("exit", (code, signal) => resolve({ code, signal })));
const cwdDeadline = Date.now() + 10_000;
while (!/session\?code=[0-9a-f]{64}/.test(cwdStdout) && Date.now() < cwdDeadline) await new Promise((resolve) => setTimeout(resolve, 50));
assert.match(cwdStdout, /http:\/\/127\.0\.0\.1:\d+\/api\/session\?code=[0-9a-f]{64}/, `omitted --control launches from cwd:\n${cwdStdout}\n${cwdStderr}`);
cwdChild.kill("SIGINT");
assert.equal((await cwdExited).code, 0, "the cwd launch also stops cleanly");

// Installer commands never load the Cockpit server.
const binSource = await readFile(cli, "utf8");
assert.ok(!/^import .*cockpit/m.test(binSource), "the Cockpit is imported lazily, only by the cockpit command");

process.stdout.write("cockpit CLI tests passed\n");
