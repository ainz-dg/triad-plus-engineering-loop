import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { App } from "../App";
// The real backend and the shared synthetic workspace: these tests exercise
// the UI against the approved API, not against mocks.
// @ts-expect-error plain ESM module without types
import { startCockpitServer } from "../../../server/server.mjs";
// @ts-expect-error plain ESM module without types
import { createDemoWorkspace } from "../../../../tests/fixtures/cockpit-demo-workspace.mjs";

type Started = { port: number; token: string; close: () => Promise<void> };

const nodeFetch = globalThis.fetch;
let server: Started;
let emptyServer: Started;
let mode: "ok" | "unauthorized" | "unreachable" = "ok";
let target: Started;

function installFetch() {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (mode === "unreachable") throw new TypeError("fetch failed");
    const url = `http://127.0.0.1:${target.port}${String(input)}`;
    const headers = new Headers(init?.headers);
    headers.set("authorization", `Bearer ${mode === "unauthorized" ? "wrong-token" : target.token}`);
    return nodeFetch(url, { ...init, headers, signal: undefined });
  }) as typeof fetch;
}

beforeAll(async () => {
  const root = await mkdtemp(path.join(tmpdir(), "triad-cockpit-ui-"));
  server = await startCockpitServer({ controlRoot: await createDemoWorkspace(root) });
  const empty = path.join(root, "empty-control");
  await mkdir(path.join(empty, ".triad-plus"), { recursive: true });
  emptyServer = await startCockpitServer({ controlRoot: empty });
});

afterAll(async () => {
  globalThis.fetch = nodeFetch;
  await server?.close();
  await emptyServer?.close();
});

beforeEach(() => {
  mode = "ok";
  target = server;
  installFetch();
  window.history.replaceState(null, "", "/#/");
  window.localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
});
afterEach(() => cleanup());

function go(hash: string) {
  act(() => {
    window.location.hash = hash;
  });
}

describe("navigation: project → card → attempt", () => {
  it("lands on the first project and lists its cards with declared state and verifier result", async () => {
    render(<App />);
    const list = await screen.findByRole("list", { name: "Cards" });
    const rows = within(list).getAllByRole("link");
    expect(rows.map((row) => row.textContent)).toEqual(expect.arrayContaining([expect.stringContaining("NOTE-101")]));
    expect(window.location.hash).toBe("#/p/root");
    const note101 = within(list).getByRole("link", { name: /NOTE-101/ });
    expect(note101.textContent).toContain("approved");
    expect(note101.textContent).toContain("2 attempts observed");
    expect(note101.textContent).toContain("Verifier: Pass");
    // Projects from both layouts are navigable.
    expect(screen.getByRole("link", { name: /mobile-shell/ })).toBeTruthy();
  });

  it("opens a card and shows attempts, gates, and evidence links", async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole("link", { name: /NOTE-101/ }));
    await screen.findByRole("heading", { level: 1, name: "Persist note drafts locally" });
    expect(window.location.hash).toBe("#/p/root/c/NOTE-101");
    const attempts = document.querySelectorAll("details.attempt");
    expect(attempts).toHaveLength(2);
    // The latest attempt is expanded, earlier ones collapsed.
    expect((attempts[1] as HTMLDetailsElement).open).toBe(true);
    expect((attempts[0] as HTMLDetailsElement).open).toBe(false);
    const attemptTwo = attempts[1] as HTMLElement;
    expect(within(attemptTwo).getByText("asg-note-101-2")).toBeTruthy();
    expect(within(attemptTwo).getByText(/Packet valid/)).toBeTruthy();
    const gates = within(attemptTwo).getByRole("table");
    expect(within(gates).getAllByRole("row").map((row) => row.querySelector("th")?.textContent)).toEqual(["Gate", "unit", "lint", "e2e-smoke"]);
    expect(attemptTwo.textContent).toContain("2 required · 2 passed · 0 not passed · 1 optional");
  });

  it("deep-links to a card and goes back to the list", async () => {
    go("#/p/root/c/NOTE-104");
    render(<App />);
    await screen.findByRole("heading", { level: 1, name: "Sync conflict banner" });
    fireEvent.click(screen.getByRole("button", { name: /Cards/ }));
    await waitFor(() => expect(window.location.hash).toBe("#/p/root"));
  });
});

