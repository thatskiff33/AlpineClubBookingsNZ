import "server-only";
import { ownedOtherLodgeNamesSchema } from "@/lib/other-lodges";
import logger from "@/lib/logger";
import {
  MAX_SERVER_VERSION_CHARS,
  distributedLodgeSchema,
  pullEnvelopeSchema,
  pushTargetResultSchema,
  sharedPostResultSchema,
  syncEnvelopeSchema,
  uploadResultSchema,
  versionResultSchema,
  type OtherLodgeUploadItem,
  type OtherLodgesPullResult,
  type OtherLodgesUploadResult,
  type PushTargetResult,
  type SharedPostImage,
  type SharedPostResult,
  type SyncEnvelope,
  type SyncPost,
} from "@/lib/servernz-api-schemas";
// The wire shapes are declared beside this client; callers keep importing the
// result types from here, the module whose functions produce them.
export type {
  OtherLodgeUploadItem,
  OtherLodgesPullResult,
  OtherLodgesUploadResult,
  PushTargetResult,
  SharedPostImage,
  SharedPostResult,
  SyncEnvelope,
  SyncPost,
};
import {
  SERVERNZ_EXPECTED_SERVER_VERSION,
  SERVER_VERSION_UNKNOWN,
  describeServerVersionPause,
  isStoredServerVersionMismatch,
  storableServerVersion,
} from "@/lib/servernz-api-version";
import { getOperationalServerNzApiKey } from "@/lib/servernz-config";
import {
  loadServerNzSettings,
  recordServerVersionCheck,
  validateCentralServerBaseUrl,
} from "@/lib/servernz-settings";

/**
 * Outbound client for the Alpine Central Server (ServerNZ) REST API. Mirrors the
 * addy-api.ts pattern: native fetch, Bearer auth, Zod-validated responses, and
 * an explicit request timeout (fetch has none by default).
 *
 * The API key is resolved from the encrypted credential store and the base URL
 * from ServerNzSettings — neither is ever logged.
 */

const REQUEST_TIMEOUT_MS = 10_000;

export class ServerNzNotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ServerNzNotConfiguredError";
  }
}

export class ServerNzApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ServerNzApiError";
    this.status = status;
  }
}

/**
 * The central server is on a different API version from the one this site was
 * built for, so nothing is transferred (#49, `INV-INT-027`). Thrown by
 * `resolveConnection` BEFORE any request is built, so no caller can reach the
 * server past it. Carries only the two numbers - never the key or the URL.
 */
export class ServerNzVersionMismatchError extends Error {
  /** The version this site speaks. */
  expected: string;
  /** The server's last reported version, or "unknown" for a server that predates versioning. */
  serverVersion: string;
  constructor(expected: string, serverVersion: string) {
    super(describeServerVersionPause(expected, serverVersion));
    this.name = "ServerNzVersionMismatchError";
    this.expected = expected;
    this.serverVersion = serverVersion;
  }
}

/**
 * The connection every request is built from, and THE ONE PLACE the version
 * gate lives (#49, `INV-INT-027`). Every server-bound function in this module
 * calls it, so a caller cannot reach the server past the gate; the only opt-out
 * is `skipVersionGate`, used by `fetchServerVersion` alone, because the version
 * call is how a paused site finds out it may resume.
 *
 * Gate order: base URL, key, URL shape (all unchanged), THEN the stored server
 * version. A stored answer that differs from `SERVERNZ_EXPECTED_SERVER_VERSION`
 * throws `ServerNzVersionMismatchError`; a stored `null` (never asked) runs one
 * inline check first so a deployment that upgraded before its nightly sync, or a
 * key saved a moment ago, learns the answer on its first request rather than
 * syncing blind until 03:00. A check that FAILS leaves the row `null` and lets
 * the request through: a failed check never pauses syncing.
 */
