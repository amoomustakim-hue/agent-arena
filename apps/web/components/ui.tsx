import type { AgentRole } from "@arena/core/blackbox.js";

// Black and white throughout. Agent identity is carried by the text label
// (every card/row already writes the role out), not by a color key someone
// has to learn — six neon hues was the "too futuristic" complaint. What
// still needs a real visual signal (severity, independent vs. circular) gets
// one through WEIGHT — filled vs. outlined vs. plain — not hue.
export const AGENT_COLOR: Record<AgentRole, string> = {
  bull: "#f5f5f5",
  bear: "#f5f5f5",
  forensics: "#f5f5f5",
  adversarial: "#f5f5f5",
  risk: "#f5f5f5",
  judge: "#f5f5f5",
  trader: "#f5f5f5",
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

export type Severity = "minor" | "material" | "fatal";

/** Weight, not hue: fatal is filled solid, material is outlined, minor is
 *  plain text. A severity someone can feel without reading the label. */
export const SEVERITY_WEIGHT: Record<Severity, "filled" | "outlined" | "plain"> = {
  fatal: "filled",
  material: "outlined",
  minor: "plain",
};

// Kept for any remaining callers that still index a single color by
// severity — all resolve to the same neutral, since the real distinction is
// SEVERITY_WEIGHT now.
export const SEVERITY_COLOR: Record<Severity, string> = {
  minor: "#8a8a8a",
  material: "#d4d4d4",
  fatal: "#f5f5f5",
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
    <section className={`rounded-lg bg-panel shadow-panel ${className}`} style={style}>
      {(title || eyebrow) && (
        <header className="flex items-center justify-between border-b border-hair px-5 py-3.5">
          {eyebrow && <span className="text-xs font-medium tracking-wide text-dim">{eyebrow}</span>}
          {title && <div className="text-base font-semibold text-bright">{title}</div>}
        </header>
      )}
      <div className="p-5">{children}</div>
    </section>
  );
}

/** A filled chip (solid background) for the highest-attention state, an
 *  outlined chip for a real-but-lesser one, or plain text for informational
 *  only — the severity/state ladder expressed as weight instead of color. */
export function Chip({
  children,
  weight = "outlined",
  className = "",
}: {
  children: React.ReactNode;
  weight?: "filled" | "outlined" | "plain";
  className?: string;
}) {
  const base = "inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-xs font-medium tracking-wide";
  if (weight === "filled") {
    return <span className={`${base} bg-bright text-void ${className}`}>{children}</span>;
  }
  if (weight === "plain") {
    return <span className={`${base} text-dim ${className}`}>{children}</span>;
  }
  return <span className={`${base} border border-hair2 text-mid ${className}`}>{children}</span>;
}

export function Pct({ v, className = "" }: { v: number; className?: string }) {
  return <span className={`tabular font-mono ${className}`}>{(v * 100).toFixed(1)}%</span>;
}
