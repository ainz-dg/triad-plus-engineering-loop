import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { discoverProjects, readArtifact, readCard, readControlRun, readWorkspace, listCards } from "./model.mjs";
import { AccessError, createWorkspaceReader } from "./safe-fs.mjs";
import { APP_CSP, loadStaticAssets } from "./static.mjs";

// Read-only HTTP surface for one control workspace. Stateless: every request
// re-reads the artifacts, nothing is cached or written, no process is spawned.

const LOOPBACK = "127.0.0.1";
const COOKIE = "triad_cockpit_session";
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const cockpitVersion = JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8")).version;

const SECURITY_HEADERS = {
  "Cache-Control": "no-store",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
};

function send(response, status, body, extraHeaders = {}) {
  const payload = `${JSON.stringify(body, null, 2)}\n`;
  response.writeHead(status, {
    ...SECURITY_HEADERS,
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    ...extraHeaders,
  });
  response.end(response.req.method === "HEAD" ? undefined : payload);
}

function error(response, status, code, message, extraHeaders) {
  send(response, status, { error: { code, message } }, extraHeaders);
}

function sameSecret(expected, supplied) {
  if (typeof supplied !== "string") return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(supplied);
  return a.length === b.length && timingSafeEqual(a, b);
}

function cookieToken(header) {
  if (typeof header !== "string") return null;
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === COOKIE) return rest.join("=");
  }
  return null;
}

function bearerToken(header) {
  const match = typeof header === "string" ? /^Bearer\s+(\S+)$/.exec(header) : null;
  return match ? match[1] : null;
}

/**
 * Build the request handler.
 *
 * Two secrets: `token` is the session secret (cookie or Bearer) and never
 * appears in a URL; `loginCode` is a one-time code that may appear in the
 * launch URL and is exchanged, once, for the session cookie via a 303 redirect
 * to a token-free location. `log` receives only method, route template, and
 * status: never query strings, secrets, paths, or artifact content.
 */
