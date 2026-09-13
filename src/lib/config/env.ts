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

const envSchema = z.object({
  APP_MODE: z.string().default("fixture"),
  PROOF_MODE: z.string().default("fixture"),
  TACHI_NETWORK: z.enum(["signet", "regtest", "mainnet"]).default("signet"),
  TACHI_BASE_URL: z.union([z.url(), z.literal("")]).default(""),
  TACHI_RPC_URL: z.union([z.url(), z.literal("")]).default(""),
  LIVE_TACHI_ENABLED: z.enum(BOOL_STRINGS).default("false"),
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
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(60),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export type EnvShape = z.infer<typeof envSchema>;

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
validateEnv();

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
  mainnetAllowed(): boolean {
    return readBool("ALLOW_MAINNET", false) && readBool("LIVE_TACHI_ENABLED", false) && !readBool("KILL_SWITCH", true);
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
  list(name: ListEnvName): string[] {
    return readList(name);
  },
};
