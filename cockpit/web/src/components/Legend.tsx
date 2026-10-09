import { useRef } from "react";
import { useDialog } from "../useDialog";
import type { Provenance } from "../types";
import { Chip, PROVENANCE_INFO, ProvenanceBadge } from "./Badges";
import { Icon } from "./Icon";

const KINDS: Provenance[] = ["code-written", "code-validated", "agent-declared", "cockpit-derived"];

export function Legend({ onClose }: { onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  useDialog(dialogRef, closeRef, onClose);
  return (
    <div className="viewer-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section ref={dialogRef} className="viewer legend" role="dialog" aria-modal="true" aria-labelledby="legend-title">
        <header className="viewer-head">
          <div className="viewer-title-wrap"><Icon name="help" size={18} /><h2 id="legend-title">How to read Triad Cockpit</h2></div>
          <button ref={closeRef} type="button" className="btn btn-icon" onClick={onClose} aria-label="Close"><Icon name="close" size={18} /></button>
        </header>
        <div className="viewer-body legend-body">
          <h3>Who wrote it</h3>
          <dl className="legend-list">
            {KINDS.map((kind) => (
              <div key={kind}><dt><ProvenanceBadge kind={kind} /></dt><dd>{PROVENANCE_INFO[kind].description}</dd></div>
            ))}
          </dl>

          <h3>Three different results</h3>
          <dl className="legend-list">
            <div><dt><strong>Verifier</strong></dt><dd>Deterministic gates (tests, lint, …) run by <span className="mono">triad-verify</span>. A pass means the recorded gates passed on the recorded candidate — nothing more.</dd></div>
            <div><dt><strong>Reviewer</strong></dt><dd>Independent semantic review. Only the optional deterministic driver stores a validated verdict; otherwise review lives in agent-written documents.</dd></div>
            <div><dt><strong>Evaluator+</strong></dt><dd>Optional product-quality check after approval. Validated against its contract by Triad+ code.</dd></div>
          </dl>
          <p className="small">The Cockpit never combines these into one “green”. A card is not shown as approved because a verification passed.</p>

          <h3>Freshness of a verification</h3>
          <dl className="legend-list">
            <div><dt><Chip tone="info" icon="check">Control files unchanged</Chip></dt><dd>The assignment, card, PRD, and gate files still match the hashes the verifier recorded.</dd></div>
            <div><dt><Chip tone="info" icon="clock">Latest for card</Chip></dt><dd>No later verification exists for the card.</dd></div>
            <div><dt><Chip icon="eyeOff" dashed>Not re-checked</Chip></dt><dd>The product candidate is never re-inspected. Unchanged control files do not prove the candidate is still the verified one.</dd></div>
          </dl>

          <h3>Declared state</h3>
          <p className="small"><Chip dashed icon="quote">approved</Chip> Dashed chips are the Orchestrator’s own declarations in <span className="mono">work-queue.yaml</span>. “In progress” does not mean an agent is running: Triad+ records no liveness.</p>

          <h3>Read-only</h3>
          <p className="small">The Cockpit cannot start, stop, or approve anything, and it never writes to the workspace.</p>
        </div>
      </section>
    </div>
  );
}
