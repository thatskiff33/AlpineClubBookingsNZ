import "server-only";
import { Prisma } from "@prisma/client";
import { ownedCentralLodgesSchema, type OwnedCentralLodge } from "@/lib/other-lodges";
import { prisma } from "@/lib/prisma";
import { isBlockedDestinationHost } from "@/lib/private-destination-hosts";

/**
 * Non-secret Alpine Central Server (ServerNZ) connection settings — a singleton
 * row keyed on the fixed id "default" (mirrors LodgeSettings). The API key is
 * NOT here; it lives in the encrypted IntegrationCredential store (see
 * `servernz-config.ts`).
 */

export const SERVERNZ_SETTINGS_ID = "default";

/** Bounded settings-row contention, including a lodge merge holding the row. */
export const SERVERNZ_TRANSACTION_OPTIONS = { timeout: 150_000, maxWait: 10_000 };

declare const SERVERNZ_CONNECTION_FENCE: unique symbol;

/**
 * A transaction client that holds the connection fence (#4436): the settings
 * row is locked and credential caches are invalidated when it ends. Only
 * `withServerNzConnectionTransaction` (`servernz-config.ts`) mints one. The
 * writers that change a connection require it, so a call on the global
 * client, or on a transaction that never took the fence, does not compile.
 */
export type ServerNzConnectionTx = Prisma.TransactionClient & {
  readonly [SERVERNZ_CONNECTION_FENCE]: true;
};

declare const SERVERNZ_ANSWER_FENCE: unique symbol;

/**
 * A transaction client that holds the ANSWER fence (#4366, #4470): the settings
 * row is locked and the stored address and API-key version were re-read under
 * it and found to be the ones a request was sent on. Only
 * `withCurrentServerNzConnection` (`servernz-version-record.ts`) mints one,
 * after that check. The writers that record a central-server answer require
 * it, so an answer recorded on the global client, or on a transaction that
 * never compared the connection, does not compile, and one from a connection
 * replaced in flight is dropped by the fence before it can run.
 */
export type ServerNzAnswerTx = Prisma.TransactionClient & {
  readonly [SERVERNZ_ANSWER_FENCE]: true;
};

export interface ServerNzSettingsValues {
  baseUrl: string | null;
  otherLodgesEnabled: boolean;
  otherLodgesLastUploadAt: string | null;
  otherLodgesLastDownloadAt: string | null;
  otherLodgesCursor: string | null;
  /**
   * The lodges the central server says this club owns (#52), with their
   * permanent central ids (#62), which is how every "is this ours?" check
   * matches them (#69, `ownsOtherLodge` in `@/lib/other-lodges`): `null` until
   * a download has recorded the list, or when the stored value does not parse
   * (read-only, like never-told), `[]` when the server said none.
   */
  otherLodgesOwnedLodges: OwnedCentralLodge[] | null;
  /**
   * True when the column HOLDS a value that does not parse as the owned list.
   * `otherLodgesOwnedLodges` is then `null` — read-only everywhere, like
   * never-told. The upload sends nothing and the committee sync writes nothing
   * on `null` either way (fail closed). A column that was written and is now
   * unreadable is a defect, not a fresh install.
   */
  otherLodgesOwnedLodgesUnreadable: boolean;
  /**
   * When a whole-registry download last merged to the end (#64), or `null`:
   * until it is set every download asks for the whole registry, so each Other
   * lodges row is matched once and keyed by its central id, and only after it
   * is a row still unkeyed marked as one the server does not list.
   */
  otherLodgesKeyedAt: string | null;
  /**
   * The central server's API version as it last reported it (#49): `null`
   * until asked, `"unknown"` when the server answered 404 (it predates
   * versioning, a mismatch), otherwise a canonical `major.minor`. The mismatch
   * is computed from this and `SERVERNZ_EXPECTED_SERVER_VERSION`, never stored.
   */
  serverVersion: string | null;
  serverVersionCheckedAt: string | null;
}

