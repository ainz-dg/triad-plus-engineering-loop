import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { App } from "../App";
// @ts-expect-error plain ESM module without types
import { startCockpitServer } from "../../../server/server.mjs";

// F4: data of one project must never be presented under another project's
// context, even when both have a card with the same ID, navigation is fast,
// and responses arrive late or out of order. A MutationObserver checks every
// DOM commit, not only the final screen.

type Started = { port: number; token: string; close: () => Promise<void> };

const TITLES: Record<string, Record<string, string>> = {
  alpha: { "SHARED-1": "Alpha version of the shared card", "ALPHA-2": "Only in alpha" },
  beta: { "SHARED-1": "Beta version of the shared card", "BETA-2": "Only in beta" },
};

const nodeFetch = globalThis.fetch;
let server: Started;
let delays: Record<string, number> = {};
let failing = false;
let inFlight = 0;
const violations: string[] = [];
let observer: MutationObserver | null = null;

async function writeQueue(control: string, project: string) {
  const directory = path.join(control, "projects", project, ".loop");
  await mkdir(directory, { recursive: true });
  const items = Object.entries(TITLES[project]).map(([id, title]) => `  - id: ${id}\n    title: ${title}\n    state: ready\n`).join("");
  await writeFile(path.join(directory, "work-queue.yaml"), `items:\n${items}`, "utf8");
}

function installFetch() {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const project = /\/api\/projects\/([^/]+)\//.exec(url)?.[1] ?? "";
    inFlight += 1;
    try {
      // Delays ignore the abort signal on purpose: a response may still land
      // after the UI moved on, which is the race under test.
      await new Promise((resolve) => setTimeout(resolve, delays[project] ?? 0));
      if (failing) throw new TypeError("fetch failed");
      const headers = new Headers(init?.headers);
      headers.set("authorization", `Bearer ${server.token}`);
      const response = await nodeFetch(`http://127.0.0.1:${server.port}${url}`, { ...init, headers, signal: undefined });
      // Buffer the body so the response is complete before it counts as landed.
      const body = await response.arrayBuffer();
      return new Response(body, { status: response.status, headers: response.headers });
    } finally {
      inFlight -= 1;
    }
  }) as typeof fetch;
}

/** Record any DOM state where shown data belongs to another project. */
function check() {
  const context = document.querySelector(".crumbs li:nth-child(2) a")?.textContent ?? null;
  if (!context || !TITLES[context]) return;
  const listTitle = document.getElementById("project-title")?.textContent;
  if (listTitle && listTitle !== context) violations.push(`list titled ${listTitle} under ${context}`);
  for (const title of document.querySelectorAll(".card-row .card-title")) {
    if (!Object.values(TITLES[context]).includes(title.textContent ?? "")) violations.push(`card row "${title.textContent}" under ${context}`);
  }
  const heading = document.getElementById("card-title")?.textContent;
  if (heading && !Object.values(TITLES[context]).includes(heading)) violations.push(`card detail "${heading}" under ${context}`);
}

function go(hash: string) {
  act(() => {
    window.location.hash = hash;
  });
}

const settle = (ms: number) => act(() => new Promise((resolve) => setTimeout(resolve, ms)));
// Wait until every request, including superseded ones, has landed, then let
// React flush: assertions after this see the effect of every late response.
const drain = async () => {
  await waitFor(() => expect(inFlight).toBe(0), { timeout: 3000 });
  await settle(20);
};

beforeAll(async () => {
  const root = await mkdtemp(path.join(tmpdir(), "triad-cockpit-isolation-"));
  const control = path.join(root, "control");
  await writeQueue(control, "alpha");
  await writeQueue(control, "beta");
  server = await startCockpitServer({ controlRoot: control });
});

afterAll(async () => {
  globalThis.fetch = nodeFetch;
  await server?.close();
});

beforeEach(() => {
  delays = {};
  inFlight = 0;
  failing = false;
  violations.length = 0;
  installFetch();
  window.history.replaceState(null, "", "/#/");
  observer = new MutationObserver(check);
  observer.observe(document.body, { subtree: true, childList: true, characterData: true });
});

afterEach(() => {
  observer?.disconnect();
  cleanup();
});

