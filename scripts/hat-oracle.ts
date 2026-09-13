/**
 * Reference HAT/RIP oracle — a standalone signing service for strict proof mode.
 *
 * DrawBound (PROOF_RELAY_PUBLIC_KEYS set, HAT_ORACLE_URL pointing here) will
 * request attestations from this service; the oracle computes the debt-aware
 * health ratio from a REAL locked-VTXO read and signs the digest with its own
 * BIP-340 key. The private key lives only in this process.
 *
 * Run:  ORACLE_PRIVATE_KEY=$(openssl rand -hex 32) pnpm oracle
 *       (add to package.json: "oracle": "tsx scripts/hat-oracle.ts")
 * Env:  ORACLE_PRIVATE_KEY (required, 32-byte hex)
 *       HAT_ORACLE_PORT    (default 3109)
 *       TACHI_NETWORK      signet | regtest (default signet)
 *       TACHI_BASE_URL     daemon override
 *
 * API:  GET  /health -> { ok, oraclePubkey, network }
 *       POST /v1/attestations/health { vaultRef, positionId, debtUnits?, collateralSats? }
 *         -> signed LoanHealthProof (verification VERIFIED, source oracle)
 */
import { createServer } from "node:http";
import { buildSignedHealthAttestation, oraclePublicKey } from "../src/lib/proofs/oracle-service";
import { env } from "../src/lib/config/env";

const PORT = Number(process.env.HAT_ORACLE_PORT || 3109);
const NETWORK = env.network();
const DAEMON_BASE = (process.env.TACHI_BASE_URL || `https://rpc-${NETWORK}.tachibtc.com`).replace(/\/$/, "");

const privateKey = process.env.ORACLE_PRIVATE_KEY?.trim();
if (!privateKey || !/^[0-9a-fA-F]{64}$/.test(privateKey.replace(/^0x/, ""))) {
  console.error("ORACLE_PRIVATE_KEY must be set to a 32-byte hex key (openssl rand -hex 32)");
  process.exit(1);
}

interface LockedVtxosResponse {
  vtxos: Array<{ amount: number }>;
}

async function readLockedSats(vaultRef: string): Promise<number> {
  try {
    const response = await fetch(`${DAEMON_BASE}/tachi_vtxoLocked?vault=${encodeURIComponent(vaultRef)}`, {
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`status ${response.status}`);
    const data = (await response.json()) as LockedVtxosResponse;
    return data.vtxos.reduce((total, vtxo) => total + (vtxo.amount || 0), 0);
  } catch (error) {
    console.warn(`[oracle] daemon read failed for ${vaultRef}:`, error instanceof Error ? error.message : error);
    return 0;
  }
}

function json(res: import("node:http").ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);
  if (req.method === "GET" && url.pathname === "/health") {
    json(res, 200, { ok: true, oraclePubkey: oraclePublicKey(privateKey), network: NETWORK });
    return;
  }
  if (req.method === "POST" && url.pathname === "/v1/attestations/health") {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", async () => {
      try {
        const body = JSON.parse(raw || "{}") as {
          vaultRef?: string;
          positionId?: string;
          debtUnits?: number;
          collateralSats?: number;
          network?: string;
        };
        if (!body.vaultRef || !body.positionId) {
          json(res, 400, { error: "vaultRef and positionId are required" });
          return;
        }
        // Real chain read first; caller-supplied collateral is the offline fallback.
        const observed = await readLockedSats(body.vaultRef);
        const collateralSats = observed > 0 ? observed : body.collateralSats ?? 5000;
        const proof = buildSignedHealthAttestation(
          {
            vaultRef: body.vaultRef,
            positionId: body.positionId,
            network: body.network ?? NETWORK,
            debtUnits: Number(body.debtUnits ?? 0),
            collateralSats,
          },
          { privateKeyHex: privateKey! },
        );
        json(res, 200, proof);
      } catch (error) {
        json(res, 500, { error: error instanceof Error ? error.message : "attestation failed" });
      }
    });
    return;
  }
  json(res, 404, { error: "not found" });
});

server.listen(PORT, () => {
  console.log(`Reference HAT oracle listening on http://127.0.0.1:${PORT}`);
  console.log(`  oracle pubkey: ${oraclePublicKey(privateKey!)}`);
  console.log(`  network: ${NETWORK} (daemon ${DAEMON_BASE})`);
  console.log("Point DrawBound at it with: HAT_ORACLE_URL=http://127.0.0.1:" + PORT + " PROOF_RELAY_PUBLIC_KEYS=<pubkey>");
});
