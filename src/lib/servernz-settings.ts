import "server-only";
import { Prisma } from "@prisma/client";
import {
  ownedOtherLodgeNamesSchema,
  type OwnedOtherLodgeNames,
} from "@/lib/other-lodges";
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
  /**
   * The lodges the central server says this club owns (#52): `null` until a
   * download from a server that sends the list has recorded it, `[]` when the
   * server said the club owns none. See `ownsOtherLodge` in `@/lib/other-lodges`.
   */
  otherLodgesOwnedNames: OwnedOtherLodgeNames;
  otherLodgesOwnedNamesAt: string | null;
  /**
   * True when the column HOLDS a value that does not parse as a list of lodge
   * names. `otherLodgesOwnedNames` is then `null` — read-only everywhere, like
   * never-told — but the upload and the committee sync, which would otherwise
   * fall back to their pre-#52 "send/write every row" behaviour on `null`,
   * read this flag and send or write NOTHING instead (fail closed): a column
   * that was written and is now unreadable is a defect, not a fresh install.
   */
  otherLodgesOwnedNamesUnreadable: boolean;
}

const DEFAULTS: ServerNzSettingsValues = {
  baseUrl: null,
  otherLodgesEnabled: false,
  otherLodgesLastUploadAt: null,
  otherLodgesLastDownloadAt: null,
  otherLodgesCursor: null,
  otherLodgesOwnedNames: null,
  otherLodgesOwnedNamesAt: null,
  otherLodgesOwnedNamesUnreadable: false,
};

/** The stored owned list as read back: its three states, plus "present but unreadable". */
export interface StoredOwnedOtherLodgeNames {
  names: OwnedOtherLodgeNames;
  unreadable: boolean;
}

/**
 * The stored owned list, read back through the same schema it was validated
 * with on the way in. A value that does not parse — anything but a bounded
 * array of lodge names — reads as UNKNOWN (`names: null`) so that nothing
 * treats junk as a lodge name or as "owns nothing", AND is flagged
 * `unreadable` so the writers that have a permissive fallback on `null` (the
 * upload, the committee officer sync) can fail closed instead. Exported so the
 * committee sync, which runs inside a caller's transaction and cannot use
 * `loadServerNzSettings`, reads the column through the same rule.
 */
export function readOwnedOtherLodgeNames(stored: unknown): StoredOwnedOtherLodgeNames {
  if (stored === null || stored === undefined) return { names: null, unreadable: false };
  const parsed = ownedOtherLodgeNamesSchema.safeParse(stored);
  return parsed.success
    ? { names: parsed.data, unreadable: false }
    : { names: null, unreadable: true };
}

/**
 * The stored owned list read through `db` — a transaction client or the global
 * one — for a writer that runs inside somebody else's transaction. Same rule as
 * `loadServerNzSettings`; a missing row is "never told".
 */
export async function loadOwnedOtherLodgeNames(
  db: Pick<Prisma.TransactionClient, "serverNzSettings">,
): Promise<StoredOwnedOtherLodgeNames> {
  const row = await db.serverNzSettings.findUnique({
    where: { id: SERVERNZ_SETTINGS_ID },
    select: { otherLodgesOwnedNames: true },
  });
  return readOwnedOtherLodgeNames(row?.otherLodgesOwnedNames);
}

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
    const owned = readOwnedOtherLodgeNames(row.otherLodgesOwnedNames);
    return {
      baseUrl: row.baseUrl,
      otherLodgesEnabled: row.otherLodgesEnabled,
      otherLodgesLastUploadAt: row.otherLodgesLastUploadAt?.toISOString() ?? null,
      otherLodgesLastDownloadAt:
        row.otherLodgesLastDownloadAt?.toISOString() ?? null,
      otherLodgesCursor: row.otherLodgesCursor,
      otherLodgesOwnedNames: owned.names,
      otherLodgesOwnedNamesAt: row.otherLodgesOwnedNamesAt?.toISOString() ?? null,
      otherLodgesOwnedNamesUnreadable: owned.unreadable,
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
 * `advancedDownloadCursor` in `servernz-cursor-overlap.ts` is where that
 * comparison is made — it holds both the stored and the returned value, which
 * this writer does not — and it is the reason nothing here needs to re-read the
 * row. Do not "tidy up" either rule by storing whatever the caller had in hand.
 *
 * `ownLodgeNames` (#52) is the owned list the pull carried, recorded ONLY when
 * the server sent one: `undefined` means it did not (an older server) and the
 * stored list — and its timestamp — are left exactly as they were. An EMPTY
 * array is a real answer ("you own nothing") and IS stored.
 */
export async function recordOtherLodgesDownload(
  cursor: string | null,
  ownLodgeNames?: string[],
): Promise<void> {
  const now = new Date();
  const owned =
    ownLodgeNames === undefined
      ? {}
      : { otherLodgesOwnedNames: ownLodgeNames, otherLodgesOwnedNamesAt: now };
  await prisma.serverNzSettings.upsert({
    where: { id: SERVERNZ_SETTINGS_ID },
    create: {
      id: SERVERNZ_SETTINGS_ID,
      otherLodgesLastDownloadAt: now,
      otherLodgesCursor: cursor,
      ...owned,
    },
    update: {
      otherLodgesLastDownloadAt: now,
      ...(cursor ? { otherLodgesCursor: cursor } : {}),
      ...owned,
    },
  });
}

/**
 * Forget which lodges the central server said this club owns (#52): back to
 * "never told", which makes the panel read-only and the upload permissive
 * again until the next download records a fresh answer. Called when the
 * connection the list was issued for ends — the API key is removed or
 * replaced, or the server address moves (which removes the key) — because the
 * list is the OLD connection's answer and a different key or server may own
 * different lodges. `Prisma.DbNull` is the database NULL the loader reads as
 * "never told"; a JSON `null` would be a present-but-unreadable value.
 */
export async function clearOtherLodgesOwnedNames(): Promise<void> {
  await prisma.serverNzSettings.upsert({
    where: { id: SERVERNZ_SETTINGS_ID },
    create: { id: SERVERNZ_SETTINGS_ID },
    update: {
      otherLodgesOwnedNames: Prisma.DbNull,
      otherLodgesOwnedNamesAt: null,
    },
  });
}
