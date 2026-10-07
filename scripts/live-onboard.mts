/**
 * DrawBound operator tooling — sequenced onboarding driver (Phases A–D, stop before the write).
 *
 * Usage (on a machine that can reach the daemon — this needs outbound HTTPS to
 * rpc-signet.tachibtc.com, or TACHI_BASE_URL):
 *
 *   OPERATOR_MNEMONIC="twelve words..." pnpm live:onboard
 *   OPERATOR_MNEMONIC="..." FUNDING_TXID=<txid> pnpm live:onboard       # resume after funding
 *   pnpm live:onboard --dry-run                                         # print the plan only
 *
 * What it does, in order, pausing for the operator between the steps that involve money:
 *
 *   1. derive   — vault P2TR + ownership address from your key (needs the daemon: the
 *                  taproot output key is tweaked with the live quorum's keys)
 *   2. fund     — prints the address and faucet link, then waits for the deposit to confirm
 *   3. register — submits the TxVaultOpen that mints ledger VTXOs (this is a real broadcast,
 *                  and the only one this script performs)
 *   4. check    — the app's own readiness gates (`scripts/live-check.mts`)
 *   5. build    — builds and daemon-verifies the signed credit transition (`build-transition.mts`)
 *
 * It then prints the txHex and STOPS. DrawBound's own broadcast of that transaction is the
 * operator's decision, made in the vault terminal, after the covenant gate has run — this
 * script never feeds itself, and never pastes into your ledger for you.
 *
 * Every dangerous step is delegated to the existing scripts so there is exactly one
 * implementation of "sign and broadcast". This file only sequences and waits.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const TSX = path.join(ROOT, "node_modules", ".bin", "tsx");

/**
 * Exec the repo-local tsx shim directly instead of `pnpm exec tsx`: this script is itself
 * launched through pnpm, and under corepack the `pnpm` shim is not on the child's PATH
 * (`spawnSync pnpm ENOENT`) — which would surface as a broken driver at the exact moment
 * an operator needs it. The shim is the shebang wrapper pnpm writes in node_modules/.bin.
 */
function nodeScript(script: string, args: string[]): string[] {
  if (!existsSync(TSX)) {
    throw new Error(`tsx is not installed at ${TSX} — run \`pnpm install\` in ${ROOT} first`);
  }
  return [TSX, path.join(ROOT, "scripts", script), ...args];
}

const NETWORK = process.env.TACHI_NETWORK === "regtest" ? "regtest" : "signet";
const DRY_RUN = process.argv.includes("--dry-run") || process.argv.includes("--plan");
const MIN_CONFIRMS = Number.parseInt(process.env.MIN_CONFIRMS ?? "6", 10);
const AMOUNT_SATS = process.env.DRAW_AMOUNT_SATS ?? "1000";

function run(cmd: string[], opts: { capture?: boolean } = {}): string {
  const line = cmd.join(" ");
  if (DRY_RUN) {
    console.log(`would run: ${line}`);
    return "";
  }
  const out = execFileSync(cmd[0], cmd.slice(1), {
    encoding: "utf8",
    stdio: opts.capture ? ["inherit", "pipe", "inherit"] : "inherit",
    env: process.env,
    cwd: ROOT,
  });
  return typeof out === "string" ? out : "";
}

/** Runs a script that prints a JSON object on stdout and noise on stderr. */
function runJson(cmd: string[]): Record<string, unknown> {
  const raw = run(cmd, { capture: true });
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    console.error("could not parse output as JSON:\n" + raw);
    throw new Error(`${cmd[cmd.length - 2]} ${cmd[cmd.length - 1]} did not print the JSON this driver expects`);
  }
}

function stop(message: string, code = 1): never {
  console.error(`\n${message}`);
  process.exit(code);
}

