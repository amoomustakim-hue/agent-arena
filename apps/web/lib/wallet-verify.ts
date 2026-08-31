import "server-only";
import { verifyMessage, isAddress } from "viem";

export type VerifyResult = { ok: true; address: string } | { ok: false; error: string };

/**
 * Confirm a signature over a message actually came from the claimed address,
 * that the message says what the caller expects it to authorize, and that
 * it isn't stale. Three checks, not one — a valid signature over the WRONG
 * message, or a valid signature over the right message from an hour ago,
 * are both failures a bare `verifyMessage` call alone wouldn't catch.
 */
export async function verifyIdentity(
  address: string,
  message: string,
  signature: string,
  expectedStatement: string,
  maxAgeMs = 10 * 60 * 1000,
): Promise<VerifyResult> {
  if (!isAddress(address)) return { ok: false, error: "Not a valid address." };
  if (!message.includes(expectedStatement)) {
    return { ok: false, error: "Signed message does not match the action being taken." };
  }

  const tsMatch = message.match(/Timestamp: (.+)$/m);
  const ts = tsMatch ? Date.parse(tsMatch[1]!) : NaN;
  if (!Number.isFinite(ts) || Date.now() - ts > maxAgeMs || ts > Date.now() + 60_000) {
    return { ok: false, error: "Signature has expired — reconnect and try again." };
  }

  const valid = await verifyMessage({ address: address as `0x${string}`, message, signature: signature as `0x${string}` });
  if (!valid) return { ok: false, error: "Signature does not match the claimed wallet address." };

  return { ok: true, address };
}