export async function createCockpitHandler({ controlRoot, token, loginCode = null, log = () => {}, staticAssets = loadStaticAssets() }) {
  if (typeof token !== "string" || token.length < 32) throw new Error("a session token of at least 32 characters is required");
  if (loginCode !== null && (typeof loginCode !== "string" || loginCode.length < 32 || loginCode === token)) {
    throw new Error("a distinct one-time login code of at least 32 characters is required");
  }
  const reader = await createWorkspaceReader(controlRoot);
  let allowedHosts = new Set();
  let pendingCode = loginCode;

  const routes = [
    { method: "GET", pattern: /^\/api\/session$/, name: "/api/session", handler: session, public: true },
    { method: "GET", pattern: /^\/api\/workspace$/, name: "/api/workspace", handler: async () => [200, await readWorkspace(reader, { cockpitVersion })] },
    { method: "GET", pattern: /^\/api\/projects\/([^/]+)\/cards$/, name: "/api/projects/:project/cards", handler: withProject(async (project) => [200, await listCards(reader, project)]) },
    {
      method: "GET",
      pattern: /^\/api\/projects\/([^/]+)\/cards\/([^/]+)$/,
      name: "/api/projects/:project/cards/:card",
      handler: withProject(async (project, [cardId]) => {
        const card = await readCard(reader, project, cardId);
        return card ? [200, card] : [404, { error: { code: "card_not_found", message: "no artifact names this card" } }];
      }),
    },
    {
      method: "GET",
      pattern: /^\/api\/projects\/([^/]+)\/control-run$/,
      name: "/api/projects/:project/control-run",
      handler: withProject(async (project) => {
        const run = await readControlRun(reader, project);
        return run ? [200, run] : [404, { error: { code: "control_run_not_found", message: "the optional deterministic driver has not written output at its default path" } }];
      }),
    },
    {
      method: "GET",
      pattern: /^\/api\/projects\/([^/]+)\/files$/,
      name: "/api/projects/:project/files",
      handler: withProject(async (project, _params, url) => {
        const requested = url.searchParams.get("path");
        if (!requested) return [400, { error: { code: "path_required", message: "query parameter path is required" } }];
        const artifact = await readArtifact(reader, project, requested);
        return artifact ? [200, artifact] : [404, { error: { code: "file_not_found", message: "no such allowlisted file" } }];
      }),
    },
  ];

  function withProject(inner) {
    return async (params, url) => {
      const [projectId, ...rest] = params;
      // Project IDs are matched against discovery, never joined into a path.
      const project = (await discoverProjects(reader)).find((candidate) => candidate.id === projectId);
      if (!project) return [404, { error: { code: "project_not_found", message: "unknown project" } }];
      return inner(project, rest, url);
    };
  }

  async function session(_params, url, response) {
    // Single use: once exchanged (or if none was issued) the code is dead, so a
    // copy left in terminal scrollback, history, or a screenshot is worthless.
    if (pendingCode === null || !sameSecret(pendingCode, url.searchParams.get("code"))) {
      return [401, { error: { code: "unauthorized", message: "invalid or already used login code" } }];
    }
    pendingCode = null;
    response.setHeader("Set-Cookie", `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/`);
    // 303 to a fixed, query-free location removes the code from the address bar.
    return [303, null, { Location: "/" }];
  }

  // The UI shell is public (it ships in the npm package and holds no workspace
  // data); every data request goes through the session-protected /api routes.
  function serveStatic(pathname, response) {
    const asset = staticAssets.assets.get(pathname);
    if (!asset) {
      if (pathname === "/" && !staticAssets.available) {
        error(response, 503, "ui_not_built", "the Cockpit UI assets are not built; the read-only API is still available");
      } else {
        error(response, 404, "not_found", "unknown resource");
      }
      return;
    }
    const html = asset.type.startsWith("text/html");
    response.writeHead(200, {
      ...SECURITY_HEADERS,
      ...(html ? { "Content-Security-Policy": APP_CSP, "Cross-Origin-Opener-Policy": "same-origin" } : {}),
      "Cache-Control": asset.immutable ? "public, max-age=31536000, immutable" : "no-cache",
      "Content-Type": asset.type,
      "Content-Length": asset.body.length,
    });
    response.end(response.req.method === "HEAD" ? undefined : asset.body);
  }

  async function handle(request, response) {
    let route = "unmatched";
    try {
      // Host must name the loopback listener; this blocks DNS-rebinding.
      if (!allowedHosts.has(String(request.headers.host ?? "").toLowerCase())) {
        error(response, 403, "host_rejected", "unexpected Host header");
        return;
      }
      if (request.method !== "GET" && request.method !== "HEAD") {
        error(response, 405, "method_not_allowed", "the Cockpit API is read-only", { Allow: "GET, HEAD" });
        return;
      }
      let url;
      try { url = new URL(request.url, "http://cockpit.invalid"); }
      catch { error(response, 400, "bad_request", "malformed request target"); return; }

      if (!url.pathname.startsWith("/api/")) {
        route = "static";
        serveStatic(url.pathname, response);
        return;
      }
      const matched = routes.find((candidate) => candidate.pattern.test(url.pathname));
      if (!matched) {
        error(response, 404, "not_found", "unknown endpoint");
        return;
      }
      route = matched.name;
      if (!matched.public) {
        const supplied = bearerToken(request.headers.authorization) ?? cookieToken(request.headers.cookie);
        if (!sameSecret(token, supplied)) {
          error(response, 401, "unauthorized", "a valid session is required");
          return;
        }
      }
      let params;
      try { params = matched.pattern.exec(url.pathname).slice(1).map((value) => decodeURIComponent(value)); }
      catch { error(response, 400, "bad_request", "malformed path parameter"); return; }
      const [status, body, headers] = await matched.handler(params, url, response);
      if (body === null) {
        response.writeHead(status, { ...SECURITY_HEADERS, "Content-Length": 0, ...headers });
        response.end();
      } else {
        send(response, status, body, headers);
      }
    } catch (caught) {
      if (caught instanceof AccessError) error(response, 403, caught.code, caught.message);
      else error(response, 500, "internal_error", "the request could not be completed");
    } finally {
      log({ method: request.method, route, status: response.statusCode });
    }
  }

  handle.setListeningPort = (port) => {
    allowedHosts = new Set([`${LOOPBACK}:${port}`, `localhost:${port}`]);
  };
  return handle;
}

/** Start the server on 127.0.0.1 only. Resolves once listening. */
export async function startCockpitServer({ controlRoot, port = 0, host = LOOPBACK, token = randomBytes(32).toString("hex"), log, staticAssets = loadStaticAssets() } = {}) {
  if (host !== LOOPBACK) throw new Error(`the Cockpit binds only to ${LOOPBACK}`);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("port must be an integer between 0 and 65535");
  const loginCode = randomBytes(32).toString("hex");
  const handler = await createCockpitHandler({ controlRoot, token, loginCode, log, staticAssets });
  const server = http.createServer(handler);
  server.headersTimeout = 10_000;
  server.requestTimeout = 30_000;
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, LOOPBACK, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  handler.setListeningPort(address.port);
  return {
    server,
    token,
    address: address.address,
    uiAvailable: staticAssets.available,
    port: address.port,
    // Carries only the one-time code, never the session secret.
    sessionUrl: `http://${LOOPBACK}:${address.port}/api/session?code=${loginCode}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
