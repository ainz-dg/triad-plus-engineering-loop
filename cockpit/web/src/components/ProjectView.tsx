import { useMemo, useState } from "react";
import { formatDate, humanize } from "../format";
import { routeHref } from "../route";
import type { CardList } from "../types";
import { DeclaredState, ProvenanceBadge, VerifierStatus } from "./Badges";
import { Icon } from "./Icon";
import { EmptyState } from "./States";

const QUEUE_STATUS = {
  ok: { label: "Work queue read", tone: "neutral" },
  partial: { label: "Work queue partly read", tone: "warn" },
  unreadable: { label: "Work queue unreadable", tone: "warn" },
  missing: { label: "No work queue", tone: "neutral" },
} as const;

export function ProjectView({ project, data, selectedCard, onOpenFile }: {
  project: string;
  data: CardList;
  selectedCard: string | null;
  onOpenFile: (path: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [state, setState] = useState("all");
  const states = useMemo(
    () => [...new Set(data.cards.map((card) => card.declared.state).filter((value): value is string => typeof value === "string"))].sort(),
    [data.cards],
  );
  const cards = data.cards.filter((card) => {
    const text = `${card.id} ${card.declared.title ?? ""}`.toLowerCase();
    if (query && !text.includes(query.trim().toLowerCase())) return false;
    if (state !== "all" && card.declared.state !== state) return false;
    return true;
  });
  const queue = QUEUE_STATUS[data.work_queue.status];
  const issues = data.diagnostics.length + data.unmatched_evaluations.length + data.work_queue.warnings.length;

  return (
    <section className="pane pane-list" aria-labelledby="project-title">
      <header className="pane-head">
        <div className="pane-title-row">
          <h1 id="project-title" className="pane-title">{project === "root" ? "Control root" : project}</h1>
          <span className="count" aria-label={`${data.cards.length} cards`}>{data.cards.length}</span>
        </div>
        <div className="queue-row">
          <span className={`queue-status tone-${queue.tone}`}>
            <Icon name={queue.tone === "warn" ? "alert" : "layers"} size={14} /> {queue.label}
          </span>
          <ProvenanceBadge kind="agent-declared" compact />
          <span className="queue-links">
            <button type="button" className="link-btn" onClick={() => onOpenFile(data.work_queue.source)}>work-queue.yaml</button>
            <button type="button" className="link-btn" onClick={() => onOpenFile(data.work_queue.source.replace(/work-queue\.yaml$/, "run-state.yaml"))}>run-state.yaml</button>
          </span>
        </div>
        {data.cards.length > 0 && (
          <div className="filters">
            <label className="search">
              <Icon name="search" size={15} />
              <span className="visually-hidden">Filter cards</span>
              <input type="search" placeholder="Filter by ID or title" value={query} onChange={(event) => setQuery(event.target.value)} />
            </label>
            {states.length > 1 && (
              <label className="select">
                <span className="visually-hidden">Declared state</span>
                <select value={state} onChange={(event) => setState(event.target.value)}>
                  <option value="all">All declared states</option>
                  {states.map((value) => <option key={value} value={value}>{humanize(value)}</option>)}
                </select>
              </label>
            )}
          </div>
        )}
      </header>

      {data.cards.length === 0 ? (
        <EmptyState icon="layers" title="No cards in this project">
          The work queue lists no items, and no assignment or verifier evidence names a card.
        </EmptyState>
      ) : cards.length === 0 ? (
        <EmptyState icon="search" title="No card matches the filter" />
      ) : (
        <ul className="card-list" aria-label="Cards">
          {cards.map((card) => {
            const latest = card.observed.latest_verification;
            const attempts = card.observed.attempt_numbers.length;
            const flagged = card.declared.status === "not_determinable" || (card.declared.unsupported_keys?.length ?? 0) > 0;
            return (
              <li key={card.id}>
                <a className="card-row" href={routeHref({ project, card: card.id })} aria-current={selectedCard === card.id ? "page" : undefined}>
                  <span className="card-row-top">
                    <span className="card-id mono">{card.id}</span>
                    <DeclaredState state={card.declared.state} status={card.declared.status} />
                    {flagged && <Icon name="alert" size={14} className="flag" label="Queue entry partly unreadable" />}
                  </span>
                  <span className={card.declared.title ? "card-title" : "card-title muted"}>
                    {card.declared.title ?? (card.declared.status === "declared" ? "Untitled" : "Not described in the work queue")}
                  </span>
                  <span className="card-row-meta">
                    <span className="meta-item">
                      {attempts === 0 ? "No attempts observed" : `${attempts} attempt${attempts === 1 ? "" : "s"} observed`}
                    </span>
                    {latest ? (
                      <span className="meta-item">
                        <VerifierStatus status={latest.status} />
                        <span className="muted">{formatDate(latest.created_at)}</span>
                      </span>
                    ) : (
                      <span className="meta-item muted">No verifier evidence</span>
                    )}
                  </span>
                </a>
              </li>
            );
          })}
        </ul>
      )}

      {issues > 0 && (
        <details className="diagnostics">
          <summary>
            <Icon name="alert" size={14} /> {issues} workspace notice{issues === 1 ? "" : "s"}
          </summary>
          {data.work_queue.warnings.length > 0 && (
            <div className="diag-group">
              <h3>Work queue</h3>
              <ul>{data.work_queue.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>
            </div>
          )}
          {data.diagnostics.length > 0 && (
            <div className="diag-group">
              <h3>Ignored artifacts</h3>
              <ul>
                {data.diagnostics.map((entry) => (
                  <li key={entry.source}>
                    <button type="button" className="link-btn mono" onClick={() => onOpenFile(entry.source)}>{entry.source}</button>
                    <span className="diag-problem">{entry.problem}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {data.unmatched_evaluations.length > 0 && (
            <div className="diag-group">
              <h3>Evaluator+ results with no matching card</h3>
              <ul>
                {data.unmatched_evaluations.map((entry) => (
                  <li key={entry.source}>
                    <button type="button" className="link-btn mono" onClick={() => onOpenFile(entry.source)}>{entry.source}</button>
                    <span className="diag-problem">feature_id {entry.feature_id ?? "unreadable"}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </details>
      )}
    </section>
  );
}
