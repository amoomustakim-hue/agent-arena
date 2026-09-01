"use server";

/**
 * Server-side mutations for the agent lineage engine. `fork`/`register` in
 * `@arena/reputation` are plain Node functions (they write a JSON file) —
 * Server Actions are the seam that lets a browser button call them without
 * a bespoke API route.
 *
 * The registry lives in the SAME shared `blackbox/` directory the Python
 * backend writes sessions into (see lib/reputation.ts), not the package's
 * own default of a `blackbox/` relative to whatever process happens to call
 * it — passed explicitly so a fork made from the UI and one made from the
 * TS CLI land in one file, not two quietly diverging registries.
 *
 * PAGE RENDERING NEVER WRITES. `getLineage` is read-only — it returns an
 * in-memory, unpersisted "virtual root" when the registry has none for a
 * role, rather than registering one on the spot. Next.js renders every
 * `generateStaticParams` page in parallel, so a write here would mean seven
 * roles all reading-then-writing the same registry file at once; a real
 * root only ever gets persisted from `forkAgentAction`, one user click at a
 * time, which is the only place a concurrent-write race isn't a near
 * certainty.
 */

import { join } from "node:path";
import { revalidatePath } from "next/cache";
import {
  register,
  fork,
  loadRegistry,
  ancestry,
  children,
  hashPersona,
  type AgentVersion,
  type Registry,
} from "@arena/reputation";
import type { AgentRole } from "@arena/core";
import { verifyIdentity } from "./wallet-verify";
import { forkStatement } from "./fork-statement";

const REGISTRY_PATH = join(process.cwd(), "..", "..", "blackbox", "agents.json");

const BASE_PERSONA: Record<AgentRole, string> = {
  bull: "Builds the strongest honest case that YES settles true. Stops the moment the evidence stops supporting it — a bull who returns 0.55 because the evidence supports 0.55 has done the job perfectly.",
  bear: "Builds the strongest honest case that YES settles false. Not a contrarian seat — manufacturing pessimism to fill the chair is the failure mode it exists to avoid.",
  forensics: "Audits whether every cited number was actually captured, and whether a case rests on the market's own price to prove the market's own price. Holds no directional view.",
  adversarial: "Hunts the assumption both sides made the same way. Returns severity none when the reasoning genuinely holds up — not paid per objection.",
  risk: "Reads liquidity, sizing, and time remaining. Names one specific, observable invalidation condition. Not a directional view.",
  judge: "Weighs the record, not the seats. A belief that survived a serious challenge outweighs one that was never tested.",
  trader: "Converts a verdict into a priced, risk-checked proposal.",
};

/** A root agent for `role` as it WOULD look if registered — computed, never
 *  written. Safe to call from every parallel static-render worker, because
 *  it touches no file. */
function virtualRoot(role: AgentRole): AgentVersion {
  const persona = BASE_PERSONA[role];
  return {
    id: `${role}@1`,
    slug: role,
    version: 1,
    role,
    displayName: role.toUpperCase(),
    persona,
    personaHash: hashPersona(persona),
    parent: null,
    author: "agent-arena",
    createdAt: 0,
  };
}

export async function getLineage(role: AgentRole): Promise<{ root: AgentVersion; forks: AgentVersion[] }> {
  const registry = await loadRegistry(REGISTRY_PATH);
  const persisted = registry.agents.find((a) => a.slug === role && a.parent === null);
  const root = persisted ?? virtualRoot(role);
  return { root, forks: children(registry, root.id) };
}

/** The one place a root is actually written — called from inside the single
 *  serialized fork action, never from page render. */
async function ensurePersistedRoot(role: AgentRole): Promise<AgentVersion> {
  const registry = await loadRegistry(REGISTRY_PATH);
  const existing = registry.agents.find((a) => a.slug === role && a.parent === null);
  if (existing) return existing;
  return register(
    { slug: role, role, displayName: role.toUpperCase(), persona: BASE_PERSONA[role], author: "agent-arena" },
    REGISTRY_PATH,
  );
}

export interface ForkResult {
  ok: boolean;
  error?: string;
  agent?: AgentVersion;
}

export async function forkAgentAction(role: AgentRole, formData: FormData): Promise<ForkResult> {
  const slug = String(formData.get("slug") ?? "").trim();
  const displayName = String(formData.get("displayName") ?? "").trim();
  const persona = String(formData.get("persona") ?? "").trim();
  const typedAuthor = String(formData.get("author") ?? "").trim();

  if (!slug || !/^[a-z0-9-]+$/.test(slug)) {
    return { ok: false, error: "Slug must be lowercase letters, numbers, and hyphens only." };
  }
  if (!displayName) return { ok: false, error: "Give it a display name." };
  if (persona.length < 20) return { ok: false, error: "Persona is too short to be a real strategy — say what it actually does differently." };

  // A connected wallet's signature makes authorship real instead of a typed
  // string anyone could put anything in. Optional — a wallet may not be
  // available on a demo machine — so this only upgrades `author`, it never
  // blocks the fork when absent.
  let author = typedAuthor || "anonymous";
  const walletAddress = String(formData.get("walletAddress") ?? "").trim();
  const walletMessage = String(formData.get("walletMessage") ?? "");
  const walletSignature = String(formData.get("walletSignature") ?? "");
  if (walletAddress && walletMessage && walletSignature) {
    const result = await verifyIdentity(
      walletAddress,
      walletMessage,
      walletSignature,
      forkStatement(role, slug, displayName),
    );
    if (!result.ok) return { ok: false, error: `Wallet signature invalid: ${result.error}` };
    author = `${result.address} (signed)`;
  }

  try {
    // Materialize the root here, inside this one action call, rather than at
    // page-render time — the write this needs is now serialized behind a
    // real user click, not racing six sibling static-generation workers.
    const root = await ensurePersistedRoot(role);
    const agent = await fork(root.id, { slug, displayName, persona, author }, REGISTRY_PATH);
    revalidatePath(`/reputation/${role}`);
    return { ok: true, agent };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function agentAncestry(id: string): Promise<AgentVersion[]> {
  const reg = await loadRegistry(REGISTRY_PATH);
  return ancestry(reg, id);
}

/**
 * Every fork a wallet has signed authorship of, across all roles — not
 * "contains this string," an exact match against the `${address} (signed)`
 * shape `forkAgentAction` writes, so a typed-text author that happens to
 * paste an address never gets credited as a real signature it never gave.
 */
export async function getForksByWallet(address: string): Promise<AgentVersion[]> {
  const reg = await loadRegistry(REGISTRY_PATH);
  const needle = `${address.toLowerCase()} (signed)`;
  return reg.agents.filter((a) => a.author.toLowerCase() === needle);
}

export type { Registry };
