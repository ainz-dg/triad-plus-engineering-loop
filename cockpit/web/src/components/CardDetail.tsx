import type { ReactNode } from "react";
import { fileName, formatDate, formatDuration, humanize, shortHash } from "../format";
import type { Attempt, CardDetail as CardDetailData, Evaluation, Gate, Verification } from "../types";
import { Chip, DeclaredState, FreshnessRow, GateStatus, ProvenanceBadge, VerifierStatus } from "./Badges";
import { Icon, type IconName } from "./Icon";
import { EmptyState } from "./States";

type Open = (path: string) => void;

function latestVerification(card: CardDetailData): Verification | null {
  const all = card.attempts.flatMap((attempt) => attempt.verifications).filter((verification) => verification.freshness);
  return all.find((verification) => verification.freshness?.recency.status === "latest_for_card") ?? null;
}

// ---------------------------------------------------------------------------
// Signals: three different questions, three different answers.

function Signal({ title, icon, meaning, children }: { title: string; icon: IconName; meaning: string; children: ReactNode }) {
  return (
    <section className="signal" aria-label={title}>
      <header className="signal-head">
        <Icon name={icon} size={15} />
        <h3>{title}</h3>
      </header>
      <div className="signal-body">{children}</div>
      <p className="signal-meaning">{meaning}</p>
    </section>
  );
}

