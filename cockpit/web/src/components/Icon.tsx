// A small, dependency-free icon set (24px grid, 1.75 stroke). Icons are
// decorative unless a label is passed; meaning is always also in text.

const PATHS = {
  triad: "M12 3.5 20.5 18.5H3.5Z",
  lock: "M7 11V8a5 5 0 0 1 10 0v3M6 11h12v9H6z",
  refresh: "M20 12a8 8 0 1 1-2.34-5.66M20 4v5h-5",
  check: "M5 12.5 10 17.5 19 7",
  cross: "M6.5 6.5 17.5 17.5M17.5 6.5 6.5 17.5",
  alert: "M12 4 21 19.5H3ZM12 10v4.5M12 17.2v.3",
  info: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 11v5.5M12 7.6v.3",
  minus: "M6 12h12",
  dot: "M12 13.2a1.2 1.2 0 1 0 0-2.4 1.2 1.2 0 0 0 0 2.4Z",
  chevronRight: "M9.5 6 15.5 12 9.5 18",
  chevronLeft: "M14.5 6 8.5 12 14.5 18",
  chevronDown: "M6 9.5 12 15.5 18 9.5",
  file: "M14 3.5H7a1.5 1.5 0 0 0-1.5 1.5v14A1.5 1.5 0 0 0 7 20.5h10a1.5 1.5 0 0 0 1.5-1.5V8ZM14 3.5V8h4.5",
  terminal: "M4 5h16v14H4zM7.5 9.5 10.5 12 7.5 14.5M12.5 15h4",
  braces: "M8.5 4.5c-2 0-2.5 1-2.5 2.5v2.5c0 1.2-.8 2-2 2.5 1.2.5 2 1.3 2 2.5V17c0 1.5.5 2.5 2.5 2.5M15.5 4.5c2 0 2.5 1 2.5 2.5v2.5c0 1.2.8 2 2 2.5-1.2.5-2 1.3-2 2.5V17c0 1.5-.5 2.5-2.5 2.5",
  copy: "M9 9h10.5v10.5H9zM15 9V4.5H4.5V15H9",
  close: "M6.5 6.5 17.5 17.5M17.5 6.5 6.5 17.5",
  search: "M10.5 17a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13ZM15.5 15.5 20 20",
  menu: "M4 7h16M4 12h16M4 17h16",
  cpu: "M8 8h8v8H8zM5 10H3M5 14H3M21 10h-2M21 14h-2M10 5V3M14 5V3M10 21v-2M14 21v-2M5 5h14v14H5z",
  shield: "M12 3.5 19 6v5.5c0 4.2-2.9 7.7-7 9-4.1-1.3-7-4.8-7-9V6ZM8.8 12.2l2.2 2.2 4.3-4.6",
  quote: "M5 6.5h14v9h-8l-4.5 3.5v-3.5H5z",
  sigma: "M17 5H7l5.5 7L7 19h10",
  layers: "M12 4 21 9l-9 5-9-5ZM3 14l9 5 9-5",
  folder: "M3.5 6.5h6l2 2h9v10h-17z",
  sun: "M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4",
  moon: "M19.5 14.5A8 8 0 0 1 9.5 4.5a8 8 0 1 0 10 10Z",
  monitor: "M3.5 5h17v11h-17zM9 20h6M12 16v4",
  help: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM9.6 9.4a2.5 2.5 0 0 1 4.9.7c0 1.7-2.5 2.2-2.5 3.9M12 17v.3",
  clock: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 7.5V12l3 2",
  wrap: "M4 6h16M4 12h13a3 3 0 0 1 0 6h-4M4 18h5M14.5 16l-2 2 2 2",
  eyeOff: "M3 3l18 18M10.6 6.1A9.8 9.8 0 0 1 12 6c5 0 8.5 4.5 9.5 6-.5.8-1.6 2.2-3.1 3.5M6.6 6.7C4.6 8 3.2 9.9 2.5 12c1 1.5 4.5 6 9.5 6 1.6 0 3-.4 4.3-1M9.9 9.9a3 3 0 0 0 4.2 4.2",
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, label, size = 16, className }: { name: IconName; label?: string; size?: number; className?: string }) {
  return (
    <svg
      className={className ? `icon ${className}` : "icon"}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      focusable="false"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}

/** The Triad+ mark: three roles on a triangle. */
export function TriadMark({ size = 28 }: { size?: number }) {
  return (
    <svg className="triad-mark" width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <path d="M16 6 26 23H6Z" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
      <circle className="node node-orchestrator" cx="16" cy="6.5" r="2.7" />
      <circle className="node node-reviewer" cx="25.4" cy="22.6" r="2.7" />
      <circle className="node node-developer" cx="6.6" cy="22.6" r="2.7" />
    </svg>
  );
}
