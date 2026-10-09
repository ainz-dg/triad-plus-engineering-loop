// Shapes returned by cockpit/server (see cockpit/README.md). The UI renders
// them; it never re-validates artifacts or re-derives backend conclusions.

export type Provenance = "code-written" | "code-validated" | "agent-declared" | "cockpit-derived" | "unclassified";

export interface Workspace {
  cockpit: { version: string; read_only: true };
  installation: {
    status: "valid" | "invalid" | "missing";
    provenance: Provenance;
    source: string;
    triad_version?: string;
    adapter?: string;
    installation_status?: string;
    updated_at?: string;
    error?: string;
    note?: string;
  };
  team: {
    status: "valid" | "invalid" | "missing";
    provenance: Provenance;
    note?: string;
    error?: string;
    roles?: Array<{ id: string; display_name: string; model: string | null; reasoning_effort: string | null; enabled: boolean }>;
  };
  projects: Array<{ id: string; base: string; layout: "control-root" | "projects-directory" }>;
  limits: string[];
}

export interface Declared {
  status: "declared" | "not_declared" | "not_determinable";
  provenance: Provenance;
  source: string;
  reason?: string;
  title?: string | null;
  state?: string | null;
  attempts?: number | string | null;
  depends_on?: string[] | string | null;
  required_gates?: string[] | string | null;
  card_path?: string | null;
  unsupported_keys?: string[];
}

export type VerificationStatus = "pass" | "fail" | "invalid_context" | "infrastructure_error" | "invalidated";

export interface CardSummary {
  id: string;
  declared: Declared;
  observed: {
    provenance: Provenance;
    assignment_count: number;
    attempt_numbers: number[];
    verification_count: number;
    latest_verification: { status: VerificationStatus; created_at: string | null; source: string; provenance: Provenance } | null;
  };
}

export interface CardList {
  project: string;
  work_queue: { status: "ok" | "partial" | "unreadable" | "missing"; source: string; provenance: Provenance; warnings: string[] };
  cards: CardSummary[];
  unmatched_evaluations: Array<{ source: string; provenance: Provenance; feature_id: string | null; readable: boolean }>;
  diagnostics: Array<{ source: string; problem: string }>;
  limits: string[];
}

export interface Gate {
  id: string | null;
  required: boolean;
  status: string | null;
  exit_code: number | null;
  duration_ms: number | null;
  output_truncated: boolean;
  stdout_log: string | null;
  stderr_log: string | null;
}

export interface Freshness {
  provenance: Provenance;
  control_bindings: { status: "unchanged" | "changed" | "unverifiable"; checks: Array<{ check: string; result: string }> };
  recency: { status: "latest_for_card" | "superseded" };
  candidate: { status: "not_checked"; recorded_fingerprint: string | null; reason: string };
}

export interface Verification {
  source: string;
  provenance: Provenance;
  status: VerificationStatus | "unreadable";
  error?: string;
  run_id?: string | null;
  assignment_id?: string | null;
  attempt?: number | null;
  created_at?: string | null;
  required_gates_passed?: boolean;
  failure?: { code?: string; reason?: string } | null;
  candidate_fingerprint?: string | null;
  git_head?: string | null;
  branch?: string | null;
  scope_status?: string | null;
  gates?: Gate[];
  freshness?: Freshness;
}

export interface Packet {
  status: "valid" | "invalid" | "missing" | "not_bound";
  provenance: Provenance;
  source?: string | null;
  sha256?: string;
  branch?: string | null;
  error?: string;
}

export interface AssignmentView {
  source: string;
  provenance: Provenance;
  sha256: string;
  assignment_id: string | null;
  agent_type: string | null;
  declared_status: string | null;
  expected_branch: string | null;
  required_gate_ids: string[];
  verification_run_id: string | null;
  packet: Packet;
}

export interface DocumentRef {
  source: string;
  provenance: Provenance;
  matches?: string[];
}

export interface Attempt {
  attempt: number;
  assignments: AssignmentView[];
  verifications: Verification[];
  documents: DocumentRef[];
}

export interface Evaluation {
  source: string;
  provenance: Provenance;
  status: "valid" | "invalid" | "not_validated" | "unreadable";
  verdict?: string | null;
  created_at?: string | null;
  error?: string;
  error_code?: string | null;
  validation?: {
    contract: "legacy" | "quality_contract";
    reason?: string;
    note?: string;
    quality_baseline?: { source: string; fingerprint: string; binding: string };
    expected_candidate_fingerprint?: { value: string; source: string; provenance: Provenance } | null;
  };
  candidate_binding?: { provenance: Provenance; result: string; note: string };
}

export interface ControlRun {
  source: string;
  provenance: Provenance;
  path_kind: string;
  status: string | null;
  feature_id: string | null;
  trace: Array<{ at: string | null; phase: string | null; action: string | null; reason: string | null }>;
  reviewer: null | {
    status: "valid" | "invalid";
    provenance: Provenance;
    decision?: string;
    summary?: string | null;
    findings?: unknown[];
    error?: string;
  };
  limit: string;
}

export interface CardDetail {
  project: string;
  id: string;
  declared: Declared;
  attempts: Attempt[];
  evaluations: Evaluation[];
  reviewer: { provenance: Provenance; note: string; documents: DocumentRef[]; ambiguous_documents: DocumentRef[] };
  control_run: ControlRun | null;
  limits: string[];
}

export interface Artifact {
  source: string;
  provenance: Provenance;
  size: number;
  modified_at: string;
  truncated: boolean;
  sha256: string | null;
  encoding: "utf8" | "omitted-binary";
  content: string | null;
}
