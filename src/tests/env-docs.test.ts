import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Configuration is a security surface here: nearly every live-execution gate is an env
 * var, and an operator working from `docs/deployment.md` + `.env.example` decides whether
 * a broadcast is armed by what those files say. Two kinds of drift make that dangerous,
 * and both are cheap to prevent:
 *
 *  - a key documented but not read anywhere — the operator sets it believing a gate is
 *    closed while nothing enforces it;
 *  - a key read by the config module but undocumented — the gate exists but nobody
 *    deploying knows to set it (this is how `ALLOW_INSECURE_RESET`, a destructive escape
 *    hatch, sat undeclared).
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function read(relative: string): string {
  return readFileSync(path.join(ROOT, relative), "utf8");
}

function walk(dir: string, out: string[] = []): string[] {
  const absolute = path.join(ROOT, dir);
  if (!existsSync(absolute)) return out;
  for (const entry of readdirSync(absolute, { withFileTypes: true })) {
    const relative = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!/node_modules|\.next|\.git/.test(relative)) walk(relative, out);
    } else if (/\.(ts|tsx|mts|mjs|js)$/.test(entry.name)) {
      out.push(relative);
    }
  }
  return out;
}

const DOC_KEYS = [...read(".env.example").matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((match) => match[1]);

const CODE_CORPUS = [
  ...walk("src"),
  ...walk("scripts"),
  "next.config.ts",
  "Dockerfile",
  "fly.toml",
]
  .filter((file) => existsSync(path.join(ROOT, file)) && statSync(path.join(ROOT, file)).isFile())
  .map((file) => read(file))
  .join("\n");

const CONFIG_SOURCE = read(path.join("src", "lib", "config", "env.ts"));

/** Every NAME the config module touches, whatever the access style. */
function keysReadByConfig(): string[] {
  const found = new Set<string>();
  for (const match of CONFIG_SOURCE.matchAll(/(?:process\.env\.|source\.)([A-Z][A-Z0-9_]{2,})/g)) found.add(match[1]);
  for (const match of CONFIG_SOURCE.matchAll(/read(?:Bool|Int|List)\(\s*"([A-Z0-9_]+)"/g)) found.add(match[1]);
  // The zod schema block lists the env keys as `NAME: z...`.
  for (const match of CONFIG_SOURCE.matchAll(/^\s{2}([A-Z][A-Z0-9_]{2,}):\s*z\./gm)) found.add(match[1]);
  return [...found].sort();
}

describe("environment documentation drift", () => {
  it("only documents keys the code actually reads", () => {
    const orphans = DOC_KEYS.filter((key) => !new RegExp(`\\b${key}\\b`).test(CODE_CORPUS));
    expect(orphans, `.env.example documents keys nothing reads: ${orphans.join(", ")}`).toEqual([]);
  });

  it("documents every key the config module reads", () => {
    const documented = new Set(DOC_KEYS);
    const missing = keysReadByConfig().filter((key) => !documented.has(key));
    expect(missing, `.env.example is missing: ${missing.join(", ")}`).toEqual([]);
  });

  it("keeps the live-execution gates explained, not just listed", () => {
    // An operator arming live writes must be able to read what each gate does without
    // opening the source. These are the keys whose default is the safe side; a bare
    // `KEY=` line with no comment is how a gate gets flipped by accident.
    const example = read(".env.example");
    for (const key of [
      "LIVE_TACHI_ENABLED",
      "KILL_SWITCH",
      "ALLOW_MAINNET",
      "ALLOWED_VAULT_REFS",
      "TACHI_EXPECTED_CHAIN_ID",
      "LIVE_REQUIRE_CHAIN_ATTESTATION",
      "LIVE_REQUIRE_CHAIN_READ",
      "LIVE_MAX_FEE_SATS",
      "MAX_TEST_SATS",
      "ALLOW_INSECURE_RESET",
    ]) {
      const line = new RegExp(`(^|\\n)(#[^\\n]*\\n)+${key}=`).exec(example);
      expect(line, `${key} must be preceded by at least one explanatory comment line`).not.toBeNull();
    }
  });

  it("ships safe live defaults in the deployment template", () => {
    // fly.toml is the repo's only deploy template; its pinned values must be the
    // locked side, so a `fly deploy` of an unconfigured app can never arm a broadcast.
    const fly = read("fly.toml");
    expect(fly).toMatch(/LIVE_TACHI_ENABLED\s*=\s*"false"/);
    expect(fly).toMatch(/KILL_SWITCH\s*=\s*"true"/);
    expect(fly).toMatch(/ALLOW_MAINNET\s*=\s*"false"/);
    expect(fly).toMatch(/LIVE_REQUIRE_CHAIN_ATTESTATION\s*=\s*"true"/);
    expect(fly).toMatch(/LIVE_REQUIRE_CHAIN_READ\s*=\s*"true"/);
  });
});