async function resolveConnection(
  options: { skipVersionGate?: boolean } = {},
): Promise<{ baseUrl: string; apiKey: string }> {
  const [apiKey, settings] = await Promise.all([
    getOperationalServerNzApiKey(),
    loadServerNzSettings(),
  ]);
  if (!settings.baseUrl) {
    throw new ServerNzNotConfiguredError(
      "The Alpine Central Server base URL is not set.",
    );
  }
  if (!apiKey) {
    throw new ServerNzNotConfiguredError(
      "No Alpine Central Server API key is stored.",
    );
  }
  // Re-checked at REQUEST time, not only where an admin types it. The stored
  // value predates this guard on any deployment that configured the server
  // earlier, and a validator that only runs on the write path leaves those rows
  // sending a bearer token wherever they already point.
  const check = validateCentralServerBaseUrl(settings.baseUrl);
  if (!check.ok) {
    throw new ServerNzNotConfiguredError(
      `The stored Alpine Central Server base URL is not usable: ${check.reason}`,
    );
  }
  const connection = { baseUrl: check.value as string, apiKey };
  if (options.skipVersionGate) return connection;

  let stored = settings.serverVersion;
  if (stored === null) {
    // Self-heal: ask once, inline. `refreshStoredServerVersion` returns null
    // for a call that FAILED, which allows the request (default 1); a record
    // that fails after a received answer throws, like any other database
    // failure on a server-bound path.
    stored = await refreshStoredServerVersion(connection);
  }
  if (isStoredServerVersionMismatch(stored)) {
    throw new ServerNzVersionMismatchError(
      SERVERNZ_EXPECTED_SERVER_VERSION,
      stored as string,
    );
  }
  return connection;
}

/**
 * Every request names the version this site speaks, so the server can refuse
 * a transfer on its side too (409 `API_VERSION_MISMATCH`) and list the club on
 * its Issues screen. The header is the server's documented name.
 */
const CLIENT_API_VERSION_HEADER = "X-Client-Api-Version";

function authHeaders(apiKey: string): HeadersInit {
  return {
    "Content-Type": "application/json",
    Accept: "application/json",
    Authorization: `Bearer ${apiKey}`,
    [CLIENT_API_VERSION_HEADER]: SERVERNZ_EXPECTED_SERVER_VERSION,
  };
}

/**
 * Ask the central server its API version (#49).
 *
 * `GET /api/v1/version` always answers 200 with the server's number, even when
 * the two differ - a 409 here would hide the very thing this asks for. A 404
 * means the server predates versioning and is reported as
 * `SERVER_VERSION_UNKNOWN`, which counts as a mismatch. Any other failure
 * throws, and the CALLER decides what a failed check means (it keeps the
 * stored answer; it never pauses syncing). The version gate is skipped here and
 * nowhere else: this is the call that tells a paused site it may resume.
 */
