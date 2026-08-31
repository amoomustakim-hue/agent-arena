"use client";

import { useActionState, useState, useRef } from "react";
import type { AgentRole } from "@arena/core";
import { forkAgentAction, type ForkResult } from "@/lib/lineage-actions";
import { useWalletIdentity } from "@/lib/useWalletIdentity";
import { forkStatement } from "@/lib/fork-statement";

const initial: ForkResult = { ok: false };

export default function ForkForm({ role, parentPersona }: { role: AgentRole; parentPersona: string }) {
  const [open, setOpen] = useState(false);
  const [signing, setSigning] = useState(false);
  const [signError, setSignError] = useState<string | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const { address, isConnected, sign } = useWalletIdentity();
  const [state, formAction, pending] = useActionState(
    (_prev: ForkResult, fd: FormData) => forkAgentAction(role, fd),
    initial,
  );

  // useActionState's dispatch normally fires from <form action={...}>. Here
  // it's invoked manually instead, because a connected wallet needs an
  // async signature step BEFORE the action runs — the fork's exact slug and
  // display name have to be in the signed statement, so signing can't happen
  // until the user has actually typed them.
  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSignError(null);
    const fd = new FormData(e.currentTarget);

    if (isConnected && address) {
      const slug = String(fd.get("slug") ?? "").trim();
      const displayName = String(fd.get("displayName") ?? "").trim();
      setSigning(true);
      const identity = await sign(forkStatement(role, slug, displayName));
      setSigning(false);
      if (!identity) {
        setSignError("Signature request was rejected or the wallet didn't respond — submitting as anonymous instead.");
      } else {
        fd.set("walletAddress", identity.address);
        fd.set("walletMessage", identity.message);
        fd.set("walletSignature", identity.signature);
      }
    }

    formAction(fd);
  }

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
    <form ref={formRef} onSubmit={handleSubmit} className="flex w-full flex-col gap-2 rounded-sm border border-hair p-3 text-xs">
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
        pattern="[a-z0-9\-]+"
        className="rounded-sm border border-hair bg-void px-2 py-1 font-mono text-2xs text-bright placeholder:text-dim"
      />
      <input
        name="displayName"
        placeholder="Display name"
        required
        className="rounded-sm border border-hair bg-void px-2 py-1 text-xs text-bright placeholder:text-dim"
      />
      {isConnected && address ? (
        <p className="rounded-sm border border-indep/30 bg-indep/5 px-2 py-1 font-mono text-2xs text-indep">
          Authorship will be signed by {address.slice(0, 6)}…{address.slice(-4)} — a real signature,
          not typed text.
        </p>
      ) : (
        <input
          name="author"
          placeholder="Your name or handle"
          className="rounded-sm border border-hair bg-void px-2 py-1 text-xs text-bright placeholder:text-dim"
        />
      )}
      <textarea
        name="persona"
        required
        rows={4}
        defaultValue={parentPersona}
        placeholder="What does this version do differently?"
        className="rounded-sm border border-hair bg-void px-2 py-1.5 text-xs leading-relaxed text-bright placeholder:text-dim"
      />
      {signError && <p className="text-2xs text-material">{signError}</p>}
      {state.error && <p className="text-2xs text-fatal">{state.error}</p>}
      <button
        type="submit"
        disabled={pending || signing}
        className="self-start rounded-sm border border-indep/40 px-2.5 py-1 font-mono text-2xs uppercase tracking-wide text-indep hover:bg-indep/10 disabled:opacity-40"
      >
        {signing ? "sign in wallet…" : pending ? "forking…" : "create fork"}
      </button>
    </form>
  );
}
