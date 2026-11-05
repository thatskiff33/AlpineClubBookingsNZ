/**
 * How long a signed-in session survives WITHOUT USE (#4612). The one place
 * that decides it.
 *
 * - Every ordinary account: 8 hours.
 * - The lodge kiosk account: 30 days, so the shared lodge tablet is not signed
 *   out after a quiet night (owner decision, 2 Nov 2026). "The kiosk account"
 *   is the app's own record class, `isLodgeKioskAccount` in `member-roles.ts`:
 *   `LODGE` is the record's whole classification. Holding `LODGE` is not
 *   enough — it is a freely tickable checkbox, so an officer or custom-role
 *   holder who also has it is an ordinary account and keeps 8 hours.
 *   Hut-leader actions on that tablet stay behind the separate 10-minute PIN
 *   session (`HUT_LEADER_PIN_SESSION_IDLE_SECONDS`).
 *
 * This is the IDLE window only: each refresh of the session re-issues the
 * token and its cookie for another full window. The absolute ceiling measured
 * from `sessionIssuedAt` is a separate rule (#4611) and is not decided here.
 *
 * WHY THIS IS DECIDED PER REQUEST. Auth.js stamps a JWT's `exp` and the
 * session cookie's `Expires` from the same number, `session.maxAge`, every time
 * it writes the cookie (sign-in, `/api/auth/session` refresh, session update).
 * A per-token `exp` set in the `jwt` callback is overwritten by that re-encode
 * (the dead line #4612 removed), and there is no per-token hook for the
 * cookie. The supported lever is the request-scoped config the app already uses
 * (`buildRequestAuthConfig`), so `session.maxAge` is chosen per request from the
 * session token the request already carries. Both the new token's `exp` and the
 * cookie's `Expires` then come from that one number and can never disagree.
 *
 * Consequences, all failing towards the shorter window:
 * - A sign-in has no token yet, so the first cookie is the ordinary window; the
 *   kiosk's first `/api/auth/session` refresh (the page's `SessionProvider` makes
 *   one on load and on focus) re-issues it for 30 days.
 * - The decision reads the incoming token's `kioskAccount` claim, which the
 *   `jwt` callback stamped from the database row on the previous request, so
 *   a role change takes effect one refresh later.
 * - A token minted before the `kioskAccount` claim existed carries none, so
 *   it gets the ordinary window until its first refresh stamps the claim.
 * - Only the session endpoint (`/api/auth/session`, the refresh and the client
 *   `update()`) reads the incoming token. Every other Auth.js action gets the
 *   ordinary window: a sign-in on the kiosk tablet while its cookie is still
 *   present mints a DIFFERENT member's session, which must not inherit 30 days.
 * - A call with no request (`auth()` in a server component, a server-side
 *   session update) gets the ordinary window. `auth()` there never writes the
 *   cookie; an update is re-issued by the next refresh.
 * - An invalidated, unreadable or absent token gets the ordinary window.
 */
import { getToken } from "next-auth/jwt";
import {
  isLodgeKioskAccount,
  type AccountClassificationInput,
} from "./member-roles";

/** Idle window of an ordinary account's session, in seconds. */
export const ACCOUNT_SESSION_IDLE_SECONDS = 8 * 60 * 60;

/** Idle window of the lodge kiosk account's session, in seconds (#4612). */
export const KIOSK_ACCOUNT_SESSION_IDLE_SECONDS = 30 * 24 * 60 * 60;

/**
 * The `kioskAccount` claim the `jwt` callback stamps from the member row on
 * every refresh: login on, and the record IS the kiosk by the app's own
 * classification (`isLodgeKioskAccount`). Not "holds `LODGE`".
 */
export function isKioskSessionMember(
  member: AccountClassificationInput & { canLogin: boolean | null | undefined },
): boolean {
  return (
    member.canLogin === true &&
    isLodgeKioskAccount(
      member.role,
      member.accessRoles,
      member.financeAccessLevel,
    )
  );
}

