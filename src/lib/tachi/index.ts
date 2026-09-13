import type { TachiAdapter } from "./adapter";
import { FixtureTachiAdapter } from "./fixture-adapter";
import { LiveTachiAdapter } from "./live-adapter";

export function isLiveMode(): boolean {
  return process.env.LIVE_TACHI_ENABLED === "true" || process.env.PROOF_MODE === "live";
}

/** Build the adapter for the current configuration. */
export function createTachiAdapter(): TachiAdapter {
  return isLiveMode() ? new LiveTachiAdapter() : new FixtureTachiAdapter();
}

let cached: TachiAdapter | null = null;

/**
 * Process-scoped adapter singleton. Callers should use this so the chosen mode is
 * stable for the life of the server process. Restart the server to change modes.
 */
export function getTachiAdapter(): TachiAdapter {
  if (!cached) cached = createTachiAdapter();
  return cached;
}