/** Best-effort L1 confirmation count via a bitcoind RPC; undefined when unreachable. */
async function confirmations(txid: string, vout: number): Promise<number | undefined> {
  const url = process.env.OPERATOR_RPC_URL?.trim();
  if (!url || DRY_RUN) return undefined;
  const auth = process.env.OPERATOR_RPC_USER
    ? "Basic " + Buffer.from(`${process.env.OPERATOR_RPC_USER}:${process.env.OPERATOR_RPC_PASSWORD ?? ""}`).toString("base64")
    : undefined;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...(auth ? { authorization: auth } : {}) },
      body: JSON.stringify({ jsonrpc: "1.0", id: "drawbound", method: "getrawtransaction", params: [txid, true] }),
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) return undefined;
    const body = (await response.json()) as { result?: { confirmations?: number }; error?: { message?: string } };
    if (body.error || !body.result) return 0;
    // Check the vout the operator typed actually exists: registering outpoint 3 of a
    // 2-output transaction is a silent dead end later ("vtxo not found").
    const outs = Array.isArray(body.result.vout) ? body.result.vout.length : undefined;
    if (outs !== undefined && (vout < 0 || vout >= outs)) {
      console.error(`      warning: ${txid} has ${outs} output(s); vout ${vout} does not exist`);
    }
    return Number(body.result.confirmations ?? 0);
  } catch {
    return undefined;
  }
}

