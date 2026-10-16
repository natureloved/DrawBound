import { z } from "zod";

/**
 * Typed, validated environment configuration.
 *
 * Design notes:
 * - `validateEnv()` runs once at module load and throws a readable error on any
 *   malformed value, so a misconfigured deployment fails fast at boot instead of
 *   silently misbehaving at request time.
 * - The accessor helpers below re-read `process.env` on every call. That keeps
 *   runtime-flippable behavior (tests toggling LIVE_TACHI_ENABLED, operators
 *   flipping the kill switch before a restart) working exactly as before, while
 *   still coercing and validating each value.
 */

const BOOL_STRINGS = ["true", "false"] as const;

/**
 * Mode values are restricted to what actually has a code path. `NATIVE`, `RELAY`
 * and `RECORDED` are documented as reserved boundaries with no implementation, so
 * naming one here fails fast at boot instead of silently behaving as `fixture`.
 * An empty value means "unset" and falls back to the default, matching the
 * `z.literal("")` convention used for the URL fields below.
 */
const modeSchema = (fallback: "fixture" | "live") =>
  z
    .union([z.literal(""), z.enum(["fixture", "live"])])
    .default(fallback)
    .transform((value) => (value === "" ? fallback : value));

const envSchema = z.object({
  APP_MODE: modeSchema("fixture"),
  PROOF_MODE: modeSchema("fixture"),
  TACHI_NETWORK: z.enum(["signet", "regtest", "mainnet"]).default("signet"),
  TACHI_BASE_URL: z.union([z.url(), z.literal("")]).default(""),
  TACHI_RPC_URL: z.union([z.url(), z.literal("")]).default(""),
  // Chain id the daemon must advertise (e.g. "tachi-signet-1"). Empty means
  // "derive from TACHI_NETWORK", which is defined for signet/regtest only.
  TACHI_EXPECTED_CHAIN_ID: z.string().max(120).default(""),
  LIVE_TACHI_ENABLED: z.enum(BOOL_STRINGS).default("false"),
  // Live execution tuning. All fail closed: a value that cannot be read is an
  // error, never a silent default to "just broadcast it".
  LIVE_REQUIRE_CHAIN_ATTESTATION: z.enum(BOOL_STRINGS).default("true"),
  LIVE_REQUIRE_CHAIN_READ: z.enum(BOOL_STRINGS).default("true"),
  LIVE_ATTESTATION_TTL_MS: z.coerce.number().int().min(1000).max(3_600_000).default(60_000),
  LIVE_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120_000).default(20_000),
  LIVE_CONFIRM_TIMEOUT_MS: z.coerce.number().int().min(1000).max(600_000).default(45_000),
  LIVE_POLL_INTERVAL_MS: z.coerce.number().int().min(250).max(30_000).default(1_500),
  LIVE_MAX_FEE_SATS: z.coerce.number().int().positive().max(1_000_000).default(5_000),
  ALLOW_MAINNET: z.enum(BOOL_STRINGS).default("false"),
  KILL_SWITCH: z.enum(BOOL_STRINGS).default("true"),
  MAX_TEST_SATS: z.coerce.number().int().positive().default(5000),
  MAX_DRAWS_PER_POSITION: z.coerce.number().int().nonnegative().default(3),
  CREDIT_UNIT_SATS: z.coerce.number().int().positive().default(10),
  MIN_HEALTH_BPS: z.coerce.number().int().positive().default(12500),
  PROOF_MAX_AGE_SECONDS: z.coerce.number().int().positive().default(300),
  SESSION_TTL_MINUTES: z.coerce.number().int().positive().default(720),
  // When true, connecting a P2TR vault address requires a valid BIP-322
  // ownership proof (fixture-style vault refs stay exempt).
  REQUIRE_OWNERSHIP_PROOF: z.enum(BOOL_STRINGS).default("false"),
  // Storage backend: json (default, single file) or sqlite (node:sqlite, durable).
  DB_BACKEND: z.enum(["json", "sqlite"]).default("json"),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(60),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  // Local-demo escape hatch: when ADMIN_TOKEN is unset, destructive routes stay
  // shut unless this is explicitly "true". Never set on a reachable deployment.
  ALLOW_INSECURE_RESET: z.enum(BOOL_STRINGS).default("false"),
  // Reverse-proxy hops in front of this app. Rate limiting only trusts
  // x-forwarded-for when this is > 0; otherwise all callers share one bucket.
  TRUSTED_PROXY_HOPS: z.coerce.number().int().nonnegative().default(0),
});

