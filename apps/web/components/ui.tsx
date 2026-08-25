import type { AgentRole } from "@arena/core/blackbox.js";

export const AGENT_COLOR: Record<AgentRole, string> = {
  bull: "#3ddc84",
  bear: "#ff5d6c",
  forensics: "#7aa2ff",
  adversarial: "#c07bff",
  risk: "#ffd23f",
  judge: "#4fe3e3",
  trader: "#94a3b8",
};

export const AGENT_ROLE_LABEL: Record<AgentRole, string> = {
  bull: "Opens directional",
  bear: "Opens directional",
  forensics: "Audits the record",
  adversarial: "Attacks both sides",
  risk: "Not directional",
  judge: "Synthesises",
  trader: "Converts verdict",
};

export const SEVERITY_COLOR: Record<"minor" | "material" | "fatal", string> = {
  minor: "#6b7d94",
  material: "#ffb020",
  fatal: "#ff3b4e",
};

export function Panel({
  children,
  className = "",
  title,
  eyebrow,
  style,
}: {
  children: React.ReactNode;
  className?: string;
  title?: React.ReactNode;
  eyebrow?: string;
  style?: React.CSSProperties;
}) {
  return (
    <section className={`rounded-md bg-panel shadow-panel ${className}`} style={style}>
      {(title || eyebrow) && (
        <header className="flex items-center justify-between border-b border-hair px-4 py-2.5">
          {eyebrow && (
            <span className="text-2xs font-mono uppercase tracking-widest text-dim">{eyebrow}</span>
          )}
          {title && <div className="text-sm font-medium text-bright">{title}</div>}
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

export function Chip({
  children,
  color,
  className = "",
}: {
  children: React.ReactNode;
  color?: string;
  className?: string;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-sm border px-1.5 py-0.5 font-mono text-2xs uppercase tracking-wide ${className}`}
      style={color ? { borderColor: `${color}55`, color } : { borderColor: "#1b2431", color: "#8c9bb0" }}
    >
      {children}
    </span>
  );
}

export function Pct({ v, className = "" }: { v: number; className?: string }) {
  return <span className={`tabular font-mono ${className}`}>{(v * 100).toFixed(1)}%</span>;
}