describe("meaning is preserved", () => {
  it("keeps verifier, reviewer, and Evaluator+ as separate signals with provenance", async () => {
    go("#/p/root/c/NOTE-101");
    render(<App />);
    await screen.findByRole("heading", { level: 1, name: "Persist note drafts locally" });
    const verifier = screen.getByRole("region", { name: "Verifier" });
    const reviewer = screen.getByRole("region", { name: "Reviewer" });
    const evaluator = screen.getByRole("region", { name: "Evaluator+" });
    expect(verifier.textContent).toContain("Pass");
    expect(verifier.textContent).toContain("Triad+ code");
    expect(reviewer.textContent).toContain("approved");
    expect(reviewer.textContent).toContain("Validated");
    expect(evaluator.textContent).toContain("PASS · validated");
    // The declared state is a dashed declaration, not a success state.
    const declared = document.querySelector(".detail-declared .chip")!;
    expect(declared.className).toContain("chip-dashed");
    expect(declared.className).not.toContain("chip-pass");
  });

  it("shows the three freshness axes separately and never claims the candidate was checked", async () => {
    go("#/p/root/c/NOTE-102");
    render(<App />);
    await screen.findByRole("heading", { level: 1, name: "Keyboard shortcuts for note search" });
    const freshness = screen.getByRole("group", { name: "Freshness of this verification" });
    expect(freshness.textContent).toContain("Control files changed");
    expect(freshness.textContent).toContain("Latest for card");
    expect(freshness.textContent).toContain("Not re-checked");
    expect(document.body.textContent).not.toMatch(/\bcurrent\b/i);
    expect(screen.getByText(/Files bound by the latest verification changed/)).toBeTruthy();
  });

  it("explains that a declared in-progress state is not liveness", async () => {
    go("#/p/root/c/NOTE-103");
    render(<App />);
    await screen.findByRole("heading", { level: 1, name: "Export notes as Markdown" });
    expect(screen.getByText(/does not mean an agent is running now/)).toBeTruthy();
    expect(screen.getByText(/Attempt 1 has an assignment but no verifier evidence/)).toBeTruthy();
  });

  it("surfaces anomalies: invalid context, invalid Evaluator+ result, unread queue keys", async () => {
    go("#/p/root/c/NOTE-104");
    render(<App />);
    await screen.findByRole("heading", { level: 1, name: "Sync conflict banner" });
    expect(screen.getByText(/Latest recorded verification is “invalid context”/)).toBeTruthy();
    expect(screen.getByText(/Evaluator\+ result NOTE-104.json is invalid/)).toBeTruthy();
    expect(screen.getByText(/Work-queue keys not read: owner/)).toBeTruthy();
    expect(screen.getByText(/Packet not bound/)).toBeTruthy();
  });

  it("lists ignored evidence and unmatched Evaluator+ results as workspace notices", async () => {
    render(<App />);
    const notices = await screen.findByText(/workspace notices/);
    fireEvent.click(notices);
    expect(screen.getByText(".loop/evidence/NOTE-199/attempt-001/verification.json")).toBeTruthy();
    expect(screen.getByText(/violates the Triad\+ contract/)).toBeTruthy();
    expect(screen.getByText("artifacts/evaluator-plus/release-candidate.json")).toBeTruthy();
  });
});

