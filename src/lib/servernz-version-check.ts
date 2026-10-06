import "server-only";
import {
  SERVERNZ_EXPECTED_SERVER_VERSION,
  computeServerVersionStatus,
  isStoredServerVersionMismatch,
  type ServerVersionStatus,
} from "@/lib/servernz-api-version";
import { refreshStoredServerVersion } from "@/lib/servernz-api";
import { getServerNzSetupState } from "@/lib/servernz-config";
import { loadServerNzSettings } from "@/lib/servernz-settings";

/**
 * The version check as a service (#49, `INV-INT-025`): ask the central server,
 * record the answer, and report the computed status. Used by the nightly sync
 * (before its claim), the mirror sync (before its claim), the setup page's
 * version route and - read-only, through `readStoredServerVersion` - the Daily
 * digest and the lodges panel, which must never make a network call.
 *
 * The gate itself (refusing a server-bound request) lives in
 * `resolveConnection` in `servernz-api.ts`; this module only reads and
 * refreshes the stored answer it gates on.
 */

export interface ServerVersionCheck {
  status: ServerVersionStatus;
  /** The server's version as shown: `"0"` with no key, else the stored answer. */
  serverVersion: string;
  /** The version this site speaks. */
  expected: string;
  checkedAt: string | null;
  /** True when this call could not reach or read the server; the stored answer stands. */
  couldNotCheck: boolean;
}

/** The server version shown when no API key is stored: nothing was asked. */
const NO_KEY_VERSION = "0";

function describe(
  stored: { serverVersion: string | null; serverVersionCheckedAt: string | null },
  apiKeySet: boolean,
  couldNotCheck: boolean,
): ServerVersionCheck {
  const status = computeServerVersionStatus(stored.serverVersion, apiKeySet);
  return {
    status,
    serverVersion:
      status === "no-key" ? NO_KEY_VERSION : (stored.serverVersion ?? NO_KEY_VERSION),
    expected: SERVERNZ_EXPECTED_SERVER_VERSION,
    checkedAt: stored.serverVersionCheckedAt,
    couldNotCheck,
  };
}

/**
 * Ask the server and record what it said. With no API key stored NO request is
 * made and the status is `no-key` (shown as `0`). When the call fails the
 * stored answer is kept and `couldNotCheck` says so - "could not check" is a
 * different thing from "mismatch", and only the second pauses syncing.
 */
export async function checkServerVersion(): Promise<ServerVersionCheck> {
  const setup = await getServerNzSetupState();
  if (!setup.apiKeySet) {
    return describe(await loadServerNzSettings(), false, false);
  }
  const refreshed = await refreshStoredServerVersion();
  return describe(await loadServerNzSettings(), true, refreshed === null);
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
  return describe(settings, setup.apiKeySet, false);
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
