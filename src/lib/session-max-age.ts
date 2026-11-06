/**
 * How old a signed-in session may get, however active it is (#4611,
 * `INV-AUTH-007`). The one place that decides it.
 *
 * The idle window (`session-idle-expiry.ts`, #4612) ends a session nobody uses;
 * every refresh slides it forward. This is the other limit: a fixed lifetime
 * counted from when the person signed in, which nothing extends — not
 * activity, a refresh, a role change or a two-factor verification. Only
 * signing in again starts a new one.
 *
 * - Every ordinary account: the club's setting,
 *   `LoginSecuritySetting.sessionMaxAgeHours` (`INV-CONFIG-001`), default 7
 *   days, accepted 8 hours to 30 days.
 * - The lodge kiosk account: its own 30 days, which the club setting never
 *   shortens or lengthens (decision recorded on #4611).
 *
 * Pure and Prisma-free, so the admin card can import the bounds. The one caller
 * of `isSessionPastMaxAge` is the `jwt` callback in `auth.ts`, the refresh
 * every session read passes through.
 */

const HOUR_MS = 60 * 60 * 1000;

/** A decoded session token; only `sessionIssuedAt` is read. */
type SessionTokenClaims = Readonly<Record<string, unknown>>;

/** The shortest maximum session age a club may set, in hours. */
export const SESSION_MAX_AGE_MIN_HOURS = 8;

/** The longest maximum session age a club may set, in hours (30 days). */
export const SESSION_MAX_AGE_MAX_HOURS = 30 * 24;

/** The maximum session age of an unconfigured club, in hours (7 days). */
export const SESSION_MAX_AGE_DEFAULT_HOURS = 7 * 24;

/**
 * The lodge kiosk account's own maximum session age, in hours (30 days). Not a
 * club setting: the club's value never applies to the kiosk.
 */
export const KIOSK_SESSION_MAX_AGE_HOURS = 30 * 24;

/**
 * When the session a token carries began, in epoch milliseconds, exactly as
 * the sign-in stamped it: `sessionIssuedAt`, or `null` when the token has no
 * readable stamp. Never the JWT's `iat`, which every refresh renews, and
 * never now.
 */
export function readTokenSessionIssuedAtMs(
  token: SessionTokenClaims,
): number | null {
  return typeof token.sessionIssuedAt === "number" &&
    Number.isFinite(token.sessionIssuedAt)
    ? token.sessionIssuedAt
    : null;
}

/**
 * The maximum age, in hours, of a session held by this account: the kiosk's
 * own ceiling for the lodge kiosk account (`isKioskSessionMember` on the
 * member row), else the club's normalised setting.
 */
export function sessionMaxAgeHoursFor(input: {
  kioskAccount: boolean;
  clubSessionMaxAgeHours: number;
}): number {
  return input.kioskAccount
    ? KIOSK_SESSION_MAX_AGE_HOURS
    : input.clubSessionMaxAgeHours;
}

/**
 * Whether the session this token carries has reached its maximum age at
 * `nowMs`. Measured from the stamped `sessionIssuedAt` only; a token without a
 * readable stamp is past it, never unlimited, and so is any session when the
 * limit is not a finite number. The session ends AT the limit: one
 * millisecond before it is still live.
 */
export function isSessionPastMaxAge(
  token: SessionTokenClaims,
  account: { kioskAccount: boolean; clubSessionMaxAgeHours: number },
  nowMs: number,
): boolean {
  const issuedAtMs = readTokenSessionIssuedAtMs(token);
  const maxAgeHours = sessionMaxAgeHoursFor(account);
  if (issuedAtMs === null || !Number.isFinite(maxAgeHours)) return true;
  return nowMs - issuedAtMs >= maxAgeHours * HOUR_MS;
}
