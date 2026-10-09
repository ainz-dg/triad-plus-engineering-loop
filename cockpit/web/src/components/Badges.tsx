import type { ReactNode } from "react";
import { humanize } from "../format";
import type { Freshness, Provenance, VerificationStatus } from "../types";
import { Icon, type IconName } from "./Icon";

// Every visual state has text and a distinct shape/icon, never colour alone.

export const PROVENANCE_INFO: Record<Provenance, { label: string; short: string; icon: IconName; description: string }> = {
  "code-written": {
    label: "Written by Triad+",
    short: "Triad+ code",
    icon: "cpu",
    description: "Produced by Triad+ runtime code (verifier, packet writer, installer, driver). Deterministic evidence.",
  },
  "code-validated": {
    label: "Validated by Triad+",
    short: "Validated",
    icon: "shield",
    description: "Written by an agent and accepted by an existing Triad+ validator.",
  },
  "agent-declared": {
    label: "Declared by an agent",
    short: "Declared",
    icon: "quote",
    description: "Written by an agent with no Triad+ validation. A statement, not proof.",
  },
  "cockpit-derived": {
    label: "Computed by Cockpit",
    short: "Derived",
    icon: "sigma",
    description: "Calculated by the Cockpit from the artifacts above (counts, groupings, hash comparisons).",
  },
  unclassified: {
    label: "Unclassified file",
    short: "File",
    icon: "file",
    description: "A file served as-is; the Cockpit makes no claim about who wrote it.",
  },
};

export function ProvenanceBadge({ kind, compact = false }: { kind: Provenance; compact?: boolean }) {
  const info = PROVENANCE_INFO[kind] ?? PROVENANCE_INFO.unclassified;
  return (
    <span className={`prov prov-${kind}`} title={`${info.label}. ${info.description}`}>
      <Icon name={info.icon} size={13} />
      <span className="prov-label">{compact ? info.short : info.label}</span>
    </span>
  );
}

type Tone = "pass" | "fail" | "warn" | "info" | "neutral";

export function Chip({ tone = "neutral", icon, children, title, dashed = false }: { tone?: Tone; icon?: IconName; children: ReactNode; title?: string; dashed?: boolean }) {
  return (
    <span className={`chip chip-${tone}${dashed ? " chip-dashed" : ""}`} title={title}>
      {icon && <Icon name={icon} size={13} />}
      <span>{children}</span>
    </span>
  );
}

const VERIFICATION: Record<VerificationStatus | "unreadable", { label: string; tone: Tone; icon: IconName }> = {
  pass: { label: "Pass", tone: "pass", icon: "check" },
  fail: { label: "Fail", tone: "fail", icon: "cross" },
  invalid_context: { label: "Invalid context", tone: "warn", icon: "alert" },
  infrastructure_error: { label: "Infrastructure error", tone: "warn", icon: "alert" },
  invalidated: { label: "Invalidated", tone: "warn", icon: "alert" },
  unreadable: { label: "Unreadable", tone: "warn", icon: "alert" },
};

/** Verifier outcome only. It says nothing about review or approval. */
export function VerifierStatus({ status, prefix = true }: { status: VerificationStatus | "unreadable" | null | undefined; prefix?: boolean }) {
  if (!status) return <Chip icon="minus">{prefix ? "Verifier: none" : "None"}</Chip>;
  const info = VERIFICATION[status] ?? { label: humanize(status), tone: "neutral" as Tone, icon: "info" as IconName };
  return (
    <Chip tone={info.tone} icon={info.icon} title="Result recorded by triad-verify for this verification run">
      {prefix ? `Verifier: ${info.label}` : info.label}
    </Chip>
  );
}

export function GateStatus({ status }: { status: string | null }) {
  if (status === "pass") return <Chip tone="pass" icon="check">pass</Chip>;
  if (status === "fail") return <Chip tone="fail" icon="cross">fail</Chip>;
  if (status === "timeout") return <Chip tone="fail" icon="clock">timeout</Chip>;
  return <Chip icon="minus">{status ?? "unknown"}</Chip>;
}

/**
 * The Orchestrator's declared card state. Deliberately neutral and dashed:
 * "approved" here is a declaration in YAML, not a verified fact, and
 * "in_progress" does not mean an agent is running now.
 */
export function DeclaredState({ state, status }: { state?: string | null; status: "declared" | "not_declared" | "not_determinable" }) {
  if (status === "not_determinable") return <Chip tone="warn" icon="alert" dashed title="The work queue was only partly readable">State unknown</Chip>;
  if (status === "not_declared") return <Chip dashed icon="minus" title="This card is not in the work queue">Not in queue</Chip>;
  return (
    <Chip dashed icon="quote" title="Declared by the Orchestrator in .loop/work-queue.yaml; not verified by Triad+ code">
      {humanize(state ?? "no state")}
    </Chip>
  );
}

const BINDINGS: Record<Freshness["control_bindings"]["status"], { label: string; tone: Tone; icon: IconName; help: string }> = {
  unchanged: { label: "Control files unchanged", tone: "info", icon: "check", help: "Assignment, card, PRD, and gate files still hash to what the verifier recorded." },
  changed: { label: "Control files changed", tone: "warn", icon: "alert", help: "At least one file the verifier bound changed after it ran. The recorded result no longer describes current files." },
  unverifiable: { label: "Control files unverifiable", tone: "neutral", icon: "minus", help: "A bound file is missing, unrecorded, or outside the allowlist." },
};

/** Three independent axes; no combined verdict on purpose. */
export function FreshnessRow({ freshness }: { freshness: Freshness }) {
  const bindings = BINDINGS[freshness.control_bindings.status];
  const superseded = freshness.recency.status === "superseded";
  return (
    <div className="freshness" role="group" aria-label="Freshness of this verification">
      <span className="freshness-item">
        <span className="freshness-axis">Bindings</span>
        <Chip tone={bindings.tone} icon={bindings.icon} title={`${bindings.help} Checks: ${freshness.control_bindings.checks.map((check) => `${check.check.replace("_sha256", "")}=${check.result}`).join(", ")}`}>
          {bindings.label}
        </Chip>
      </span>
      <span className="freshness-item">
        <span className="freshness-axis">Recency</span>
        <Chip tone={superseded ? "neutral" : "info"} icon={superseded ? "layers" : "clock"} title={superseded ? "A later verification exists for this card." : "No later verification is recorded for this card."}>
          {superseded ? "Superseded" : "Latest for card"}
        </Chip>
      </span>
      <span className="freshness-item">
        <span className="freshness-axis">Candidate</span>
        <Chip tone="neutral" icon="eyeOff" dashed title={freshness.candidate.reason}>
          Not re-checked
        </Chip>
      </span>
    </div>
  );
}