const DEFAULTS: ServerNzSettingsValues = {
  baseUrl: null,
  otherLodgesEnabled: false,
  otherLodgesLastUploadAt: null,
  otherLodgesLastDownloadAt: null,
  otherLodgesCursor: null,
  otherLodgesOwnedLodges: null,
  otherLodgesOwnedLodgesUnreadable: false,
  otherLodgesKeyedAt: null,
  serverVersion: null,
  serverVersionCheckedAt: null,
};

/** The stored owned list as read back: its three states, plus "present but unreadable". */
export interface StoredOwnedOtherLodges {
  lodges: OwnedCentralLodge[] | null;
  unreadable: boolean;
}

/**
 * The stored owned list, read back through the same schema it was validated
 * with on the way in. A value that does not parse reads as UNKNOWN
 * (`lodges: null`) so that nothing treats junk as a lodge or as "owns
 * nothing". It is also flagged `unreadable` to distinguish corrupt data from
 * ownership not yet recorded. Upload and committee sync both fail closed on
 * `null`. Exported so the committee sync, which runs inside a caller's
 * transaction and cannot use `loadServerNzSettings`, reads the column through
 * the same rule.
 */
export function readOwnedOtherLodges(stored: unknown): StoredOwnedOtherLodges {
  if (stored === null || stored === undefined) return { lodges: null, unreadable: false };
  const parsed = ownedCentralLodgesSchema.safeParse(stored);
  return parsed.success
    ? { lodges: parsed.data, unreadable: false }
    : { lodges: null, unreadable: true };
}

/**
 * The stored owned list read through `db` — a transaction client or the global
 * one — for a writer that runs inside somebody else's transaction. Same rule as
 * `loadServerNzSettings`; a missing row is "never told".
 */
export async function loadOwnedOtherLodges(
  db: Pick<Prisma.TransactionClient, "serverNzSettings">,
): Promise<StoredOwnedOtherLodges> {
  const row = await db.serverNzSettings.findUnique({
    where: { id: SERVERNZ_SETTINGS_ID },
    select: { otherLodgesOwnedLodges: true },
  });
  return readOwnedOtherLodges(row?.otherLodgesOwnedLodges);
}

/**
 * Lock the settings row for the caller's transaction (#4366, #4436).
 * Request capture, connection replacement and version recording share this
 * fence. Each reads mutable connection state only after locking, and takes
 * credential rows afterwards. No advisory key or provider call is involved.
 * The connection transaction materialises the singleton before locking it;
 * the recorder can safely decline an answer when the row is absent.
 * Every answer writer goes through the one fence built on it,
 * `withCurrentServerNzConnection` / `serverNzAnswerWriter`
 * (`servernz-version-record.ts`): the version recorder and every write of the
 * Other lodges download and upload watermark (#4485). The Central lodge link
 * writer takes it before its `Lodge` row to re-check the owned list.
 */
export async function lockServerNzSettings(
  db: Pick<Prisma.TransactionClient, "$executeRaw">,
): Promise<void> {
  await db.$executeRaw`SELECT 1 FROM "ServerNzSettings" WHERE "id" = ${SERVERNZ_SETTINGS_ID} FOR UPDATE`;
}

/**
 * Read the ServerNZ settings with safe defaults. A missing row or query failure
 * falls back to defaults so the setup page keeps rendering.
 */
