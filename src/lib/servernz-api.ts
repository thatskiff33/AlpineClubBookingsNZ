import "server-only";
import {
  ownedCentralLodgesSchema,
  type OwnedCentralLodge,
} from "@/lib/other-lodges";
import logger from "@/lib/logger";
import { usableCentralId } from "@/lib/other-lodge-central-id";
import {
  MAX_SERVER_VERSION_CHARS,
  deletedLodgeSchema,
  distributedLodgeSchema,
  pulledRowNameSchema,
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
import { getOperationalServerNzCredential, withServerNzConnectionTransaction } from "@/lib/servernz-config";
import {
  loadServerNzSettings,
  validateCentralServerBaseUrl,
  type ServerNzSettingsValues,
} from "@/lib/servernz-settings";
import {
  recordServerVersionIfCurrent,
  type ServerNzConnectionIdentity,
} from "@/lib/servernz-version-record";

/**
 * Outbound client for the Alpine Central Server (ServerNZ) REST API. Mirrors the
 * addy-api.ts pattern: native fetch, Bearer auth, Zod-validated responses, and
 * an explicit request timeout (fetch has none by default).
 *
 * The API key is resolved from the encrypted credential store and the base URL
 * from ServerNzSettings — neither is ever logged.
 */

const REQUEST_TIMEOUT_MS = 10_000;
const CONNECTION_CHANGED = Symbol("connection changed");

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
 * A resolved connection: where to send, the bearer key, and the identity of
 * both as stored when they were read (#4366). `identity` travels with every
 * request so a version answer is recorded only for the connection it came from.
 */
interface ServerNzConnection {
  baseUrl: string;
  apiKey: string;
  identity: ServerNzConnectionIdentity;
  /**
   * The settings row as read in the SAME fenced read as `identity` (#4262
   * review): a caller that bases its request or its writes on stored answers
   * (the Other lodges cursor, keyed marker and owned list) takes them from
   * here, so they belong to the connection the request is sent on.
   */
  settings: ServerNzSettingsValues;
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
 * the request through: a failed check never pauses syncing. An answer dropped
 * after a connection change instead resolves and gates the current connection
 * once more only at the same base URL; a changed URL or second drop fails
 * with a retryable 503.
 */
async function resolveConnection(
  options: { skipVersionGate?: boolean; retriedConnection?: ServerNzConnectionIdentity } = {},
): Promise<ServerNzConnection> {
  const [credential, settings] = await withServerNzConnectionTransaction(async (tx) => {
    const settings = await loadServerNzSettings(tx);
    const credential = await getOperationalServerNzCredential(tx);
    return [credential, settings] as const;
  });
  if (options.retriedConnection && settings.baseUrl !== options.retriedConnection.baseUrl) {
    throw new ServerNzApiError(503, "The Alpine Central Server connection changed during its version check; retry the request.");
  }
  if (!settings.baseUrl) {
    throw new ServerNzNotConfiguredError(
      "The Alpine Central Server base URL is not set.",
    );
  }
  if (!credential) {
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
  const connection = {
    baseUrl: check.value as string,
    apiKey: credential.apiKey,
    identity: { baseUrl: settings.baseUrl, credentialVersion: credential.version },
    settings,
  };
  if (options.skipVersionGate) return connection;

  let stored = settings.serverVersion;
  if (stored === null) {
    // Self-heal: ask once, inline. `refreshServerVersionAnswer` returns null
    // for a call that FAILED, which allows the request (default 1); a record
    // that fails after a received answer throws, like any other database
    // failure on a server-bound path.
    const answer = await refreshServerVersionAnswer(connection);
    if (answer === CONNECTION_CHANGED) {
      if (options.retriedConnection) {
        throw new ServerNzApiError(503, "The Alpine Central Server connection changed during its version check; retry the request.");
      }
      return resolveConnection({ retriedConnection: connection.identity });
    }
    stored = answer;
  }
  assertStoredServerVersionMatches(stored);
  return connection;
}

/**
 * Throw the version pause (#49) when the RECORDED server version differs from
 * the one this site is built for; a version never recorded passes (the gate in
 * `resolveConnection` asks the server then). The one throw site, used by that
 * gate and by the Upload and Download buttons BEFORE they take the sync claim
 * (#66), so a pause neither takes the claim nor is answered as "a sync is
 * running".
 */
export function assertStoredServerVersionMatches(stored: string | null): void {
  if (isStoredServerVersionMismatch(stored)) {
    throw new ServerNzVersionMismatchError(
      SERVERNZ_EXPECTED_SERVER_VERSION,
      stored as string,
    );
  }
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
export async function fetchServerVersion(
  connection?: ServerNzConnection,
): Promise<string> {
  const { baseUrl, apiKey, identity } =
    connection ?? (await resolveConnection({ skipVersionGate: true }));
  const res = await fetch(`${baseUrl}/api/v1/version`, {
    method: "GET",
    cache: "no-store",
    headers: authHeaders(apiKey),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (res.status === 404) return SERVER_VERSION_UNKNOWN;
  if (!res.ok) await refuse(res, identity);
  // Malformed or over-long on the wire reads as the unknown marker: still an
  // ANSWER (and a mismatch), never a failed check.
  return storableServerVersion(versionResultSchema.parse(await res.json()).version);
}

/**
 * THE ONE PATH THAT WRITES THE VERSION COLUMN (#49 review items 3 and 4,
 * #4366): the answer is normalised (`storableServerVersion`) and recorded only
 * if the connection it was obtained on - the stored address and the API key's
 * credential version, captured before the request - is STILL the stored one,
 * compared and recorded under the settings-row lock
 * (`recordServerVersionIfCurrent`). A connection changed while the call was in
 * flight has already forgotten the old connection's answers, and the old
 * server's late answer must not be written over that - it would pause, or
 * clear a pause on, a connection it never described. The credential version,
 * not the key, is compared, so a key saved again with the same value
 * (A -> B -> A) is still a different connection. Returns what was recorded, or
 * CONNECTION_CHANGED when the answer was dropped for that reason. A record that fails
 * throws: a RECEIVED mismatch must never read as "could not check".
 */
async function recordServerAnswer(
  raw: string,
  identity: ServerNzConnectionIdentity,
): Promise<string | typeof CONNECTION_CHANGED> {
  const version = storableServerVersion(raw);
  if (!(await recordServerVersionIfCurrent(identity, version))) {
    logger.info(
      { expected: SERVERNZ_EXPECTED_SERVER_VERSION, serverVersion: version },
      "Dropped a late Alpine Central Server version answer: the connection changed while it was in flight",
    );
    return CONNECTION_CHANGED;
  }
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
export async function refreshStoredServerVersion(
  connection?: ServerNzConnection,
): Promise<string | null> {
  const answer = await refreshServerVersionAnswer(connection);
  return answer === CONNECTION_CHANGED ? null : answer;
}

async function refreshServerVersionAnswer(
  connection?: ServerNzConnection,
): Promise<string | null | typeof CONNECTION_CHANGED> {
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
  return recordServerAnswer(version, resolved.identity);
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
 * with the same connection fence, #4366) and throws `ServerNzVersionMismatchError`,
 * which every caller already maps to its paused path. It used to surface as a
 * plain 4xx `ServerNzApiError`, which `shareOnePost` reads as a refusal that
 * will never change and retires the share for good. Every other failure is
 * the `ServerNzApiError` it always was.
 */
async function refuse(
  res: Response,
  sentOn: ServerNzConnectionIdentity,
): Promise<never> {
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
    const stored = await recordServerAnswer(body.serverVersion, sentOn);
    throw new ServerNzVersionMismatchError(
      SERVERNZ_EXPECTED_SERVER_VERSION,
      stored === CONNECTION_CHANGED ? storableServerVersion(body.serverVersion) : stored,
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
  const { baseUrl, apiKey, identity } = await resolveConnection();

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
  if (!res.ok) await refuse(res, identity);
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
  const { baseUrl, apiKey, identity } = await resolveConnection();
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
  if (!res.ok) await refuse(res, identity);
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
  const { baseUrl, apiKey, identity } = await resolveConnection();
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
  if (!res.ok) await refuse(res, identity);
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
  const { baseUrl, apiKey, identity } = await resolveConnection();
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
    if (res.status === 409) await refuse(res, identity);
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
  const { baseUrl, apiKey, identity } = await resolveConnection();
  const res = await fetch(`${baseUrl}/api/v1/push-target`, {
    method: "PUT",
    cache: "no-store",
    headers: authHeaders(apiKey),
    body: JSON.stringify({ url: callbackUrl }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) await refuse(res, identity);
  return pushTargetResultSchema.parse(await res.json());
}

/** Capture upload settings and the sender together, as the download does. */
export async function prepareOtherLodgesUpload() {
  const connection = await resolveConnection();
  return {
    settings: connection.settings,
    upload: (lodges: OtherLodgeUploadItem[]) => uploadOtherLodges(lodges, connection),
  };
}

/** Upload the club's entries, returning the request identity for fenced recording. */
export async function uploadOtherLodges(
  lodges: OtherLodgeUploadItem[],
  connection?: ServerNzConnection,
): Promise<OtherLodgesUploadResult & { sentOn: ServerNzConnectionIdentity }> {
  const { baseUrl, apiKey, identity } = connection ?? await resolveConnection();
  const res = await fetch(`${baseUrl}/api/v1/other-lodges`, {
    method: "POST",
    cache: "no-store",
    headers: authHeaders(apiKey),
    body: JSON.stringify({ lodges }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) await refuse(res, identity);
  return { ...uploadResultSchema.parse(await res.json()), sentOn: identity };
}

/**
 * Pull the distributed Other Clubs set from the central server. `since` may be
 * a function of the stored settings, so the cursor asked from is the one read
 * in the same fenced read as the connection (#4262 review); the result returns
 * that read as `snapshot`.
 */
export async function pullOtherLodges(
  since?: string | null | ((stored: ServerNzSettingsValues) => string | null),
): Promise<OtherLodgesPullResult> {
  const { baseUrl, apiKey, identity, settings } = await resolveConnection();
  const sinceValue = typeof since === "function" ? since(settings) : since;
  const url = new URL(`${baseUrl}/api/v1/other-lodges`);
  if (sinceValue) url.searchParams.set("since", sinceValue);
  const res = await fetch(url, {
    method: "GET",
    cache: "no-store",
    headers: authHeaders(apiKey),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) await refuse(res, identity);
  const envelope = pullEnvelopeSchema.parse(await res.json());

  // Per-row validation: a row the server sends that breaks the bounds above is
  // discarded rather than aborting the batch. Dropping one row loses one club's
  // details until the server sends a valid version; throwing would lose the
  // whole pull AND leave the cursor unadvanced, so the same bad row would be
  // re-fetched and re-fail on every subsequent run.
  const lodges: OtherLodgesPullResult["lodges"] = [];
  let dropped = 0;
  const droppedRows: Array<{ name: string; id: string | null }> = [];
  for (const raw of envelope.lodges) {
    const row = distributedLodgeSchema.safeParse(raw);
    if (row.success) {
      lodges.push(row.data);
      continue;
    }
    dropped++;
    const named = pulledRowNameSchema.safeParse(raw);
    if (named.success) droppedRows.push({ name: named.data.name, id: usableCentralId(named.data.id) });
  }

  // The owned list, validated apart from the rows and the cursor: refused
  // whole when it breaks its bounds (a list that is wrong in one place is not
  // a list to edit and upload by), and then reported as not sent rather than
  // failing the pull.
  let ownLodges: OwnedCentralLodge[] | undefined;
  let ownLodgesRefused = false;
  if (envelope.ownLodges !== undefined) {
    const owned = ownedCentralLodgesSchema.safeParse(envelope.ownLodges);
    if (owned.success) ownLodges = owned.data;
    else ownLodgesRefused = true;
  }

  // Deletions (#58): each entry on its own, like the rows; one malformed entry
  // costs that deletion, not the rest.
  const deletedLodgeIds = envelope.deletedLodges?.flatMap((raw) => {
    const entry = deletedLodgeSchema.safeParse(raw);
    return entry.success ? [entry.data.id] : [];
  });
  // A dropped row this answer also reports deleted names no live lodge.
  const deleted = new Set(deletedLodgeIds ?? []);
  const droppedNames = droppedRows.filter((row) => row.id === null || !deleted.has(row.id)).map((row) => row.name);

  return {
    lodges,
    cursor: envelope.cursor,
    count: envelope.count,
    dropped,
    droppedNames,
    ownLodges,
    ownLodgesRefused,
    deletedLodgeIds,
    sentOn: identity,
    snapshot: settings,
  };
}
