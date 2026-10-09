import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Compiled UI assets, loaded once at startup into an in-memory table keyed by
// URL path. Requests are looked up in that table and never joined into a
// filesystem path, so static routes cannot reach anything but these files.
// The assets are the same bytes shipped in the npm package; they contain no
// workspace data, which stays behind the session-protected /api routes.

export const DIST_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "dist");
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
};
const MAX_ASSET_BYTES = 5 * 1024 * 1024;

// Only what the UI needs: local scripts, styles, images, and same-origin API
// calls. No inline script or style, no eval, no external origin, no framing.
export const APP_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self'",
  "font-src 'self'",
  "connect-src 'self'",
  "manifest-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

function walk(directory, prefix = "") {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const full = path.join(directory, entry.name);
    const url = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) files.push(...walk(full, url));
    else if (entry.isFile()) files.push({ full, url });
  }
  return files;
}

/**
 * Load the compiled UI. Returns `{ available, assets: Map<url, asset> }`; a
 * missing build yields `available: false` and the API keeps working.
 */
export function loadStaticAssets(root = DIST_ROOT) {
  const assets = new Map();
  let index;
  try { index = statSync(path.join(root, "index.html")); } catch { return { available: false, assets }; }
  if (!index.isFile()) return { available: false, assets };
  for (const { full, url } of walk(root)) {
    const type = TYPES[path.extname(full).toLowerCase()];
    if (!type) continue;
    const body = readFileSync(full);
    if (body.length > MAX_ASSET_BYTES) continue;
    // Hashed bundle names are immutable; everything else is revalidated.
    const immutable = url.startsWith("/assets/") && /-[A-Za-z0-9_-]{8,}\.[a-z0-9]+$/.test(url);
    assets.set(url, { body, type, immutable });
  }
  const html = assets.get("/index.html");
  if (html) assets.set("/", html);
  return { available: assets.has("/"), assets };
}
