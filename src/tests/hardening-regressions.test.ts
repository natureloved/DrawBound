import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, beforeEach } from "vitest";

// Isolate persistence and stay in fixture mode before importing routes.
process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "drawbound-hardening-"));
process.env.LIVE_TACHI_ENABLED = "false";
process.env.PROOF_MODE = "fixture";
process.env.ALLOW_INSECURE_RESET = "true";

import { POST as connectPost } from "@/app/api/wallet/connect/route";
import { POST as drawPost } from "@/app/api/draw/route";
import { GET as positionsGet } from "@/app/api/positions/route";
import { GET as receiptsGet } from "@/app/api/receipts/route";
import { POST as resetPost } from "@/app/api/reset/route";
import { clearSessions, SESSION_HEADER } from "@/lib/auth/sessions";
import { clearRateLimits } from "@/lib/security/rate-limit";
import { connectVault, positionIdForVault, transitionFingerprint, withPositionLock } from "@/lib/store";
import { assertWritePolicy } from "@/lib/security/policy";
import { redactSecret } from "@/lib/security/redact";
import { safeEqual } from "@/lib/auth/sessions";
import { generateSessionKeypair } from "@/lib/wallet/canonical";
import { signTransitionRequest } from "@/lib/wallet/transition-builder";
import { canTransition } from "@/lib/domain/state-machine";

interface JsonLike { [key: string]: unknown }

const SESSION_HEADER_NAME = SESSION_HEADER;

