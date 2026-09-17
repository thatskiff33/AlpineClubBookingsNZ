import "server-only";
import { prisma } from "@/lib/prisma";
import { isBlockedDestinationHost } from "@/lib/private-destination-hosts";

/**
 * Non-secret Alpine Central Server (ServerNZ) connection settings — a singleton
 * row keyed on the fixed id "default" (mirrors LodgeSettings). The API key is
 * NOT here; it lives in the encrypted IntegrationCredential store (see
 * `servernz-config.ts`).
 */

export const SERVERNZ_SETTINGS_ID = "default";

export interface ServerNzSettingsValues {
  baseUrl: string | null;
  otherLodgesEnabled: boolean;
  otherLodgesLastUploadAt: string | null;
  otherLodgesLastDownloadAt: string | null;
  otherLodgesCursor: string | null;
}

const DEFAULTS: ServerNzSettingsValues = {
  baseUrl: null,
  otherLodgesEnabled: false,
  otherLodgesLastUploadAt: null,
  otherLodgesLastDownloadAt: null,
  otherLodgesCursor: null,
};

/**
 * Read the ServerNZ settings with safe defaults. A missing row or query failure
 * falls back to defaults so the setup page keeps rendering.
 */
export async function loadServerNzSettings(): Promise<ServerNzSettingsValues> {
  try {
    const row = await prisma.serverNzSettings.findUnique({
      where: { id: SERVERNZ_SETTINGS_ID },
    });
    if (!row) return { ...DEFAULTS };
    return {
      baseUrl: row.baseUrl,
      otherLodgesEnabled: row.otherLodgesEnabled,
      otherLodgesLastUploadAt: row.otherLodgesLastUploadAt?.toISOString() ?? null,
      otherLodgesLastDownloadAt:
        row.otherLodgesLastDownloadAt?.toISOString() ?? null,
      otherLodgesCursor: row.otherLodgesCursor,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

/** Normalise a base URL: trim, drop a trailing slash, or null when blank. */
export function normalizeBaseUrl(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return trimmed.replace(/\/+$/, "");
}

export interface BaseUrlValidation {
  ok: boolean;
  /** Present when `ok`; the normalised origin-and-path to store. */
  value?: string;
  /** Present when not `ok`; safe to show an admin. */
  reason?: string;
}

/**
 * Validate an operator-supplied central-server base URL.
 *
 * `https` is REQUIRED rather than preferred: `servernz-api.ts` sends the stored
 * API key as `Authorization: Bearer`, so permitting `http://` would put a
 * long-lived credential on the wire in cleartext on every sync.
 */
export function validateCentralServerBaseUrl(value: string): BaseUrlValidation {
  const trimmed = normalizeBaseUrl(value);
  if (!trimmed) return { ok: false, reason: "Enter the central server's base URL." };

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, reason: "That is not a valid URL." };
  }

  if (parsed.protocol !== "https:") {
    return {
      ok: false,
      reason:
        "The base URL must start with https:// — the API key is sent to it as a bearer token, so an http:// address would put it on the wire in cleartext.",
    };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, reason: "Remove the username or password from the URL." };
  }
  if (isBlockedDestinationHost(parsed.hostname)) {
    return {
      ok: false,
      reason:
        "That address is a private, loopback or link-local host. The central server must be a public address.",
    };
  }
  return { ok: true, value: normalizeBaseUrl(parsed.toString()) ?? trimmed };
}

/** Update the connection settings (base URL and/or the per-item enable flag). */
export async function updateServerNzSettings(input: {
  baseUrl?: string | null;
  otherLodgesEnabled?: boolean;
  updatedByMemberId: string;
}): Promise<ServerNzSettingsValues> {
  const data: {
    baseUrl?: string | null;
    otherLodgesEnabled?: boolean;
    updatedByMemberId: string;
  } = { updatedByMemberId: input.updatedByMemberId };
  if (input.baseUrl !== undefined) data.baseUrl = normalizeBaseUrl(input.baseUrl);
  if (input.otherLodgesEnabled !== undefined)
    data.otherLodgesEnabled = input.otherLodgesEnabled;

  await prisma.serverNzSettings.upsert({
    where: { id: SERVERNZ_SETTINGS_ID },
    create: { id: SERVERNZ_SETTINGS_ID, ...data },
    update: data,
  });
  return loadServerNzSettings();
}

/**
 * Record a successful upload of the Other Clubs registry.
 *
 * `otherLodgesLastUploadAt` doubles as the incremental-upload watermark: the
 * next upload only sends local rows whose `updatedAt` is newer than this. Pass
 * the newest `updatedAt` among the rows just uploaded so the watermark advances
 * on the same clock as the rows themselves (both DB-generated). Falls back to
 * `now()` when no explicit watermark is given.
 */
export async function recordOtherLodgesUpload(at: Date = new Date()): Promise<void> {
  await prisma.serverNzSettings.upsert({
    where: { id: SERVERNZ_SETTINGS_ID },
    create: {
      id: SERVERNZ_SETTINGS_ID,
      otherLodgesLastUploadAt: at,
    },
    update: { otherLodgesLastUploadAt: at },
  });
}

/**
 * Record a successful download, persisting the incremental cursor.
 *
 * WHAT BELONGS IN `cursor` IS THE SERVER'S OWN WATERMARK, and never the value the
 * caller asked WITH. The Other Clubs pull deliberately requests a bounded window
 * before the stored cursor to cover commit-order races (#2995), so "what we
 * asked for" and "how far the server says we have got" are two different values
 * and only the second may be stored. Storing the request value would turn a
 * one-minute re-ask into a watermark that slides backwards a minute per run.
 *
 * IT MUST ALSO NEVER MOVE BACKWARDS. A server that echoes `since` when a page is
 * empty hands the overlapped request value straight back as its answer, so
 * persisting the response uncritically has the same effect by a different route.
 * `advancedDownloadCursor` in `servernz-other-lodges-sync.ts` is where that
 * comparison is made — it holds both the stored and the returned value, which
 * this writer does not — and it is the reason nothing here needs to re-read the
 * row. Do not "tidy up" either rule by storing whatever the caller had in hand.
 */
export async function recordOtherLodgesDownload(cursor: string | null): Promise<void> {
  await prisma.serverNzSettings.upsert({
    where: { id: SERVERNZ_SETTINGS_ID },
    create: {
      id: SERVERNZ_SETTINGS_ID,
      otherLodgesLastDownloadAt: new Date(),
      otherLodgesCursor: cursor,
    },
    update: {
      otherLodgesLastDownloadAt: new Date(),
      ...(cursor ? { otherLodgesCursor: cursor } : {}),
    },
  });
}
