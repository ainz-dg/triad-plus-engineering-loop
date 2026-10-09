import type { ReactNode } from "react";
import type { ApiError } from "../api";
import { Icon, type IconName } from "./Icon";

export function EmptyState({ icon = "info", title, children }: { icon?: IconName; title: string; children?: ReactNode }) {
  return (
    <div className="empty" role="status">
      <span className="empty-icon"><Icon name={icon} size={20} /></span>
      <p className="empty-title">{title}</p>
      {children && <div className="empty-body">{children}</div>}
    </div>
  );
}

export function Loading({ label }: { label: string }) {
  return (
    <div className="loading" role="status" aria-live="polite">
      <span className="spinner" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

export function ErrorState({ error, what }: { error: ApiError; what: string }) {
  if (error.kind === "not_found") {
    return <EmptyState icon="minus" title={`${what} not found`}>No artifact in this workspace names it. It may have been removed since the last refresh.</EmptyState>;
  }
  if (error.kind === "refused") {
    return <EmptyState icon="lock" title="Not exposed by the Cockpit">This path is outside the read-only allowlist.</EmptyState>;
  }
  if (error.kind === "unreachable") {
    return <EmptyState icon="alert" title="Cockpit server unreachable">The local server stopped or the connection dropped. Restart <code>triad-plus cockpit</code> and use the new link.</EmptyState>;
  }
  return <EmptyState icon="alert" title={`Could not load ${what.toLowerCase()}`}>{error.message}</EmptyState>;
}

/** Full-screen state when the session is gone; the UI never handles secrets. */
export function SessionEnded() {
  return (
    <div className="session-ended">
      <div className="session-card" role="alert">
        <Icon name="lock" size={22} />
        <h1>Session ended</h1>
        <p>This Cockpit tab no longer has a valid session. The server may have restarted, or the link was opened in another browser.</p>
        <p>Run the command again and open the new one-time link it prints:</p>
        <pre className="command">npx triad-plus cockpit --control &lt;path&gt;</pre>
      </div>
    </div>
  );
}
