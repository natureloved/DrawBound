import { afterEach, describe, expect, it } from "vitest";
import { clearSessions, createSession } from "@/lib/auth/sessions";

// process.env.NODE_ENV is typed read-only; the cast is the test's way of
// simulating a production deployment for one test at a time.
const envRecord = process.env as Record<string, string | undefined>;
const ORIGINAL_NODE_ENV = envRecord.NODE_ENV;
const ORIGINAL_SECRET = envRecord.SESSION_SECRET;

afterEach(() => {
  if (ORIGINAL_NODE_ENV === undefined) delete envRecord.NODE_ENV;
  else envRecord.NODE_ENV = ORIGINAL_NODE_ENV;
  if (ORIGINAL_SECRET === undefined) delete envRecord.SESSION_SECRET;
  else envRecord.SESSION_SECRET = ORIGINAL_SECRET;
  clearSessions();
});

describe("session secret fail-closed", () => {
  it("refuses to sign a token in production without SESSION_SECRET", () => {
    envRecord.NODE_ENV = "production";
    delete envRecord.SESSION_SECRET;
    expect(() =>
      createSession({ vaultRef: "tb1ptest", positionId: "p1", publicKey: "aa".repeat(32) }),
    ).toThrow(/SESSION_SECRET is required in production/);
  });

  it("signs with a configured secret in production", () => {
    envRecord.NODE_ENV = "production";
    envRecord.SESSION_SECRET = "0123456789abcdef0123456789abcdef";
    const session = createSession({ vaultRef: "tb1ptest", positionId: "p1", publicKey: "aa".repeat(32) });
    expect(session.token).toContain(".");
  });

  it("rejects a short SESSION_SECRET at env validation", async () => {
    const { validateEnv } = await import("@/lib/config/env");
    expect(() => validateEnv({ ...process.env, SESSION_SECRET: "short" })).toThrow(/SESSION_SECRET/);
  });
});