export type EnvShape = z.infer<typeof envSchema>;

/**
 * Cross-field policy checks that run once at boot.
 *
 * The important one: live mode without a proof-trust anchor. In live mode the
 * draw gate derives health from the server's own chain read and then broadcasts
 * on that basis, which means the protocol is only as honest as its operator.
 * Requiring an oracle (HAT_ORACLE_URL) or a strict proof allowlist makes the
 * health input externally verifiable before any real write happens.
 *
 * The second group is the signet binding: a live deployment used to boot with an
 * empty allowlist, no vault ref, and an address from another network, then fail
 * confusingly at the first broadcast (or not fail at all). Those are now startup
 * errors. The prefix test here is deliberately cheap — the authoritative bech32m
 * decode lives in `checkVaultRef` (src/lib/tachi/signet.ts) and runs on every
 * live operation — but it must not import that module: this function executes
 * while `env` is still initializing, so the config module has to stay a leaf.
 */
const P2TR_PREFIX: Record<string, string> = { signet: "tb1p", regtest: "bcrt1p", mainnet: "bc1p" };

function looksLikeP2trForNetwork(value: string, network: string): boolean {
  const prefix = P2TR_PREFIX[network];
  if (!prefix) return false;
  const candidate = value.trim().toLowerCase();
  // 42-char witness program + prefix; bech32m checksum is verified at operation time.
  return candidate.startsWith(prefix) && candidate.length >= prefix.length + 58 && candidate.length <= prefix.length + 66 && /^[a-z0-9]+$/.test(candidate);
}

export function validatePolicy(source: NodeJS.ProcessEnv = process.env): void {
  const live = readBoolFrom(source, "LIVE_TACHI_ENABLED") || source.PROOF_MODE === "live";
  if (!live) return;

  const hasOracle = Boolean(source.HAT_ORACLE_URL?.trim());
  const hasAllowlist = Boolean(source.PROOF_RELAY_PUBLIC_KEYS?.trim());
  if (!hasOracle && !hasAllowlist) {
    invalid(
      "LIVE_TACHI_ENABLED",
      "live mode requires externally verifiable health: set HAT_ORACLE_URL or PROOF_RELAY_PUBLIC_KEYS " +
        "(otherwise the gate can only self-attest health and broadcast on it)",
    );
  }

  const network = source.TACHI_NETWORK?.trim() || "signet";
  if (!P2TR_PREFIX[network]) {
    invalid("TACHI_NETWORK", `live mode needs one of signet|regtest|mainnet, got "${source.TACHI_NETWORK}"`);
  }

  if (network === "mainnet" && !source.TACHI_EXPECTED_CHAIN_ID?.trim()) {
    invalid(
      "TACHI_EXPECTED_CHAIN_ID",
      "mainnet has no published chain-id default; set TACHI_EXPECTED_CHAIN_ID to the chain id your daemon advertises",
    );
  }

  const attestationDisabled = source.LIVE_REQUIRE_CHAIN_ATTESTATION?.trim() === "false";
  if (attestationDisabled && !hasOracle) {
    invalid(
      "LIVE_REQUIRE_CHAIN_ATTESTATION",
      "disabling network attestation is only permitted alongside a signed-proof anchor (HAT_ORACLE_URL), " +
        "otherwise neither the chain the transactions land on nor the health they are gated by is externally verified",
    );
  }

  const vaultRefs = (source.ALLOWED_VAULT_REFS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (vaultRefs.length === 0) {
    invalid("ALLOWED_VAULT_REFS", "live mode requires a non-empty vault allowlist; without it nothing bounds which vault may be transitioned");
  }
  const configured = source.TACHI_VAULT_REF?.trim();
  if (!configured) {
    invalid("TACHI_VAULT_REF", "live mode requires the operator's funded TAURUS P2TR vault address");
  }
  for (const ref of configured ? [configured, ...vaultRefs] : vaultRefs) {
    if (!looksLikeP2trForNetwork(ref, network)) {
      invalid(
        "ALLOWED_VAULT_REFS",
        `"${ref}" is not a P2TR address for TACHI_NETWORK=${network} (expected the "${P2TR_PREFIX[network]}" prefix); ` +
          "a vault address from another network can never match the daemon's locked-VTXO index",
      );
    }
  }
}

function readBoolFrom(source: NodeJS.ProcessEnv, name: string): boolean {
  const raw = source[name];
  return raw === "true";
}

/** Comma-separated list envs (free-form strings, validated loosely). */
export type ListEnvName = "ALLOWED_VAULT_REFS" | "PROOF_RELAY_PUBLIC_KEYS" | "ALLOWED_RECIPIENTS";

function invalid(name: string, detail: string): never {
  throw new Error(`Invalid environment configuration for ${name}: ${detail}`);
}

/** Validate the full known env shape once; throws with a readable message. */
export function validateEnv(source: NodeJS.ProcessEnv = process.env): EnvShape {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    invalid("environment", issues);
  }
  return result.data;
}

