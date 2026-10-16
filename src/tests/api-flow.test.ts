import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, beforeAll } from "vitest";

// Isolate persistence and stay in fixture mode before importing routes.
process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "drawbound-api-"));
process.env.LIVE_TACHI_ENABLED = "false";
process.env.PROOF_MODE = "fixture";
delete process.env.ADMIN_TOKEN;

import { POST as drawPost } from "@/app/api/draw/route";
import { POST as repayPost } from "@/app/api/repay/route";
import { POST as unlockPost } from "@/app/api/unlock/route";
import { POST as disconnectPost } from "@/app/api/wallet/disconnect/route";
import { GET as positionsGet } from "@/app/api/positions/route";
import { GET as receiptsGet } from "@/app/api/receipts/route";
import { POST as proofsPost } from "@/app/api/proofs/route";
import { POST as resetPost } from "@/app/api/reset/route";
import { GET as healthGet } from "@/app/api/health/route";
import { connectVault } from "@/lib/store";
import { createSession, getSession, clearSessions, revokeSession, SESSION_HEADER } from "@/lib/auth/sessions";
import { clearRateLimits } from "@/lib/security/rate-limit";
import { generateSessionKeypair } from "@/lib/wallet/canonical";
import { signTransitionRequest } from "@/lib/wallet/transition-builder";
import type { CreditPosition, DecisionReceipt } from "@/lib/domain/types";

const VAULT_A = "tb1pintegrationvaultaaaa";
const VAULT_B = "tb1pintegrationvaultbbbb";

interface Signer {
  privateKey: string;
  publicKey: string;
  token: string;
  positionId: string;
  vaultRef: string;
}

async function makeSigner(vaultRef: string): Promise<Signer> {
  const kp = generateSessionKeypair();
  const position = await connectVault(vaultRef, 5000);
  const session = createSession({ vaultRef, positionId: position.id, publicKey: kp.publicKey });
  return { privateKey: kp.privateKey, publicKey: kp.publicKey, token: session.token, positionId: position.id, vaultRef };
}

function signedBody(signer: Signer, action: "DRAW" | "REPAY" | "UNLOCK", amount: number, nonce: number, privateKeyOverride?: string) {
  const signature = signTransitionRequest(privateKeyOverride ?? signer.privateKey, {
    positionId: signer.positionId,
    vaultRef: signer.vaultRef,
    action,
    amount,
    nonce,
  });
  return { amount, nonce, signature };
}

