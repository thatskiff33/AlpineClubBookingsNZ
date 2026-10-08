/**
 * The Alpine Central Server API version this site was built for, and the ONE
 * rule for comparing versions (#49, `INV-INT-027`, `INV-SSOT`).
 *
 * The server publishes a single `major.minor` number for the whole `/api/v1`
 * contract (other lodges, the message board, push registration). This site
 * syncs only while the two numbers are IDENTICAL - a different minor included -
 * and pauses every server-bound transfer otherwise. Upgrading this site means
 * changing the constant below; nothing stored has to be reset, because the
 * mismatch is computed from the stored server answer on every read.
 *
 * COMPARISON IS BY INTEGER PARTS, NEVER AS A NUMBER (owner decision on the
 * issue): `1.10` is a later version than `1.1`, and as floating-point numbers
 * they are equal. Nothing here calls `Number()` or `parseFloat()` on a version
 * string, and the guard test's census keeps it that way.
 *
 * No `server-only` import: the setup page's client component shows the
 * expected version beside the server's.
 */

/** The server API version this release speaks. Bump it when the server does. */
export const SERVERNZ_EXPECTED_SERVER_VERSION = "2.1";

/**
 * What is stored when the server answered the version call with 404 (it
 * predates versioning) or with a string that is not a canonical `major.minor`.
 * Treated as a mismatch, never as "unchecked".
 */
export const SERVER_VERSION_UNKNOWN = "unknown";

/** The server version shown when no API key is stored: nothing was asked. */
export const NO_KEY_SERVER_VERSION = "0";

/**
 * The ONE spelling of "paused for version" (#49, `INV-SSOT`): the machine
 * code the Upload/Download routes answer with, the nightly sync's and the
 * mirror's skip reason, and the setup page's refresh trigger. They are one
 * fact - a server-bound transfer refused because the versions differ - so a
 * reader finding any of them finds the same word.
 */
export const SERVER_VERSION_MISMATCH_CODE = "server-version-mismatch";

/**
 * How long a recorded answer is trusted before the setup page's version route
 * asks the server again (#49 review). The page asks once on entry and after a
 * save; this is what keeps a second tab, a reload or a quick re-save from
 * tripping the server's per-token rate limit on the version call.
 */
export const SERVER_VERSION_RECHECK_INTERVAL_MS = 60_000;

/**
 * The server's answer as a value fit to store: a canonical `major.minor`
 * verbatim, anything else - a 404, a malformed or over-long string - as the
 * fixed unknown marker. One rule for every path that writes the column.
 */
export function storableServerVersion(raw: unknown): string {
  return parseServerVersion(raw) ? (raw as string) : SERVER_VERSION_UNKNOWN;
}

/** What `checkServerVersion` and `GET /api/admin/alpine-server/version` report. */
export interface ServerVersionCheck {
  status: ServerVersionStatus;
  /** The server's version as shown: `NO_KEY_SERVER_VERSION` with no key, else the stored answer. */
  serverVersion: string;
  /** The version this site speaks. */
  expected: string;
  checkedAt: string | null;
  /** True when this call could not reach or read the server; the stored answer stands. */
  couldNotCheck: boolean;
  /** True when a key is stored but no usable server address is, so nothing was asked. */
  missingBaseUrl: boolean;
}

/**
 * Canonical form only: no leading zeros, no sign, no whitespace, so one version
 * has exactly one spelling. Identical to the server's own pattern.
 */
const SERVER_VERSION_PATTERN = /^(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})$/;

export interface ParsedServerVersion {
  major: number;
  minor: number;
}

/** The two integer parts of a canonical `major.minor` string, or null. */
export function parseServerVersion(raw: unknown): ParsedServerVersion | null {
  if (typeof raw !== "string") return null;
  const match = SERVER_VERSION_PATTERN.exec(raw);
  if (!match) return null;
  // Each part is already a bounded run of decimal digits with no leading zero,
  // so parseInt of that exact run is an integer read, not a float read.
  return {
    major: parseInt(match[1] as string, 10),
    minor: parseInt(match[2] as string, 10),
  };
}

/**
 * True only when BOTH are valid versions with the same major AND minor.
 * `"unknown"`, null, a malformed string and `1.10` against `1.1` all compare
 * as different.
 */
export function compareServerVersions(a: unknown, b: unknown): boolean {
  const left = parseServerVersion(a);
  const right = parseServerVersion(b);
  if (!left || !right) return false;
  return left.major === right.major && left.minor === right.minor;
}

export type ServerVersionStatus =
  /** No API key is stored, so no check is made; the page shows `0`. */
  | "no-key"
  /** A key is stored but the server has not been asked yet. Syncing is allowed. */
  | "unchecked"
  | "match"
  /** Any difference, a 404 ("unknown") included. Syncing is paused. */
  | "mismatch";

/**
 * The status of a stored server version against this site's constant.
 * Pure, so the digest, the setup page, the lodges panel and the sync gate all
 * answer the same question the same way.
 */
export function computeServerVersionStatus(
  stored: string | null | undefined,
  apiKeySet: boolean,
): ServerVersionStatus {
  if (!apiKeySet) return "no-key";
  if (stored === null || stored === undefined) return "unchecked";
  return compareServerVersions(stored, SERVERNZ_EXPECTED_SERVER_VERSION)
    ? "match"
    : "mismatch";
}

/**
 * The one sentence that explains a pause, used by the gate's error, the Daily
 * digest, the setup page and the lodges panel so every surface says the same
 * thing. Names only the two numbers.
 */
export function describeServerVersionPause(
  expected: string,
  serverVersion: string,
): string {
  const serverPart =
    serverVersion === SERVER_VERSION_UNKNOWN
      ? "the server does not report a version, so it is on a release from before version checks"
      : `the server reports ${serverVersion}`;
  return `Syncing with the Alpine Central Server is paused: this site is built for server version ${expected} and ${serverPart}. Nothing is sent or received until the two match.`;
}

/**
 * Whether a STORED version pauses syncing. Only a recorded answer can: NULL
 * (never asked) allows, and so does a key that is missing, because then
 * `resolveConnection` refuses the request for its own reason first.
 */
export function isStoredServerVersionMismatch(
  stored: string | null | undefined,
): boolean {
  return (
    stored !== null &&
    stored !== undefined &&
    !compareServerVersions(stored, SERVERNZ_EXPECTED_SERVER_VERSION)
  );
}
