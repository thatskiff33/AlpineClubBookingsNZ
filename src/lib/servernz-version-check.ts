import "server-only";
import {
  NO_KEY_SERVER_VERSION,
  SERVERNZ_EXPECTED_SERVER_VERSION,
  SERVER_VERSION_RECHECK_INTERVAL_MS,
  computeServerVersionStatus,
  isStoredServerVersionMismatch,
  type ServerVersionCheck,
} from "@/lib/servernz-api-version";
import {
  ServerNzNotConfiguredError,
  refreshStoredServerVersion,
} from "@/lib/servernz-api";
import { getServerNzSetupState } from "@/lib/servernz-config";
import { loadServerNzSettings } from "@/lib/servernz-settings";

/**
 * The version check as a service (#49, `INV-INT-026`): ask the central server,
 * record the answer, and report the computed status. Used by the nightly sync
 * (before its claim), the mirror sync (before its claim), the setup page's
 * version route and - read-only, through `readStoredServerVersion` - the Daily
 * digest and the lodges panel, which must never make a network call.
 *
 * The gate itself (refusing a server-bound request) lives in
 * `resolveConnection` in `servernz-api.ts`; this module only reads and
 * refreshes the stored answer it gates on.
 */

type Stored = { serverVersion: string | null; serverVersionCheckedAt: string | null };

function describe(
  stored: Stored,
  apiKeySet: boolean,
  flags: { couldNotCheck?: boolean; missingBaseUrl?: boolean } = {},
): ServerVersionCheck {
  const status = computeServerVersionStatus(stored.serverVersion, apiKeySet);
  return {
    status,
    serverVersion:
      status === "no-key"
        ? NO_KEY_SERVER_VERSION
        : (stored.serverVersion ?? NO_KEY_SERVER_VERSION),
    expected: SERVERNZ_EXPECTED_SERVER_VERSION,
    checkedAt: stored.serverVersionCheckedAt,
    couldNotCheck: flags.couldNotCheck ?? false,
    missingBaseUrl: flags.missingBaseUrl ?? false,
  };
}

/** True when the stored answer was recorded inside the recheck interval. */
function recentlyChecked(stored: Stored, now: Date): boolean {
  if (!stored.serverVersionCheckedAt) return false;
  const at = Date.parse(stored.serverVersionCheckedAt);
  return Number.isFinite(at) && now.getTime() - at < SERVER_VERSION_RECHECK_INTERVAL_MS;
}

/**
 * Ask the server and record what it said. With no API key stored NO request is
 * made and the status is `no-key` (shown as `0`). When the call fails the
 * stored answer is kept and `couldNotCheck` says so - "could not check" is a
 * different thing from "mismatch", and only the second pauses syncing. A key
 * with no usable server address is reported as `missingBaseUrl`, quietly.
 *
 * `options.throttle` (the setup page's route) returns the stored answer
 * without a call when one was recorded inside `SERVER_VERSION_RECHECK_INTERVAL_MS`,
 * so a reload or a second tab cannot trip the server's per-token rate limit.
 * The nightly sync and the mirror do not throttle: hours apart, and the whole
 * point of their check is a fresh answer before a pass.
 */
export async function checkServerVersion(
  options: { throttle?: boolean; now?: Date } = {},
): Promise<ServerVersionCheck> {
  const setup = await getServerNzSetupState();
  if (!setup.apiKeySet) {
    return describe(await loadServerNzSettings(), false);
  }
  if (options.throttle) {
    const stored = await loadServerNzSettings();
    if (recentlyChecked(stored, options.now ?? new Date())) return describe(stored, true);
  }
  try {
    const refreshed = await refreshStoredServerVersion();
    return describe(await loadServerNzSettings(), true, { couldNotCheck: refreshed === null });
  } catch (error) {
    if (error instanceof ServerNzNotConfiguredError) {
      return describe(await loadServerNzSettings(), true, { missingBaseUrl: true });
    }
    throw error;
  }
}

/**
 * The stored answer, with NO network call: the digest (which follows the
 * nightly sync) and the lodges panel read it this way.
 */
export async function readStoredServerVersion(): Promise<ServerVersionCheck> {
  const [setup, settings] = await Promise.all([
    getServerNzSetupState(),
    loadServerNzSettings(),
  ]);
  return describe(settings, setup.apiKeySet);
}

/**
 * The cheapest form of the question the sync pre-checks ask (#49): "would a
 * server-bound request be refused for version?" Reads the settings row alone -
 * no key lookup - because only a RECORDED answer can pause, and the recorded
 * answer is forgotten whenever the key is. Callers that hold a single-flight
 * claim or an attempt counter ask this BEFORE taking either, so a pause neither
 * wedges a claim nor burns an attempt.
 */
export async function isServerSyncPaused(): Promise<boolean> {
  const settings = await loadServerNzSettings();
  return isStoredServerVersionMismatch(settings.serverVersion);
}
