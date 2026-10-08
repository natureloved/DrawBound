/**
 * DrawBound operator tooling — read-only live-execution preflight.
 *
 * Usage:
 *   pnpm exec tsx scripts/live-check.mts            # gates + daemon probe
 *   pnpm exec tsx scripts/live-check.mts --config    # gates only, no network
 *   pnpm exec tsx scripts/live-check.mts --json      # machine-readable
 *
 * Prints every gate a live broadcast has to pass and exits non-zero if any blocking
 * one fails, so it can also be wired into a deploy step:
 *
 *   pnpm exec tsx scripts/live-check.mts --config && next start
 *
 * It performs reads only — no broadcast, no signing, no key material required. The
 * checks are the app's own (`src/lib/tachi/readiness.ts`), never a copy, so this
 * report cannot drift from what the server will actually enforce.
 */
import { existsSync } from "node:fs";

if (typeof process.loadEnvFile === "function" && existsSync(".env")) {
  process.loadEnvFile();
}

const AS_JSON = process.argv.includes("--json");
const CONFIG_ONLY = process.argv.includes("--config");

/** Sentinel: the failure has already been explained to the operator, don't print a stack too. */
const ALREADY_REPORTED = new Error("live-check: configuration refused at import time");

/**
 * Project `.ts` modules load as CommonJS under this toolchain, so their names are not
 * visible to a static ESM import (`SyntaxError: does not provide an export named …`).
 * A dynamic import is how an operator script reuses app logic without duplicating it —
 * duplicated gate logic is exactly how a runbook ends up checking something the server
 * does not.
 */
async function loadModule<T>(specifier: string): Promise<T> {
  const mod = (await import(specifier)) as unknown as Record<string, unknown>;
  const resolved = (mod.default ?? mod) as Record<string, unknown>;
  const picked: Record<string, unknown> = {};
  for (const key of new Set([...Object.keys(mod), ...Object.keys(resolved)])) {
    picked[key] = mod[key] ?? resolved[key];
  }
  return picked as T;
}

interface ReadinessCheckView {
  id: string;
  label: string;
  ok: boolean;
  blocking: boolean;
  detail: string;
  fix?: string;
}
interface ReadinessReportView {
  mode: string;
  network: string;
  baseUrl: string;
  expectedChainId?: string;
  executionReady: boolean;
  blocking: string[];
  checks: ReadinessCheckView[];
  attestation?: { advertisedChainId?: string; height?: number; version?: string; status?: string };
  vault?: { address: string; lockedSats: number; lockedVtxoCount: number; funded: boolean };
}

async function main(): Promise<void> {
  const readiness = await loadModule<{
    configReadiness: () => ReadinessReportView;
    probeReadiness: () => Promise<ReadinessReportView>;
  }>("@/lib/tachi/readiness").catch((error: unknown) => {
    // Importing the readiness module pulls in the env schema, which validates and
    // enforces boot policy. A deployment that violates it never gets as far as a
    // report — and that IS the report, so translate it instead of dumping a stack.
    const message = error instanceof Error ? error.message : String(error);
    if (AS_JSON) console.log(JSON.stringify({ error: message, executionReady: false }, null, 2));
    else {
      console.error("DrawBound refuses to run live with this environment:");
      console.error(`  ${message}`);
      console.error("Fix the configuration above; `--config` shows the rest of the gates once it parses.");
    }
    process.exitCode = 2;
    throw ALREADY_REPORTED;
  });

  let report: ReadinessReportView;
  try {
    report = CONFIG_ONLY ? readiness.configReadiness() : await readiness.probeReadiness();
  } catch (error) {
    console.error(
      `live-check could not evaluate readiness: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
    );
    process.exitCode = 2;
    return;
  }

  if (AS_JSON) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    const ticks = report.checks.filter((entry) => entry.ok).length;
    console.log(`DrawBound live-execution preflight — ${ticks}/${report.checks.length} checks pass`);
    console.log(`mode=${report.mode} network=${report.network} daemon=${report.baseUrl}${report.expectedChainId ? ` expected-chain=${report.expectedChainId}` : ""}`);
    if (report.attestation) {
      const a = report.attestation;
      const height = Number.isFinite(a.height) ? String(a.height) : "?";
      console.log(`daemon: chain=${a.advertisedChainId || "(none)"} height=${height} version=${a.version || "?"} status=${a.status ?? "?"}`);
    }
    if (report.vault) {
      console.log(`vault:  ${report.vault.address} locked=${report.vault.lockedSats} sats across ${report.vault.lockedVtxoCount} VTXO(s)`);
    }
    console.log("");
    for (const entry of report.checks) {
      const mark = entry.ok ? "  ok  " : entry.blocking ? " FAIL " : " note ";
      console.log(`[${mark}] ${entry.label} — ${entry.detail}`);
      if (!entry.ok && entry.fix) console.log(`         fix: ${entry.fix}`);
    }
    console.log("");
    console.log(
      report.executionReady
        ? "READY: a signed transaction would be broadcast against this daemon."
        : `NOT READY: ${report.blocking.join("; ")}`,
    );
    if (!CONFIG_ONLY && report.executionReady) {
      console.log("next: build and verify a transition with pnpm exec tsx scripts/build-transition.mts <fundingTxid> <amountSats>");
    }
  }

  process.exitCode = report.executionReady ? 0 : 1;
}

main().catch((error) => {
  if (error === ALREADY_REPORTED) return;
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exitCode = 2;
});