describe("artifact viewer", () => {
  it("shows log content as inert text, never as markup", async () => {
    go("#/p/root/c/NOTE-101?file=.loop%2Fevidence%2FNOTE-101%2Fattempt-002%2Flogs%2Fe2e-smoke.stderr.log");
    render(<App />);
    const dialog = await screen.findByRole("dialog", { name: "e2e-smoke.stderr.log" });
    await within(dialog).findByText(/<script>alert\('artifact text is never executed'\)<\/script>/);
    expect(dialog.querySelector("script")).toBeNull();
    expect(dialog.textContent).toContain("Written by Triad+");
  });

  it("renders Markdown without links or images that could load or navigate", async () => {
    go("#/p/root/c/NOTE-101?file=.loop%2Fevidence%2FNOTE-101%2Fattempt-002%2Freview-report.md");
    render(<App />);
    const dialog = await screen.findByRole("dialog", { name: "review-report.md" });
    await within(dialog).findByRole("heading", { name: /Review — NOTE-101, attempt 2/ });
    expect(dialog.querySelector("a, img, iframe")).toBeNull();
    expect(dialog.textContent).toContain("(https://example.invalid/design)");
  });

  it("pretty-prints JSON and handles a missing artifact", async () => {
    go("#/p/root/c/NOTE-101?file=artifacts%2Fevaluator-plus%2FNOTE-101.json");
    render(<App />);
    const dialog = await screen.findByRole("dialog", { name: "NOTE-101.json" });
    await waitFor(() => expect(dialog.querySelector(".json-view")?.textContent).toContain('"verdict": "PASS"'));
    cleanup();
    go("#/p/root/c/NOTE-101?file=.loop%2Fnot-written.json");
    render(<App />);
    expect(await screen.findByText("Artifact not available")).toBeTruthy();
  });

  it("closes with Escape", async () => {
    go("#/p/root/c/NOTE-101?file=.loop%2Frun-state.yaml");
    render(<App />);
    await screen.findByRole("dialog", { name: "run-state.yaml" });
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(window.location.hash).toBe("#/p/root/c/NOTE-101");
  });
});

describe("errors and empty states", () => {
  it("shows a session-ended screen on 401", async () => {
    mode = "unauthorized";
    render(<App />);
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", expect.stringContaining("Session ended"));
  });

  it("shows an unreachable state when the backend is down", async () => {
    mode = "unreachable";
    render(<App />);
    expect(await screen.findByText("Cockpit server unreachable")).toBeTruthy();
  });

  it("shows an unknown card as not found", async () => {
    go("#/p/root/c/NOTE-999");
    render(<App />);
    expect(await screen.findByText("Card not found")).toBeTruthy();
  });

  it("shows an empty workspace and a card without verifications", async () => {
    target = emptyServer;
    render(<App />);
    expect(await screen.findByText("No project in this workspace")).toBeTruthy();
    cleanup();
    target = server;
    go("#/p/mobile-shell/c/MOB-1");
    render(<App />);
    await screen.findByRole("heading", { level: 1, name: "Wrap the web app in a native shell" });
    expect(screen.getByText("No attempt observed")).toBeTruthy();
    expect(screen.getByRole("region", { name: "Verifier" }).textContent).toContain("No verifier evidence");
  });
});

describe("theme", () => {
  it("switches and persists the theme preference", async () => {
    render(<App />);
    await screen.findByRole("list", { name: "Cards" });
    fireEvent.click(screen.getByRole("radio", { name: "Dark theme" }));
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(window.localStorage.getItem("triad-cockpit-theme")).toBe("dark");
    fireEvent.click(screen.getByRole("radio", { name: "System theme" }));
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
    expect(window.localStorage.getItem("triad-cockpit-theme")).toBeNull();
  });
});

describe("keyboard", () => {
  it("keeps Tab inside the artifact viewer and returns focus on close", async () => {
    go("#/p/root/c/NOTE-101?file=.loop%2Frun-state.yaml");
    render(<App />);
    const dialog = await screen.findByRole("dialog", { name: "run-state.yaml" });
    await within(dialog).findByText(/project_decision/);
    const close = within(dialog).getByRole("button", { name: "Close viewer" });
    expect(document.activeElement).toBe(close);
    const focusable = [...dialog.querySelectorAll<HTMLElement>("button, [tabindex='0']")];
    const last = focusable[focusable.length - 1];
    last.focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(document.activeElement).toBe(focusable[0]);
    focusable[0].focus();
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it("opens the reading guide and closes it with Escape", async () => {
    render(<App />);
    await screen.findByRole("list", { name: "Cards" });
    fireEvent.click(screen.getByRole("button", { name: /How to read this view/ }));
    const guide = await screen.findByRole("dialog", { name: "How to read Triad Cockpit" });
    expect(guide.textContent).toContain("Not re-checked");
    expect(guide.textContent).toContain("never combines these into one");
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});
