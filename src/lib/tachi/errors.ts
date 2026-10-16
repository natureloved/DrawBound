/**
 * Typed failures from the live signet/regtest execution path.
 *
 * These cross a bundling boundary (Next.js route handlers, standalone output),
 * where `instanceof` on a shared class is not guaranteed to hold, so callers
 * discriminate on the stable string `code` instead. `isTachiLiveError` does the
 * narrowing and is the only thing routes should import.
 */

export type TachiLiveErrorCode =
  /** The daemon is unreachable, or it does not attest the configured network. */
  | "ATTESTATION"
  /** A live chain read failed; live mode refuses to decide on modeled data. */
  | "CHAIN_READ"
  /** A configuration/policy gate refused the operation (kill switch, allowlist, caps). */
  | "POLICY"
  /** The payload was refused before it was ever sent to the daemon. */
  | "PAYLOAD"
  /** The mempool rejected the broadcast (non-zero CheckTx code). */
  | "REJECTED"
  /**
   * The broadcast was accepted but the transaction was not observed committed
   * in time. NOT a failure: the transaction may still commit. The daemon hash
   * is carried so the caller can journal it and never re-broadcast blind.
   */
  | "UNCONFIRMED";

export interface TachiLiveErrorOptions {
  code: TachiLiveErrorCode;
  /** Daemon-reported transaction hash, when one exists. */
  txHash?: string;
  /** Extra machine-readable context (safe to log: never contains keys). */
  details?: Record<string, string | number | boolean>;
}

export class TachiLiveError extends Error {
  readonly code: TachiLiveErrorCode;
  readonly txHash?: string;
  readonly details?: Record<string, string | number | boolean>;

  constructor(message: string, options: TachiLiveErrorOptions) {
    super(message);
    this.name = "TachiLiveError";
    this.code = options.code;
    this.txHash = options.txHash;
    this.details = options.details;
  }
}

/** Narrow an unknown throwable to a TachiLiveError, optionally by code. */
export function isTachiLiveError(error: unknown, code?: TachiLiveErrorCode): error is TachiLiveError {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { name?: unknown; code?: unknown };
  if (candidate.name !== "TachiLiveError") return false;
  return code === undefined || candidate.code === code;
}

/** Best-effort human-readable message for an unknown error. */
export function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}
