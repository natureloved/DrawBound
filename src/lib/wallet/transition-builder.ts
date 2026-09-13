import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, canonicalTransitionMessage, signCanonical } from "./canonical";
import type { SignedTransition, TransitionRequest } from "./types";

/**
 * Demo transition payloads and session signing.
 *
 * IMPORTANT — honesty boundary: `buildDemoTransition` produces a SYNTHETIC,
 * self-labelled payload (magic prefix `dbdemo01`). It is a rehearsal artifact
 * for FIXTURE mode only. It is not a Bitcoin transaction, it is not signed with
 * any vault key, and `LiveTachiAdapter` refuses to broadcast it. A live credit
 * transition requires a real signed txHex built by the operator's Taurus wallet
 * (see docs/tachi-integration.md).
 *
 * What IS real cryptography: `signTransitionRequest` signs the canonical
 * transition message with the browser session's ephemeral Schnorr key
 * (BIP-340 via @noble/curves), and the server verifies that signature against
 * the session public key registered at wallet connect.
 */

export const SYNTHETIC_TX_MAGIC = "dbdemo01";

export function buildDemoTransition(request: TransitionRequest): SignedTransition {
  const canonicalPayload = JSON.stringify({
    version: 1,
    type: "satvm_credit_transition_demo",
    action: request.action,
    positionId: request.positionId,
    vaultRef: request.vaultRef,
    amount: request.amount,
    nonce: request.nonce,
    proofDigest: request.proofDigest ?? "none",
    timestamp: new Date().toISOString(),
  });

  const txHash = bytesToHex(sha256(new TextEncoder().encode(canonicalPayload)));
  const witnessSig = bytesToHex(sha256(new TextEncoder().encode(`sig:${txHash}:${request.vaultRef}`)));
  const rawPayloadHex = bytesToHex(new TextEncoder().encode(canonicalPayload));

  // [magic 8 hex][txHash 64][witness 64][payload] — tagged so it can never be
  // mistaken for a real Bitcoin transaction by any Drawbound code path.
  const txHex = `${SYNTHETIC_TX_MAGIC}${txHash}${witnessSig}${rawPayloadHex}`;
  return { txHex, txid: txHash };
}

/** True when a txHex is a Drawbound synthetic demo payload (fixture mode only). */
export function isSyntheticTransition(txHex?: string): boolean {
  return typeof txHex === "string" && txHex.startsWith(SYNTHETIC_TX_MAGIC);
}

/**
 * Sign a transition request with the session private key (ephemeral, browser-held).
 * The server verifies against the session public key bound at wallet connect.
 */
export function signTransitionRequest(
  sessionPrivateKeyHex: string,
  request: Pick<TransitionRequest, "positionId" | "vaultRef" | "action" | "amount" | "nonce">,
): string {
  return signCanonical(canonicalTransitionMessage(request), sessionPrivateKeyHex);
}