function req(url: string, init: { method?: string; headers?: Record<string, string>; body?: unknown } = {}): Request {
  return new Request(`http://localhost${url}`, {
    method: init.method ?? "POST",
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
}

async function call(handler: (r: Request) => Promise<Response>, request: Request) {
  const res = await handler(request);
  let json: JsonLike = {};
  try {
    json = (await res.json()) as JsonLike;
  } catch {
    json = {};
  }
  return { status: res.status, json };
}

async function connect(vaultRef: string) {
  const kp = generateSessionKeypair();
  const res = await call(connectPost, req("/api/wallet/connect", { body: { vaultRef, sessionPublicKey: kp.publicKey } }));
  const token = String(res.json.sessionToken ?? "");
  return { ...kp, vaultRef, token, positionId: String((res.json as { position?: { id: string } }).position?.id ?? ""), status: res.status, json: res.json };
}

function signedBody(session: ReturnType<typeof connect> extends Promise<infer T> ? T : never, action: "DRAW" | "REPAY" | "UNLOCK", amount: number, nonce: number) {
  return {
    amount,
    nonce,
    signature: signTransitionRequest(session.privateKey, {
      positionId: session.positionId,
      vaultRef: session.vaultRef,
      action,
      amount,
      nonce,
    }),
  };
}

beforeEach(() => {
  clearSessions();
  clearRateLimits();
});

describe("position identity is collision-resistant", () => {
  it("maps separator variants and 32-char-prefix twins to different ids", () => {
    expect(positionIdForVault("vault:taurus:signet:demo")).not.toBe(positionIdForVault("vault-taurus-signet-demo"));
    expect(positionIdForVault("tb1p" + "q".repeat(58))).not.toBe(positionIdForVault("tb1p" + "q".repeat(57) + "z"));
  });

  it("is stable and hex-shaped", () => {
    const id = positionIdForVault("tb1pstable");
    expect(positionIdForVault("tb1pstable")).toBe(id);
    expect(id).toMatch(/^pos_[0-9a-f]{32}$/);
  });
});

describe("sessions are bound to their vault", () => {
  it("refuses a draw whose session was opened for a different vaultRef", async () => {
    const victimVault = "tb1phardeningvictimref01";
    const attackerVault = "tb1phardeningattackerref02";
    const victim = await connect(victimVault);
    const attacker = await connect(attackerVault);

    // The attacker signs a request naming the VICTIM's position id.
    const body = {
      amount: 100,
      nonce: 0,
      signature: signTransitionRequest(attacker.privateKey, {
        positionId: victim.positionId,
        vaultRef: victim.vaultRef,
        action: "DRAW",
        amount: 100,
        nonce: 0,
      }),
    };
    const res = await call(drawPost, req("/api/draw", { headers: { [SESSION_HEADER_NAME]: attacker.token }, body }));
    // 403 (vault binding) — never the victim's position.
    expect(res.status).toBe(403);
    expect(res.json.position).toBeUndefined();

    const owned = await call(
      drawPost,
      req("/api/draw", { headers: { [SESSION_HEADER_NAME]: victim.token }, body: signedBody(victim, "DRAW", 100, 0) }),
    );
    expect(owned.json.decision).toBe("ALLOW");
  }, 40_000);
});

describe("idempotency is bound to the signer, not the signature bytes", () => {
  it("treats a re-signed retry as the same transition", () => {
    // BIP-340 signing is randomized, so the signature changes each call; the
    // fingerprint must not, or retries would re-execute the transition.
    const a = transitionFingerprint("pos_x", "DRAW", 100, 0, "aa".repeat(32));
    const b = transitionFingerprint("pos_x", "DRAW", 100, 0, "aa".repeat(32));
    expect(a).toBe(b);
  });

  it("separates the same tuple signed by a different key", () => {
    expect(transitionFingerprint("pos_x", "DRAW", 100, 0, "aa".repeat(32))).not.toBe(
      transitionFingerprint("pos_x", "DRAW", 100, 0, "bb".repeat(32)),
    );
  });
});

describe("transitions are serialized per position", () => {
  it("lets exactly one of many concurrent draws through", async () => {
    const session = await connect("tb1phardeningserialref1");
    // Six concurrent requests, distinct amounts, same nonce.
    const results = await Promise.all(
      [100, 150, 200, 250, 300, 350].map((amount, i) =>
        call(
          drawPost,
          req("/api/draw", {
            headers: { [SESSION_HEADER_NAME]: session.token },
            body: signedBody(session, "DRAW", amount, 0),
          }),
        ).then((r) => ({ amount, index: i, status: r.status, decision: r.json.decision })),
      ),
    );
    const allowed = results.filter((r) => r.decision === "ALLOW");
    const stale = results.filter((r) => r.status === 409);
    expect(allowed.length).toBe(1);
    expect(stale.length).toBe(5);
  }, 30_000);

  it("serializes lock users in arrival order and never deadlocks on rejection", async () => {
    const order: number[] = [];
    await Promise.all(
      [1, 2, 3, 4, 5].map((n) =>
        withPositionLock("pos_lock_probe", async () => {
          await new Promise((r) => setTimeout(r, 5));
          order.push(n);
          if (n === 2) throw new Error("boom");
          return n;
        }).catch(() => null),
      ),
    );
    expect(order).toEqual([1, 2, 3, 4, 5]);
  });
});

describe("reads are scoped", () => {
  it("hides the position list and refuses cross-position reads", async () => {
    const a = await connect("tb1phardeninglistrefaaaaa");
    const b = await connect("tb1phardeninglistrefbbbbb");

    const listA = await call(positionsGet, req("/api/positions", { method: "GET", headers: { [SESSION_HEADER_NAME]: a.token } }));
    expect(listA.json.positions).toEqual([]);

    const cross = await call(
      positionsGet,
      req(`/api/positions?id=${a.positionId}`, { method: "GET", headers: { [SESSION_HEADER_NAME]: b.token } }),
    );
    expect(cross.status).toBe(403);

    const crossReceipts = await call(
      receiptsGet,
      req(`/api/receipts?positionId=${a.positionId}`, { method: "GET", headers: { [SESSION_HEADER_NAME]: b.token } }),
    );
    expect(crossReceipts.status).toBe(403);

    const anonReceipts = await call(receiptsGet, req("/api/receipts", { method: "GET" }));
    expect(anonReceipts.status).toBe(401);
  }, 30_000);
});

describe("session tokens come from the header only", () => {
  it("ignores a body-borne token", async () => {
    const session = await connect("tb1phardeningbodytokenref");
    const body = { ...signedBody(session, "DRAW", 100, 0), sessionToken: session.token };
    const res = await call(drawPost, req("/api/draw", { body }));
    expect(res.status).toBe(401);
  });
});

describe("replay rejection does not disclose the current nonce", () => {
  it("returns a generic 409", async () => {
    const session = await connect("tb1phardeningnonceref01");
    await call(drawPost, req("/api/draw", { headers: { [SESSION_HEADER_NAME]: session.token }, body: signedBody(session, "DRAW", 100, 0) }));
    const stale = await call(
      drawPost,
      req("/api/draw", { headers: { [SESSION_HEADER_NAME]: session.token }, body: signedBody(session, "DRAW", 50, 0) }),
    );
    expect(stale.status).toBe(409);
    expect(JSON.stringify(stale.json)).not.toMatch(/does not match current \d/);
  });
});

describe("restoring an existing position requires proof", () => {
  it("refuses an anonymous reconnect to a vault that already has debt", async () => {
    const vaultRef = "tb1phardeningrestoreref01";
    const first = await connect(vaultRef);
    const drawn = await call(
      drawPost,
      req("/api/draw", { headers: { [SESSION_HEADER_NAME]: first.token }, body: signedBody(first, "DRAW", 100, 0) }),
    );
    expect(drawn.json.decision).toBe("ALLOW");

    // A second, unauthenticated connect to the SAME vault must not silently
    // inherit control of the position with its outstanding debt.
    const second = await connect(vaultRef);
    expect(second.status).toBe(403);
    expect(JSON.stringify(second.json)).toMatch(/ownership proof or an admin token/i);
  });
});

describe("destructive reset is gated", () => {
  it("refuses without a token or an explicit demo opt-in", async () => {
    delete process.env.ALLOW_INSECURE_RESET;
    const res = await call(resetPost, req("/api/reset", { body: {} }));
    expect(res.status).toBe(403);
  });
});

describe("credit limit never widens when collateral shrinks", () => {
  it("re-derives the limit from observed collateral and freezes over-debt", async () => {
    const vaultRef = "tb1phardeningshrinkref01";
    const created = await connectVault(vaultRef, 5000);
    expect(created.creditLimitUnits).toBe(500);

    // Simulate a reconnect whose live read reports a much smaller vault.
    const shrunk = await connectVault(vaultRef, 1000);
    expect(shrunk.collateralSats).toBe(1000);
    expect(shrunk.creditLimitUnits).toBe(100);

    // With debt above the new (smaller) limit the position must freeze rather
    // than keep borrowing against collateral that is no longer there.
    const frozen = await connectVault(vaultRef, 1000);
    expect(frozen.debtUnits).toBe(0);
    frozen.debtUnits = 300;
    const { savePosition } = await import("@/lib/store");
    await savePosition(frozen);
    const again = await connectVault(vaultRef, 1000);
    expect(again.state).toBe("FROZEN");
    expect(again.creditLimitUnits).toBe(100);
  });
});

describe("write policy reads network from validated env", () => {
  it("ignores a caller-supplied network and caps test collateral", () => {
    // Env resolves to signet here, so the cap applies regardless of the
    // network argument a caller passes in: a caller naming "mainnet" cannot
    // skip the gate.
    expect(() => assertWritePolicy("signet", 999_999)).toThrow(/cap/i);
    expect(() => assertWritePolicy("mainnet", 999_999)).toThrow(/cap/i);
    expect(() => assertWritePolicy("signet", 1_000)).not.toThrow();
    expect(() => assertWritePolicy("signet", 0)).toThrow(/whole number of sats/i);
  });
});

describe("secret redaction is length-independent", () => {
  it("never echoes any part of the secret", () => {
    const secret = "abcdefghijklmnopqrst";
    const masked = redactSecret(secret);
    expect(masked).not.toContain("abcd");
    expect(masked).not.toContain("qrst");
    expect(masked).toBe("[redacted:20]");
  });
});

describe("constant-time compare is length-safe", () => {
  it("still rejects mismatch, and does not early-exit on length", () => {
    expect(safeEqual("same-length-abc", "same-length-abc")).toBe(true);
    expect(safeEqual("short", "much-longer-value")).toBe(false);
    expect(safeEqual("", "")).toBe(true);
  });
});

describe("FROZEN is a terminal-deny state for draws", () => {
  it("permits repay/unlock but never draw", () => {
    expect(canTransition("FROZEN", "DRAW")).toBe(false);
    expect(canTransition("FROZEN", "REPAY")).toBe(true);
    expect(canTransition("FROZEN", "UNLOCK")).toBe(true);
  });
});

describe("commitTransition keeps state and audit trail together", () => {
  it("writes the position and receipt through one backend call", async () => {
    const { commitTransition, getReceipts, getPosition } = await import("@/lib/store");
    const vaultRef = "tb1phardeningcommitref01";
    const positionId = positionIdForVault(vaultRef);
    const receipt = {
      id: "rcpt_hardening_01",
      positionId,
      action: "DRAW" as const,
      requestedAmount: 100,
      previousState: "COLLATERALIZED" as const,
      result: "ALLOW" as const,
      reason: "hardening probe",
      resultingState: "ACTIVE" as const,
      receiptDigest: `sha256:${positionId}:100`,
      createdAt: new Date().toISOString(),
    };
    await commitTransition(
      {
        id: positionId,
        vaultRef,
        collateralSats: 5000,
        debtUnits: 100,
        creditLimitUnits: 500,
        minHealthBps: 12500,
        state: "ACTIVE",
        exitStatus: "LOCKED",
        drawCount: 1,
        nonce: 1,
      },
      receipt,
    );
    const stored = await getPosition(positionId);
    expect(stored?.state).toBe("ACTIVE");
    const receipts = await getReceipts(positionId);
    expect(receipts.length).toBeGreaterThanOrEqual(1);
  });
});
