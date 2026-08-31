import type { AgentRole } from "@arena/core";

/**
 * The exact text a wallet signs to authorize one specific fork, and the same
 * text the server checks the signature was actually over. Shared, not
 * duplicated, because the two copies drifting apart quietly would mean a
 * signature "verifying" against a description of a different fork than the
 * one it was signed for.
 */
export const forkStatement = (role: AgentRole, slug: string, displayName: string) =>
  `Fork ${role} as "${slug}" (${displayName})`;