// Fail fast at boot: an unparseable env must never start a server that looks healthy.
// The policy check runs after it so its error is about configuration, not parsing.
validateEnv();
validatePolicy();

function readBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  if (raw !== "true" && raw !== "false") invalid(name, `expected "true" or "false", got "${raw}"`);
  return raw === "true";
}

function readInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) invalid(name, `expected a positive integer, got "${raw}"`);
  return parsed;
}

function readList(name: string): string[] {
  return (process.env[name] ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

export const env = {
  network(): "signet" | "regtest" | "mainnet" {
    const raw = process.env.TACHI_NETWORK;
    if (raw === undefined || raw === "") return "signet";
    if (raw !== "signet" && raw !== "regtest" && raw !== "mainnet") invalid("TACHI_NETWORK", `got "${raw}"`);
    return raw;
  },
  liveEnabled(): boolean {
    return readBool("LIVE_TACHI_ENABLED", false) || process.env.PROOF_MODE === "live";
  },
  /** Validated proof/adapter mode (fixture | live), never a raw process.env read. */
  proofMode(): "fixture" | "live" {
    const raw = process.env.PROOF_MODE;
    if (raw === undefined || raw === "") return "fixture";
    if (raw !== "fixture" && raw !== "live") invalid("PROOF_MODE", `got "${raw}"`);
    return raw;
  },
  mainnetAllowed(): boolean {
    return readBool("ALLOW_MAINNET", false) && readBool("LIVE_TACHI_ENABLED", false) && !readBool("KILL_SWITCH", true);
  },
  /** Base URL override for the Tachi daemon; empty means "use the per-network default". */
  tachiBaseUrl(): string | undefined {
    const raw = process.env.TACHI_BASE_URL?.trim();
    return raw ? raw.replace(/\/+$/, "") : undefined;
  },
  /** Chain id the daemon must advertise. Empty means "derive from TACHI_NETWORK". */
  expectedChainId(): string | undefined {
    const raw = process.env.TACHI_EXPECTED_CHAIN_ID?.trim();
    return raw ? raw : undefined;
  },
  /** When true (default) every live read/broadcast first verifies the daemon's chain id. */
  liveRequiresChainAttestation(): boolean {
    return readBool("LIVE_REQUIRE_CHAIN_ATTESTATION", true);
  },
  /**
   * When true (default) live mode refuses to decide on modeled collateral: a
   * failed chain read is a denial, not a fallback to the fixture numbers.
   */
  liveRequiresChainRead(): boolean {
    return readBool("LIVE_REQUIRE_CHAIN_READ", true);
  },
  liveAttestationTtlMs(): number {
    return readInt("LIVE_ATTESTATION_TTL_MS", 60_000);
  },
  liveRequestTimeoutMs(): number {
    return readInt("LIVE_REQUEST_TIMEOUT_MS", 20_000);
  },
  /** How long to wait for a broadcast transaction to be observed committed. */
  liveConfirmTimeoutMs(): number {
    return readInt("LIVE_CONFIRM_TIMEOUT_MS", 45_000);
  },
  livePollIntervalMs(): number {
    return readInt("LIVE_POLL_INTERVAL_MS", 1_500);
  },
  /** Fee ceiling for a transaction the server will broadcast on an operator's behalf. */
  liveMaxFeeSats(): number {
    return readInt("LIVE_MAX_FEE_SATS", 5_000);
  },
  killSwitch(): boolean {
    return readBool("KILL_SWITCH", true);
  },
  maxTestSats(): number {
    return readInt("MAX_TEST_SATS", 5000);
  },
  maxDrawsPerPosition(): number {
    const raw = process.env.MAX_DRAWS_PER_POSITION;
    if (raw === undefined || raw === "") return 3;
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed < 0) invalid("MAX_DRAWS_PER_POSITION", `expected a non-negative integer, got "${raw}"`);
    return parsed;
  },
  creditUnitSats(): number {
    return readInt("CREDIT_UNIT_SATS", 10);
  },
  minHealthBps(): number {
    return readInt("MIN_HEALTH_BPS", 12500);
  },
  proofMaxAgeSeconds(): number {
    return readInt("PROOF_MAX_AGE_SECONDS", 300);
  },
  sessionTtlMs(): number {
    return readInt("SESSION_TTL_MINUTES", 720) * 60_000;
  },
  requireOwnershipProof(): boolean {
    return readBool("REQUIRE_OWNERSHIP_PROOF", false);
  },
  storageBackend(): "json" | "sqlite" {
    const raw = process.env.DB_BACKEND;
    if (raw === undefined || raw === "") return "json";
    if (raw !== "json" && raw !== "sqlite") invalid("DB_BACKEND", `expected "json" or "sqlite", got "${raw}"`);
    return raw;
  },
  rateLimitMax(): number {
    return readInt("RATE_LIMIT_MAX", 60);
  },
  rateLimitWindowMs(): number {
    return readInt("RATE_LIMIT_WINDOW_MS", 60_000);
  },
  allowedVaultRefs(): string[] {
    return readList("ALLOWED_VAULT_REFS");
  },
  proofRelayPublicKeys(): string[] {
    return readList("PROOF_RELAY_PUBLIC_KEYS");
  },
  adminToken(): string | undefined {
    const raw = process.env.ADMIN_TOKEN?.trim();
    return raw ? raw : undefined;
  },
  /**
   * Number of reverse-proxy hops in front of this app. Rate limiting only trusts
   * `x-forwarded-for` when this is > 0; otherwise every caller shares one
   * bucket (safe-by-default against header-rotation bypass).
   */
  trustedProxyHops(): number {
    return readInt("TRUSTED_PROXY_HOPS", 0);
  },
  /**
   * Local-demo escape hatch: when ADMIN_TOKEN is unset, destructive routes stay
   * shut unless a deployment explicitly opts in. Never enable in a deployment
   * that is reachable by anyone but the operator.
   */
  allowInsecureReset(): boolean {
    return readBool("ALLOW_INSECURE_RESET", false);
  },
  list(name: ListEnvName): string[] {
    return readList(name);
  },
};
