import { SENTRY_BROWSER_CONFIG_PATH } from "@/lib/privacy-retention-replay";

let finish!: (dsn: string | null) => void;
/** Replay waits for initialization, not just for the configuration fetch. */
export const browserSentryReady = new Promise<string | null>(resolve => { finish = resolve; });

/** Called once by instrumentation-client, before the application mounts. */
export async function initializeBrowserSentry(initialize: (dsn: string) => void): Promise<void> {
  let dsn: string | null = null;
  try {
    const response = await fetch(SENTRY_BROWSER_CONFIG_PATH, { cache: "no-store" });
    if (response.ok) {
      const config: unknown = await response.json();
      if (config && typeof config === "object" && "dsn" in config && typeof config.dsn === "string") {
        dsn = config.dsn.trim() || null;
      }
    }
    if (dsn) initialize(dsn);
  } catch {
    // Unavailable or malformed configuration means no browser reporting/replay.
    dsn = null;
  }
  finish(dsn);
}