export async function loadServerNzSettings(
  db: Pick<Prisma.TransactionClient, "serverNzSettings"> = prisma,
): Promise<ServerNzSettingsValues> {
  try {
    const row = await db.serverNzSettings.findUnique({
      where: { id: SERVERNZ_SETTINGS_ID },
    });
    if (!row) return { ...DEFAULTS };
    const owned = readOwnedOtherLodges(row.otherLodgesOwnedLodges);
    return {
      baseUrl: row.baseUrl,
      otherLodgesEnabled: row.otherLodgesEnabled,
      otherLodgesLastUploadAt: row.otherLodgesLastUploadAt?.toISOString() ?? null,
      otherLodgesLastDownloadAt:
        row.otherLodgesLastDownloadAt?.toISOString() ?? null,
      otherLodgesCursor: row.otherLodgesCursor,
      otherLodgesOwnedLodges: owned.lodges,
      otherLodgesOwnedLodgesUnreadable: owned.unreadable,
      otherLodgesKeyedAt: row.otherLodgesKeyedAt?.toISOString() ?? null,
      serverVersion: row.serverVersion,
      serverVersionCheckedAt: row.serverVersionCheckedAt?.toISOString() ?? null,
    };
  } catch (error) {
    // A fenced operational read must fail rather than hide a database failure.
    if (db !== prisma) throw error;
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

/**
 * Update the connection settings (base URL and/or the per-item enable flag).
 * `db` is a fenced client (#4436): the one caller is
 * `saveServerNzConnectionSettings`, whose transaction moves the address and
 * removes its key together.
 */
export async function updateServerNzSettings(input: {
  baseUrl?: string | null;
  otherLodgesEnabled?: boolean;
  updatedByMemberId: string;
}, db: ServerNzConnectionTx): Promise<ServerNzSettingsValues> {
  const data: {
    baseUrl?: string | null;
    otherLodgesEnabled?: boolean;
    updatedByMemberId: string;
  } = { updatedByMemberId: input.updatedByMemberId };
  if (input.baseUrl !== undefined) data.baseUrl = normalizeBaseUrl(input.baseUrl);
  if (input.otherLodgesEnabled !== undefined)
    data.otherLodgesEnabled = input.otherLodgesEnabled;

  await db.serverNzSettings.upsert({
    where: { id: SERVERNZ_SETTINGS_ID },
    create: { id: SERVERNZ_SETTINGS_ID, ...data },
    update: data,
  });
  return loadServerNzSettings(db);
}

/**
 * Record a successful upload of the Other Clubs registry.
 *
 * `otherLodgesLastUploadAt` doubles as the incremental-upload watermark: the
 * next upload only sends local rows whose `updatedAt` is newer than this. Pass
 * the newest `updatedAt` among the rows just uploaded so the watermark advances
 * on the same clock as the rows themselves (both DB-generated). `db` is the
 * upload response's fenced transaction (`serverNzAnswerWriter`), by type.
 */
export async function recordOtherLodgesUpload(
  at: Date,
  db: ServerNzAnswerTx,
): Promise<void> {
  await db.serverNzSettings.upsert({
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
 * `ownLodges` (#52, #62) is the owned list the pull carried, recorded ONLY when
 * the server sent a valid one: `undefined` means it did not, and the stored
 * list — and its timestamp — are left exactly as they were. An EMPTY array is
 * a real answer ("you own nothing") and IS stored.
 */
export async function recordOtherLodgesDownload(
  cursor: string | null,
  ownLodges: OwnedCentralLodge[] | undefined,
  options: {
    /** This download asked for the whole registry and merged all of it (#64). */
    keyed?: boolean;
    /**
     * REQUIRED (#4262 review; by type since #4470): the download's fenced
     * transaction client (`serverNzAnswerWriter` for the identity its pull was
     * sent on). There is no default, and the global client or any other
     * transaction is not a `ServerNzAnswerTx`, so a record outside the
     * settings-row fence does not compile. The fence drops the record when the
     * connection the pull captured is no longer the stored one: an address
     * move or key change while the download ran leaves the reset standing.
     */
    db: ServerNzAnswerTx;
  },
): Promise<void> {
  const { db } = options;
  const now = new Date();
  // Written only when the server sent a valid list: absent leaves the stored
  // one alone. `otherLodgesOwnedNamesAt` (named for the list it first timed)
  // records when. The name-only list of API 2.4 and earlier
  // (`otherLodgesOwnedNames`) is no longer read here (#69) and is LEFT AS IT
  // WAS: the draining colour of a blue/green deploy still reads it, and
  // clearing it would read there as "never told" (every edit refused, and the
  // committee sync falling back to matching lodges by building name).
  const owned = {
    ...(ownLodges === undefined
      ? {}
      : { otherLodgesOwnedLodges: ownLodges, otherLodgesOwnedNamesAt: now }),
    ...(options.keyed ? { otherLodgesKeyedAt: now } : {}),
  };
  await db.serverNzSettings.upsert({
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
 * "never told", which makes the panel read-only and stops the upload (#69)
 * until the next download records a fresh answer. Called when the
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
      // The ids belong to the same connection's answer (#62).
      otherLodgesOwnedLodges: Prisma.DbNull,
    },
  });
}

/**
 * Record what the central server said its API version is (#49): a canonical
 * `major.minor`, or `SERVER_VERSION_UNKNOWN` when it answered 404. Written
 * AFTER the HTTP call has completed, only through `recordServerVersionIfCurrent`
 * (`servernz-version-record.ts`), whose short transaction passes `db` - there
 * is no default client, and `servernz-settings.test.ts` pins that one caller
 * (#4366). A failed call
 * never reaches here - the previous answer stays, so a network blip cannot
 * pause syncing (`INV-INT-027`). Bounded to the column's VarChar(16) by the
 * caller's schema, which caps the wire value at 16 characters.
 */
export async function recordServerVersionCheck(
  version: string,
  at: Date,
  db: ServerNzAnswerTx,
): Promise<void> {
  await db.serverNzSettings.upsert({
    where: { id: SERVERNZ_SETTINGS_ID },
    create: {
      id: SERVERNZ_SETTINGS_ID,
      serverVersion: version,
      serverVersionCheckedAt: at,
    },
    update: { serverVersion: version, serverVersionCheckedAt: at },
  });
}

/**
 * Forget the server's last reported version (#49): back to "never asked".
 * Called wherever the owned-lodge list is forgotten - the API key is removed
 * or replaced, or the server address moves - because the answer belonged to
 * that connection, and a different server may be on a different version. The
 * next server-bound request, or the next nightly sync, asks again.
 */
export async function clearServerVersionCheck(): Promise<void> {
  await prisma.serverNzSettings.upsert({
    where: { id: SERVERNZ_SETTINGS_ID },
    create: { id: SERVERNZ_SETTINGS_ID },
    update: { serverVersion: null, serverVersionCheckedAt: null },
  });
}

/**
 * Forget everything the central server told this connection, in ONE write:
 * the owned-lodge list (#52), transfer cursors and last reported version (#49).
 * Called when the connection ends - the key is removed or replaced, or the
 * address moves - because all answers and sync positions belonged to it. One
 * upsert rather than separate writes, so a crash between them cannot
 * leave the row half-forgotten: a stale version pausing a new connection, or a
 * stale owned list editable under a new key. `db` is a fenced client (#4436):
 * the connection change it belongs to runs in
 * `withServerNzConnectionTransaction`, so the forget commits with the key or
 * address write, never on its own.
 */
export async function forgetServerConnectionAnswers(
  db: ServerNzConnectionTx,
): Promise<void> {
  await db.serverNzSettings.upsert({
    where: { id: SERVERNZ_SETTINGS_ID },
    create: { id: SERVERNZ_SETTINGS_ID },
    update: {
      otherLodgesOwnedNames: Prisma.DbNull,
      otherLodgesOwnedNamesAt: null,
      // The owned ids are the same connection's answer (#62).
      otherLodgesOwnedLodges: Prisma.DbNull,
      // Neither transfer may resume from the previous connection's position.
      otherLodgesLastUploadAt: null,
      otherLodgesLastDownloadAt: null,
      otherLodgesCursor: null,
      commsCursorSince: null,
      commsCursorSinceId: null,
      commsLastSyncAt: null,
      commsPoisonChangeId: null,
      commsPoisonCount: 0,
      // A new connection keys the registry again with a whole download (#64).
      otherLodgesKeyedAt: null,
      serverVersion: null,
      serverVersionCheckedAt: null,
    },
  });
}

