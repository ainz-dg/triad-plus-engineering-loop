import { routeHref } from "../route";
import { applyThemePreference, type ThemePreference } from "../theme";
import type { Workspace } from "../types";
import { ProvenanceBadge } from "./Badges";
import { Icon, TriadMark, type IconName } from "./Icon";

const THEMES: Array<{ value: ThemePreference; label: string; icon: IconName }> = [
  { value: "system", label: "System", icon: "monitor" },
  { value: "light", label: "Light", icon: "sun" },
  { value: "dark", label: "Dark", icon: "moon" },
];

export function ThemeSwitch({ value, onChange }: { value: ThemePreference; onChange: (value: ThemePreference) => void }) {
  return (
    <div className="segmented" role="radiogroup" aria-label="Theme">
      {THEMES.map((theme) => (
        <button
          key={theme.value}
          type="button"
          role="radio"
          aria-checked={value === theme.value}
          className={value === theme.value ? "is-active" : undefined}
          onClick={() => {
            applyThemePreference(theme.value);
            onChange(theme.value);
          }}
          aria-label={`${theme.label} theme`}
        >
          <Icon name={theme.icon} size={14} />
          <span>{theme.label}</span>
        </button>
      ))}
    </div>
  );
}

export function Sidebar({ workspace, currentProject, theme, onTheme, onLegend, onNavigate }: {
  workspace: Workspace | undefined;
  currentProject: string | null;
  theme: ThemePreference;
  onTheme: (value: ThemePreference) => void;
  onLegend: () => void;
  onNavigate?: () => void;
}) {
  const installation = workspace?.installation;
  const roles = workspace?.team.status === "valid" ? workspace.team.roles ?? [] : [];
  return (
    <aside className="sidebar" aria-label="Workspace">
      <div className="brand">
        <TriadMark />
        <div>
          <p className="brand-name">Triad Cockpit</p>
          <p className="brand-sub">Triad+ engineering loop</p>
        </div>
      </div>

      <section className="side-section" aria-labelledby="side-workspace">
        <h2 id="side-workspace" className="side-heading">Workspace</h2>
        {installation?.status === "valid" ? (
          <dl className="facts">
            <div><dt>Triad+</dt><dd className="mono">{installation.triad_version}</dd></div>
            <div><dt>Adapter</dt><dd>{installation.adapter}</dd></div>
            <div><dt>Install</dt><dd>{installation.installation_status}</dd></div>
          </dl>
        ) : (
          <p className="muted small">
            {installation?.status === "invalid" ? "Installation manifest is invalid." : "No installation manifest (legacy or uninitialized workspace)."}
          </p>
        )}
        {installation && <ProvenanceBadge kind={installation.provenance} compact />}
      </section>

      <nav className="side-section" aria-labelledby="side-projects">
        <h2 id="side-projects" className="side-heading">Projects</h2>
        {workspace && workspace.projects.length === 0 && <p className="muted small">No project with a <code>.loop/</code> directory was found.</p>}
        <ul className="project-nav">
          {workspace?.projects.map((project) => (
            <li key={project.id}>
              <a href={routeHref({ project: project.id })} aria-current={currentProject === project.id ? "page" : undefined} onClick={onNavigate}>
                <Icon name="folder" size={15} />
                <span className="project-name">{project.id === "root" ? "Control root" : project.id}</span>
                <span className="project-base mono">{project.base === "." ? "workspace root" : project.base}</span>
              </a>
            </li>
          ))}
        </ul>
      </nav>

      {roles.length > 0 && (
        <section className="side-section" aria-labelledby="side-team">
          <h2 id="side-team" className="side-heading">Team</h2>
          <ul className="roles">
            {roles.map((role) => (
              <li key={role.id} className={role.enabled ? undefined : "is-disabled"}>
                <span className={`role-dot role-${role.id}`} aria-hidden="true" />
                <span className="role-id">{role.id}</span>
                <span className="role-name">{role.display_name}</span>
                {!role.enabled && <span className="role-off">off</span>}
              </li>
            ))}
          </ul>
          <p className="muted tiny">Desired configuration from team.json; the model a host session actually used is not observable.</p>
        </section>
      )}

      <div className="side-footer">
        <ThemeSwitch value={theme} onChange={onTheme} />
        <button type="button" className="btn btn-ghost btn-block" onClick={onLegend}>
          <Icon name="help" /> How to read this view
        </button>
      </div>
    </aside>
  );
}
