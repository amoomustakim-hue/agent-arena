/**
 * Agent versioning and forking — §7's GitHub-style ecosystem.
 *
 * An "agent" here is a persona plus its parameters. Forking one produces a new
 * agent with its own identity and its own reputation, and a permanent pointer
 * back to its parent.
 *
 * The rule that makes this honest: **a fork starts with an empty track record.**
 * It does not inherit the parent's Brier score. Inheriting reputation would let
 * anyone fork the top agent, change one word of the prompt, and claim its
 * history — which is exactly how a reputation system becomes worthless. The
 * lineage is displayed, the credibility is not transferred.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { AgentRole } from "@arena/core";

export const REGISTRY = process.env.ARENA_REGISTRY ?? join("blackbox", "agents.json");

export interface AgentVersion {
  /** Stable id: `${slug}@${version}`. */
  id: string;
  slug: string;
  version: number;
  role: AgentRole;
  displayName: string;
  /** The prompt that defines this agent's behaviour. */
  persona: string;
  /** Content hash of the persona. Two agents with the same hash behave
   *  identically, so a "fork" that changed nothing is detectable rather than
   *  presented as new work. */
  personaHash: string;
  /** The agent this was forked from, or null for a root agent. */
  parent: string | null;
  author: string;
  createdAt: number;
}

export const hashPersona = (p: string) =>
  createHash("sha256").update(p.trim()).digest("hex").slice(0, 12);

export interface Registry {
  agents: AgentVersion[];
}

export async function loadRegistry(path = REGISTRY): Promise<Registry> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return { agents: [] };
  }
}

export async function saveRegistry(reg: Registry, path = REGISTRY): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, JSON.stringify(reg, null, 2), "utf8");
}

export async function register(
  spec: { slug: string; role: AgentRole; displayName: string; persona: string; author: string },
  path = REGISTRY,
): Promise<AgentVersion> {
  const reg = await loadRegistry(path);
  const existing = reg.agents.filter((a) => a.slug === spec.slug);
  const version = existing.length ? Math.max(...existing.map((a) => a.version)) + 1 : 1;
  const agent: AgentVersion = {
    id: `${spec.slug}@${version}`,
    slug: spec.slug,
    version,
    role: spec.role,
    displayName: spec.displayName,
    persona: spec.persona,
    personaHash: hashPersona(spec.persona),
    parent: null,
    author: spec.author,
    createdAt: Date.now(),
  };
  reg.agents.push(agent);
  await saveRegistry(reg, path);
  return agent;
}

/**
 * Fork an agent: a new slug, version 1, with a parent pointer and NO inherited
 * reputation.
 *
 * Refuses a fork whose persona is byte-identical to its parent's. That is not a
 * new strategy, and letting it through would fill the marketplace with clones
 * competing on nothing.
 */
export async function fork(
  parentId: string,
  changes: { slug: string; displayName: string; persona: string; author: string },
  path = REGISTRY,
): Promise<AgentVersion> {
  const reg = await loadRegistry(path);
  const parent = reg.agents.find((a) => a.id === parentId);
  if (!parent) throw new Error(`No such agent: ${parentId}`);

  const personaHash = hashPersona(changes.persona);
  if (personaHash === parent.personaHash) {
    throw new Error(
      `Fork of ${parentId} is byte-identical to its parent. Change the strategy, ` +
        `or reference the parent directly instead of cloning it.`,
    );
  }
  if (reg.agents.some((a) => a.slug === changes.slug)) {
    throw new Error(`Slug "${changes.slug}" is taken. Pick another.`);
  }

  const agent: AgentVersion = {
    id: `${changes.slug}@1`,
    slug: changes.slug,
    version: 1,
    role: parent.role,
    displayName: changes.displayName,
    persona: changes.persona,
    personaHash,
    parent: parent.id,
    author: changes.author,
    createdAt: Date.now(),
  };
  reg.agents.push(agent);
  await saveRegistry(reg, path);
  return agent;
}

/** Walk from an agent back to its root. */
export function ancestry(reg: Registry, id: string): AgentVersion[] {
  const chain: AgentVersion[] = [];
  const seen = new Set<string>();
  let cur = reg.agents.find((a) => a.id === id);
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    chain.push(cur);
    cur = cur.parent ? reg.agents.find((a) => a.id === cur!.parent) : undefined;
  }
  return chain;
}

/** Direct descendants of an agent. */
export const children = (reg: Registry, id: string) => reg.agents.filter((a) => a.parent === id);

/** The lineage forest, rendered as indented text for a CLI or a profile page. */
export function renderTree(reg: Registry): string {
  const roots = reg.agents.filter((a) => !a.parent);
  const lines: string[] = [];
  const walk = (a: AgentVersion, depth: number) => {
    lines.push(`${"  ".repeat(depth)}${depth ? "└─ " : ""}${a.id}  ${a.displayName}  (${a.role}, by ${a.author})`);
    for (const c of children(reg, a.id)) walk(c, depth + 1);
  };
  for (const r of roots) walk(r, 0);
  return lines.join("\n");
}
