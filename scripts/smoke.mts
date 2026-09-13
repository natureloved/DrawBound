import { schnorr } from "@noble/curves/secp256k1.js";
import { randomBytes } from "@noble/hashes/utils.js";

const BASE = process.env.SMOKE_BASE ?? "http://127.0.0.1:3107";
const SESSION_HEADER = "x-drawbound-session";
const toHex = (b: Uint8Array) => Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");

async function main() {
  function assert(cond: boolean, msg: string) {
    if (!cond) { console.error("FAIL:", msg); process.exit(1); }
    console.log("ok -", msg);
  }
  const j = async (res: Response) => res.json() as Promise<any>;

  const priv = randomBytes(32);
  const pub = toHex(schnorr.getPublicKey(priv));
  const sign = (msg: string) => toHex(schnorr.sign(new TextEncoder().encode(msg), priv));
  const vaultRef = "tb1psmoketest" + Date.now().toString().slice(-8);

  const health = await j(await fetch(`${BASE}/api/health`));
  assert(health.status === "ok" && health.mode === "fixture", `health ok, mode=${health.mode}`);

  const noAuth = await fetch(`${BASE}/api/draw`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ amount: 100, nonce: 0, signature: "ab".repeat(64) }) });
  assert(noAuth.status === 401, "draw without session -> 401");

  const connectRes = await fetch(`${BASE}/api/wallet/connect`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ vaultRef, sessionPublicKey: pub }) });
  const connect = await j(connectRes);
  assert(connectRes.status === 200 && connect.ok === true, `connect ok (liveReadOk=${connect.liveReadOk}, lockedSats=${connect.lockedSats}, proofSource=${connect.proofSource})`);
  assert(typeof connect.sessionToken === "string" && connect.sessionToken.length === 64, "session token issued");
  const token: string = connect.sessionToken;
  const positionId: string = connect.position.id;
  assert(connect.position.creditLimitUnits === 500, `credit limit derived: ${connect.position.creditLimitUnits}`);

  const headers = { "content-type": "application/json", [SESSION_HEADER]: token };
  const msg = (action: string, amount: number, nonce: number) => `DrawBound:v1:${positionId}:${vaultRef}:${action}:${amount}:${nonce}`;

  const badSig = await fetch(`${BASE}/api/draw`, { method: "POST", headers, body: JSON.stringify({ amount: 100, nonce: 0, signature: "cd".repeat(64) }) });
  assert(badSig.status === 403, "draw with bad signature -> 403");

  let res = await j(await fetch(`${BASE}/api/draw`, { method: "POST", headers, body: JSON.stringify({ amount: 100, nonce: 0, signature: sign(msg("DRAW", 100, 0)) }) }));
  assert(res.decision === "ALLOW" && res.position.debtUnits === 100 && res.position.nonce === 1, `draw 100 ALLOW, debt=${res.position.debtUnits}, nonce=${res.position.nonce}, transitionRef=${res.receipt?.transitionRef}`);

  res = await j(await fetch(`${BASE}/api/draw`, { method: "POST", headers, body: JSON.stringify({ amount: 100, nonce: 0, signature: sign(msg("DRAW", 100, 0)) }) }));
  assert(res.idempotent === true && res.decision === "ALLOW", "replay returns original receipt (idempotent)");
  const posAfterReplay = await j(await fetch(`${BASE}/api/positions?id=${positionId}`));
  assert(posAfterReplay.position.debtUnits === 100, "debt unchanged after replay");

  const stale = await fetch(`${BASE}/api/draw`, { method: "POST", headers, body: JSON.stringify({ amount: 50, nonce: 0, signature: sign(msg("DRAW", 50, 0)) }) });
  assert(stale.status === 409, "stale nonce on new fingerprint -> 409");

  res = await j(await fetch(`${BASE}/api/draw`, { method: "POST", headers, body: JSON.stringify({ amount: 10000, nonce: 1, signature: sign(msg("DRAW", 10000, 1)) }) }));
  assert(res.decision === "DENY" && /exceeds credit limit/i.test(res.reason), `over-limit draw DENY: ${res.reason}`);

  const scoped = await j(await fetch(`${BASE}/api/positions`, { headers }));
  assert(scoped.position?.id === positionId, "positions GET scoped to session");

  res = await j(await fetch(`${BASE}/api/repay`, { method: "POST", headers, body: JSON.stringify({ amount: 100, nonce: 1, signature: sign(msg("REPAY", 100, 1)) }) }));
  assert(res.decision === "ALLOW" && res.position.debtUnits === 0 && res.position.state === "REPAID", `repay ALLOW from FROZEN, state=${res.position.state}, exit=${res.position.exitStatus}`);

  res = await j(await fetch(`${BASE}/api/unlock`, { method: "POST", headers, body: JSON.stringify({ amount: 0, nonce: 2, signature: sign(msg("UNLOCK", 0, 2)) }) }));
  assert(res.decision === "ALLOW" && res.position.state === "EXITED", `unlock ALLOW -> ${res.position.state}/${res.position.exitStatus}`);

  const receipts = await j(await fetch(`${BASE}/api/receipts`, { headers }));
  assert(receipts.receipts.length >= 4 && receipts.receipts.every((r: any) => r.positionId === positionId), `receipts scoped (${receipts.receipts.length} events)`);

  await fetch(`${BASE}/api/wallet/disconnect`, { method: "POST", headers });
  const afterDisconnect = await fetch(`${BASE}/api/draw`, { method: "POST", headers, body: JSON.stringify({ amount: 1, nonce: 3, signature: sign(msg("DRAW", 1, 3)) }) });
  assert(afterDisconnect.status === 401, "session revoked after disconnect -> 401");

  console.log("\nSMOKE TEST PASSED");
}
main().catch((e) => { console.error(e); process.exit(1); });
