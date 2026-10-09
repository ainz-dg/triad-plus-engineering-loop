// Deterministic screenshots through the Chrome DevTools Protocol (no
// dependencies): every shot pins its viewport, device type, and color scheme,
// so the result never depends on the host's light/dark setting.
// Usage: node cdp-shots.mjs <loginUrl> <outDir> <profileDir>
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";

const [loginUrl, outDir, profile] = process.argv.slice(2);
const SHOTS = [
  { name: "01-desktop-dark-card-detail.png", hash: "#/p/root/c/NOTE-101", width: 1440, height: 900, mobile: false, scheme: "dark" },
  { name: "02-desktop-light-card-attention.png", hash: "#/p/root/c/NOTE-104", width: 1440, height: 900, mobile: false, scheme: "light" },
  { name: "03-desktop-dark-artifact-viewer.png", hash: "#/p/root/c/NOTE-101?file=.loop%2Fevidence%2FNOTE-101%2Fattempt-002%2Freview-report.md", width: 1440, height: 900, mobile: false, scheme: "dark" },
  { name: "04-mobile-dark-card-list.png", hash: "#/p/root", width: 375, height: 812, mobile: true, scheme: "dark" },
  { name: "05-mobile-dark-card-signals.png", hash: "#/p/root/c/NOTE-102", width: 375, height: 812, mobile: true, scheme: "dark" },
  { name: "06-mobile-dark-freshness-gates.png", hash: "#/p/root/c/NOTE-102", width: 375, height: 812, mobile: true, scheme: "dark", scrollY: 1250 },
  { name: "07-tablet-light-card.png", hash: "#/p/root/c/NOTE-102", width: 900, height: 1100, mobile: false, scheme: "light" },
];

const chrome = spawn("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", [
  "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
  `--user-data-dir=${profile}`, "--remote-debugging-port=9333", "about:blank",
], { stdio: "ignore" });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let target;
for (let i = 0; i < 50 && !target; i += 1) {
  try { target = (await (await fetch("http://127.0.0.1:9333/json")).json()).find((t) => t.type === "page"); } catch { await sleep(200); }
}
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve) => ws.addEventListener("open", resolve, { once: true }));
let id = 0;
const pending = new Map();
ws.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); }
});
const send = (method, params = {}) => new Promise((resolve) => { id += 1; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })); });
const evaluate = async (expression) => (await send("Runtime.evaluate", { expression, returnByValue: true })).result.result.value;

await send("Page.enable");
await send("Page.navigate", { url: loginUrl });
await sleep(1500);

for (const shot of SHOTS) {
  await send("Emulation.setDeviceMetricsOverride", { width: shot.width, height: shot.height, deviceScaleFactor: shot.mobile ? 2 : 1, mobile: shot.mobile });
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: shot.scheme }] });
  await send("Page.navigate", { url: `http://127.0.0.1:4317/${shot.hash}` });
  await sleep(1500);
  // Every shot sets its own scroll position; nothing carries over from the previous one.
  await evaluate(`document.querySelectorAll('.pane').forEach((pane) => pane.scrollTo(0, 0)); document.querySelector('.pane-detail')?.scrollTo(0, ${shot.scrollY ?? 0})`);
  await sleep(400);
  const facts = JSON.parse(await evaluate(`JSON.stringify({
    width: innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
    scheme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
    pinnedTheme: document.documentElement.getAttribute('data-theme'),
    status: document.querySelector('.refresh-label')?.textContent ?? null,
  })`));
  const { result } = await send("Page.captureScreenshot", { format: "png" });
  await writeFile(path.join(outDir, shot.name), Buffer.from(result.data, "base64"));
  console.log(JSON.stringify({ file: shot.name, viewport: `${shot.width}x${shot.height}${shot.mobile ? " mobile@2x" : ""}`, ...facts }));
}
ws.close();
chrome.kill();
