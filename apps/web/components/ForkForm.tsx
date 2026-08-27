"use client";

import { useActionState, useState } from "react";
import type { AgentRole } from "@arena/core";
import { forkAgentAction, type ForkResult } from "@/lib/lineage-actions";

const initial: ForkResult = { ok: false };

export default function ForkForm({ role, parentPersona }: { role: AgentRole; parentPersona: string }) {
  const [open, setOpen] = useState(false);
  const [state, formAction, pending] = useActionState(
    (_prev: ForkResult, fd: FormData) => forkAgentAction(role, fd),
    initial,
  );

  if (state.ok && state.agent) {
    return (
      <div className="rounded-sm border border-indep/40 bg-indep/10 px-3 py-2 text-2xs text-indep">
        Forked as <strong className="font-mono">{state.agent.id}</strong> — starts with an empty
        track record. Reputation is never inherited; the lineage is displayed, the credibility is
        not transferred.
      </div>
    );
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="rounded-sm border border-hair px-2.5 py-1 font-mono text-2xs uppercase tracking-wide text-dim hover:border-hair2 hover:text-mid"
      >
        Fork agent
      </button>
    );
  }

  return (
    <form action={formAction} className="flex w-full flex-col gap-2 rounded-sm border border-hair p-3 text-xs">
      <div className="flex items-center justify-between">
        <span className="font-mono text-2xs uppercase tracking-widest text-dim">Fork this agent</span>
        <button type="button" onClick={() => setOpen(false)} className="text-2xs text-dim hover:text-mid">
          cancel
        </button>
      </div>
      <p className="text-2xs text-dim">
        A fork starts with an empty track record — reputation is never inherited. It also has to
        actually change the persona; a fork that&apos;s byte-identical to its parent is refused.
      </p>
      <input
        name="slug"
        placeholder="slug (e.g. bull-aggressive)"
        required
        pattern="[a-z0-9-]+"
        className="rounded-sm border border-hair bg-void px-2 py-1 font-mono text-2xs text-bright placeholder:text-dim"
      />
      <input
        name="displayName"
        placeholder="Display name"
        required
        className="rounded-sm border border-hair bg-void px-2 py-1 text-xs text-bright placeholder:text-dim"
      />
      <input
        name="author"
        placeholder="Your name or handle"
        className="rounded-sm border border-hair bg-void px-2 py-1 text-xs text-bright placeholder:text-dim"
      />
      <textarea
        name="persona"
        required
        rows={4}
        defaultValue={parentPersona}
        placeholder="What does this version do differently?"
        className="rounded-sm border border-hair bg-void px-2 py-1.5 text-xs leading-relaxed text-bright placeholder:text-dim"
      />
      {state.error && <p className="text-2xs text-fatal">{state.error}</p>}
      <button
        type="submit"
        disabled={pending}
        className="self-start rounded-sm border border-indep/40 px-2.5 py-1 font-mono text-2xs uppercase tracking-wide text-indep hover:bg-indep/10 disabled:opacity-40"
      >
        {pending ? "forking…" : "create fork"}
      </button>
    </form>
  );
}
