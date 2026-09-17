import { describe, expect, it } from "vitest";
import { validateEnv } from "@/lib/config/env";

/**
 * Environment validation contract.
 *
 * Regression guard for a real bug: `.env` had `APP_MODE=LIVE_TACHI_ENABLED` and
 * `PROOF_MODE=LIVE_TACHI_ENABLED` (a botched find/replace left the variable NAME
 * as the value). Both fields were `z.string()`, so the garbage sailed through
 * validation and the app silently ran in fixture mode. They are now enums.
 *
 * `validateEnv` takes an explicit source so these cases never touch process.env.
 */
const env = (over: Record<string, string>) => over as unknown as NodeJS.ProcessEnv;

describe("environment validation", () => {
  it("accepts the implemented modes", () => {
    for (const mode of ["fixture", "live"]) {
      const parsed = validateEnv(env({ APP_MODE: mode, PROOF_MODE: mode }));
      expect(parsed.APP_MODE).toBe(mode);
      expect(parsed.PROOF_MODE).toBe(mode);
    }
  });

  it("rejects the exact garbage values that shipped in .env", () => {
    expect(() => validateEnv(env({ APP_MODE: "LIVE_TACHI_ENABLED" }))).toThrow(/Invalid environment configuration/);
    expect(() => validateEnv(env({ PROOF_MODE: "LIVE_TACHI_ENABLED" }))).toThrow(/Invalid environment configuration/);
  });

  it("rejects reserved modes that have no implementation", () => {
    for (const reserved of ["NATIVE", "RELAY", "RECORDED", "native", "relay"]) {
      expect(() => validateEnv(env({ PROOF_MODE: reserved }))).toThrow(/Invalid environment configuration/);
    }
  });

  it("treats an empty value as unset and falls back to the default", () => {
    const parsed = validateEnv(env({ APP_MODE: "", PROOF_MODE: "" }));
    expect(parsed.APP_MODE).toBe("fixture");
    expect(parsed.PROOF_MODE).toBe("fixture");
  });

  it("defaults to fixture when the mode vars are absent", () => {
    const parsed = validateEnv(env({}));
    expect(parsed.APP_MODE).toBe("fixture");
    expect(parsed.PROOF_MODE).toBe("fixture");
  });

  it("keeps the kill switch on by default (safe default)", () => {
    expect(validateEnv(env({})).KILL_SWITCH).toBe("true");
  });

  it("rejects non-boolean values for the boolean fields", () => {
    expect(() => validateEnv(env({ KILL_SWITCH: "yes" }))).toThrow(/Invalid environment configuration/);
    expect(() => validateEnv(env({ LIVE_TACHI_ENABLED: "1" }))).toThrow(/Invalid environment configuration/);
    expect(() => validateEnv(env({ ALLOW_MAINNET: "TRUE" }))).toThrow(/Invalid environment configuration/);
  });

  it("rejects unknown networks and storage backends", () => {
    expect(() => validateEnv(env({ TACHI_NETWORK: "testnet" }))).toThrow(/Invalid environment configuration/);
    expect(() => validateEnv(env({ DB_BACKEND: "postgres" }))).toThrow(/Invalid environment configuration/);
  });

  it("rejects a malformed URL but allows an empty one", () => {
    expect(() => validateEnv(env({ TACHI_BASE_URL: "not-a-url" }))).toThrow(/Invalid environment configuration/);
    expect(validateEnv(env({ TACHI_BASE_URL: "" })).TACHI_BASE_URL).toBe("");
  });
});