function Signals({ card }: { card: CardDetailData }) {
  const latest = latestVerification(card);
  const reviewer = card.control_run?.reviewer;
  const reviewDocs = card.reviewer.documents.length + card.attempts.reduce((total, attempt) => total + attempt.documents.filter((document) => /review/i.test(document.source)).length, 0);
  const evaluations = [...card.evaluations].sort((a, b) => String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")));
  const evaluation = evaluations[0];
  return (
    <div className="signals">
      <Signal title="Verifier" icon="terminal" meaning="Deterministic gates run by triad-verify on the recorded candidate.">
        {latest ? (
          <>
            <VerifierStatus status={latest.status} prefix={false} />
            <p className="signal-line">Latest record · attempt {latest.attempt ?? "?"} · {formatDate(latest.created_at)}</p>
            <ProvenanceBadge kind={latest.provenance} compact />
          </>
        ) : (
          <>
            <Chip icon="minus">No verifier evidence</Chip>
            <p className="signal-line">No valid verification.json names this card.</p>
          </>
        )}
      </Signal>
      <Signal title="Reviewer" icon="shield" meaning="Independent semantic review. Host-governed runs keep the verdict in agent-written files.">
        {reviewer?.status === "valid" ? (
          <>
            <Chip tone={reviewer.decision === "approved" ? "pass" : "warn"} icon={reviewer.decision === "approved" ? "check" : "alert"}>
              {humanize(reviewer.decision)}
            </Chip>
            <p className="signal-line">Validated contract from the deterministic driver run.</p>
            <ProvenanceBadge kind={reviewer.provenance} compact />
          </>
        ) : (
          <>
            <Chip icon="quote" dashed>No validated verdict</Chip>
            <p className="signal-line">{reviewDocs ? `${reviewDocs} review document${reviewDocs === 1 ? "" : "s"} (agent-declared)` : "No review document found."}</p>
          </>
        )}
      </Signal>
      <Signal title="Evaluator+" icon="sigma" meaning="Optional post-approval product-quality check; outside the core triad.">
        {evaluation ? (
          <>
            <EvaluationStatus evaluation={evaluation} />
            <p className="signal-line">{evaluations.length > 1 ? `Latest of ${evaluations.length} results` : "One result"} · {formatDate(evaluation.created_at)}</p>
            <ProvenanceBadge kind={evaluation.provenance} compact />
          </>
        ) : (
          <>
            <Chip icon="minus">No result</Chip>
            <p className="signal-line">No Evaluator+ result names this card.</p>
          </>
        )}
      </Signal>
    </div>
  );
}

function EvaluationStatus({ evaluation }: { evaluation: Evaluation }) {
  if (evaluation.status === "valid") {
    const tone = evaluation.verdict === "PASS" ? "pass" : evaluation.verdict === "FAIL" ? "fail" : "warn";
    return <Chip tone={tone} icon={tone === "pass" ? "check" : tone === "fail" ? "cross" : "alert"}>{evaluation.verdict} · validated</Chip>;
  }
  if (evaluation.status === "not_validated") return <Chip tone="warn" icon="alert" dashed>{evaluation.verdict ?? "?"} · not validated</Chip>;
  return <Chip tone="warn" icon="alert" dashed>{evaluation.status === "invalid" ? "Invalid result" : "Unreadable"}</Chip>;
}

// ---------------------------------------------------------------------------
// Observations: facts from the artifacts worth a look. Never a verdict.

function observations(card: CardDetailData): Array<{ icon: IconName; text: string }> {
  const items: Array<{ icon: IconName; text: string }> = [];
  const latest = latestVerification(card);
  if (latest && latest.status !== "pass") items.push({ icon: "alert", text: `Latest recorded verification is “${humanize(latest.status)}”.` });
  if (latest?.freshness?.control_bindings.status === "changed") items.push({ icon: "alert", text: "Files bound by the latest verification changed after it ran." });
  for (const attempt of card.attempts) {
    if (attempt.assignments.length > 0 && attempt.verifications.length === 0) items.push({ icon: "info", text: `Attempt ${attempt.attempt} has an assignment but no verifier evidence.` });
    for (const assignment of attempt.assignments) {
      if (assignment.packet.status === "invalid" || assignment.packet.status === "missing") items.push({ icon: "alert", text: `Attempt ${attempt.attempt}: assignment packet is ${assignment.packet.status}.` });
    }
  }
  for (const evaluation of card.evaluations) {
    if (evaluation.status === "not_validated") items.push({ icon: "alert", text: `Evaluator+ result not validated (${humanize(evaluation.validation?.reason)}).` });
    if (evaluation.status === "invalid") items.push({ icon: "alert", text: `Evaluator+ result ${fileName(evaluation.source)} is invalid.` });
  }
  if (card.declared.status === "not_determinable") items.push({ icon: "alert", text: "Declared state unknown: the work queue was only partly readable." });
  if (card.declared.unsupported_keys?.length) items.push({ icon: "info", text: `Work-queue keys not read: ${card.declared.unsupported_keys.join(", ")}.` });
  if (card.reviewer.ambiguous_documents.length) items.push({ icon: "info", text: `${card.reviewer.ambiguous_documents.length} document name(s) match several cards and are not attributed.` });
  return items;
}

// ---------------------------------------------------------------------------
// Attempts

function gateSummary(gates: Gate[]) {
  const required = gates.filter((gate) => gate.required);
  const passed = required.filter((gate) => gate.status === "pass").length;
  const failed = required.filter((gate) => gate.status !== "pass").length;
  const duration = gates.reduce((total, gate) => total + (gate.duration_ms ?? 0), 0);
  return { required: required.length, passed, failed, optional: gates.length - required.length, duration };
}

function GateTable({ gates, onOpen }: { gates: Gate[]; onOpen: Open }) {
  if (gates.length === 0) return <p className="muted small">No gate ran in this verification.</p>;
  return (
    <div className="table-scroll">
      <table className="gates">
        <thead>
          <tr><th scope="col">Gate</th><th scope="col">Kind</th><th scope="col">Result</th><th scope="col">Exit</th><th scope="col">Duration</th><th scope="col">Output</th></tr>
        </thead>
        <tbody>
          {gates.map((gate, index) => (
            <tr key={`${gate.id}-${index}`} className={gate.required && gate.status !== "pass" ? "is-failing" : undefined}>
              <th scope="row" className="mono">{gate.id ?? "—"}</th>
              <td data-label="Kind">{gate.required ? "required" : "optional"}</td>
              <td data-label="Result"><GateStatus status={gate.status} /></td>
              <td data-label="Exit" className="mono">{gate.exit_code ?? "—"}</td>
              <td data-label="Duration" className="mono">{formatDuration(gate.duration_ms)}</td>
              <td data-label="Output" className="gate-logs">
                {gate.stdout_log && <button type="button" className="link-btn" onClick={() => onOpen(gate.stdout_log!)}>stdout</button>}
                {gate.stderr_log && <button type="button" className="link-btn" onClick={() => onOpen(gate.stderr_log!)}>stderr</button>}
                {gate.output_truncated && <span className="muted small">truncated</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function VerificationBlock({ verification, onOpen }: { verification: Verification; onOpen: Open }) {
  if (verification.status === "unreadable" || !verification.freshness) {
    return (
      <div className="verification is-unreadable">
        <VerifierStatus status="unreadable" />
        <p className="small">{verification.error}</p>
      </div>
    );
  }
  const summary = gateSummary(verification.gates ?? []);
  return (
    <div className="verification">
      <div className="verification-head">
        <VerifierStatus status={verification.status} />
        <span className="muted small">{formatDate(verification.created_at)}</span>
        <ProvenanceBadge kind={verification.provenance} compact />
        <button type="button" className="link-btn push" onClick={() => onOpen(verification.source)}>
          <Icon name="braces" size={14} /> verification.json
        </button>
      </div>
      <p className="gate-summary">
        <strong>{summary.required}</strong> required · <strong>{summary.passed}</strong> passed · <strong className={summary.failed ? "text-fail" : undefined}>{summary.failed}</strong> not passed
        {summary.optional > 0 && <> · {summary.optional} optional</>} · {formatDuration(summary.duration)} total
      </p>
      {verification.failure && (
        <p className="failure"><Icon name="alert" size={14} /> {verification.failure.code}: {verification.failure.reason}</p>
      )}
      <FreshnessRow freshness={verification.freshness} />
      <GateTable gates={verification.gates ?? []} onOpen={onOpen} />
      <dl className="facts facts-inline">
        <div><dt>Run</dt><dd className="mono">{verification.run_id ?? "—"}</dd></div>
        <div><dt>Branch</dt><dd className="mono">{verification.branch ?? "—"}</dd></div>
        <div><dt>Candidate</dt><dd className="mono" title={verification.candidate_fingerprint ?? undefined}>{shortHash(verification.candidate_fingerprint)}</dd></div>
      </dl>
    </div>
  );
}

function AttemptBlock({ attempt, open, onOpen }: { attempt: Attempt; open: boolean; onOpen: Open }) {
  const statuses = attempt.verifications.map((verification) => verification.status);
  return (
    <details className="attempt" open={open}>
      <summary>
        <span className="attempt-number">Attempt {attempt.attempt}</span>
        <span className="attempt-summary">
          {statuses.length === 0 ? <Chip icon="minus">No verifier evidence</Chip> : statuses.map((status, index) => <VerifierStatus key={index} status={status} />)}
        </span>
        <Icon name="chevronDown" className="disclosure" />
      </summary>
      <div className="attempt-body">
        <div className="subsection">
          <h4>Assignments <ProvenanceBadge kind="agent-declared" compact /></h4>
          {attempt.assignments.length === 0 ? (
            <p className="muted small">No assignment file for this attempt (only verifier evidence names it).</p>
          ) : (
            <ul className="assignments">
              {attempt.assignments.map((assignment) => (
                <li key={assignment.source}>
                  <button type="button" className="link-btn mono" onClick={() => onOpen(assignment.source)}>{assignment.assignment_id ?? fileName(assignment.source)}</button>
                  <span className="muted small">{assignment.agent_type ?? "unknown agent"}</span>
                  {assignment.expected_branch && <span className="mono small">{assignment.expected_branch}</span>}
                  <span className="packet">
                    {assignment.packet.status === "valid" && assignment.packet.source ? (
                      <button type="button" className="link-btn" onClick={() => onOpen(assignment.packet.source!)} title="Assignment Packet verified against its SHA-256 binding">
                        <Icon name="shield" size={14} /> Packet valid
                      </button>
                    ) : (
                      <Chip tone={assignment.packet.status === "not_bound" ? "neutral" : "warn"} icon={assignment.packet.status === "not_bound" ? "minus" : "alert"}>
                        Packet {humanize(assignment.packet.status)}
                      </Chip>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="subsection">
          <h4>Verifications</h4>
          {attempt.verifications.length === 0 ? (
            <p className="muted small">No verifier evidence was recorded for this attempt.</p>
          ) : (
            attempt.verifications.map((verification) => <VerificationBlock key={verification.source} verification={verification} onOpen={onOpen} />)
          )}
        </div>
        {attempt.documents.length > 0 && (
          <div className="subsection">
            <h4>Files next to the evidence <ProvenanceBadge kind="agent-declared" compact /></h4>
            <ul className="doc-list">
              {attempt.documents.map((document) => (
                <li key={document.source}><button type="button" className="link-btn" onClick={() => onOpen(document.source)}><Icon name="file" size={14} /> {fileName(document.source)}</button></li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </details>
  );
}

// ---------------------------------------------------------------------------

function Section({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="detail-section">
      <header className="section-head"><h2>{title}</h2>{aside}</header>
      {children}
    </section>
  );
}

export function CardDetail({ card, onOpen, onBack }: { card: CardDetailData; onOpen: Open; onBack: () => void }) {
  const notes = observations(card);
  const latestAttempt = card.attempts.at(-1)?.attempt;
  return (
    <article className="pane pane-detail" aria-labelledby="card-title">
      <button type="button" className="btn btn-ghost back-btn" onClick={onBack}><Icon name="chevronLeft" /> Cards</button>
      <header className="detail-head">
        <p className="detail-id mono">{card.id}</p>
        <h1 id="card-title">{card.declared.title ?? <span className="muted">Not described in the work queue</span>}</h1>
        <div className="detail-declared">
          <span className="label">Declared state</span>
          <DeclaredState state={card.declared.state} status={card.declared.status} />
          {card.declared.card_path && <button type="button" className="link-btn" onClick={() => onOpen(card.declared.card_path!)}><Icon name="file" size={14} /> {card.declared.card_path}</button>}
        </div>
        {card.declared.state === "in_progress" && (
          <p className="hint"><Icon name="info" size={14} /> “In progress” is the Orchestrator’s declaration. Triad+ records no liveness, so it does not mean an agent is running now.</p>
        )}
      </header>

      <Signals card={card} />

      <Section title="Worth a look" aside={<ProvenanceBadge kind="cockpit-derived" compact />}>
        {notes.length === 0 ? (
          <p className="muted small">No anomaly found in the recorded artifacts. This is not an approval.</p>
        ) : (
          <ul className="observations">
            {notes.map((note, index) => <li key={index}><Icon name={note.icon} size={14} /> {note.text}</li>)}
          </ul>
        )}
      </Section>

      <Section title={`Attempts (${card.attempts.length})`} aside={<span className="muted small">By attempt number · no transition timeline is recorded</span>}>
        {card.attempts.length === 0 ? (
          <EmptyState icon="layers" title="No attempt observed">No assignment or verifier evidence names this card yet.</EmptyState>
        ) : (
          card.attempts.map((attempt) => <AttemptBlock key={attempt.attempt} attempt={attempt} open={attempt.attempt === latestAttempt} onOpen={onOpen} />)
        )}
      </Section>

      <Section title="Review" aside={<ProvenanceBadge kind="agent-declared" compact />}>
        {card.control_run?.reviewer?.status === "valid" && (
          <div className="contract">
            <p><strong>Reviewer contract</strong> (deterministic driver, validated): {humanize(card.control_run.reviewer.decision)}</p>
            {card.control_run.reviewer.summary && <p className="small">{card.control_run.reviewer.summary}</p>}
            {(card.control_run.reviewer.findings?.length ?? 0) > 0 && (
              <ul className="small">{card.control_run.reviewer.findings!.map((finding, index) => <li key={index}>{typeof finding === "string" ? finding : JSON.stringify(finding)}</li>)}</ul>
            )}
          </div>
        )}
        {card.reviewer.documents.length === 0 && card.attempts.every((attempt) => attempt.documents.length === 0) && !card.control_run?.reviewer ? (
          <p className="muted small">No review document is attributed to this card.</p>
        ) : (
          <ul className="doc-list">
            {card.reviewer.documents.map((document) => (
              <li key={document.source}><button type="button" className="link-btn" onClick={() => onOpen(document.source)}><Icon name="file" size={14} /> {document.source}</button> <ProvenanceBadge kind={document.provenance} compact /></li>
            ))}
          </ul>
        )}
        {card.reviewer.ambiguous_documents.length > 0 && (
          <div className="ambiguous">
            <p className="small"><Icon name="info" size={14} /> Not attributed — the name matches several cards:</p>
            <ul className="doc-list">
              {card.reviewer.ambiguous_documents.map((document) => (
                <li key={document.source}><button type="button" className="link-btn" onClick={() => onOpen(document.source)}>{document.source}</button> <span className="muted small">{document.matches?.join(", ")}</span></li>
              ))}
            </ul>
          </div>
        )}
      </Section>

      {card.evaluations.length > 0 && (
        <Section title="Evaluator+">
          <ul className="evaluations">
            {card.evaluations.map((evaluation) => (
              <li key={evaluation.source}>
                <div className="evaluation-head">
                  <EvaluationStatus evaluation={evaluation} />
                  <button type="button" className="link-btn" onClick={() => onOpen(evaluation.source)}><Icon name="braces" size={14} /> {fileName(evaluation.source)}</button>
                  <ProvenanceBadge kind={evaluation.provenance} compact />
                </div>
                <dl className="facts facts-inline">
                  <div><dt>Contract</dt><dd>{evaluation.validation?.contract === "quality_contract" ? "Quality Contract" : evaluation.validation ? "Legacy" : "—"}</dd></div>
                  {evaluation.validation?.reason && <div><dt>Reason</dt><dd>{humanize(evaluation.validation.reason)}</dd></div>}
                  {evaluation.error && <div><dt>Error</dt><dd>{evaluation.error}</dd></div>}
                  {evaluation.candidate_binding && <div><dt>Candidate record</dt><dd title={evaluation.candidate_binding.note}>{humanize(evaluation.candidate_binding.result)}</dd></div>}
                </dl>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {card.control_run && (
        <Section title="Deterministic driver run" aside={<ProvenanceBadge kind={card.control_run.provenance} compact />}>
          <p className="small">Status <strong>{humanize(card.control_run.status)}</strong> · recorded by the optional <span className="mono">triad-control-run</span> driver, not by host-governed runs.</p>
          {card.control_run.trace.length > 0 && (
            <ol className="trace">
              {card.control_run.trace.map((entry, index) => (
                <li key={index}>
                  <span className="mono small">{formatDate(entry.at)}</span>
                  <span className="trace-action mono">{entry.action}</span>
                  <span className="muted small">{entry.reason}</span>
                </li>
              ))}
            </ol>
          )}
          <button type="button" className="link-btn" onClick={() => onOpen(card.control_run!.source)}><Icon name="braces" size={14} /> {fileName(card.control_run.source)}</button>
        </Section>
      )}

      <details className="limits">
        <summary><Icon name="eyeOff" size={14} /> What this view cannot know</summary>
        <ul>{card.limits.map((limit, index) => <li key={index}>{limit.replaceAll("`", "")}</li>)}</ul>
      </details>
    </article>
  );
}