describe("F4: project isolation with a shared card ID", () => {
  it("never shows beta's card while alpha's same-ID card is loading", async () => {
    go("#/p/beta/c/SHARED-1");
    render(<App />);
    await screen.findByRole("heading", { level: 1, name: TITLES.beta["SHARED-1"] });
    delays = { alpha: 250 };
    go("#/p/alpha/c/SHARED-1");
    // While alpha is in flight the detail must be a loading state, not beta's card.
    await settle(60);
    expect(screen.queryByRole("heading", { level: 1, name: TITLES.beta["SHARED-1"] })).toBeNull();
    await screen.findByRole("heading", { level: 1, name: TITLES.alpha["SHARED-1"] });
    expect(violations).toEqual([]);
  });

  it("ignores a late response for the previous project", async () => {
    go("#/p/beta/c/SHARED-1");
    render(<App />);
    await screen.findByRole("heading", { level: 1, name: TITLES.beta["SHARED-1"] });
    delays = { alpha: 300, beta: 0 };
    go("#/p/alpha/c/SHARED-1");
    await settle(20);
    go("#/p/beta/c/SHARED-1");
    await screen.findByRole("heading", { level: 1, name: TITLES.beta["SHARED-1"] });
    // Let alpha's late responses arrive; they must not replace beta's data.
    await drain();
    expect(document.getElementById("card-title")?.textContent).toBe(TITLES.beta["SHARED-1"]);
    expect(document.getElementById("project-title")?.textContent).toBe("beta");
    expect(violations).toEqual([]);
  });

  it("stays consistent through rapid alternation with out-of-order responses", async () => {
    go("#/p/alpha/c/SHARED-1");
    render(<App />);
    await screen.findByRole("heading", { level: 1, name: TITLES.alpha["SHARED-1"] });
    const sequence = ["beta", "alpha", "beta", "alpha", "beta", "alpha", "beta"];
    for (const [index, project] of sequence.entries()) {
      delays = { alpha: (index % 3) * 70 + 20, beta: ((index + 1) % 3) * 90 + 10 };
      go(`#/p/${project}/c/SHARED-1`);
      await settle(15);
    }
    await drain();
    expect(document.getElementById("card-title")?.textContent).toBe(TITLES.beta["SHARED-1"]);
    expect([...document.querySelectorAll(".card-row .card-title")].map((node) => node.textContent).sort()).toEqual(Object.values(TITLES.beta).sort());
    expect(violations).toEqual([]);
  });

  it("does not carry a card list across projects while the new list loads", async () => {
    go("#/p/alpha");
    render(<App />);
    await screen.findByText(TITLES.alpha["ALPHA-2"]);
    delays = { beta: 250 };
    go("#/p/beta");
    await settle(60);
    expect(screen.queryByText(TITLES.alpha["ALPHA-2"])).toBeNull();
    await screen.findByText(TITLES.beta["BETA-2"]);
    expect(violations).toEqual([]);
  });
});

describe("refresh label", () => {
  const label = () => document.querySelector(".refresh-label")?.textContent ?? "";

  it("says Refreshing while a refresh is in flight and Updated only after it succeeds", async () => {
    go("#/p/alpha/c/SHARED-1");
    render(<App />);
    await screen.findByRole("heading", { level: 1, name: TITLES.alpha["SHARED-1"] });
    await waitFor(() => expect(label()).toMatch(/^Updated \d{2}:\d{2}:\d{2}$/));
    delays = { alpha: 250 };
    fireEvent.click(screen.getByRole("button", { name: /Refresh data/ }));
    await settle(30);
    expect(label()).toBe("Refreshing…");
    // A refresh of the same card keeps its data on screen.
    expect(document.getElementById("card-title")?.textContent).toBe(TITLES.alpha["SHARED-1"]);
    await waitFor(() => expect(label()).toMatch(/^Updated \d{2}:\d{2}:\d{2}$/));
  });

  it("reports a failed refresh instead of a new update time", async () => {
    go("#/p/alpha");
    render(<App />);
    await screen.findByText(TITLES.alpha["ALPHA-2"]);
    await waitFor(() => expect(label()).toMatch(/^Updated /));
    failing = true;
    fireEvent.click(screen.getByRole("button", { name: /Refresh data/ }));
    await waitFor(() => expect(label()).toBe("Update failed"));
    expect(screen.getByRole("button", { name: /Refresh data/ }).getAttribute("aria-label")).toContain("failed");
  });
});
