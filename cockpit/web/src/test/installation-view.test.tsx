import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Sidebar } from "../components/Sidebar";
import type { Workspace } from "../types";

function renderSidebar(installation: Workspace["installation"]) {
  const workspace: Workspace = {
    cockpit: { version: "test", read_only: true },
    installation,
    team: { status: "missing", provenance: "code-validated" },
    projects: [],
    limits: [],
  };
  render(
    <Sidebar
      workspace={workspace}
      currentProject={null}
      theme="system"
      onTheme={() => {}}
      onLegend={() => {}}
    />,
  );
}

describe("installation projection", () => {
  it("keeps the valid v1 singleton adapter display", () => {
    renderSidebar({
      status: "valid",
      provenance: "code-written",
      source: ".triad-plus/installation.json",
      schema_version: 1,
      triad_version: "1.16.0",
      adapter: "opencode",
      installation_status: "installed",
      managed_asset_count: 7,
    });

    expect(screen.getByText("Adapter")).toBeTruthy();
    expect(screen.getByText("opencode")).toBeTruthy();
    expect(screen.getByText("Managed assets")).toBeTruthy();
    expect(screen.getByText("7")).toBeTruthy();
    expect(screen.queryByText("Adapters")).toBeNull();
  });

  it("renders the declared v2 adapter list and unique/shared path counts without a fake singleton", () => {
    renderSidebar({
      status: "valid",
      provenance: "code-written",
      source: ".triad-plus/installation.json",
      schema_version: 2,
      triad_version: "1.16.0",
      installation_status: "installed",
      adapter_count: 2,
      adapters: [
        {
          id: "claude-code",
          scopes: { project: true, global: false },
          scope_status: { project: "installed", global: "not_configured" },
          managed_asset_reference_count: 2,
        },
        {
          id: "copilot",
          scopes: { project: true, global: false },
          scope_status: { project: "partial", global: "not_configured" },
          managed_asset_reference_count: 2,
        },
      ],
      managed_asset_path_count: 3,
      shared_asset_count: 1,
    });

    expect(screen.getByText("Adapters")).toBeTruthy();
    expect(screen.getByText("claude-code")).toBeTruthy();
    expect(screen.getByText("copilot")).toBeTruthy();
    expect(screen.getByRole("list", { name: "Installed adapters" }).children).toHaveLength(2);
    expect(screen.getByText(/Project: enabled \(installed\)/)).toBeTruthy();
    expect(screen.getByText(/Project: enabled \(partial\)/)).toBeTruthy();
    expect(screen.getAllByText(/Global: disabled \(not configured\)/)).toHaveLength(2);
    expect(screen.getByText("Unique scope/path pairs")).toBeTruthy();
    expect(screen.getByText("Shared scope/path pairs")).toBeTruthy();
    expect(screen.getByText("3")).toBeTruthy();
    expect(screen.getByText("1")).toBeTruthy();
    expect(screen.queryByText("Adapter")).toBeNull();
  });

  it("renders a valid final-adapter tombstone as an empty v2 installation", () => {
    renderSidebar({
      status: "valid",
      provenance: "code-written",
      source: ".triad-plus/installation.json",
      schema_version: 2,
      triad_version: "1.16.0",
      installation_status: "uninstalled",
      adapter_count: 0,
      adapters: [],
      managed_asset_path_count: 0,
      shared_asset_count: 0,
    });

    expect(screen.getByText("Adapters")).toBeTruthy();
    expect(screen.getByText("None")).toBeTruthy();
    expect(screen.getByText("uninstalled")).toBeTruthy();
  });
});
