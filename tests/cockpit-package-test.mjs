import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDemoWorkspace } from "./fixtures/cockpit-demo-workspace.mjs";

// The npm package ships the Cockpit ready to run: compiled UI and server, no
// UI sources or build tooling, and still zero runtime dependencies. Then the
// packed tarball is installed in a clean directory and the Cockpit is started
// from the installed copy.

const repositoryRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const DIST_BUDGET_BYTES = 400 * 1024;

const manifest = JSON.parse(await readFile(path.join(repositoryRoot, "package.json"), "utf8"));
for (const field of ["dependencies", "optionalDependencies", "peerDependencies", "bundleDependencies", "bundledDependencies"]) {
  assert.ok(!manifest[field] || Object.keys(manifest[field]).length === 0, `package.json must keep zero ${field}`);
}
assert.ok(!manifest.scripts.install && !manifest.scripts.postinstall && !manifest.scripts.preinstall, "no install-time scripts");

// --- Packed file list -------------------------------------------------------

const dry = spawnSync(npm, ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: repositoryRoot, encoding: "utf8" });
assert.equal(dry.status, 0, dry.stderr);
const parsed = JSON.parse(dry.stdout);
const pack = Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0];
const files = new Map(pack.files.map((file) => [file.path, file.size]));

const dist = await readdir(path.join(repositoryRoot, "cockpit", "dist"), { recursive: true, withFileTypes: true });
const distFiles = dist.filter((entry) => entry.isFile()).map((entry) => path.relative(repositoryRoot, path.join(entry.parentPath, entry.name)).split(path.sep).join("/"));
assert.ok(distFiles.includes("cockpit/dist/index.html"), "cockpit/dist must be built (npm run cockpit:build)");
for (const file of distFiles) assert.ok(files.has(file), `${file} must be in the tarball`);
for (const file of ["server.mjs", "launch.mjs", "model.mjs", "safe-fs.mjs", "static.mjs", "work-queue.mjs", "evidence-contract.mjs"]) {
  assert.ok(files.has(`cockpit/server/${file}`), `cockpit/server/${file} must be in the tarball`);
}
for (const file of files.keys()) {
  assert.ok(!file.startsWith("cockpit/web/"), `UI sources must not ship: ${file}`);
  assert.ok(!file.includes("node_modules/"), `node_modules must not ship: ${file}`);
  assert.ok(!file.startsWith("tests/fixtures/"), `test fixtures must not ship: ${file}`);
  assert.ok(!file.endsWith(".map"), `source maps must not ship: ${file}`);
}

// Every asset the HTML references is shipped.
const html = await readFile(path.join(repositoryRoot, "cockpit", "dist", "index.html"), "utf8");
for (const [, reference] of html.matchAll(/(?:src|href)="\/([^"]+)"/g)) {
  assert.ok(files.has(`cockpit/dist/${reference}`), `index.html references ${reference}, which is not packed`);
}

const distBytes = distFiles.reduce((total, file) => total + files.get(file), 0);
assert.ok(distBytes <= DIST_BUDGET_BYTES, `cockpit/dist is ${distBytes} bytes, over the ${DIST_BUDGET_BYTES}-byte budget`);
process.stdout.write(`tarball: ${pack.size} bytes packed, ${pack.unpackedSize} unpacked, ${pack.entryCount ?? files.size} files; cockpit/dist ${distBytes} bytes\n`);

// --- Install the tarball in a clean directory and start the Cockpit ----------

const work = await mkdtemp(path.join(tmpdir(), "triad-cockpit-pack-"));
const packed = spawnSync(npm, ["pack", "--ignore-scripts", "--pack-destination", work, "--json"], { cwd: repositoryRoot, encoding: "utf8" });
assert.equal(packed.status, 0, packed.stderr);
const packedInfo = JSON.parse(packed.stdout);
const tarball = path.join(work, (Array.isArray(packedInfo) ? packedInfo[0] : Object.values(packedInfo)[0]).filename);
const app = path.join(work, "clean-app");
await mkdir(app);
const install = spawnSync(npm, ["install", "--offline", "--no-audit", "--no-fund", "--ignore-scripts", tarball], { cwd: app, encoding: "utf8" });
assert.equal(install.status, 0, install.stderr);
const installedRoot = path.join(app, "node_modules", "triad-plus");
const installedEntries = await readdir(path.join(app, "node_modules"));
assert.deepEqual(installedEntries.filter((name) => !name.startsWith(".")), ["triad-plus"], "installing triad-plus pulls in no other package");

const control = await createDemoWorkspace(path.join(work, "workspace"));
const child = spawn(process.execPath, [path.join(installedRoot, "bin", "triad-plus.js"), "cockpit", "--control", control, "--port", "0"], { cwd: app, stdio: ["ignore", "pipe", "pipe"] });
let stdout = "";
child.stdout.on("data", (chunk) => { stdout += chunk; });
const exited = new Promise((resolve) => child.on("exit", (code) => resolve(code)));
const deadline = Date.now() + 10_000;
while (!/code=[0-9a-f]{64}/.test(stdout) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
const launch = /http:\/\/127\.0\.0\.1:(\d+)\/api\/session\?code=([0-9a-f]{64})/.exec(stdout);
assert.ok(launch, `the installed CLI prints a session URL:\n${stdout}`);
assert.ok(!stdout.includes("UI assets are not built"), "the installed package includes the compiled UI");
const base = `http://127.0.0.1:${launch[1]}`;
try {
  const shell = await fetch(`${base}/`);
  assert.equal(shell.status, 200);
  const page = await shell.text();
  for (const [, reference] of page.matchAll(/(?:src|href)="(\/[^"]+)"/g)) {
    assert.equal((await fetch(`${base}${reference}`)).status, 200, `${reference} is served from the installed package`);
  }
  const login = await fetch(`${base}/api/session?code=${launch[2]}`, { redirect: "manual" });
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const cards = await fetch(`${base}/api/projects/root/cards`, { headers: { cookie } });
  assert.equal(cards.status, 200);
  assert.ok((await cards.json()).cards.some((card) => card.id === "NOTE-101"));
} finally {
  child.kill("SIGINT");
}
assert.equal(await exited, 0);

process.stdout.write("cockpit package tests passed\n");