export async function fetchServerVersion(connection?: {
  baseUrl: string;
  apiKey: string;
}): Promise<string> {
  const { baseUrl, apiKey } =
    connection ?? (await resolveConnection({ skipVersionGate: true }));
  const res = await fetch(`${baseUrl}/api/v1/version`, {
    method: "GET",
    cache: "no-store",
    headers: authHeaders(apiKey),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (res.status === 404) return SERVER_VERSION_UNKNOWN;
  if (!res.ok) await refuse(res, apiKey);
  // Malformed or over-long on the wire reads as the unknown marker: still an
  // ANSWER (and a mismatch), never a failed check.
  return storableServerVersion(versionResultSchema.parse(await res.json()).version);
}

/**
 * THE ONE PATH THAT WRITES THE VERSION COLUMN (#49 review items 3 and 4): the
 * answer is normalised (`storableServerVersion`) and recorded only if the API
 * key it was obtained with is STILL the stored key. A key saved while the call
 * was in flight has already forgotten the old connection's answers, and the
 * old server's late answer must not be written over that - it would pause, or
 * clear a pause on, a connection it never described. Returns what was
 * recorded, or null when the answer was dropped for that reason. A record that
 * fails throws: a RECEIVED mismatch must never read as "could not check".
 */
async function recordServerAnswer(
  raw: string,
  apiKeyUsed: string,
): Promise<string | null> {
  const version = storableServerVersion(raw);
  const currentKey = await getOperationalServerNzApiKey();
  if (currentKey !== apiKeyUsed) {
    logger.info(
      { expected: SERVERNZ_EXPECTED_SERVER_VERSION, serverVersion: version },
      "Dropped a late Alpine Central Server version answer: the API key changed while it was in flight",
    );
    return null;
  }
  await recordServerVersionCheck(version);
  if (version !== SERVERNZ_EXPECTED_SERVER_VERSION) {
    logger.info(
      { expected: SERVERNZ_EXPECTED_SERVER_VERSION, serverVersion: version },
      "Alpine Central Server reports a different API version; syncing is paused",
    );
  }
  return version;
}

/**
 * Fetch the server's version and record it, returning what was recorded - or
 * `null` when the call failed or the answer arrived late (see above), in which
 * case NOTHING is recorded and the stored answer stands. Shared by the gate's
 * self-heal above and by `checkServerVersion` in `servernz-version-check.ts`.
 * Only the FETCH is guarded: a received answer that cannot be recorded throws.
 * `ServerNzNotConfiguredError` is rethrown quietly, without the warning - a key
 * with no usable address is a configuration state the caller names, not a
 * failed check to warn about on every pass. Logs only the two numbers
 * (`INV-INT-005`).
 */
export async function refreshStoredServerVersion(connection?: {
  baseUrl: string;
  apiKey: string;
}): Promise<string | null> {
  const resolved =
    connection ?? (await resolveConnection({ skipVersionGate: true }));
  let version: string;
  try {
    version = await fetchServerVersion(resolved);
  } catch (error) {
    if (error instanceof ServerNzVersionMismatchError) {
      // `refuse` already recorded the server's 409 answer.
      return error.serverVersion;
    }
    logger.warn(
      { err: error, expected: SERVERNZ_EXPECTED_SERVER_VERSION },
      "Could not check the Alpine Central Server API version; keeping the last known answer",
    );
    return null;
  }
  return recordServerAnswer(version, resolved.apiKey);
}

/**
 * Sharing carries image bytes, so it gets its own, longer ceiling: the ordinary
 * timeout is sized for small JSON calls and would abort a legitimate upload.
 */
const SHARE_TIMEOUT_MS = 60_000;

/** Longest remote-supplied error text we will carry into a message or audit row. */
const MAX_REMOTE_ERROR_CHARS = 200;

/** The server's refusal code for a request whose declared version differs from its own. */
const SERVER_API_VERSION_MISMATCH_CODE = "API_VERSION_MISMATCH";

/**
 * The server's own error text, bounded and stripped of control characters.
 *
 * This string travels: `respondToSyncError` writes it into the audit `details`
 * column and shows it in the admin UI. `sanitizeAuditDetails` catches `key=value`
 * shapes, card numbers and long HTML, but a bare token echoed back by a remote
 * server matches none of those — so the honest fix is to stop treating the
 * remote's text as free-form. Bounded here, at the one place it enters.
 */
function remoteErrorMessage(status: number, body: { error?: unknown }): string {
  const fallback = `Request failed (${status})`;
  if (typeof body.error !== "string" || !body.error.trim()) return fallback;
  const cleaned = body.error
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_REMOTE_ERROR_CHARS);
  return cleaned || fallback;
}

/**
 * THE ONE WAY A FAILED RESPONSE BECOMES AN ERROR (#49 review item 1). The body
 * is parsed once. A 409 carrying the server's `API_VERSION_MISMATCH` code is
 * the server refusing the transfer for version - the same fact the local gate
 * refuses for - so it RECORDS the server's number (through the one write path,
 * with the same key-change guard) and throws `ServerNzVersionMismatchError`,
 * which every caller already maps to its paused path. It used to surface as a
 * plain 4xx `ServerNzApiError`, which `shareOnePost` reads as a refusal that
 * will never change and retires the share for good. Every other failure is
 * the `ServerNzApiError` it always was.
 */
async function refuse(res: Response, apiKeyUsed: string): Promise<never> {
  let body: { error?: unknown; code?: unknown; serverVersion?: unknown } = {};
  try {
    body = (await res.json()) ?? {};
  } catch {
    // No JSON body: the status is the whole message.
  }
  if (
    res.status === 409 &&
    body.code === SERVER_API_VERSION_MISMATCH_CODE &&
    typeof body.serverVersion === "string" &&
    body.serverVersion.length <= MAX_SERVER_VERSION_CHARS
  ) {
    const stored = await recordServerAnswer(body.serverVersion, apiKeyUsed);
    throw new ServerNzVersionMismatchError(
      SERVERNZ_EXPECTED_SERVER_VERSION,
      stored ?? storableServerVersion(body.serverVersion),
    );
  }
  throw new ServerNzApiError(res.status, remoteErrorMessage(res.status, body));
}

/**
 * Headers for a multipart request.
 *
 * Content-Type is deliberately ABSENT: `fetch` sets it from the FormData
 * together with the boundary, and setting it by hand produces a body the
 * server cannot parse because the boundary does not match.
 */
function multipartAuthHeaders(apiKey: string): HeadersInit {
  return {
    Accept: "application/json",
    Authorization: `Bearer ${apiKey}`,
    [CLIENT_API_VERSION_HEADER]: SERVERNZ_EXPECTED_SERVER_VERSION,
  };
}

/**
 * Share one board post with the network.
 *
 * The images are sent in the same ORDER as `image_ids`, which is the contract
 * the server uses to rewrite the body's image URLs onto its own copies. Send
 * them out of order and every picture in the post ends up attached to the
 * wrong paragraph.
 *
 * Author identity is whatever the caller passes, and the server cannot verify
 * any of it — it trusts this club's API key. That is exactly why the route
 * that calls this takes the author from the session and never from the
 * request body.
 */
export async function shareClubPost(input: {
  authorUserId: string;
  authorName: string;
  content: string;
  bodyHtml: string | null;
  images: SharedPostImage[];
}): Promise<SharedPostResult> {
  const { baseUrl, apiKey } = await resolveConnection();

  const form = new FormData();
  form.append("author_user_id", input.authorUserId);
  form.append("author_name", input.authorName);
  // authorEmail is deliberately NOT sent. The server holds it only for
  // moderation and never serialises it, but a club that does not need to send
  // a member's address should not send one.
  form.append("content", input.content);
  if (input.bodyHtml) form.append("body_html", input.bodyHtml);
  if (input.images.length > 0) {
    form.append("image_ids", input.images.map((i) => i.publicId).join(","));
    for (const image of input.images) {
      form.append(
        "images",
        new Blob([new Uint8Array(image.bytes)], { type: image.mimeType }),
        `${image.publicId}.webp`,
      );
    }
  }

  const res = await fetch(`${baseUrl}/api/v1/posts`, {
    method: "POST",
    cache: "no-store",
    headers: multipartAuthHeaders(apiKey),
    body: form,
    signal: AbortSignal.timeout(SHARE_TIMEOUT_MS),
  });
  if (!res.ok) await refuse(res, apiKey);
  return sharedPostResultSchema.parse(await res.json());
}

/**
 * Withdraw a previously shared post from the network.
 *
 * Idempotent by design: a 404 means the server has already forgotten it, which
 * is the state the caller wanted, so it is a success rather than an error. A
 * withdrawal that reported failure on a second attempt would leave the local
 * row stuck claiming to be shared forever.
 */
export async function withdrawClubPost(serverPostId: string): Promise<void> {
  const { baseUrl, apiKey } = await resolveConnection();
  const res = await fetch(
    `${baseUrl}/api/v1/posts/${encodeURIComponent(serverPostId)}`,
    {
      method: "DELETE",
      cache: "no-store",
      headers: authHeaders(apiKey),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    },
  );
  if (res.status === 404) return;
  if (!res.ok) await refuse(res, apiKey);
}

/**
 * Pull one page of the shared-post mirror cursor.
 *
 * `since`/`sinceId` are the server's own cursor handed back from the previous
 * page — opaque here on purpose. Omitting them asks for a FULL sync, which the
 * server answers with visible posts only and no tombstone backlog.
 */
export async function pullSharedPostSync(cursor: {
  since?: string | null;
  sinceId?: string | null;
}): Promise<SyncEnvelope> {
  const { baseUrl, apiKey } = await resolveConnection();
  const url = new URL(`${baseUrl}/api/v1/feed/sync`);
  if (cursor.since) {
    url.searchParams.set("since", cursor.since);
    if (cursor.sinceId) url.searchParams.set("sinceId", cursor.sinceId);
  }
  const res = await fetch(url, {
    method: "GET",
    cache: "no-store",
    headers: authHeaders(apiKey),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) await refuse(res, apiKey);
  return syncEnvelopeSchema.parse(await res.json());
}

/**
 * Fetch one mirrored image's bytes from the central server.
 *
 * The URL comes out of a sync page this client just validated, but it is still
 * pinned to the configured base URL rather than fetched as given: a compromised
 * or misbehaving server must not be able to point this install's sync pass at
 * an arbitrary third host.
 */
export async function fetchSharedPostImage(
  imageUrl: string,
): Promise<Uint8Array | null> {
  const { baseUrl, apiKey } = await resolveConnection();
  const base = new URL(baseUrl);
  let target: URL;
  try {
    target = new URL(imageUrl, baseUrl);
  } catch {
    return null;
  }
  if (target.origin !== base.origin) return null;
  if (!/^\/api\/images\/posts\/[0-9a-f]{32}(\.webp)?$/.test(target.pathname)) {
    return null;
  }

  const res = await fetch(target, {
    method: "GET",
    cache: "no-store",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      [CLIENT_API_VERSION_HEADER]: SERVERNZ_EXPECTED_SERVER_VERSION,
    },
    signal: AbortSignal.timeout(SHARE_TIMEOUT_MS),
  });
  if (!res.ok) {
    // A missing or refused picture is null (the words still arrive) - except
    // the server's version refusal, which is the pass's answer, not the
    // picture's, and must not be mirrored away as "no image".
    if (res.status === 409) await refuse(res, apiKey);
    return null;
  }
  return new Uint8Array(await res.arrayBuffer());
}

/**
 * Tell the central server where to push shared posts for this install.
 *
 * Returns the signing secret the webhook must verify pushes with. The caller
 * stores it in the encrypted credential store — it is a secret exactly like
 * the API key beside it, and it never belongs in a plain settings row.
 */
export async function registerPushTarget(
  callbackUrl: string,
): Promise<PushTargetResult> {
  const { baseUrl, apiKey } = await resolveConnection();
  const res = await fetch(`${baseUrl}/api/v1/push-target`, {
    method: "PUT",
    cache: "no-store",
    headers: authHeaders(apiKey),
    body: JSON.stringify({ url: callbackUrl }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) await refuse(res, apiKey);
  return pushTargetResultSchema.parse(await res.json());
}

/** Upload the club's Other Clubs entries to the central server. */
export async function uploadOtherLodges(
  lodges: OtherLodgeUploadItem[],
): Promise<OtherLodgesUploadResult> {
  const { baseUrl, apiKey } = await resolveConnection();
  const res = await fetch(`${baseUrl}/api/v1/other-lodges`, {
    method: "POST",
    cache: "no-store",
    headers: authHeaders(apiKey),
    body: JSON.stringify({ lodges }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) await refuse(res, apiKey);
  return uploadResultSchema.parse(await res.json());
}

/** Pull the distributed Other Clubs set from the central server. */
export async function pullOtherLodges(
  since?: string | null,
): Promise<OtherLodgesPullResult> {
  const { baseUrl, apiKey } = await resolveConnection();
  const url = new URL(`${baseUrl}/api/v1/other-lodges`);
  if (since) url.searchParams.set("since", since);
  const res = await fetch(url, {
    method: "GET",
    cache: "no-store",
    headers: authHeaders(apiKey),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) await refuse(res, apiKey);
  const envelope = pullEnvelopeSchema.parse(await res.json());

  // Per-row validation: a row the server sends that breaks the bounds above is
  // discarded rather than aborting the batch. Dropping one row loses one club's
  // details until the server sends a valid version; throwing would lose the
  // whole pull AND leave the cursor unadvanced, so the same bad row would be
  // re-fetched and re-fail on every subsequent run.
  const lodges: OtherLodgesPullResult["lodges"] = [];
  let dropped = 0;
  for (const raw of envelope.lodges) {
    const row = distributedLodgeSchema.safeParse(raw);
    if (row.success) lodges.push(row.data);
    else dropped++;
  }

  // The owned list, validated apart from the rows and the cursor: refused
  // whole when it breaks its bounds (one name over the bound could never match
  // a local row, but a list that is wrong in one place is not a list to edit
  // and upload by), and then reported as not sent rather than failing the pull.
  let ownLodgeNames: string[] | undefined;
  let ownLodgeNamesRefused = false;
  if (envelope.ownLodgeNames !== undefined) {
    const owned = ownedOtherLodgeNamesSchema.safeParse(envelope.ownLodgeNames);
    if (owned.success) ownLodgeNames = owned.data;
    else ownLodgeNamesRefused = true;
  }

  return {
    lodges,
    cursor: envelope.cursor,
    count: envelope.count,
    dropped,
    ownLodgeNames,
    ownLodgeNamesRefused,
  };
}