async function main(): Promise<void> {
  if (DRY_RUN) {
    console.log(
      [
        "plan:",
        "  1. pnpm exec tsx scripts/operator-live.mts derive            -> vault P2TR + ownership address",
        "  2. fund that address on signet, wait ~6 confirmations          -> FUNDING_TXID",
        "  3. pnpm exec tsx scripts/operator-live.mts register $TXID $VOUT  (broadcasts TxVaultOpen)",
        "  4. pnpm live:check                                             -> must exit 0",
        "  5. pnpm exec tsx scripts/build-transition.mts $TXID $AMOUNT $VOUT -> txHex",
        "  6. you: start the app, connect, paste txHex in Advanced, execute  (the only gated write)",
        "",
        "inputs this driver reads: OPERATOR_MNEMONIC | OPERATOR_PRIVATE_KEY, TACHI_NETWORK,",
        "TACHI_BASE_URL, FUNDING_TXID, FUNDING_VOUT, DRAW_AMOUNT_SATS, OPERATOR_RPC_URL,",
        "MIN_CONFIRMS. Nothing here broadcasts a credit transition.",
      ].join("\n"),
    );
    return;
  }

  const key = process.env.OPERATOR_MNEMONIC?.trim() || process.env.OPERATOR_PRIVATE_KEY?.trim();
  if (!key && !DRY_RUN) {
    stop(
      "This driver signs, so it needs a key: OPERATOR_MNEMONIC (preferred, disposable signet wallet)\n" +
        "or OPERATOR_PRIVATE_KEY (32-byte hex). Use a wallet that holds testnet funds and nothing else.",
    );
  }

  console.log(`DrawBound live onboarding — network=${NETWORK}${DRY_RUN ? " (dry run)" : ""}`);

  // 1. Derive the vault. Cannot be done offline: the P2TR output key commits to the
  //    quorum's keys, so it is the daemon's set of validators that defines this address.
  console.log("\n[1/5] deriving vault address from the live quorum…");
  const derived = runJson(nodeScript("operator-live.mts", ["derive"]));
  const vaultRef = String(derived.vaultP2tr ?? process.env.TACHI_VAULT_REF ?? "").trim();
  if (!vaultRef) stop("derive printed no vaultP2tr and TACHI_VAULT_REF is not set");
  console.log(`      vault ${vaultRef}`);
  console.log(`      ownership address ${derived.ownershipAddress ?? "(re-run derive to see it)"}`);
  console.log(
    `\n      export these before starting the app:\n        TACHI_VAULT_REF=${vaultRef}\n        ALLOWED_VAULT_REFS=${vaultRef}`,
  );

  // 2. Funding. Money has to arrive from outside: a faucet, or your own wallet.
  let txid = (process.env.FUNDING_TXID ?? "").trim();
  const vout = Number.parseInt(process.env.FUNDING_VOUT ?? "0", 10);
  if (!txid) {
    console.log(`\n[2/5] fund that address with testnet sats (>= ${Number(AMOUNT_SATS) * 3} sats to cover amount + fee + change)`);
    console.log(`      faucet: https://faucet.signet.xyz or https://signet.faucet.mempool.space, send to ${vaultRef}`);
    if (DRY_RUN) {
      txid = "<fundingTxid>";
    } else {
      const rl = await createInterface({ input: process.stdin, output: process.stdout });
      txid = (await rl.question("      paste the deposit txid once it has ~6 confirmations (empty to stop): ")).trim();
      rl.close();
      if (!txid) stop("no txid supplied; nothing to register", 0);
    }
  } else {
    console.log(`\n[2/5] watching funding tx ${txid}:${vout} for ${MIN_CONFIRMS} confirmations…`);
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const confs = await confirmations(txid, vout);
      if (confs === undefined) {
        console.log("      no reachable bitcoind RPC (OPERATOR_RPC_URL) — assuming you confirmed it in a block explorer");
        break;
      }
      console.log(`      confirmations: ${confs}`);
      if (confs >= MIN_CONFIRMS) break;
      if (confs === 0) stop(`tx ${txid} is not visible to that bitcoind — check OPERATOR_RPC_URL/network`);
      await new Promise((resolve) => setTimeout(resolve, 15_000));
      if (attempt === 59) stop("timed out waiting for confirmations; re-run with FUNDING_TXID set");
    }
  }

  // 3. Ledger registration — the first real broadcast, and the one that makes the
  //    vault spendable. Delegated, not reimplemented.
  console.log("\n[3/5] registering the outpoint on the Tachi ledger (TxVaultOpen)…");
  run(nodeScript("operator-live.mts", ["register", txid, String(vout)]));

  // 4. The app's own gates.
  console.log("\n[4/5] running the live-readiness preflight…");
  try {
    run(nodeScript("live-check.mts", []));
  } catch {
    stop(
      "live:check refused: fix the printed gates before building a transition.\n" +
        "Most common: TACHI_VAULT_REF/ALLOWED_VAULT_REFS unset in this shell, or KILL_SWITCH/HAT_ORACLE_URL.\n" +
        "Remember a live process refuses to boot at all without an external proof anchor.",
    );
  }

  // 5. Build the transition. Prints hex; broadcasts nothing.
  console.log("\n[5/5] building and daemon-verifying the credit transition…");
  const built = runJson(nodeScript("build-transition.mts", [txid, AMOUNT_SATS, String(vout)]));
  if (built.status !== "READY" && !DRY_RUN) stop(`build-transition reported ${String(built.status ?? "no status")}`);
  console.log(
    `\nREADY. Vault ${built.vaultRef ?? vaultRef}: ${String(built.drawAmountSats ?? AMOUNT_SATS)} sats, fee ${String(built.feeSats ?? "?")} sats, nonce ${String(built.nonce ?? "?")}.`,
  );
  console.log("Next and final step, done by you in the app (never by this script):");
  console.log("  1. start the server with live mode armed (see docs/deployment.md, step 3 of the runbook)");
  console.log("  2. connect the vault in /vault, open Advanced, paste txHex, execute the action");
  console.log("  3. DrawBound attests the chain, decodes the hex again, enforces the caps, broadcasts,");
  console.log("     and only writes its ledger once the daemon reports the transaction committed.");
  if (typeof built.txHex === "string") {
    console.log("\ntxHex:");
    console.log(built.txHex);
  }
}

main()
  .then(() => undefined)
  .catch((error) => {
    if (DRY_RUN) return;
    const message = error instanceof Error ? error.message : String(error);
    // The child already printed what it saw; this is the one thing it cannot know,
    // because nine times out of ten the answer is "this machine cannot reach the daemon".
    console.error(`
step failed: ${message.split("\n")[0]}`);
    console.error(
      `if the message above mentions a fetch failure, check egress first:\n  curl -sS ${(process.env.TACHI_BASE_URL || `https://rpc-${NETWORK}.tachibtc.com`) + "/health"}`,
    );
    process.exitCode = 1;
  });