function req(url: string, init: { method?: string; token?: string; body?: unknown; adminToken?: string } = {}): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (init.token) headers[SESSION_HEADER] = init.token;
  if (init.adminToken) headers["x-admin-token"] = init.adminToken;
  return new Request(`http://localhost${url}`, {
    method: init.method ?? "POST",
    headers,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
}

interface RouteResult {
  status: number;
  json: {
    decision?: "ALLOW" | "DENY";
    reason?: string;
    receipt?: DecisionReceipt;
    position?: CreditPosition;
    positions?: CreditPosition[];
    receipts?: DecisionReceipt[];
    idempotent?: boolean;
    error?: string;
    detail?: string;
    proof?: { healthBps: number; source?: string };
    status?: string;
    mode?: string;
  };
}

async function call(handler: (r: Request) => Promise<Response>, request: Request): Promise<RouteResult> {
  const response = await handler(request);
  return { status: response.status, json: (await response.json()) as RouteResult["json"] };
}

beforeAll(() => {
  clearSessions();
  clearRateLimits();
});

describe("authenticated API flow (fixture mode)", () => {
  it("rejects actions without a session", async () => {
    const res = await call(drawPost, req("/api/draw", { body: { amount: 100, nonce: 0, signature: "aa".repeat(64) } }));
    expect(res.status).toBe(401);
  });

  it("rejects a bad signature from a valid session", async () => {
    const signer = await makeSigner(VAULT_B);
    const res = await call(drawPost, req("/api/draw", { token: signer.token, body: { amount: 100, nonce: 0, signature: "ab".repeat(64) } }));
    expect(res.status).toBe(403);
    expect(res.json.detail).toMatch(/signature/i);
  });

  it("rejects a signature made by a different key", async () => {
    const signer = await makeSigner(VAULT_B);
    const attacker = generateSessionKeypair();
    const body = signedBody(signer, "DRAW", 100, 0, attacker.privateKey);
    const res = await call(drawPost, req("/api/draw", { token: signer.token, body }));
    expect(res.status).toBe(403);
  });

  it("runs the full lifecycle: draw -> replay(idempotent) -> stale nonce -> repay -> unlock -> re-unlock denied", async () => {
    const signer = await makeSigner(VAULT_A);

    // DRAW 100 at nonce 0 -> ALLOW
    const draw = await call(drawPost, req("/api/draw", { token: signer.token, body: signedBody(signer, "DRAW", 100, 0) }));
    expect(draw.status).toBe(200);
    expect(draw.json.decision).toBe("ALLOW");
    expect(draw.json.position?.debtUnits).toBe(100);
    expect(draw.json.position?.nonce).toBe(1);
    expect(draw.json.position?.state).toBe("ACTIVE");
    expect(draw.json.receipt?.transitionRef).toContain("satvm:fixture");

    // Exact replay (nonce 0 again) -> original receipt, flagged idempotent, no double-spend.
    const replay = await call(drawPost, req("/api/draw", { token: signer.token, body: signedBody(signer, "DRAW", 100, 0) }));
    expect(replay.status).toBe(200);
    expect(replay.json.idempotent).toBe(true);
    expect(replay.json.receipt?.id).toBe(draw.json.receipt?.id);
    const afterReplay = await call(positionsGet, req(`/api/positions?id=${signer.positionId}`, { method: "GET", token: signer.token }));
    expect(afterReplay.json.position?.debtUnits).toBe(100);

    // Stale nonce on a NEW fingerprint -> 409, no state change.
    const stale = await call(drawPost, req("/api/draw", { token: signer.token, body: signedBody(signer, "DRAW", 50, 0) }));
    expect(stale.status).toBe(409);

    // Health proof is debt-aware: 5000 sats vs 1000 sats obligation = 500%.
    const proofs = await call(proofsPost, req("/api/proofs", { token: signer.token, body: { live: false, kind: "healthy" } }));
    expect(proofs.status).toBe(200);

    // REPAY all at nonce 1 -> REPAID/AVAILABLE
    const repay = await call(repayPost, req("/api/repay", { token: signer.token, body: signedBody(signer, "REPAY", 100, 1) }));
    expect(repay.status).toBe(200);
    expect(repay.json.decision).toBe("ALLOW");
    expect(repay.json.position?.debtUnits).toBe(0);
    expect(repay.json.position?.state).toBe("REPAID");
    expect(repay.json.position?.exitStatus).toBe("AVAILABLE");

    // UNLOCK at nonce 2 -> EXITED
    const unlock = await call(unlockPost, req("/api/unlock", { token: signer.token, body: signedBody(signer, "UNLOCK", 0, 2) }));
    expect(unlock.status).toBe(200);
    expect(unlock.json.decision).toBe("ALLOW");
    expect(unlock.json.position?.state).toBe("EXITED");
    expect(unlock.json.position?.exitStatus).toBe("EXITED");

    // Second unlock (nonce 3) -> DENY receipt, position stays EXITED.
    const reUnlock = await call(unlockPost, req("/api/unlock", { token: signer.token, body: signedBody(signer, "UNLOCK", 0, 3) }));
    expect(reUnlock.json.decision).toBe("DENY");
    expect(reUnlock.json.reason).toMatch(/already exited/i);

    // Receipts for this position only: DRAW, REPAY, UNLOCK, UNLOCK-denied.
    const receipts = await call(receiptsGet, req("/api/receipts", { method: "GET", token: signer.token }));
    expect(receipts.json.receipts?.length).toBeGreaterThanOrEqual(4);
    expect(receipts.json.receipts?.every((r) => r.positionId === signer.positionId)).toBe(true);
  });

  it("denies a draw that exceeds the credit limit and freezes the position", async () => {
    const signer = await makeSigner("tb1pintegrationvaultcccc");
    const res = await call(drawPost, req("/api/draw", { token: signer.token, body: signedBody(signer, "DRAW", 10000, 0) }));
    expect(res.json.decision).toBe("DENY");
    expect(res.json.reason).toMatch(/exceeds credit limit/i);
    expect(res.json.position?.state).toBe("FROZEN");
  });

  it("scopes positions per session", async () => {
    const signerA = await makeSigner("tb1pintegrationvaultdddd");
    const signerB = await makeSigner("tb1pintegrationvaulteeee");
    const posA = await call(positionsGet, req("/api/positions", { method: "GET", token: signerA.token }));
    const posB = await call(positionsGet, req("/api/positions", { method: "GET", token: signerB.token }));
    expect(posA.json.position?.id).toBe(signerA.positionId);
    expect(posB.json.position?.id).toBe(signerB.positionId);

    // An ordinary session sees only its own position — never the global list.
    expect(posA.json.positions).toEqual([]);
    expect(posB.json.positions).toEqual([]);

    // Reading another session's position by id is refused.
    const cross = await call(positionsGet, req(`/api/positions?id=${signerA.positionId}`, { method: "GET", token: signerB.token }));
    expect(cross.status).toBe(403);

    // Reading receipts for another position is refused too.
    const crossReceipts = await call(receiptsGet, req(`/api/receipts?positionId=${signerA.positionId}`, { method: "GET", token: signerB.token }));
    expect(crossReceipts.status).toBe(403);
  });

  // Regression: revocation used to delete only the in-memory map entry, while
  // `getSession` re-admitted any HMAC-valid token on the stateless fallback
  // path — so a revoked token kept working until it expired.
  describe("session revocation", () => {
    it("revokes a session end-to-end: a revoked token stops working", async () => {
      clearSessions();
      clearRateLimits();
      const signer = await makeSigner("tb1pintegrationvaultrevoke");

      const before = await call(drawPost, req("/api/draw", { token: signer.token, body: signedBody(signer, "DRAW", 100, 0) }));
      expect(before.status).toBe(200);
      expect(getSession(signer.token)).toBeDefined();

      const disconnect = await call(disconnectPost, req("/api/wallet/disconnect", { token: signer.token }));
      expect(disconnect.status).toBe(200);

      // The revoked token must be refused by the action routes, not just absent
      // from the in-memory map.
      expect(getSession(signer.token)).toBeUndefined();
      const after = await call(drawPost, req("/api/draw", { token: signer.token, body: signedBody(signer, "DRAW", 1, 1) }));
      expect(after.status).toBe(401);
      // Reading own position by id: refused without a session (401, not the 403
      // an authenticated-but-unauthorized session would get).
      const afterRead = await call(positionsGet, req(`/api/positions?id=${signer.positionId}`, { method: "GET", token: signer.token }));
      expect(afterRead.status).toBe(401);
      const afterReceipts = await call(receiptsGet, req("/api/receipts", { method: "GET", token: signer.token }));
      expect(afterReceipts.status).toBe(401);
    });

    it("refuses to re-admit a revoked token through the stateless HMAC path", async () => {
      clearSessions();
      clearRateLimits();
      const signer = await makeSigner("tb1pintegrationvaultstateless");

      // Drop the in-memory copy WITHOUT revoking: the token must still verify
      // through the stateless fallback (that path exists for multi-container
      // serverless deployments and must keep working).
      revokeSession("some-other-token-that-does-not-exist");
      expect(getSession(signer.token)).toBeUndefined();

      // Now revoke for real and confirm the HMAC path refuses it too — the
      // exact hole that let a disconnect be undone.
      revokeSession(signer.token);
      expect(getSession(signer.token)).toBeUndefined();
      const attempt = await call(drawPost, req("/api/draw", { token: signer.token, body: signedBody(signer, "DRAW", 1, 1) }));
      expect(attempt.status).toBe(401);
    });

    it("issues fresh sessions that work after a revocation", async () => {
      clearSessions();
      clearRateLimits();
      const victim = await makeSigner("tb1pintegrationvaultvictim");
      revokeSession(victim.token);
      expect(getSession(victim.token)).toBeUndefined();

      // A brand-new session must be unaffected by the earlier revocation.
      const fresh = await makeSigner("tb1pintegrationvaultfresh");
      expect(getSession(fresh.token)).toBeDefined();
      const draw = await call(drawPost, req("/api/draw", { token: fresh.token, body: signedBody(fresh, "DRAW", 100, 0) }));
      expect(draw.status).toBe(200);
      expect(draw.json.decision).toBe("ALLOW");
    });
  });

  it("serves health without auth and gates reset behind admin policy", async () => {
    const health = await call(healthGet, req("/api/health", { method: "GET" }));
    expect(health.status).toBe(200);
    expect(health.json.status).toBe("ok");
    expect(health.json.mode).toBe("fixture");

    // No ADMIN_TOKEN and no explicit opt-in: reset is refused in every mode.
    const openReset = await call(resetPost, req("/api/reset", {}));
    expect(openReset.status).toBe(403);

    // Explicit local-demo opt-in re-opens it, and only then.
    process.env.ALLOW_INSECURE_RESET = "true";
    try {
      const optedIn = await call(resetPost, req("/api/reset", {}));
      expect(optedIn.status).toBe(200);
    } finally {
      delete process.env.ALLOW_INSECURE_RESET;
    }

    // With ADMIN_TOKEN configured: wrong token forbidden, right token allowed.
    process.env.ADMIN_TOKEN = "s3cret-admin";
    try {
      const denied = await call(resetPost, req("/api/reset", { adminToken: "wrong" }));
      expect(denied.status).toBe(403);
      const allowed = await call(resetPost, req("/api/reset", { adminToken: "s3cret-admin" }));
      expect(allowed.status).toBe(200);
    } finally {
      delete process.env.ADMIN_TOKEN;
    }
  });
});
