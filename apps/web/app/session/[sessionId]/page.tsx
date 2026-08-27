"use client";

import { useEffect, useRef, useState, use as usePromise } from "react";
import Link from "next/link";
import type { RecordedEvent } from "@arena/core/blackbox.js";
import { WS_URL, proposeTrade, settleSession } from "@/lib/api";
import { findEvent } from "@/lib/derive";
import WarRoom from "@/components/WarRoom";

type ConnState = "connecting" | "open" | "closed" | "error";

/**
 * The live counterpart to the static war room: same rendering components,
 * fed by a WebSocket instead of a fixture file. The backend replays every
 * event recorded so far on connect, then streams new ones — this component
 * does not distinguish the two, it just appends to `events` either way,
 * which is what makes attaching mid-debate show the full causal graph
 * rather than only whatever happens to arrive after the socket opens.
 */
export default function LiveSessionPage({ params }: { params: Promise<{ sessionId: string }> }) {
  const { sessionId } = usePromise(params);
  const [events, setEvents] = useState<RecordedEvent[]>([]);
  const [conn, setConn] = useState<ConnState>("connecting");
  const [phase, setPhase] = useState<string>("");
  const [runStatus, setRunStatus] = useState<"running" | "done" | "error" | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [proposing, setProposing] = useState(false);
  const [settling, setSettling] = useState(false);
  const seenIds = useRef(new Set<string>());

  useEffect(() => {
    seenIds.current = new Set();
    setEvents([]);
    const ws = new WebSocket(`${WS_URL}/ws/council/${sessionId}`);
    ws.onopen = () => setConn("open");
    ws.onerror = () => setConn("error");
    ws.onclose = () => setConn((c) => (c === "error" ? c : "closed"));
    ws.onmessage = (msg) => {
      const data = JSON.parse(msg.data);
      if (data.type === "event") {
        const ev: RecordedEvent = data.event;
        if (seenIds.current.has(ev.id)) return; // replay + reconnect can overlap
        seenIds.current.add(ev.id);
        setEvents((prev) => [...prev, ev].sort((a, b) => a.seq - b.seq));
      } else if (data.type === "progress") {
        setPhase(data.detail ?? data.phase ?? "");
        if (typeof data.sLeft === "number") {
          setPhase((_) => `${data.detail ?? data.phase} (${Math.max(0, Math.round(data.sLeft))}s left)`);
        }
        if (data.phase === "closed") setRunStatus(data.detail === "done" ? "done" : "error");
      } else if (data.type === "status") {
        if (data.status === "done" || data.status === "error") setRunStatus(data.status);
        else setRunStatus("running");
      }
    };
    return () => ws.close();
  }, [sessionId]);

  const verdict = findEvent(events, "verdict");
  const settled = findEvent(events, "settled");

  const handlePropose = async () => {
    setProposing(true);
    setActionError(null);
    try {
      await proposeTrade(sessionId);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setProposing(false);
    }
  };

  const handleSettle = async () => {
    setSettling(true);
    setActionError(null);
    try {
      const res = await settleSession(sessionId);
      if (!res.settled) setActionError(res.detail ?? "Not settled yet — try again once the window closes.");
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setSettling(false);
    }
  };

  if (conn === "connecting" && events.length === 0) {
    return (
      <div className="mx-auto max-w-[900px] px-5 py-10 text-sm text-dim">Connecting to session…</div>
    );
  }
  if (conn === "error" && events.length === 0) {
    return (
      <div className="mx-auto max-w-[900px] px-5 py-10">
        <p className="text-sm text-fatal">
          Could not reach the session. Is the backend running, and is <code>NEXT_PUBLIC_API_URL</code>{" "}
          pointed at it?
        </p>
        <Link href="/markets" className="mt-3 inline-block text-xs text-mid underline">
          ← back to markets
        </Link>
      </div>
    );
  }
  if (events.length === 0) {
    return (
      <div className="mx-auto max-w-[900px] px-5 py-10 text-sm text-dim">
        Waiting for the first event… {phase}
      </div>
    );
  }

  return (
    <div>
      <div className="mx-auto flex max-w-[1400px] items-center justify-between gap-4 px-5 pt-4 text-2xs">
        <div className="flex items-center gap-3 font-mono uppercase tracking-widest">
          <Link href="/markets" className="text-dim hover:text-mid">
            ← markets
          </Link>
          <span className="text-dim">session {sessionId}</span>
          {runStatus === "running" && <span className="text-fatal">{phase}</span>}
          {runStatus === "error" && <span className="text-fatal">council failed — see backend logs</span>}
          {runStatus === "done" && <span className="text-indep">council finished</span>}
        </div>
        <div className="flex items-center gap-2">
          {verdict && !settled && (
            <button
              onClick={handlePropose}
              disabled={proposing}
              className="rounded-sm border border-indep/40 px-2.5 py-1 font-mono text-2xs uppercase text-indep hover:bg-indep/10 disabled:opacity-40"
            >
              {proposing ? "proposing…" : "propose trade"}
            </button>
          )}
          {verdict && !settled && (
            <button
              onClick={handleSettle}
              disabled={settling}
              className="rounded-sm border border-hair2 px-2.5 py-1 font-mono text-2xs uppercase text-mid hover:bg-panel2 disabled:opacity-40"
              title="Checks the chain and scores every agent. Read-only against the chain — does not claim winnings."
            >
              {settling ? "checking…" : "settle now"}
            </button>
          )}
        </div>
      </div>
      {actionError && (
        <div className="mx-auto max-w-[1400px] px-5 pt-2">
          <div className="rounded-sm border border-fatal/40 bg-fatal/10 px-3 py-2 text-2xs text-fatal">
            {actionError}
          </div>
        </div>
      )}
      <WarRoom events={events} live={runStatus === "running" || runStatus === null} />
    </div>
  );
}