/**
 * A decoded session token. The decision reads `kioskAccount` and
 * `sessionInvalidated`, both stamped by `auth.ts`'s `jwt` callback.
 */
type SessionIdleClaims = Readonly<Record<string, unknown>>;

/**
 * The idle window for a session carrying these claims: the kiosk window only
 * for an explicit `kioskAccount: true` on a live session. A missing claim (a
 * token minted before the claim existed) reads as an ordinary account.
 */
export function sessionIdleSecondsForClaims(
  claims: SessionIdleClaims | null | undefined,
): number {
  if (!claims || claims.sessionInvalidated === true) {
    return ACCOUNT_SESSION_IDLE_SECONDS;
  }
  return claims.kioskAccount === true
    ? KIOSK_ACCOUNT_SESSION_IDLE_SECONDS
    : ACCOUNT_SESSION_IDLE_SECONDS;
}

/** The app's Auth.js URL, which `next-auth` puts in place of the request's. */
function authEnvUrl(): URL | null {
  const envUrl = process.env.AUTH_URL ?? process.env.NEXTAUTH_URL;
  if (!envUrl) return null;
  try {
    return new URL(envUrl);
  } catch {
    return null;
  }
}

/**
 * Is this request Auth.js's `session` action? Mirrors `next-auth`'s base path
 * (`setEnvDefaults`: the `AUTH_URL`/`NEXTAUTH_URL` path when it is not `/`,
 * else `/api/auth`). Any other action — above all a sign-in callback, which
 * mints a new member's token — must not take its window from the old cookie.
 */
function isSessionAction(
  request: Request,
  basePath: string | undefined,
): boolean {
  const envPath = authEnvUrl()?.pathname;
  const base =
    basePath ?? (envPath && envPath !== "/" ? envPath : "/api/auth");
  return (
    new URL(request.url).pathname.replace(/\/+$/, "") ===
    `${base.replace(/\/+$/, "")}/session`
  );
}

/**
 * The name Auth.js gives the session cookie for this request. Mirrors
 * `@auth/core`'s `init` (`useSecureCookies ?? url.protocol === "https:"`) over
 * the URL `next-auth`'s route handlers pass it (`reqWithEnvURL`: the
 * `AUTH_URL`/`NEXTAUTH_URL` origin when set, else the request's own). The name
 * is also the key-derivation salt, so a wrong guess decodes nothing and falls
 * back to the ordinary window rather than reading the wrong cookie.
 */
function sessionCookieName(
  request: Request,
  useSecureCookies: boolean | undefined,
): string {
  const protocol = (authEnvUrl() ?? new URL(request.url)).protocol;
  const secure = useSecureCookies ?? protocol === "https:";
  return `${secure ? "__Secure-" : ""}authjs.session-token`;
}

/**
 * The idle window for this request's session: `session.maxAge` for the config
 * Auth.js runs it with. Only the session action reads a token, and only from
 * the session cookie — never an `Authorization: Bearer` header, which Auth.js's
 * own session read ignores. Fails to the ordinary window on any doubt.
 */
export async function resolveRequestSessionIdleSeconds(
  request: Request | undefined,
  config: {
    secret?: string | string[];
    useSecureCookies?: boolean;
    basePath?: string;
  },
): Promise<number> {
  if (!request || !config.secret) return ACCOUNT_SESSION_IDLE_SECONDS;
  if (!isSessionAction(request, config.basePath)) {
    return ACCOUNT_SESSION_IDLE_SECONDS;
  }
  const cookie = request.headers.get("cookie");
  if (!cookie) return ACCOUNT_SESSION_IDLE_SECONDS;
  try {
    const cookieName = sessionCookieName(request, config.useSecureCookies);
    const claims = await getToken({
      req: { headers: new Headers({ cookie }) },
      secret: config.secret,
      cookieName,
      salt: cookieName,
    });
    return sessionIdleSecondsForClaims(claims);
  } catch {
    return ACCOUNT_SESSION_IDLE_SECONDS;
  }
}
