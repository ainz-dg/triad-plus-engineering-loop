import { useCallback, useEffect, useRef, useState } from "react";
import { api, onUnauthorized } from "./api";
import { ArtifactViewer } from "./components/ArtifactViewer";
import { CardDetail } from "./components/CardDetail";
import { Icon } from "./components/Icon";
import { Legend } from "./components/Legend";
import { ProjectView } from "./components/ProjectView";
import { Sidebar } from "./components/Sidebar";
import { EmptyState, ErrorState, Loading, SessionEnded } from "./components/States";
import { formatTime } from "./format";
import { navigate, routeHref, useRoute } from "./route";
import { readThemePreference, type ThemePreference } from "./theme";
import { useResource } from "./useResource";

export function App() {
  const route = useRoute();
  const [epoch, setEpoch] = useState(0);
  const [loadedAt, setLoadedAt] = useState(() => new Date());
  const [sessionLost, setSessionLost] = useState(false);
  const [theme, setTheme] = useState<ThemePreference>(() => readThemePreference());
  const [legend, setLegend] = useState(false);
  const [menu, setMenu] = useState(false);
  const closeLegend = useCallback(() => setLegend(false), []);

  useEffect(() => onUnauthorized(() => setSessionLost(true)), []);
  useEffect(() => {
    if (!menu) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setMenu(false); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [menu]);

  const workspace = useResource("workspace", (signal) => api.workspace(signal), epoch);
  const projects = workspace.data?.projects ?? [];
  const project = route.project && projects.some((entry) => entry.id === route.project) ? route.project : null;

  // Land on the first project when none is selected.
  useEffect(() => {
    if (!route.project && projects.length > 0) navigate({ project: projects[0].id }, { replace: true });
  }, [route.project, projects]);

  const cards = useResource(project ? `cards:${project}` : null, (signal) => api.cards(project!, signal), epoch);
  const card = useResource(project && route.card ? `card:${project}:${route.card}` : null, (signal) => api.card(project!, route.card!, signal), epoch);

  const refresh = useCallback(() => {
    setEpoch((value) => value + 1);
    setLoadedAt(new Date());
  }, []);
  // Opening a file is a history step, so Back closes the viewer. A viewer
  // reached by deep link is closed in place instead of leaving the Cockpit.
  const openedInApp = useRef(false);
  const openFile = useCallback((path: string) => {
    openedInApp.current = true;
    navigate({ ...route, file: path });
  }, [route]);
  const closeFile = useCallback(() => {
    if (openedInApp.current) {
      openedInApp.current = false;
      window.history.back();
    } else {
      navigate({ ...route, file: null }, { replace: true });
    }
  }, [route]);

  if (sessionLost) return <SessionEnded />;

  const unknownProject = workspace.state === "ready" && route.project && !project;
  const view = route.card ? "detail" : "list";

  return (
    <div className={`app view-${view}${menu ? " menu-open" : ""}`}>
      <a className="skip-link" href="#main">Skip to content</a>
      <div className="sidebar-wrap" onClick={(event) => { if (event.target === event.currentTarget) setMenu(false); }}>
        <Sidebar workspace={workspace.data} currentProject={project} theme={theme} onTheme={setTheme} onLegend={() => { setMenu(false); setLegend(true); }} onNavigate={() => setMenu(false)} />
      </div>

      <header className="topbar">
        <button type="button" className="btn btn-icon menu-btn" aria-label="Open workspace menu" aria-expanded={menu} onClick={() => setMenu(!menu)}>
          <Icon name="menu" size={18} />
        </button>
        <nav className="crumbs" aria-label="Breadcrumb">
          <ol>
            <li><a href={routeHref({})}>Workspace</a></li>
            {project && <li><a href={routeHref({ project })} aria-current={route.card ? undefined : "page"}>{project === "root" ? "Control root" : project}</a></li>}
            {project && route.card && <li><span aria-current="page" className="mono">{route.card}</span></li>}
          </ol>
        </nav>
        <div className="topbar-actions">
          <span className="readonly" title="The Cockpit cannot change anything in the workspace or start agents.">
            <Icon name="lock" size={14} /> Read-only
          </span>
          <button type="button" className="btn btn-ghost refresh" onClick={refresh} aria-label={`Refresh data, last loaded ${formatTime(loadedAt)}`}>
            <Icon name="refresh" className={workspace.state === "loading" || cards.state === "loading" || card.state === "loading" ? "spin" : undefined} />
            <span className="refresh-label">Updated {formatTime(loadedAt)}</span>
          </button>
        </div>
      </header>

      <main id="main" className="main" tabIndex={-1}>
        {workspace.state === "error" && !workspace.data ? (
          <div className="pane pane-full"><ErrorState error={workspace.error} what="Workspace" /></div>
        ) : !workspace.data ? (
          <div className="pane pane-full"><Loading label="Reading the control workspace…" /></div>
        ) : projects.length === 0 ? (
          <div className="pane pane-full">
            <EmptyState icon="folder" title="No project in this workspace">
              No <code>.loop/</code> directory was found in the control root or under <code>projects/&lt;id&gt;/</code>. Bootstrap a project with the Triad+ skill first.
            </EmptyState>
          </div>
        ) : unknownProject ? (
          <div className="pane pane-full"><EmptyState icon="minus" title="Unknown project">This workspace has no project named “{route.project}”.</EmptyState></div>
        ) : (
          <>
            {cards.data ? (
              <ProjectView project={project!} data={cards.data} selectedCard={route.card} onOpenFile={openFile} />
            ) : (
              <section className="pane pane-list">{cards.state === "error" ? <ErrorState error={cards.error} what="Cards" /> : <Loading label="Loading cards…" />}</section>
            )}
            <div className="pane-detail-wrap">
              {!route.card ? (
                <div className="pane pane-detail pane-placeholder">
                  <EmptyState icon="layers" title="Select a card">Pick a card to see its attempts, verifier evidence, reviews, and Evaluator+ results.</EmptyState>
                </div>
              ) : card.data && card.data.id === route.card ? (
                <CardDetail card={card.data} onOpen={openFile} onBack={() => navigate({ project })} />
              ) : card.state === "error" ? (
                <div className="pane pane-detail"><ErrorState error={card.error} what="Card" /></div>
              ) : (
                <div className="pane pane-detail"><Loading label="Loading card…" /></div>
              )}
            </div>
          </>
        )}
      </main>

      {route.file && project && <ArtifactViewer project={project} path={route.file} onClose={closeFile} epoch={epoch} />}
      {legend && <Legend onClose={closeLegend} />}
    </div>
  );
}
