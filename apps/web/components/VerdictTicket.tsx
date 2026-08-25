"use client";

import type { RecordedEvent } from "@arena/core/blackbox.js";
import { findEvent, findAllEvents, pct, pp } from "@/lib/derive";
import { AGENT_COLOR, Panel, Pct } from "./ui";

export default function VerdictTicket({ visible }: { visible: RecordedEvent[] }) {
  const verdict = findEvent(visible, "verdict");
  const edge = findEvent(visible, "edge_computed");
  const proposal = findEvent(visible, "trade_proposed");
  const risk = findEvent(visible, "risk_verdict");
  const approved = findEvent(visible, "trade_approved");
  const rejected = findEvent(visible, "trade_rejected");
  const executed = findEvent(visible, "trade_executed");
  const settled = findEvent(visible, "settled");
  const scores = findAllEvents(visible, "scored");

  if (!verdict) {
    return (
      <Panel eyebrow="Verdict" title="Not reached yet">
        <p className="text-2xs text-dim">Scrub forward — the judge has not spoken at this point in the session.</p>
      </Panel>
    );
  }

  return (
    <Panel eyebrow="Closing statement" title="Verdict">
      <div className="flex flex-col gap-4">
        <div>
          <div className="flex items-baseline gap-3">
            <span className="text-3xl font-semibold text-bright">
              <Pct v={verdict.p} />
            </span>
            <span className="font-mono text-2xs text-dim">spread {(verdict.spread * 100).toFixed(0)}pp</span>
          </div>
          <p className="mt-1.5 text-xs leading-relaxed text-mid">{verdict.dissent}</p>
        </div>

        {edge && (
          <Row label="Edge">
            <span className="tabular font-mono text-sm text-bright">
              council <Pct v={edge.councilP} /> vs market <Pct v={edge.marketImplied} />
            </span>
            <span className={`tabular font-mono text-sm ${edge.edge >= 0 ? "text-indep" : "text-circ"}`}>
              {pp(edge.edge)}
            </span>
          </Row>
        )}

        {proposal && (
          <Row label="Proposal">
            <span className="font-mono text-sm text-bright">
              {proposal.side} × {proposal.size} @ {pct(proposal.limitPrice)}
            </span>
            <span className="font-mono text-2xs text-dim">max loss {proposal.maxLoss}</span>
          </Row>
        )}
        {proposal && (
          <p className="-mt-2 text-2xs text-dim">
            <span className="text-mid">Invalidation:</span> {proposal.invalidation}
          </p>
        )}

        {risk && (
          <div>
            <div className="mb-1 flex items-center gap-2">
              <span className="text-2xs font-mono uppercase tracking-widest text-dim">Risk</span>
              <span className={`text-2xs font-mono uppercase ${risk.ok ? "text-indep" : "text-fatal"}`}>
                {risk.ok ? "pass" : "blocked"}
              </span>
            </div>
            <ul className="flex flex-col gap-1">
              {risk.concerns.map((c, i) => (
                <li key={i} className="text-2xs text-dim">
                  · {c}
                </li>
              ))}
            </ul>
          </div>
        )}

        {(approved || rejected) && (
          <Row label="Approval gate">
            {approved ? (
              <span className="font-mono text-2xs text-indep">approved by {approved.actor}</span>
            ) : rejected ? (
              <span className="font-mono text-2xs text-fatal">rejected — {rejected.why}</span>
            ) : null}
          </Row>
        )}

        {executed && (
          <Row label="Execution">
            <span className="font-mono text-2xs text-bright">
              {executed.dryRun ? "dry run" : `${executed.filled} filled`}
            </span>
            {!executed.dryRun && (
              <span className="truncate font-mono text-2xs text-dim" title={executed.txHash}>
                {executed.txHash.slice(0, 10)}…
              </span>
            )}
          </Row>
        )}

        {settled && (
          <Row label="Settlement">
            <span
              className={`font-mono text-sm font-semibold ${
                settled.outcome === "VOID" ? "text-dim" : settled.outcome === "NO" ? "text-bear" : "text-bull"
              }`}
            >
              {settled.outcome}
            </span>
            {settled.settlementPrice !== undefined && (
              <span className="tabular font-mono text-2xs text-dim">{settled.settlementPrice}</span>
            )}
          </Row>
        )}

        {scores.length > 0 && (
          <div>
            <span className="mb-1.5 block text-2xs font-mono uppercase tracking-widest text-dim">
              Scored
            </span>
            <div className="flex flex-col gap-1">
              {scores.map((s) => (
                <div key={s.agent} className="flex items-center justify-between text-2xs">
                  <span className="font-mono uppercase" style={{ color: AGENT_COLOR[s.agent] }}>
                    {s.agent}
                  </span>
                  <span className="tabular font-mono text-dim">
                    brier {s.brier.toFixed(4)}
                    {s.revisions > 0 ? `  ·  ${s.revisionsHelpful}/${s.revisions} helpful` : ""}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </Panel>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 border-t border-hair pt-2.5">
      <span className="shrink-0 text-2xs font-mono uppercase tracking-widest text-dim">{label}</span>
      <div className="flex items-center gap-2">{children}</div>
    </div>
  );
}
