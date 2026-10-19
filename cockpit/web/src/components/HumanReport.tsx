import { useId } from "react";
import type { DocumentRef } from "../types";
import { Icon } from "./Icon";

// Only the backend discovers files. This entry never infers materialization
// or approval from a declared state, a file name, or Markdown contents.
export function HumanReport({ title, document, missing, onOpen }: {
  title: "Card report" | "Delivery handoff";
  document?: DocumentRef | null;
  missing: string;
  onOpen: (path: string) => void;
}) {
  const noteId = useId();
  return (
    <section className="human-report" aria-label={title}>
      {document ? (
        <>
          <button type="button" className="btn btn-block" aria-describedby={noteId} onClick={() => onOpen(document.source)}>
            <Icon name="file" size={16} /> {title}
          </button>
          <p id={noteId} className="muted small">Derived human-readable view; not a new approval or verification.</p>
        </>
      ) : (
        <>
          <h2>{title}</h2>
          <p className="muted small">{missing}</p>
        </>
      )}
    </section>
  );
}
