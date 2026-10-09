import { useMemo, useRef, useState, type ReactNode } from "react";
import { useDialog } from "../useDialog";
import { api } from "../api";
import { fileName, formatBytes, formatDate, shortHash } from "../format";
import { useResource } from "../useResource";
import { ProvenanceBadge } from "./Badges";
import { Icon } from "./Icon";
import { Markdown } from "./Markdown";
import { EmptyState, ErrorState, Loading } from "./States";

// Read-only viewer for one allowlisted file. Content is always rendered as
// text nodes (Markdown through the inert renderer), so nothing in an artifact
// can run, load, or navigate. The path is sent to the backend unchanged; the
// backend allowlist decides what is readable.

type Kind = "markdown" | "json" | "text";

function kindOf(path: string): Kind {
  if (/\.md$/i.test(path)) return "markdown";
  if (/\.json$/i.test(path)) return "json";
  return "text";
}

function JsonView({ text }: { text: string }) {
  const pretty = useMemo(() => {
    try { return { ok: true as const, text: JSON.stringify(JSON.parse(text), null, 2) }; }
    catch { return { ok: false as const, text }; }
  }, [text]);
  const tokens = useMemo(() => {
    if (!pretty.ok) return [pretty.text];
    const out: ReactNode[] = [];
    const pattern = /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g;
    let last = 0;
    let key = 0;
    for (let match = pattern.exec(pretty.text); match; match = pattern.exec(pretty.text)) {
      if (match.index > last) out.push(pretty.text.slice(last, match.index));
      const className = match[1] ? (match[2] ? "j-key" : "j-str") : match[3] ? "j-lit" : "j-num";
      out.push(<span key={key++} className={className}>{match[1] ?? match[0]}</span>);
      if (match[2]) out.push(match[2]);
      last = pattern.lastIndex;
    }
    out.push(pretty.text.slice(last));
    return out;
  }, [pretty]);
  return (
    <>
      {!pretty.ok && <p className="viewer-note"><Icon name="alert" size={14} /> Not valid JSON; shown as text.</p>}
      <pre className="code-view json-view" tabIndex={0}><code>{tokens}</code></pre>
    </>
  );
}

function TextView({ text, wrap }: { text: string; wrap: boolean }) {
  const lines = useMemo(() => text.replace(/\n$/, "").split("\n"), [text]);
  if (text.length === 0) return <EmptyState icon="minus" title="Empty file">The file exists and has no content.</EmptyState>;
  return (
    <pre className={`code-view text-view${wrap ? " wrap" : ""}`} tabIndex={0}>
      <code>
        {lines.map((line, index) => (
          <span className="line" key={index}>
            <span className="ln" aria-hidden="true">{index + 1}</span>
            <span className="lc">{line || " "}</span>
            {"\n"}
          </span>
        ))}
      </code>
    </pre>
  );
}

export function ArtifactViewer({ project, path, onClose, epoch }: { project: string; path: string; onClose: () => void; epoch: number }) {
  const resource = useResource(`${project}\u0000${path}`, (signal) => api.file(project, path, signal), epoch);
  const [wrap, setWrap] = useState(true);
  const [copied, setCopied] = useState<"idle" | "done" | "failed">("idle");
  const closeRef = useRef<HTMLButtonElement>(null);
  const kind = kindOf(path);

  const dialogRef = useRef<HTMLElement>(null);
  useDialog(dialogRef, closeRef, onClose);

  const artifact = resource.state === "ready" ? resource.data : null;
  const copy = async () => {
    if (!artifact?.content) return;
    try {
      await navigator.clipboard.writeText(artifact.content);
      setCopied("done");
    } catch {
      setCopied("failed");
    }
    window.setTimeout(() => setCopied("idle"), 2000);
  };

  return (
    <div className="viewer-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section ref={dialogRef} className="viewer" role="dialog" aria-modal="true" aria-labelledby="viewer-title">
        <header className="viewer-head">
          <div className="viewer-title-wrap">
            <Icon name={kind === "json" ? "braces" : kind === "markdown" ? "file" : "terminal"} size={18} />
            <div>
              <h2 id="viewer-title">{fileName(path)}</h2>
              <p className="viewer-path mono">{path}</p>
            </div>
          </div>
          <div className="viewer-actions">
            {kind === "text" && artifact?.content && (
              <button type="button" className="btn btn-ghost" aria-pressed={wrap} onClick={() => setWrap(!wrap)}>
                <Icon name="wrap" /> {wrap ? "Wrap on" : "Wrap off"}
              </button>
            )}
            {artifact?.content && (
              <button type="button" className="btn btn-ghost" onClick={copy}>
                <Icon name={copied === "done" ? "check" : "copy"} /> {copied === "done" ? "Copied" : copied === "failed" ? "Copy failed" : "Copy"}
              </button>
            )}
            <button ref={closeRef} type="button" className="btn btn-icon" onClick={onClose} aria-label="Close viewer">
              <Icon name="close" size={18} />
            </button>
          </div>
        </header>
        {artifact && (
          <div className="viewer-meta">
            <ProvenanceBadge kind={artifact.provenance} />
            <span>{formatBytes(artifact.size)}</span>
            <span title={artifact.modified_at}>Modified {formatDate(artifact.modified_at)}</span>
            {artifact.sha256 && <span className="mono" title={artifact.sha256}>sha256 {shortHash(artifact.sha256, 12)}</span>}
          </div>
        )}
        {artifact?.truncated && (
          <p className="viewer-banner" role="note">
            <Icon name="alert" size={14} /> Truncated: only the first {formatBytes(artifact.content?.length ?? 0)} of {formatBytes(artifact.size)} are shown. The Cockpit caps reads at 1 MiB.
          </p>
        )}
        <div className="viewer-body">
          {resource.state === "loading" && <Loading label="Loading artifact…" />}
          {resource.state === "error" && (resource.error.kind === "not_found"
            ? <EmptyState icon="minus" title="Artifact not available">The file does not exist in this workspace (it may never have been written).</EmptyState>
            : <ErrorState error={resource.error} what="Artifact" />)}
          {artifact && artifact.encoding === "omitted-binary" && <EmptyState icon="eyeOff" title="Binary content omitted">The Cockpit only displays text artifacts.</EmptyState>}
          {artifact && artifact.content !== null && (kind === "markdown" ? <Markdown source={artifact.content} /> : kind === "json" ? <JsonView text={artifact.content} /> : <TextView text={artifact.content} wrap={wrap} />)}
        </div>
      </section>
    </div>
  );
}
