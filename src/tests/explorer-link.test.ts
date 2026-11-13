import { describe, expect, it } from "vitest";
import { explorerTxUrl, TACHI_EXPLORER_BASE_URL, txHashFromTransitionRef } from "@/lib/tachi/explorer";

/**
 * Tachi integration requirement 2 (2026-11-13): every transaction triggers
 * an in-app notification with a clickable link to the transaction on the
 * Tachi Explorer. The vault page renders exactly the URL these helpers
 * build, from the hash parsed out of a receipt's transitionRef.
 */

// Live hashes executed on signet 2026-11-12/13 (verified on the explorer).
const DRAW_HASH = "20C3AA5830525D3FA959EB7F6259C98C01BFC0296A5C09EEFC114605736C1EDC";
const LOCK_HASH = "afe0267bdbeec7d91a3577eca4fc544e131754b8b0a3bda764df27b4d96f5200";

describe("Tachi Explorer links", () => {
  it("builds the signet explorer URL for a transaction hash", () => {
    expect(TACHI_EXPLORER_BASE_URL).toBe("https://signet.tachibtcscan.com");
    expect(explorerTxUrl(DRAW_HASH.toLowerCase())).toBe(
      "https://signet.tachibtcscan.com/tx/20c3aa5830525d3fa959eb7f6259c98c01bfc0296a5c09eefc114605736c1edc",
    );
    expect(explorerTxUrl(LOCK_HASH)).toBe(`https://signet.tachibtcscan.com/tx/${LOCK_HASH}`);
  });

  it("parses the hash out of a live committed transitionRef", () => {
    expect(txHashFromTransitionRef(`satvm:live:draw:${DRAW_HASH}:a1b2c3d4e5f6`)).toBe(DRAW_HASH.toLowerCase());
    expect(txHashFromTransitionRef(`satvm:live:repay:${LOCK_HASH}:a1b2c3d4e5f6`)).toBe(LOCK_HASH);
    expect(txHashFromTransitionRef(`satvm:live:unlock:${LOCK_HASH}:a1b2c3d4e5f6`)).toBe(LOCK_HASH);
  });

  it("parses the hash out of a live pending transitionRef", () => {
    expect(txHashFromTransitionRef(`satvm:live:pending:${DRAW_HASH}`)).toBe(DRAW_HASH.toLowerCase());
  });

  it("returns null for fixture refs and anything without a real hash", () => {
    expect(txHashFromTransitionRef("satvm:fixture:draw:1:a1b2c3d4e5f6")).toBeNull();
    expect(txHashFromTransitionRef("satvm:1")).toBeNull();
    expect(txHashFromTransitionRef("satvm:live:draw:not-a-hash:suffix")).toBeNull();
    expect(txHashFromTransitionRef("satvm:live:draw:cafe1234deadbeef:suffix")).toBeNull();
    expect(txHashFromTransitionRef(undefined)).toBeNull();
    expect(txHashFromTransitionRef(null)).toBeNull();
    expect(txHashFromTransitionRef("")).toBeNull();
  });
});
